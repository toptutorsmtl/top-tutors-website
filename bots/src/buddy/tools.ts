import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Db } from "../shared/db.js";
import { kvSet } from "../shared/db.js";
import { ISO_DATE, localDate } from "../shared/time.js";
import * as topics from "./topics.js";

const id = z.number().int().describe("Topic id from list_topics");

export function buddyTools(db: Db, tz: string) {
  const json = (v: unknown) => JSON.stringify(v);
  const notFound = (n: number) => json({ error: `No topic #${n}. Call list_topics for valid ids.` });

  return [
    betaZodTool({
      name: "list_topics",
      description: "List tracked topics with id, title, kind, status (active|snoozed|dropped|done), snooze date.",
      inputSchema: z.object({}),
      run: async () => json(await topics.listTopics(db)),
    }),
    betaZodTool({
      name: "add_topic",
      description: "Start tracking a goal, habit, commitment, or recurring concern the user wants help staying on top of.",
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe("Short label in the user's words"),
        kind: z.enum(["goal", "habit", "commitment", "concern"]),
        notes: z.string().max(1000).optional(),
      }),
      run: async ({ title, kind, notes }) => json(await topics.addTopic(db, title, kind, notes)),
    }),
    betaZodTool({
      name: "drop_topic",
      description:
        "Permanently stop bringing up a topic because the user said to drop it / stop asking / it's no longer relevant. Call immediately, no questions.",
      inputSchema: z.object({ id }),
      run: async ({ id }) => (await topics.dropTopic(db, id)) ? json({ ok: true, id, status: "dropped" }) : notFound(id),
    }),
    betaZodTool({
      name: "snooze_topic",
      description: "Hide a topic until a date (YYYY-MM-DD). Use when the user says not now / later / next week.",
      inputSchema: z.object({ id, until: z.string().regex(ISO_DATE).describe("YYYY-MM-DD") }),
      run: async ({ id, until }) => {
        if (until <= localDate(tz)) return json({ error: "Snooze date must be in the future" });
        return (await topics.snoozeTopic(db, id, until)) ? json({ ok: true, id, until }) : notFound(id);
      },
    }),
    betaZodTool({
      name: "complete_topic",
      description: "Mark a topic done (achieved / finished).",
      inputSchema: z.object({ id }),
      run: async ({ id }) => (await topics.completeTopic(db, id)) ? json({ ok: true, id, status: "done" }) : notFound(id),
    }),
    betaZodTool({
      name: "reactivate_topic",
      description: "Bring a dropped/done/snoozed topic back. ONLY when the user themselves asks to start tracking it again.",
      inputSchema: z.object({ id }),
      run: async ({ id }) => (await topics.reactivateTopic(db, id)) ? json({ ok: true, id, status: "active" }) : notFound(id),
    }),
    betaZodTool({
      name: "log_checkin",
      description: "Save the user's morning plan, evening reflection, or a notable win/note for today.",
      inputSchema: z.object({
        type: z.enum(["morning", "evening", "note"]),
        content: z.string().min(1).max(2000).describe("Their words, lightly condensed"),
      }),
      run: async ({ type, content }) => {
        await db.query("INSERT INTO checkins (date, type, content) VALUES ($1, $2, $3)", [localDate(tz), type, content]);
        return json({ ok: true });
      },
    }),
    betaZodTool({
      name: "set_quiet",
      description: "Pause all proactive messages for a number of hours (0 to resume).",
      inputSchema: z.object({ hours: z.number().min(0).max(24 * 30) }),
      run: async ({ hours }) => {
        const until = new Date(Date.now() + hours * 3_600_000).toISOString();
        await kvSet(db, "buddy:quiet_until", until);
        return json({ ok: true, quiet_until: until });
      },
    }),
  ];
}
