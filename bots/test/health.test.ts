import { describe, expect, it } from "vitest";
import { parseHealthPayload, parseNumber, HealthPayloadError } from "../src/health/parse.js";
import { ingestHealth, LAST_SYNC_KEY } from "../src/health/server.js";
import { getDailyRange, upsertDaily } from "../src/coach/metrics.js";
import { kvGet } from "../src/shared/db.js";
import { testDb } from "./helpers.js";

describe("parseNumber", () => {
  it.each([
    [1834, 1834],
    ["1834", 1834],
    ["2 150,5", 2150.5],
    ["2 150", 2150],
    ["82,4", 82.4],
    ["82.4 kg", 82.4],
    ["1,234", 1234],
    ["1.234,5", 1234.5],
    ["1,234.5", 1234.5],
    ["", null],
    ["kcal", null],
    [null, null],
  ])("%s -> %s", (input, out) => expect(parseNumber(input)).toBe(out));
});

describe("parseHealthPayload", () => {
  it("parses a typical Shortcut payload", () => {
    const p = parseHealthPayload(
      { date: "2026-11-12", calories: "2 150", protein_g: 165.2, carbs_g: "210", fat_g: "70,5", steps: 9012, weight: "181.6", weight_unit: "lb", weight_date: "2026-11-12" },
      "2026-11-01",
    );
    expect(p.day).toMatchObject({ date: "2026-11-12", calories: 2150, protein_g: 165.2, carbs_g: 210, fat_g: 70.5, steps: 9012 });
    expect(p.weight).toEqual({ date: "2026-11-12", weight_kg: 82.37 });
    expect(p.test).toBe(false);
  });

  it("treats zeros and blanks as missing, falls back to today's date", () => {
    const p = parseHealthPayload({ calories: 0, protein_g: "", weight: "" }, "2026-11-12");
    expect(p.day.date).toBe("2026-11-12");
    expect(p.day.calories).toBeNull();
    expect(p.day.protein_g).toBeNull();
    expect(p.weight).toBeNull();
  });

  it("reads the unit from a '180 lb' style string and accepts ISO datetimes", () => {
    const p = parseHealthPayload({ weight: "180 lb", weight_date: "2026-11-11T07:02:00-05:00" }, "2026-11-12");
    expect(p.weight).toEqual({ date: "2026-11-11", weight_kg: 81.65 });
  });

  it("rejects absurd weights and non-objects", () => {
    expect(() => parseHealthPayload({ weight: 5 }, "2026-11-12")).toThrow(HealthPayloadError);
    expect(() => parseHealthPayload("nope", "2026-11-12")).toThrow(HealthPayloadError);
  });
});

describe("ingestHealth", () => {
  it("stores metrics, records sync time, and notifies only on first sync / test", async () => {
    const db = await testDb();
    const calls: boolean[] = [];
    const deps = { db, ingestKey: "k", tz: "America/Toronto", onIngest: async (_: unknown, notify: boolean) => void calls.push(notify) };

    await ingestHealth(deps, { date: "2026-11-12", calories: 1000, protein_g: 80, weight: 82.4, weight_unit: "kg" });
    await ingestHealth(deps, { date: "2026-11-12", calories: 2100, protein_g: 0 }); // later in the day; protein 0 must not erase
    await ingestHealth(deps, { date: "2026-11-12", test: true });

    const [row] = await getDailyRange(db, "2026-11-12", "2026-11-12");
    expect(row).toMatchObject({ calories: 2100, protein_g: 80, weight_kg: 82.4, source: "health" });
    expect(calls).toEqual([true, false, true]);
    expect(await kvGet(db, LAST_SYNC_KEY)).not.toBeNull();
  });
});

describe("upsertDaily precedence", () => {
  it("screenshots fill gaps but never overwrite Health values", async () => {
    const db = await testDb();
    await upsertDaily(db, "2026-11-10", { calories: 2000 }, "health");
    await upsertDaily(db, "2026-11-10", { calories: 1500, protein_g: 150 }, "screenshot");
    let [row] = await getDailyRange(db, "2026-11-10", "2026-11-10");
    expect(row).toMatchObject({ calories: 2000, protein_g: 150, source: "health" });

    await upsertDaily(db, "2026-11-10", { calories: 2200 }, "health");
    [row] = await getDailyRange(db, "2026-11-10", "2026-11-10");
    expect(row!.calories).toBe(2200);
  });
});
