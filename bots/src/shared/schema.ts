/** Idempotent schema. Runs on every boot. */
export const SCHEMA_SQL = `
-- shared --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  bot         TEXT NOT NULL,              -- 'coach' | 'buddy'
  role        TEXT NOT NULL,              -- 'user' | 'assistant'
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_bot_created ON messages (bot, created_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- coach ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_metrics (
  date        DATE PRIMARY KEY,
  weight_kg   DOUBLE PRECISION,
  calories    DOUBLE PRECISION,
  protein_g   DOUBLE PRECISION,
  carbs_g     DOUBLE PRECISION,
  fat_g       DOUBLE PRECISION,
  fiber_g     DOUBLE PRECISION,
  steps       DOUBLE PRECISION,
  source      TEXT NOT NULL,              -- last writer: 'health' | 'screenshot' | 'manual'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mf_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  date              DATE NOT NULL,
  trend_weight_kg   DOUBLE PRECISION,
  expenditure_kcal  DOUBLE PRECISION,
  target_calories   DOUBLE PRECISION,
  target_protein_g  DOUBLE PRECISION,
  target_carbs_g    DOUBLE PRECISION,
  target_fat_g      DOUBLE PRECISION,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coach_goals (
  id                        BIGSERIAL PRIMARY KEY,
  phase                     TEXT,          -- 'cut' | 'maintain' | 'bulk'
  target_rate_pct_per_week  DOUBLE PRECISION,
  calories                  DOUBLE PRECISION,
  protein_g                 DOUBLE PRECISION,
  carbs_g                   DOUBLE PRECISION,
  fat_g                     DOUBLE PRECISION,
  target_weight_kg          DOUBLE PRECISION,
  notes                     TEXT,
  effective_from            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_raw (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB NOT NULL
);

-- buddy ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topics (
  id                 BIGSERIAL PRIMARY KEY,
  title              TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'goal',     -- goal | habit | commitment | concern
  status             TEXT NOT NULL DEFAULT 'active',   -- active | snoozed | dropped | done
  snooze_until       DATE,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  dropped_at         TIMESTAMPTZ,
  last_mentioned_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS checkins (
  id          BIGSERIAL PRIMARY KEY,
  date        DATE NOT NULL,
  type        TEXT NOT NULL,              -- morning | evening | note
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nudge_log (
  id          BIGSERIAL PRIMARY KEY,
  bot         TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- morning | evening | weekly | watchdog | ...
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered    BOOLEAN NOT NULL DEFAULT false
);
`;
