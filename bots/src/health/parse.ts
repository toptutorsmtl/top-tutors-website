import { ISO_DATE } from "../shared/time.js";

/**
 * Payload sent by the iPhone Shortcut (see docs/apple-health-shortcut.md).
 * Shortcuts is loose about types: numbers can arrive as numbers, as "2 150,5",
 * or as "82.4 kg", depending on locale and on how a Health sample got coerced to text.
 * Parsing is deliberately forgiving.
 */
export interface HealthDay {
  date: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  steps: number | null;
}

export interface HealthWeight {
  date: string;
  weight_kg: number;
}

export interface ParsedHealth {
  day: HealthDay;
  weight: HealthWeight | null;
  test: boolean;
}

const LB_TO_KG = 0.45359237;

/** "2 150,5 kcal" -> 2150.5, "82.4 kg" -> 82.4, 1834 -> 1834, "" -> null */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let s = v.replace(/[\s  ]/g, "");
  const m = /-?[\d.,]+/.exec(s);
  if (!m) return null;
  s = m[0];
  if (s.includes(".") && s.includes(",")) {
    // Whichever separator comes last is the decimal one.
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (s.includes(",")) {
    // "1,234" (thousands) vs "82,4" (decimal): 3 digits after a single comma = thousands.
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Pull a unit hint out of either an explicit unit field or a "82.4 lb" style string. */
function weightUnit(rawValue: unknown, rawUnit: unknown): "kg" | "lb" {
  const hay = `${typeof rawUnit === "string" ? rawUnit : ""} ${typeof rawValue === "string" ? rawValue : ""}`.toLowerCase();
  if (/\b(lb|lbs|pound|pounds|livre|livres)\b/.test(hay)) return "lb";
  return "kg";
}

function parseDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const d = v.trim().slice(0, 10);
  return ISO_DATE.test(d) ? d : null;
}

/** Zero means "nothing logged yet", not a real zero. Treat as missing so it never overwrites data. */
function positive(n: number | null): number | null {
  return n !== null && n > 0 ? n : null;
}

export class HealthPayloadError extends Error {}

export function parseHealthPayload(body: unknown, fallbackDate: string): ParsedHealth {
  if (!body || typeof body !== "object") throw new HealthPayloadError("Body must be a JSON object");
  const b = body as Record<string, unknown>;

  const date = parseDate(b.date) ?? fallbackDate;

  const day: HealthDay = {
    date,
    calories: positive(parseNumber(b.calories)),
    protein_g: positive(parseNumber(b.protein_g)),
    carbs_g: positive(parseNumber(b.carbs_g)),
    fat_g: positive(parseNumber(b.fat_g)),
    fiber_g: positive(parseNumber(b.fiber_g)),
    steps: positive(parseNumber(b.steps)),
  };

  let weight: HealthWeight | null = null;
  const w = positive(parseNumber(b.weight));
  if (w !== null) {
    const unit = weightUnit(b.weight, b.weight_unit);
    const kg = unit === "lb" ? w * LB_TO_KG : w;
    if (kg < 25 || kg > 350) throw new HealthPayloadError(`Weight ${w} ${unit} looks wrong`);
    weight = { date: parseDate(b.weight_date) ?? date, weight_kg: Math.round(kg * 100) / 100 };
  }

  return { day, weight, test: b.test === true || b.test === "true" || b.test === 1 };
}
