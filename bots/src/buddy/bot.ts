import { Bot, InlineKeyboard } from "grammy";
import type { Config } from "../config.js";
import type { Db } from "../shared/db.js";
import { kvSet } from "../shared/db.js";
import { recentMessages, saveMessage } from "../shared/history.js";
import { runAgent } from "../shared/llm.js";
import { canSendProactive, loadNudgeState, logNudge, markNudgesAnswered } from "../shared/nudges.js";
import { ownerOnly, replyLong, sendLong, withTyping } from "../shared/telegram.js";
import { addDays, localDate, localMinutes, localNowLabel } from "../shared/time.js";
import { proactivePrompt, reactiveSystem } from "./prompt.js";
import { buddyTools } from "./tools.js";
import * as topics from "./topics.js";

export const BUDDY_COMMANDS = [
  { command: "topics", description: "What I'm keeping an eye on (drop / snooze / done buttons)" },
  { command: "checkin", description: "Do a check-in now" },
  { command: "quiet", description: "Pause my messages: /quiet 4 (hours), /quiet off" },
  { command: "help", description: "How I work" },
];

export function createBuddy(cfg: Config, db: Db) {
  const bot = new Bot(cfg.buddyToken);
  bot.use(ownerOnly("buddy", cfg.allowedUserId));
  const tools = buddyTools(db, cfg.tz);

  bot.command(["start", "help"], (ctx) =>
    ctx.reply(
      "Hey, I'm Buddy 👋 I help you stay on top of what matters to you, without nagging.\n\n" +
        "Tell me what you're working on and I'll keep it in mind. Say \"drop it\" about anything and I'll never bring it up again. " +
        "I check in in the morning and evening, max a few messages a day, and I go quiet if you're busy.\n\n" +
        "/topics to see and edit what I'm tracking, /quiet 4 for 4 hours of silence.",
    ),
  );

  bot.command("topics", async (ctx) => {
    await topics.wakeSnoozed(db, localDate(cfg.tz));
    const list = await topics.listTopics(db, ["active", "snoozed"]);
    if (!list.length) return ctx.reply("Nothing tracked right now. Just tell me what you're working on.");
    for (const t of list) {
      const kb = new InlineKeyboard()
        .text("Drop", `drop:${t.id}`)
        .text("Snooze 1w", `snooze:${t.id}`)
        .text("Done ✅", `done:${t.id}`);
      await ctx.reply(`${t.title}${t.status === "snoozed" ? ` (snoozed until ${t.snooze_until})` : ""}`, {
        reply_markup: kb,
      });
    }
  });

  bot.callbackQuery(/^(drop|snooze|done):(\d+)$/, async (ctx) => {
    const [, action, idStr] = ctx.match!;
    const id = Number(idStr);
    let label = "";
    if (action === "drop") {
      await topics.dropTopic(db, id);
      label = "Dropped. I won't bring it up again.";
    } else if (action === "snooze") {
      const until = addDays(localDate(cfg.tz), 7);
      await topics.snoozeTopic(db, id, until);
      label = `Snoozed until ${until}.`;
    } else {
      await topics.completeTopic(db, id);
      label = "Done! Nice one 🎉";
    }
    await ctx.answerCallbackQuery({ text: label });
    const t = await topics.getTopic(db, id);
    await ctx.editMessageText(`${t?.title ?? `#${id}`}: ${label}`).catch(() => {});
  });

  bot.command("quiet", async (ctx) => {
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "off" || arg === "0") {
      await kvSet(db, "buddy:quiet_until", new Date(0).toISOString());
      return ctx.reply("I'm back. I'll check in at the usual times.");
    }
    const hours = Number(arg || "4");
    if (!Number.isFinite(hours) || hours <= 0) return ctx.reply("Usage: /quiet 4 (hours) or /quiet off");
    await kvSet(db, "buddy:quiet_until", new Date(Date.now() + hours * 3_600_000).toISOString());
    return ctx.reply(`Going quiet for ${hours}h. You can still message me anytime.`);
  });

  bot.command("checkin", async (ctx) => {
    const kind = localMinutes(cfg.tz) < 15 * 60 ? "morning" : "evening";
    const text = await composeProactive(kind);
    await saveMessage(db, "buddy", "assistant", text);
    await replyLong(ctx, text);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    await markNudgesAnswered(db, "buddy");
    await topics.wakeSnoozed(db, localDate(cfg.tz));
    const history = await recentMessages(db, "buddy", 20);
    const all = await topics.listTopics(db);
    const reply = await withTyping(ctx, () =>
      runAgent({
        model: cfg.buddyModel,
        system: reactiveSystem(localNowLabel(cfg.tz), all),
        history,
        input: text,
        tools,
        effort: "low",
      }),
    );
    await saveMessage(db, "buddy", "user", text);
    if (reply) {
      await saveMessage(db, "buddy", "assistant", reply);
      await replyLong(ctx, reply);
    }
  });

  bot.catch((err) => {
    console.error("[buddy] handler error", err.error);
    err.ctx.reply("Oops, something broke on my side. Try again in a minute?").catch(() => {});
  });

  async function composeProactive(kind: "morning" | "evening"): Promise<string> {
    const today = localDate(cfg.tz);
    await topics.wakeSnoozed(db, today);
    const eligible = topics.topicsForProactive(await topics.listTopics(db), today);
    const plan =
      kind === "evening"
        ? ((
            await db.query<{ content: string }>(
              "SELECT content FROM checkins WHERE date = $1 AND type = 'morning' ORDER BY created_at DESC LIMIT 1",
              [today],
            )
          ).rows[0]?.content ?? null)
        : null;
    const text = await runAgent({
      model: cfg.buddyModel,
      system: "You are Buddy, a warm, brief, upbeat accountability partner. Plain text only.",
      history: [], // no chat history in proactive prompts: nothing dropped can leak in
      input: proactivePrompt(kind, localNowLabel(cfg.tz), eligible, plan),
      tools: [],
      effort: "low",
    });
    return text || (kind === "morning" ? "Morning! What are the 1-3 things that matter today?" : "How did today go?");
  }

  /** Scheduled entry point. Respects quiet hours, the daily budget, and back-off. */
  async function proactive(kind: "morning" | "evening") {
    if (cfg.allowedUserId === null) return;
    const state = await loadNudgeState(db, "buddy", localDate(cfg.tz), cfg.tz);
    const policy = {
      maxPerDay: cfg.maxProactivePerDay,
      quietStartMin: cfg.quietStartMin,
      quietEndMin: cfg.quietEndMin,
      maxUnansweredStreak: 2,
    };
    const decision = canSendProactive(policy, state, localMinutes(cfg.tz));
    if (!decision.ok) {
      console.log(`[buddy] skipping ${kind} check-in: ${decision.reason}`);
      return;
    }
    const text = await composeProactive(kind);
    await sendLong(bot, cfg.allowedUserId, text);
    await saveMessage(db, "buddy", "assistant", text);
    await logNudge(db, "buddy", kind);
  }

  return { bot, proactive };
}
