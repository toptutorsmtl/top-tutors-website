import { describe, expect, it } from "vitest";
import { summarize, trendWeights, type DailyRow } from "../src/coach/metrics.js";
import { currentGoals, updateGoals } from "../src/coach/goals.js";
import { addDays } from "../src/shared/time.js";
import { testDb } from "./helpers.js";

const row = (date: string, weight: number | null, calories: number | null, protein = 150): DailyRow => ({
  date, weight_kg: weight, calories, protein_g: calories === null ? null : protein, carbs_g: null, fat_g: null, fiber_g: null, steps: null, source: "health",
});

describe("trendWeights", () => {
  it("smooths noise and compounds over gaps", () => {
    const t = trendWeights([
      { date: "2026-11-01", weight_kg: 80 },
      { date: "2026-11-02", weight_kg: 81 },
      { date: "2026-11-05", weight_kg: 81 },
    ]);
    expect(t[0]!.trend_kg).toBe(80);
    expect(t[1]!.trend_kg).toBe(80.1);
    // 3-day gap: alpha = 1 - 0.9^3 = 0.271
    expect(t[2]!.trend_kg).toBeCloseTo(80.1 + 0.271 * 0.9, 2);
  });
});

describe("summarize", () => {
  it("computes averages, rate and a plausible expenditure on a steady cut", () => {
    // 28 days losing 0.1 kg/day while eating 2000 kcal -> deficit ~770/day -> TDEE ~2770
    const rows: DailyRow[] = [];
    for (let i = 0; i < 28; i++) rows.push(row(addDays("2026-10-15", i), 85 - 0.1 * i, 2000));
    const s = summarize(rows, "2026-10-29", "2026-11-11");
    expect(s.days).toBe(14);
    expect(s.days_with_food_logged).toBe(14);
    expect(s.avg_calories).toBe(2000);
    expect(s.trend_change_kg).toBeLessThan(0);
    expect(s.trend_change_pct_per_week).toBeLessThan(0);
    expect(s.estimated_expenditure_kcal).toBeGreaterThan(2500);
    expect(s.estimated_expenditure_kcal).toBeLessThan(3000);
  });

  it("returns nulls instead of guessing when there's no data", () => {
    const s = summarize([], "2026-11-05", "2026-11-11");
    expect(s).toMatchObject({ avg_calories: null, trend_change_kg: null, estimated_expenditure_kcal: null, days_with_food_logged: 0 });
  });
});

describe("goals", () => {
  it("versions goals and merges partial updates", async () => {
    const db = await testDb();
    expect(await currentGoals(db)).toBeNull();
    await updateGoals(db, { phase: "cut", calories: 2100, protein_g: 170 });
    const g = await updateGoals(db, { calories: 2000 });
    expect(g).toMatchObject({ phase: "cut", calories: 2000, protein_g: 170 });
  });
});
