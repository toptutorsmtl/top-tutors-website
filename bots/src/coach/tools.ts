import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Db } from "../shared/db.js";
import { addDays, ISO_DATE, localDate } from "../shared/time.js";
import { currentGoals, updateGoals } from "./goals.js";
import { getDailyRange, loadSummary, trendWeights, upsertDaily } from "./metrics.js";

const date = z.string().regex(ISO_DATE).describe("YYYY-MM-DD");
const num = (d: string) => z.number().positive().optional().describe(d);

export function coachTools(db: Db, tz: string) {
  const json = (v: unknown) => JSON.stringify(v);

  return [
    betaZodTool({
      name: "get_daily_metrics",
      description:
        "Raw daily rows (weight_kg, calories, protein_g, carbs_g, fat_g, fiber_g, steps, source) plus a computed trend weight, for a date range (max 120 days).",
      inputSchema: z.object({ from: date, to: date }),
      run: async ({ from, to }) => {
        if (from > to) return json({ error: "from must be <= to" });
        if (from < addDays(to, -120)) from = addDays(to, -120);
        const rows = await getDailyRange(db, addDays(from, -30), to);
        const trend = new Map(
          trendWeights(rows.filter((r) => r.weight_kg !== null).map((r) => ({ date: r.date, weight_kg: r.weight_kg! }))).map(
            (t) => [t.date, t.trend_kg],
          ),
        );
        return json(rows.filter((r) => r.date >= from).map((r) => ({ ...r, trend_kg: trend.get(r.date) ?? null })));
      },
    }),
    betaZodTool({
      name: "get_summary",
      description:
        "Averages and trend for the last N days ending today (or `end`): avg calories/macros/steps, days logged, trend weight change, %/week, and a rough expenditure estimate.",
      inputSchema: z.object({ days: z.number().int().min(1).max(120), end: date.optional() }),
      run: async ({ days, end }) => {
        const to = end ?? localDate(tz);
        return json(await loadSummary(db, addDays(to, -(days - 1)), to));
      },
    }),
    betaZodTool({
      name: "get_goals",
      description: "Current goals: phase, target rate %/week, calorie and macro targets, target weight, notes.",
      inputSchema: z.object({}),
      run: async () => json((await currentGoals(db)) ?? { note: "No goals set yet." }),
    }),
    betaZodTool({
      name: "update_goals",
      description: "Change goals. Only pass fields that change; others are kept.",
      inputSchema: z.object({
        phase: z.enum(["cut", "maintain", "bulk"]).optional(),
        target_rate_pct_per_week: z
          .number()
          .min(-2)
          .max(2)
          .optional()
          .describe("Negative for loss, e.g. -0.5 = lose 0.5% bodyweight/week"),
        calories: num("kcal/day"),
        protein_g: num("g/day"),
        carbs_g: num("g/day"),
        fat_g: num("g/day"),
        target_weight_kg: num("kg"),
        notes: z.string().max(1000).optional(),
      }),
      run: async (patch) => json(await updateGoals(db, patch)),
    }),
    betaZodTool({
      name: "save_daily_metrics",
      description:
        "Save logged values for one day read from a screenshot or told by the user. Never overwrites values that came from the Apple Health sync.",
      inputSchema: z.object({
        date,
        from_screenshot: z.boolean().describe("true if read from a screenshot, false if the user typed it"),
        weight_kg: num("Convert lb to kg (x 0.4536)"),
        calories: num("kcal"),
        protein_g: num("g"),
        carbs_g: num("g"),
        fat_g: num("g"),
        fiber_g: num("g"),
        steps: num("steps"),
      }),
      run: async ({ date, from_screenshot, ...values }) => {
        await upsertDaily(db, date, values, from_screenshot ? "screenshot" : "manual");
        return json({ ok: true, date, saved: values });
      },
    }),
    betaZodTool({
      name: "save_mf_snapshot",
      description:
        "Save MacroFactor's own computed numbers seen in a screenshot: trend weight, expenditure (TDEE), recommended daily targets.",
      inputSchema: z.object({
        date,
        trend_weight_kg: num("kg"),
        expenditure_kcal: num("kcal/day"),
        target_calories: num("kcal/day"),
        target_protein_g: num("g/day"),
        target_carbs_g: num("g/day"),
        target_fat_g: num("g/day"),
        note: z.string().max(500).optional(),
      }),
      run: async (s) => {
        await db.query(
          `INSERT INTO mf_snapshots (date, trend_weight_kg, expenditure_kcal, target_calories, target_protein_g, target_carbs_g, target_fat_g, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            s.date,
            s.trend_weight_kg ?? null,
            s.expenditure_kcal ?? null,
            s.target_calories ?? null,
            s.target_protein_g ?? null,
            s.target_carbs_g ?? null,
            s.target_fat_g ?? null,
            s.note ?? null,
          ],
        );
        return json({ ok: true, saved: s });
      },
    }),
    betaZodTool({
      name: "get_latest_mf_snapshot",
      description: "Most recent MacroFactor snapshot (official trend weight, expenditure, targets) and its date.",
      inputSchema: z.object({}),
      run: async () => json(await latestSnapshot(db)),
    }),
  ];
}

export async function latestSnapshot(db: Db) {
  const { rows } = await db.query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, trend_weight_kg, expenditure_kcal, target_calories,
            target_protein_g, target_carbs_g, target_fat_g, note
     FROM mf_snapshots ORDER BY date DESC, id DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}
