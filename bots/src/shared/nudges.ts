import type { Db } from "./db.js";
import type { BotName } from "./history.js";
import { inWindow } from "./time.js";

export interface NudgePolicy {
  maxPerDay: number;
  quietStartMin: number;
  quietEndMin: number;
  /** Stop all proactive messages after this many unanswered ones in a row. */
  maxUnansweredStreak: number;
}

export interface NudgeState {
  sentToday: number;
  /** Most recent proactive messages first. */
  recentAnswered: boolean[];
  /** Manual /quiet: ISO timestamp, or null. */
  quietUntil: string | null;
}

export type NudgeDecision = { ok: true } | { ok: false; reason: string };

/** Pure decision: may this bot send a proactive message right now? */
export function canSendProactive(
  policy: NudgePolicy,
  state: NudgeState,
  nowLocalMinutes: number,
  now: Date = new Date(),
): NudgeDecision {
  if (state.quietUntil && new Date(state.quietUntil) > now) return { ok: false, reason: "quiet mode" };
  if (inWindow(nowLocalMinutes, policy.quietStartMin, policy.quietEndMin)) return { ok: false, reason: "quiet hours" };
  if (state.sentToday >= policy.maxPerDay) return { ok: false, reason: "daily budget used" };
  let streak = 0;
  for (const answered of state.recentAnswered) {
    if (answered) break;
    streak++;
  }
  if (streak >= policy.maxUnansweredStreak) return { ok: false, reason: "backing off: last messages unanswered" };
  return { ok: true };
}

export async function loadNudgeState(db: Db, bot: BotName, todayLocal: string, tz: string): Promise<NudgeState> {
  const sent = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nudge_log WHERE bot = $1 AND (sent_at AT TIME ZONE $3)::date = $2`,
    [bot, todayLocal, tz],
  );
  const recent = await db.query<{ answered: boolean }>(
    "SELECT answered FROM nudge_log WHERE bot = $1 ORDER BY sent_at DESC, id DESC LIMIT 10",
    [bot],
  );
  const quiet = await db.query<{ value: string }>("SELECT value FROM kv WHERE key = $1", [`${bot}:quiet_until`]);
  return {
    sentToday: sent.rows[0]?.n ?? 0,
    recentAnswered: recent.rows.map((r) => r.answered),
    quietUntil: quiet.rows[0]?.value ?? null,
  };
}

export async function logNudge(db: Db, bot: BotName, kind: string) {
  await db.query("INSERT INTO nudge_log (bot, kind) VALUES ($1, $2)", [bot, kind]);
}

/** Any user message counts as an answer to every pending proactive message. */
export async function markNudgesAnswered(db: Db, bot: BotName) {
  await db.query("UPDATE nudge_log SET answered = true WHERE bot = $1 AND answered = false", [bot]);
}
