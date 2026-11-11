import type { Bot, Context } from "grammy";

/** Only let ALLOWED_USER_ID through. If unset, log whoever writes so the owner can copy their id. */
export function ownerOnly(botLabel: string, allowedUserId: number | null) {
  return async (ctx: Context, next: () => Promise<void>) => {
    const uid = ctx.from?.id;
    if (allowedUserId === null) {
      console.log(`[${botLabel}] Message from user id ${uid}. Set ALLOWED_USER_ID=${uid} and restart.`);
      if (ctx.chat?.type === "private") {
        await ctx.reply(`Setup: your Telegram user id is ${uid}. Put it in ALLOWED_USER_ID and restart me.`);
      }
      return;
    }
    if (uid !== allowedUserId) return; // silently ignore strangers
    await next();
  };
}

/** Telegram caps messages at 4096 chars. Split on paragraph boundaries where possible. */
export function chunkMessage(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendLong(bot: Bot, chatId: number, text: string) {
  for (const part of chunkMessage(text)) await bot.api.sendMessage(chatId, part);
}

export async function replyLong(ctx: Context, text: string) {
  for (const part of chunkMessage(text)) await ctx.reply(part);
}

/** Download a Telegram file and return it base64-encoded with a best-guess media type. */
export async function downloadFile(
  bot: Bot,
  token: string,
  fileId: string,
): Promise<{ data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" }> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram returned no file_path");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`File download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const p = file.file_path.toLowerCase();
  const mediaType = p.endsWith(".png")
    ? "image/png"
    : p.endsWith(".webp")
      ? "image/webp"
      : p.endsWith(".gif")
        ? "image/gif"
        : "image/jpeg";
  return { data: buf.toString("base64"), mediaType };
}

/** Keep the "typing…" indicator alive while a slow call runs. */
export async function withTyping<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const send = () => ctx.replyWithChatAction("typing").catch(() => {});
  await send();
  const timer = setInterval(send, 4500);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
