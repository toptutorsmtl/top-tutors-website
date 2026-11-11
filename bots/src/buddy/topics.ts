import type { Db } from "../shared/db.js";

export type TopicStatus = "active" | "snoozed" | "dropped" | "done";
export type TopicKind = "goal" | "habit" | "commitment" | "concern";

export interface Topic {
  id: number;
  title: string;
  kind: TopicKind;
  status: TopicStatus;
  snooze_until: string | null;
  notes: string | null;
}

const SELECT = `SELECT id::int AS id, title, kind, status, to_char(snooze_until, 'YYYY-MM-DD') AS snooze_until, notes FROM topics`;

export async function listTopics(db: Db, statuses?: TopicStatus[]): Promise<Topic[]> {
  if (!statuses) return (await db.query<Topic>(`${SELECT} ORDER BY id`)).rows;
  return (await db.query<Topic>(`${SELECT} WHERE status = ANY($1) ORDER BY id`, [statuses])).rows;
}

export async function getTopic(db: Db, id: number): Promise<Topic | null> {
  return (await db.query<Topic>(`${SELECT} WHERE id = $1`, [id])).rows[0] ?? null;
}

export async function addTopic(db: Db, title: string, kind: TopicKind, notes?: string): Promise<Topic> {
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO topics (title, kind, notes) VALUES ($1, $2, $3) RETURNING id::int AS id",
    [title.trim(), kind, notes ?? null],
  );
  return (await getTopic(db, rows[0]!.id))!;
}

export async function dropTopic(db: Db, id: number): Promise<Topic | null> {
  await db.query("UPDATE topics SET status = 'dropped', dropped_at = now(), snooze_until = NULL WHERE id = $1", [id]);
  return getTopic(db, id);
}

export async function snoozeTopic(db: Db, id: number, until: string): Promise<Topic | null> {
  await db.query("UPDATE topics SET status = 'snoozed', snooze_until = $2 WHERE id = $1", [id, until]);
  return getTopic(db, id);
}

export async function completeTopic(db: Db, id: number): Promise<Topic | null> {
  await db.query("UPDATE topics SET status = 'done', snooze_until = NULL WHERE id = $1", [id]);
  return getTopic(db, id);
}

/** Only for when the user explicitly brings a topic back. */
export async function reactivateTopic(db: Db, id: number): Promise<Topic | null> {
  await db.query("UPDATE topics SET status = 'active', snooze_until = NULL, dropped_at = NULL WHERE id = $1", [id]);
  return getTopic(db, id);
}

/** Wake up snoozed topics whose date has arrived. */
export async function wakeSnoozed(db: Db, today: string): Promise<void> {
  await db.query(
    "UPDATE topics SET status = 'active', snooze_until = NULL WHERE status = 'snoozed' AND snooze_until <= $1",
    [today],
  );
}

/**
 * THE drop guarantee. Proactive messages are built only from what this returns.
 * Dropped, done, and snoozed topics are filtered out here, in code, before any prompt exists.
 */
export function topicsForProactive(all: Topic[], today: string): Topic[] {
  return all.filter((t) => t.status === "active" && (t.snooze_until === null || t.snooze_until <= today));
}
