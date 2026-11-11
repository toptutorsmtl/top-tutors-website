import type { Db } from "../shared/db.js";
import { addDays, daysBetween } from "../shared/time.js";

export interface DailyRow {
  date: string;
  weight_kg: number | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  steps: number | null;
  source: string;
}

export type MetricFields = Partial<Omit<DailyRow, "date" | "source">>;

const FIELDS = ["weight_kg", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "steps"] as const;

/**
 * Upsert one day's metrics.
 * - source 'health' or 'manual': provided values win (they're the logged truth).
 * - source 'screenshot': only fills fields that are still empty (OCR never beats the Health sync).
 * Missing (undefined/null) values never erase existing data.
 */
export async function upsertDaily(db: Db, date: string, values: MetricFields, source: "health" | "screenshot" | "manual") {
  const cols = FIELDS.filter((f) => values[f] !== undefined && values[f] !== null);
  if (cols.length === 0) return;
  const params: unknown[] = [date, source, ...cols.map((c) => values[c])];
  const insertCols = ["date", "source", ...cols].join(", ");
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  const updates = cols
    .map((c) =>
      source === "screenshot"
        ? `${c} = COALESCE(daily_metrics.${c}, EXCLUDED.${c})`
        : `${c} = COALESCE(EXCLUDED.${c}, daily_metrics.${c})`,
    )
    .join(", ");
  const sourceUpdate = source === "screenshot" ? "source = daily_metrics.source" : "source = EXCLUDED.source";
  await db.query(
    `INSERT INTO daily_metrics (${insertCols}) VALUES (${placeholders})
     ON CONFLICT (date) DO UPDATE SET ${updates}, ${sourceUpdate}, updated_at = now()`,
    params,
  );
}

export async function getDailyRange(db: Db, from: string, to: string): Promise<DailyRow[]> {
  const { rows } = await db.query<DailyRow>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, weight_kg, calories, protein_g, carbs_g, fat_g, fiber_g, steps, source
     FROM daily_metrics WHERE date BETWEEN $1 AND $2 ORDER BY date`,
    [from, to],
  );
  return rows.map((r) => {
    const out = { ...r } as DailyRow;
    for (const f of FIELDS) out[f] = r[f] === null || r[f] === undefined ? null : Number(r[f]);
    return out;
  });
}

/**
 * Exponentially smoothed trend weight (same idea as MacroFactor / Hacker's Diet).
 * Gaps are handled by compounding the smoothing factor over the missing days.
 */
export function trendWeights(points: { date: string; weight_kg: number }[], alpha = 0.1) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const out: { date: string; weight_kg: number; trend_kg: number }[] = [];
  let trend: number | null = null;
  let prevDate: string | null = null;
  for (const p of sorted) {
    if (trend === null || prevDate === null) {
      trend = p.weight_kg;
    } else {
      const gap = Math.max(1, daysBetween(prevDate, p.date));
      const a = 1 - Math.pow(1 - alpha, gap);
      trend = trend + a * (p.weight_kg - trend);
    }
    prevDate = p.date;
    out.push({ date: p.date, weight_kg: p.weight_kg, trend_kg: round(trend, 2) });
  }
  return out;
}

export interface Summary {
  from: string;
  to: string;
  days: number;
  days_with_food_logged: number;
  days_with_weight: number;
  avg_calories: number | null;
  avg_protein_g: number | null;
  avg_carbs_g: number | null;
  avg_fat_g: number | null;
  avg_steps: number | null;
  trend_start_kg: number | null;
  trend_end_kg: number | null;
  trend_change_kg: number | null;
  trend_change_pct_per_week: number | null;
  /** Rough TDEE: average intake minus the energy implied by the trend change (7700 kcal/kg). */
  estimated_expenditure_kcal: number | null;
}

/**
 * Summary of [from, to]. Trend weight is computed with up to 30 days of lead-in so the
 * first days of the window aren't distorted by a cold start.
 */
export function summarize(rows: DailyRow[], from: string, to: string): Summary {
  const inWindow = rows.filter((r) => r.date >= from && r.date <= to);
  const food = inWindow.filter((r) => r.calories !== null);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length, 0) : null;
  };

  const trend = trendWeights(
    rows.filter((r) => r.weight_kg !== null && r.date <= to).map((r) => ({ date: r.date, weight_kg: r.weight_kg! })),
  );
  const trendInWindow = trend.filter((t) => t.date >= from);
  let start: number | null = null;
  let end: number | null = null;
  let spanDays = 0;
  if (trendInWindow.length >= 2) {
    // Start from the last trend value before the window if there is one.
    const before = trend.filter((t) => t.date < from).at(-1);
    const first = before ?? trendInWindow[0]!;
    const last = trendInWindow.at(-1)!;
    start = first.trend_kg;
    end = last.trend_kg;
    spanDays = daysBetween(first.date, last.date);
  }
  const change = start !== null && end !== null ? round(end - start, 2) : null;
  const pctPerWeek =
    change !== null && start && spanDays > 0 ? round(((change / start) * 100 * 7) / spanDays, 2) : null;

  const avgCal = avg(food.map((r) => r.calories));
  let tdee: number | null = null;
  if (avgCal !== null && change !== null && spanDays >= 7 && food.length >= Math.min(7, spanDays)) {
    tdee = round(avgCal - (change * 7700) / spanDays, 0);
  }

  return {
    from,
    to,
    days: daysBetween(from, to) + 1,
    days_with_food_logged: food.length,
    days_with_weight: inWindow.filter((r) => r.weight_kg !== null).length,
    avg_calories: avgCal,
    avg_protein_g: avg(food.map((r) => r.protein_g)),
    avg_carbs_g: avg(food.map((r) => r.carbs_g)),
    avg_fat_g: avg(food.map((r) => r.fat_g)),
    avg_steps: avg(inWindow.map((r) => r.steps)),
    trend_start_kg: start,
    trend_end_kg: end,
    trend_change_kg: change,
    trend_change_pct_per_week: pctPerWeek,
    estimated_expenditure_kcal: tdee,
  };
}

/** Load rows for a window plus lead-in and summarise it. */
export async function loadSummary(db: Db, from: string, to: string): Promise<Summary> {
  const rows = await getDailyRange(db, addDays(from, -30), to);
  return summarize(rows, from, to);
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
