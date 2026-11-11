import { Bot } from "grammy";
import type { Config } from "../config.js";
import type { Db } from "../shared/db.js";
import { kvGet, kvSet } from "../shared/db.js";
import { recentMessages, saveMessage } from "../shared/history.js";
import { runAgent } from "../shared/llm.js";
import { canSendProactive, loadNudgeState, logNudge, markNudgesAnswered } from "../shared/nudges.js";
import { downloadFile, ownerOnly, replyLong, sendLong, withTyping } from "../shared/telegram.js";
import { addDays, localDate, localMinutes, localNowLabel } from "../shared/time.js";
import { LAST_SYNC_KEY } from "../health/server.js";
import type { ParsedHealth } from "../health/parse.js";
import { currentGoals } from "./goals.js";
import { getDailyRange, loadSummary, type Summary } from "./metrics.js";
import { coachSystem, weeklyCheckinPrompt } from "./prompt.js";
import { coachTools, latestSnapshot } from "./tools.js";

export const COACH_COMMANDS = [
  { command: "today", description: "Today's numbers + last sync" },
  { command: "week", description: "Last 7 days: averages and trend" },
  { command: "goals", description: "Current targets" },
  { command: "sync", description: "Apple Health sync status / how to send data" },
  { command: "quiet", description: "Pause check-ins: /quiet 24 (hours), /quiet off" },
  { command: "help", description: "How I work" },
];

const fmt = (n: number | null | undefined, unit = "", dp = 0) =>
  n === null || n === undefined ? "–" : `${n.toFixed(dp)}${unit}`;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

