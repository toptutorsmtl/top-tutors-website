import type { Db } from "./db.js";

export type BotName = "coach" | "buddy";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

export async function saveMessage(db: Db, bot: BotName, role: "user" | "assistant", content: string) {
  await db.query("INSERT INTO messages (bot, role, content) VALUES ($1, $2, $3)", [bot, role, content]);
}

/**
 * Last `limit` messages, oldest first, normalised so the list starts with a user turn and
 * roles alternate (consecutive same-role messages are merged). The Messages API needs that shape.
 */
export async function recentMessages(db: Db, bot: BotName, limit = 20): Promise<StoredMessage[]> {
  const { rows } = await db.query<StoredMessage>(
    `SELECT role, content FROM (
       SELECT role, content, created_at, id FROM messages WHERE bot = $1
       ORDER BY created_at DESC, id DESC LIMIT $2
     ) t ORDER BY created_at ASC, id ASC`,
    [bot, limit],
  );
  const merged: StoredMessage[] = [];
  for (const m of rows) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  while (merged.length && merged[0]!.role !== "user") merged.shift();
  return merged;
}
