function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/** "HH:MM" -> minutes since midnight */
export function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) throw new Error(`Bad time "${hm}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface Config {
  coachToken: string;
  buddyToken: string;
  allowedUserId: number | null;
  coachModel: string;
  buddyModel: string;
  databaseUrl: string;
  ingestKey: string;
  port: number;
  tz: string;
  buddyMorning: string;
  buddyEvening: string;
  quietStartMin: number;
  quietEndMin: number;
  maxProactivePerDay: number;
  coachWeekly: string;
}

export function loadConfig(): Config {
  const allowed = process.env.ALLOWED_USER_ID;
  return {
    coachToken: req("TELEGRAM_TOKEN_COACH"),
    buddyToken: req("TELEGRAM_TOKEN_BUDDY"),
    allowedUserId: allowed ? Number(allowed) : null,
    coachModel: opt("COACH_MODEL", "claude-opus-5-5"),
    buddyModel: opt("BUDDY_MODEL", "claude-opus-5-5"),
    databaseUrl: req("DATABASE_URL"),
    ingestKey: req("INGEST_KEY"),
    port: Number(opt("PORT", "3000")),
    tz: opt("TZ_NAME", "America/Toronto"),
    buddyMorning: opt("BUDDY_MORNING", "08:30"),
    buddyEvening: opt("BUDDY_EVENING", "21:00"),
    quietStartMin: parseHm(opt("BUDDY_QUIET_START", "22:30")),
    quietEndMin: parseHm(opt("BUDDY_QUIET_END", "08:00")),
    maxProactivePerDay: Number(opt("BUDDY_MAX_PROACTIVE_PER_DAY", "3")),
    coachWeekly: opt("COACH_WEEKLY_CHECKIN", "SUN 19:00"),
  };
}
