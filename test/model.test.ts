import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeBrief } from "../src/model.ts";
import { BriefController, operationTimeoutMs } from "../src/brief.ts";
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

test("nonterminal, deferred, truncated and tool replies fail without fetching or transport retrying", async () => {
  for (const stopReason of ["pending", "deferred", "length", "toolUse", "error", "aborted"]) {
    let calls = 0;
    const registry = { streamSimple: () => {
      calls++;
      return { result: async () => ({ content: [], stopReason, errorMessage: "Provider detail", usage: { cost: { total: 0.01 } } }) };
    } } as unknown as Registry;
    const result = await completeBrief(registry, model, "test/brief", "Evidence", "session-id", new AbortController().signal);
    assert.equal(result.error, `model stopped: ${stopReason}: Provider detail`);
    assert.equal(result.cost, 0.01);
    assert.equal(result.repairable, stopReason === "length" ? true : undefined);
    assert.equal(calls, 1);
  }
});

// A timeout is a request failure, not a validation error. No real timers or provider calls.
test("adapter enforces its own request deadline even if the provider ignores cancellation", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 30_000);
    return deadline.signal;
  });
  let calls = 0;
  let signal: AbortSignal | undefined;
  const registry = { streamSimple: (_model: unknown, _context: unknown, options: any) => {
    calls++;
    signal = options.signal;
    return { result: () => new Promise(() => {}) };
  } } as unknown as Registry;
  const request = completeBrief(registry, model, "test/brief", "Evidence", "session-id", new AbortController().signal);
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(request, /Timed out/);
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
});

test("a request timeout during repair stops the operation without a third call", async (t) => {
  const operationDeadline = new AbortController();
  const requestDeadlines: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (ms === operationTimeoutMs) return operationDeadline.signal;
    assert.equal(ms, 30_000);
    const deadline = new AbortController();
    requestDeadlines.push(deadline);
    return deadline.signal;
  });
  let calls = 0;
  let resolve!: (value: any) => void;
  const reply = (text: string, cost: number) => ({ content: [{ type: "text", text }], stopReason: "stop", usage: { cost: { total: cost } } });
  const registry = { streamSimple: () => {
    calls++;
    return { result: () => calls === 1 ? Promise.resolve(reply("bad JSON", 0.01)) : new Promise((r) => { resolve = r; }) };
  } } as unknown as Registry;
  const initial = { goal: "Accepted task", done: "—", now: "Accepted work", next: "—", blocked: "—" };
  const c = new BriefController((prompt, signal, reportCost) => completeBrief(registry, model, "test/brief", prompt, "session-id", signal, reportCost),
    () => {}, initial);
  c.add({ type: "user", text: "New work" }, true);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.equal(requestDeadlines.length, 2, "each attempt gets its own request deadline");
  requestDeadlines[1]!.abort(new DOMException("Request timed out", "TimeoutError"));
  await c.waitForIdle();
  assert.equal(c.stats.calls, 2);
  assert.equal(c.stats.pending, 1);
  assert.equal(c.stats.repairing, false);
  assert.equal(c.stats.cost, 0.01);
  assert.match(c.stats.error!, /Request timed out/);
  assert.equal(operationDeadline.signal.aborted, false);
  assert.deepEqual(c.brief, initial);
  resolve(reply(JSON.stringify(initial), 0.02)); await new Promise<void>((r) => setImmediate(r));
  assert.equal(c.stats.cost, 0.03);
  assert.equal(calls, 2);
  assert.deepEqual(c.brief, initial);
  c.close();
});

test("adapter reports late returned cost after cancellation without exposing a late reply", async () => {
  const abort = new AbortController();
  let resolve!: (value: any) => void;
  const costs: number[] = [];
  const registry = { streamSimple: () => ({ result: () => new Promise((r) => { resolve = r; }) }) } as unknown as Registry;
  const request = completeBrief(registry, model, "test/brief", "Evidence", "session-id", abort.signal, (cost) => costs.push(cost));
  abort.abort(new Error("Cancelled"));
  await assert.rejects(request, /Cancelled/);
  resolve({ content: [{ type: "text", text: "stale" }], stopReason: "stop", usage: { cost: { total: 0.01 } } });
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(costs, [0.01]);
});
