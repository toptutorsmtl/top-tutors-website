import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Db } from "../shared/db.js";
import { kvGet, kvSet } from "../shared/db.js";
import { localDate } from "../shared/time.js";
import { upsertDaily } from "../coach/metrics.js";
import { HealthPayloadError, parseHealthPayload, type ParsedHealth } from "./parse.js";

export const LAST_SYNC_KEY = "health:last_sync_at";

export interface IngestDeps {
  db: Db;
  ingestKey: string;
  tz: string;
  /** Called after a successful ingest; `notify` is true for test pings and the very first sync. */
  onIngest?: (parsed: ParsedHealth, notify: boolean) => Promise<void>;
}

export async function ingestHealth(deps: IngestDeps, body: unknown): Promise<ParsedHealth> {
  const parsed = parseHealthPayload(body, localDate(deps.tz));
  await deps.db.query("INSERT INTO health_raw (payload) VALUES ($1)", [JSON.stringify(body)]);
  // Keep raw payloads for ~30 days, enough to debug the Shortcut.
  await deps.db.query("DELETE FROM health_raw WHERE received_at < now() - interval '30 days'");

  const { date, ...nutrition } = parsed.day;
  await upsertDaily(deps.db, date, nutrition, "health");
  if (parsed.weight) await upsertDaily(deps.db, parsed.weight.date, { weight_kg: parsed.weight.weight_kg }, "health");

  const firstEver = (await kvGet(deps.db, LAST_SYNC_KEY)) === null;
  await kvSet(deps.db, LAST_SYNC_KEY, new Date().toISOString());
  // A fresh sync re-arms the "sync looks stuck" watchdog.
  await kvSet(deps.db, "health:watchdog_warned", "0");

  await deps.onIngest?.(parsed, parsed.test || firstEver);
  return parsed;
}

function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startHealthServer(deps: IngestDeps, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });

      if (req.method === "POST" && url.pathname === "/ingest/health") {
        const key = req.headers["x-ingest-key"];
        if (!keyMatches(Array.isArray(key) ? key[0] : key, deps.ingestKey)) return send(res, 401, { error: "bad key" });
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: "body is not JSON" });
        }
        const parsed = await ingestHealth(deps, body);
        return send(res, 200, { ok: true, saved: parsed });
      }

      send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HealthPayloadError) return send(res, 400, { error: err.message });
      console.error("[health] ingest failed", err);
      send(res, 500, { error: "internal error" });
    }
  });
  server.listen(port, () => console.log(`[health] listening on :${port}`));
  return server;
}
