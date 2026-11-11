import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { StoredMessage } from "./history.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

export type Effort = "low" | "medium" | "high";

export interface AgentRequest {
  model: string;
  system: string;
  history: StoredMessage[];
  /** New user turn: plain text, or content blocks (e.g. a screenshot + caption). */
  input: string | BetaContentBlockParam[];
  tools: BetaRunnableTool<any>[];
  effort?: Effort;
  maxIterations?: number;
}

/**
 * Runs one conversational turn with tools and returns the final text reply.
 *
 * - The SDK tool runner drives the tool loop (tool_use -> run() -> tool_result -> ...).
 * - Server-side refusal fallbacks are enabled (fallbacks: "default"), so a safety-classifier
 *   decline is retried on a fallback model inside the same call instead of failing.
 * - History is stored as plain text between Telegram turns; thinking blocks are only replayed
 *   inside a single turn's tool loop, which the runner handles.
 */
export async function runAgent(req: AgentRequest): Promise<string> {
  const messages: BetaMessageParam[] = [
    ...req.history.map((m) => ({ role: m.role, content: m.content }) as BetaMessageParam),
    { role: "user", content: req.input },
  ];
  // The API needs alternating roles; if history ended with a user turn, merge into it.
  const fixed = mergeConsecutiveUsers(messages);

  const runner = getClient().beta.messages.toolRunner({
    model: req.model,
    max_tokens: 16000,
    system: req.system,
    messages: fixed,
    tools: req.tools,
    output_config: { effort: req.effort ?? "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    max_iterations: req.maxIterations ?? 8,
  });
  const final: BetaMessage = await runner.runUntilDone();
  return extractText(final);
}

export function extractText(msg: BetaMessage): string {
  if (msg.stop_reason === "refusal") {
    return "Sorry, I can't help with that one.";
  }
  const text = msg.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text && msg.stop_reason === "max_tokens") return "(That got cut off. Ask me again, more narrowly?)";
  return text;
}

function mergeConsecutiveUsers(messages: BetaMessageParam[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

function toBlocks(c: BetaMessageParam["content"]): BetaContentBlockParam[] {
  return typeof c === "string" ? [{ type: "text", text: c }] : (c as BetaContentBlockParam[]);
}
