import { describe, expect, it } from "vitest";
import * as topics from "../src/buddy/topics.js";
import { proactivePrompt, reactiveSystem } from "../src/buddy/prompt.js";
import { canSendProactive, loadNudgeState, logNudge, markNudgesAnswered } from "../src/shared/nudges.js";
import { recentMessages, saveMessage } from "../src/shared/history.js";
import { testDb } from "./helpers.js";

describe("drop guarantee", () => {
  it("a dropped topic never appears in a proactive prompt", async () => {
    const db = await testDb();
    const gym = await topics.addTopic(db, "Go to the gym 4x/week", "habit");
    const podcast = await topics.addTopic(db, "Launch the podcast", "goal");
    const taxes = await topics.addTopic(db, "File taxes", "commitment");
    await topics.dropTopic(db, podcast.id);
    await topics.snoozeTopic(db, taxes.id, "2026-11-20");

    const eligible = topics.topicsForProactive(await topics.listTopics(db), "2026-11-12");
    expect(eligible.map((t) => t.id)).toEqual([gym.id]);

    for (const kind of ["morning", "evening"] as const) {
      const prompt = proactivePrompt(kind, "Thursday", eligible, null);
      expect(prompt).toContain("gym");
      expect(prompt.toLowerCase()).not.toContain("podcast");
      expect(prompt.toLowerCase()).not.toContain("taxes");
    }
  });

  it("snoozed topics come back on their date; dropped ones don't", async () => {
    const db = await testDb();
    const a = await topics.addTopic(db, "Taxes", "commitment");
    const b = await topics.addTopic(db, "Podcast", "goal");
    await topics.snoozeTopic(db, a.id, "2026-11-20");
    await topics.dropTopic(db, b.id);
    await topics.wakeSnoozed(db, "2026-11-20");
    const eligible = topics.topicsForProactive(await topics.listTopics(db), "2026-11-20");
    expect(eligible.map((t) => t.title)).toEqual(["Taxes"]);
  });

  it("reactive chat lists dropped topics only under the never-bring-up rule", async () => {
    const db = await testDb();
    const b = await topics.addTopic(db, "Podcast", "goal");
    await topics.dropTopic(db, b.id);
    const sys = reactiveSystem("now", await topics.listTopics(db));
    expect(sys).toMatch(/Dropped by the user\. NEVER bring these up yourself[\s\S]*Podcast/);
    expect(sys).toMatch(/Active topics:\n\(none\)/);
  });
});

describe("nudge policy", () => {
  const policy = { maxPerDay: 3, quietStartMin: 22 * 60 + 30, quietEndMin: 8 * 60, maxUnansweredStreak: 2 };
  const base = { sentToday: 0, recentAnswered: [], quietUntil: null };
  const noon = 12 * 60;

  it("allows a normal check-in", () => expect(canSendProactive(policy, base, noon).ok).toBe(true));
  it("respects quiet hours across midnight", () => {
    expect(canSendProactive(policy, base, 23 * 60).ok).toBe(false);
    expect(canSendProactive(policy, base, 7 * 60).ok).toBe(false);
    expect(canSendProactive(policy, base, 8 * 60).ok).toBe(true);
  });
  it("respects the daily budget", () => expect(canSendProactive(policy, { ...base, sentToday: 3 }, noon).ok).toBe(false));
  it("backs off after 2 unanswered", () => {
    expect(canSendProactive(policy, { ...base, recentAnswered: [false] }, noon).ok).toBe(true);
    expect(canSendProactive(policy, { ...base, recentAnswered: [false, false, true] }, noon).ok).toBe(false);
  });
  it("respects /quiet", () => {
    const later = new Date(Date.now() + 3600_000).toISOString();
    expect(canSendProactive(policy, { ...base, quietUntil: later }, noon).ok).toBe(false);
  });

  it("any reply resets the back-off (db round trip)", async () => {
    const db = await testDb();
    await logNudge(db, "buddy", "morning");
    await logNudge(db, "buddy", "evening");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
    let s = await loadNudgeState(db, "buddy", today, "America/Toronto");
    expect(s.sentToday).toBe(2);
    expect(canSendProactive({ ...policy, maxPerDay: 10 }, s, noon).ok).toBe(false);
    await markNudgesAnswered(db, "buddy");
    s = await loadNudgeState(db, "buddy", today, "America/Toronto");
    expect(canSendProactive({ ...policy, maxPerDay: 10 }, s, noon).ok).toBe(true);
  });
});

describe("history", () => {
  it("starts with a user turn and merges consecutive roles", async () => {
    const db = await testDb();
    await saveMessage(db, "buddy", "assistant", "Morning!");
    await saveMessage(db, "buddy", "user", "hey");
    await saveMessage(db, "buddy", "user", "also this");
    await saveMessage(db, "buddy", "assistant", "ok");
    const h = await recentMessages(db, "buddy");
    expect(h).toEqual([
      { role: "user", content: "hey\n\nalso this" },
      { role: "assistant", content: "ok" },
    ]);
  });
});
