import { describe, expect, it } from "vitest";
import { toCron } from "../src/index.js";
import { chunkMessage } from "../src/shared/telegram.js";
import { inWindow, localDate } from "../src/shared/time.js";

describe("misc", () => {
  it("toCron", () => {
    expect(toCron("08:30")).toBe("30 8 * * *");
    expect(toCron("SUN 19:00")).toBe("0 19 * * SUN");
  });
  it("chunkMessage splits long text under the Telegram limit", () => {
    const parts = chunkMessage(("para ".repeat(300) + "\n\n").repeat(10));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
  });
  it("time helpers", () => {
    expect(localDate("America/Toronto", new Date("2026-11-12T03:00:00Z"))).toBe("2026-11-11");
    expect(inWindow(30, 22 * 60, 8 * 60)).toBe(true);
    expect(inWindow(12 * 60, 22 * 60, 8 * 60)).toBe(false);
  });
});

import { poolerAlternates } from "../src/shared/db.js";
describe("poolerAlternates", () => {
  it("offers the other Supabase pooler cluster", () => {
    const u = "postgres://coach_bots_app.ref:pw@aws-0-ca-central-1.pooler.supabase.com:5432/postgres";
    expect(poolerAlternates(u)).toEqual([u, u.replace("aws-0-", "aws-1-")]);
    expect(poolerAlternates("postgres://u:p@localhost:5432/db")).toHaveLength(1);
  });
});
