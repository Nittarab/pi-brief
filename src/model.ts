// Adapter: one request contract shared by the extension and live evaluation. No retries.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanText } from "./evidence.ts";
import { briefSystemPrompt } from "./judgment.ts";
import type { SummaryResult } from "./brief.ts";

export const defaultModel = "opencode-go/mimo-v2.6-flash";
type Registry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ReturnType<Registry["find"]>>;

export async function completeBrief(registry: Registry, model: Model, name: string, prompt: string, sessionId: string, signal: AbortSignal): Promise<SummaryResult> {
  const reply = await registry.complete(model, {
    systemPrompt: briefSystemPrompt,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, {
    signal, timeoutMs: 30_000, maxRetries: 0, maxTokens: 700, cacheRetention: "none",
    ...(name === defaultModel ? { samplingParams: { chat_template_kwargs: { enable_thinking: false } } } : {}),
    sessionId,
  });
  const detail = cleanText(reply.errorMessage ?? "", 90);
  return {
    text: reply.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
    cost: reply.usage.cost.total,
    error: reply.stopReason === "stop" ? undefined : `model stopped: ${reply.stopReason}${detail ? `: ${detail}` : ""}`,
  };
}
