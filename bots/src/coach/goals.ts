import type { Db } from "../shared/db.js";

export interface Goals {
  phase: "cut" | "maintain" | "bulk" | null;
  target_rate_pct_per_week: number | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  target_weight_kg: number | null;
  notes: string | null;
}

const COLS = [
  "phase",
  "target_rate_pct_per_week",
  "calories",
  "protein_g",
  "carbs_g",
  "fat_g",
  "target_weight_kg",
  "notes",
] as const;

export async function currentGoals(db: Db): Promise<Goals | null> {
  const { rows } = await db.query<Goals>(
    `SELECT ${COLS.join(", ")} FROM coach_goals ORDER BY effective_from DESC, id DESC LIMIT 1`,
  );
  const g = rows[0];
  if (!g) return null;
  for (const k of COLS) if (k !== "phase" && k !== "notes" && g[k] !== null) (g as any)[k] = Number(g[k]);
  return g;
}

/** Goals are versioned: each update writes a new row merged over the current one. */
export async function updateGoals(db: Db, patch: Partial<Goals>): Promise<Goals> {
  const cur = (await currentGoals(db)) ?? ({} as Partial<Goals>);
  const next: Record<string, unknown> = {};
  for (const k of COLS) next[k] = patch[k] !== undefined ? patch[k] : (cur[k] ?? null);
  await db.query(
    `INSERT INTO coach_goals (${COLS.join(", ")}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(", ")})`,
    COLS.map((k) => next[k]),
  );
  return (await currentGoals(db))!;
}