export function formatSummary(s: Summary): string {
  const rate = s.trend_change_pct_per_week;
  return [
    `${s.from} → ${s.to} (${s.days_with_food_logged}/${s.days} days logged)`,
    `Avg: ${fmt(s.avg_calories, " kcal")} · P ${fmt(s.avg_protein_g, "g")} · C ${fmt(s.avg_carbs_g, "g")} · F ${fmt(s.avg_fat_g, "g")}`,
    `Trend weight: ${fmt(s.trend_start_kg, " kg", 1)} → ${fmt(s.trend_end_kg, " kg", 1)} (${
      s.trend_change_kg === null ? "–" : `${s.trend_change_kg > 0 ? "+" : ""}${s.trend_change_kg.toFixed(2)} kg`
    }${rate === null ? "" : `, ${rate > 0 ? "+" : ""}${rate.toFixed(2)}%/wk`})`,
    s.avg_steps !== null ? `Steps: ${fmt(s.avg_steps)}/day` : "",
    s.estimated_expenditure_kcal !== null ? `Est. expenditure: ~${fmt(s.estimated_expenditure_kcal, " kcal")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createCoach(cfg: Config, db: Db) {
  const bot = new Bot(cfg.coachToken);
  bot.use(ownerOnly("coach", cfg.allowedUserId));
  const tools = coachTools(db, cfg.tz);

  bot.command(["start", "help"], (ctx) =>
    ctx.reply(
      "I'm Coach 💪 I read your MacroFactor numbers (via the Apple Health sync) and coach you on them.\n\n" +
        "• Ask me anything: \"how's my cut going?\", \"am I eating enough protein?\"\n" +
        "• Send a MacroFactor screenshot and I'll read it (great for trend weight, expenditure and targets).\n" +
        "• I send a short weekly check-in on Sundays.\n\n" +
        "/today · /week · /goals · /sync",
    ),
  );

  bot.command("today", async (ctx) => {
    const today = localDate(cfg.tz);
    const [row] = await getDailyRange(db, today, today);
    const goals = await currentGoals(db);
    const lastSync = await kvGet(db, LAST_SYNC_KEY);
    const target = (v: number | null | undefined, unit: string) => (v ? ` / ${Math.round(v)}${unit}` : "");
    await ctx.reply(
      [
        `Today (${today})`,
        `Calories: ${fmt(row?.calories)}${target(goals?.calories, " kcal")}`,
        `Protein: ${fmt(row?.protein_g, "g")}${target(goals?.protein_g, "g")} · Carbs ${fmt(row?.carbs_g, "g")} · Fat ${fmt(row?.fat_g, "g")}`,
        `Weight: ${fmt(row?.weight_kg, " kg", 1)} · Steps: ${fmt(row?.steps)}`,
        `Last Health sync: ${ago(lastSync)}`,
      ].join("\n"),
    );
  });

  bot.command("week", async (ctx) => {
    const to = localDate(cfg.tz);
    await ctx.reply(formatSummary(await loadSummary(db, addDays(to, -6), to)));
  });

  bot.command("goals", async (ctx) => {
    const g = await currentGoals(db);
    if (!g) return ctx.reply("No goals yet. Tell me, e.g. \"I'm cutting at 0.5%/week, 2100 kcal, 170 g protein\", or send your MacroFactor targets screenshot.");
    await ctx.reply(
      [
        `Phase: ${g.phase ?? "–"}${g.target_rate_pct_per_week !== null ? ` (${g.target_rate_pct_per_week}%/wk)` : ""}`,
        `Targets: ${fmt(g.calories, " kcal")} · P ${fmt(g.protein_g, "g")} · C ${fmt(g.carbs_g, "g")} · F ${fmt(g.fat_g, "g")}`,
        g.target_weight_kg ? `Goal weight: ${g.target_weight_kg} kg` : "",
        g.notes ? `Notes: ${g.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  });

  bot.command("sync", async (ctx) => {
    const lastSync = await kvGet(db, LAST_SYNC_KEY);
    await ctx.reply(
      `Last Apple Health sync: ${ago(lastSync)}.\n\n` +
        "If it looks stuck: open MacroFactor and close it again (that triggers the Shortcut), or run the \"Coach Sync\" shortcut manually. " +
        "You can also just send me a screenshot of MacroFactor's dashboard.",
    );
  });

  bot.command("quiet", async (ctx) => {
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "off" || arg === "0") {
      await kvSet(db, "coach:quiet_until", new Date(0).toISOString());
      return ctx.reply("Check-ins back on.");
    }
    const hours = Number(arg || "24");
    if (!Number.isFinite(hours) || hours <= 0) return ctx.reply("Usage: /quiet 24 (hours) or /quiet off");
    await kvSet(db, "coach:quiet_until", new Date(Date.now() + hours * 3_600_000).toISOString());
    return ctx.reply(`No check-ins for ${hours}h.`);
  });

  async function chat(input: Parameters<typeof runAgent>[0]["input"], historyText: string) {
    await markNudgesAnswered(db, "coach");
    const history = await recentMessages(db, "coach", 20);
    const reply = await runAgent({
      model: cfg.coachModel,
      system: coachSystem(localNowLabel(cfg.tz), localDate(cfg.tz), await kvGet(db, LAST_SYNC_KEY)),
      history,
      input,
      tools,
      effort: "medium",
    });
    await saveMessage(db, "coach", "user", historyText);
    if (reply) await saveMessage(db, "coach", "assistant", reply);
    return reply;
  }

  bot.on("message:text", async (ctx) => {
    const reply = await withTyping(ctx, () => chat(ctx.message.text, ctx.message.text));
    if (reply) await replyLong(ctx, reply);
  });

  // Screenshots: sent as a photo, or as an image file ("send as file" keeps full resolution).
  bot.on(["message:photo", "message:document"], async (ctx) => {
    const doc = ctx.message.document;
    if (doc && !doc.mime_type?.startsWith("image/")) {
      return ctx.reply("I can read screenshots (images). For other files, not yet.");
    }
    const fileId = doc ? doc.file_id : ctx.message.photo!.at(-1)!.file_id; // largest photo size
    const caption = ctx.message.caption?.trim();
    const reply = await withTyping(ctx, async () => {
      const img = await downloadFile(bot, cfg.coachToken, fileId);
      return chat(
        [
          { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } },
          {
            type: "text",
            text: caption
              ? `MacroFactor screenshot. My note: ${caption}`
              : "Here's a MacroFactor screenshot. Read it, save what's there, and tell me what you saved.",
          },
        ],
        `[sent a screenshot]${caption ? ` ${caption}` : ""}`,
      );
    });
    if (reply) await replyLong(ctx, reply);
  });

  bot.catch((err) => {
    console.error("[coach] handler error", err.error);
    err.ctx.reply("Something broke on my side. Try again in a minute?").catch(() => {});
  });

  async function allowedNow(): Promise<boolean> {
    const state = await loadNudgeState(db, "coach", localDate(cfg.tz), cfg.tz);
    const d = canSendProactive(
      { maxPerDay: 2, quietStartMin: cfg.quietStartMin, quietEndMin: cfg.quietEndMin, maxUnansweredStreak: 3 },
      state,
      localMinutes(cfg.tz),
    );
    if (!d.ok) console.log(`[coach] skipping proactive message: ${d.reason}`);
    return d.ok;
  }

  async function weeklyCheckin() {
    if (cfg.allowedUserId === null || !(await allowedNow())) return;
    const to = localDate(cfg.tz);
    const thisWeek = await loadSummary(db, addDays(to, -6), to);
    const lastWeek = await loadSummary(db, addDays(to, -13), addDays(to, -7));
    const text = await runAgent({
      model: cfg.coachModel,
      system: coachSystem(localNowLabel(cfg.tz), to, await kvGet(db, LAST_SYNC_KEY)),
      history: [],
      input: weeklyCheckinPrompt(
        JSON.stringify(thisWeek),
        JSON.stringify(lastWeek),
        JSON.stringify(await currentGoals(db)),
        JSON.stringify(await latestSnapshot(db)),
      ),
      tools: [],
      effort: "medium",
    });
    const msg = text || formatSummary(thisWeek);
    await sendLong(bot, cfg.allowedUserId, msg);
    await saveMessage(db, "coach", "assistant", msg);
    await logNudge(db, "coach", "weekly");
  }

  /** One message per stale period if the Health sync stops arriving. */
  async function syncWatchdog() {
    if (cfg.allowedUserId === null) return;
    const last = await kvGet(db, LAST_SYNC_KEY);
    if (!last) return; // never set up yet: don't nag
    const staleHours = (Date.now() - new Date(last).getTime()) / 3_600_000;
    if (staleHours < 36 || (await kvGet(db, "health:watchdog_warned")) === "1") return;
    if (!(await allowedNow())) return;
    const msg =
      `Heads up: no Apple Health sync for ${Math.round(staleHours / 24)} days. ` +
      "Open and close MacroFactor (that triggers the Shortcut), or send me a screenshot of today's dashboard.";
    await sendLong(bot, cfg.allowedUserId, msg);
    await saveMessage(db, "coach", "assistant", msg);
    await logNudge(db, "coach", "watchdog");
    await kvSet(db, "health:watchdog_warned", "1");
  }

  /** Called by the ingest endpoint. Confirms test pings and the first-ever sync only, so normal syncs stay silent. */
  async function onIngest(parsed: ParsedHealth, notify: boolean) {
    if (!notify || cfg.allowedUserId === null) return;
    const d = parsed.day;
    const parts = [
      parsed.weight ? `${parsed.weight.weight_kg} kg (${parsed.weight.date})` : null,
      d.calories !== null ? `${Math.round(d.calories)} kcal` : null,
      d.protein_g !== null ? `P ${Math.round(d.protein_g)}g` : null,
      d.carbs_g !== null ? `C ${Math.round(d.carbs_g)}g` : null,
      d.fat_g !== null ? `F ${Math.round(d.fat_g)}g` : null,
      d.steps !== null ? `${Math.round(d.steps)} steps` : null,
    ].filter(Boolean);
    await bot.api.sendMessage(
      cfg.allowedUserId,
      `✅ Health sync received for ${d.date}: ${parts.join(", ") || "no values yet (log something in MacroFactor first)"}`,
    );
  }

  return { bot, weeklyCheckin, syncWatchdog, onIngest, localMinutes: () => localMinutes(cfg.tz) };
}
