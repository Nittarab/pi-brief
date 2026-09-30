import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeBrief } from "../src/model.ts";
import { briefSystemPrompt } from "../src/judgment.ts";

type Registry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ReturnType<Registry["find"]>>;
const model = { id: "brief" } as Model;

test("adapter uses provider-neutral streaming, transcript system messages and bounded options", async () => {
  const abort = new AbortController();
  const registry = { streamSimple: (_model: unknown, context: any, options: any) => {
    assert.deepEqual(context.messages.map((message: any) => message.role), ["system", "user"]);
    assert.equal(context.messages[0].content, briefSystemPrompt);
    assert.equal(context.messages[1].content, "Evidence");
    assert.equal(context.systemPrompt, undefined);
    assert.equal(options.maxTokens, 700);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeoutMs, 30_000);
    assert.equal(options.cacheRetention, "none");
    assert.equal(options.toolChoice, "none");
    assert.equal(options.reasoning, undefined);
    assert.equal(options.sessionId, "session-id");
    assert.ok(options.signal instanceof AbortSignal);
    return { result: async () => ({
      content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "one" }, { type: "text", text: "two" }],
      stopReason: "stop", usage: { cost: { total: 0.001 } },
    }) };
  } } as unknown as Registry;
  assert.deepEqual(await completeBrief(registry, model, "test/brief", "Evidence", "session-id", abort.signal), {
    text: "onetwo", cost: 0.001, error: undefined,
  });
});

test("cancellation finishes even if a custom provider ignores the abort signal", async () => {
  const abort = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const registry = { streamSimple: (_model: unknown, _context: unknown, options: any) => {
    requestSignal = options.signal;
    return { result: () => new Promise(() => {}) };
  } } as unknown as Registry;
  const request = completeBrief(registry, model, "test/brief", "Evidence", "session-id", abort.signal);
  abort.abort(new Error("Session closed"));
  await assert.rejects(request, /Session closed/);
  assert.equal(requestSignal?.aborted, true);
});

test("an already-aborted request never enters the provider", async () => {
  const registry = { streamSimple: () => { assert.fail("provider must not be called"); } } as unknown as Registry;
  await assert.rejects(completeBrief(registry, model, "test/brief", "Evidence", "session-id", AbortSignal.abort(new Error("Cancelled"))), /Cancelled/);
});

test("nonterminal, deferred, truncated and tool replies fail without fetching or retrying", async () => {
  for (const stopReason of ["pending", "deferred", "length", "toolUse", "error", "aborted"]) {
    let calls = 0;
    const registry = { streamSimple: () => {
      calls++;
      return { result: async () => ({ content: [], stopReason, errorMessage: "Provider detail", usage: { cost: { total: 0.01 } } }) };
    } } as unknown as Registry;
    const result = await completeBrief(registry, model, "test/brief", "Evidence", "session-id", new AbortController().signal);
    assert.equal(result.error, `model stopped: ${stopReason}: Provider detail`);
    assert.equal(result.cost, 0.01);
    assert.equal(calls, 1);
  }
});
