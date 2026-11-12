import { Cron } from "croner";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./shared/db.js";
import { startHealthServer } from "./health/server.js";
import { BUDDY_COMMANDS, createBuddy } from "./buddy/bot.js";
import { COACH_COMMANDS, createCoach } from "./coach/bot.js";

/** "08:30" -> "30 8 * * *"; "SUN 19:00" -> "0 19 * * SUN" */
export function toCron(spec: string): string {
  const m = /^(?:([A-Za-z]{3})\s+)?(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) throw new Error(`Bad schedule "${spec}"`);
  const [, dow, h, min] = m;
  return `${Number(min)} ${Number(h)} * * ${dow ? dow.toUpperCase() : "*"}`;
}

async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.databaseUrl, cfg.dbSchema);
  await migrate(db);

  const coach = createCoach(cfg, db);
  const buddy = createBuddy(cfg, db);

  startHealthServer({ db, ingestKey: cfg.ingestKey, tz: cfg.tz, onIngest: coach.onIngest }, cfg.port);

  await coach.bot.api.setMyCommands(COACH_COMMANDS).catch((e) => console.warn("[coach] setMyCommands failed", e));
  await buddy.bot.api.setMyCommands(BUDDY_COMMANDS).catch((e) => console.warn("[buddy] setMyCommands failed", e));

  const safe = (label: string, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      console.error(`[cron] ${label} failed`, e);
    }
  };
  const opts = { timezone: cfg.tz, protect: true };
  new Cron(toCron(cfg.buddyMorning), opts, safe("buddy morning", () => buddy.proactive("morning")));
  new Cron(toCron(cfg.buddyEvening), opts, safe("buddy evening", () => buddy.proactive("evening")));
  new Cron(toCron(cfg.coachWeekly), opts, safe("coach weekly", coach.weeklyCheckin));
  new Cron("0 12 * * *", opts, safe("coach sync watchdog", coach.syncWatchdog));

  // Long polling: no public webhook URL needed for Telegram. Only the Health endpoint must be reachable.
  void coach.bot.start({ onStart: (me) => console.log(`[coach] @${me.username} running`) });
  void buddy.bot.start({ onStart: (me) => console.log(`[buddy] @${me.username} running`) });

  const stop = async () => {
    await Promise.allSettled([coach.bot.stop(), buddy.bot.stop()]);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.env.VITEST === undefined) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
