import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Isolate configuration: never read the operator's actual ~/.pi/agent/brief.json.
const home = mkdtempSync(join(tmpdir(), "pi-brief-test-"));
process.env.HOME = home;
process.env.PI_BRIEF_MODEL = "test/brief";
after(() => { rmSync(home, { recursive: true, force: true }); });
const { default: extension } = await import("../src/index.ts");
const brief = { goal: "Ship", done: "Checked", now: "Review", next: "Release", blocked: "—" };
const response = { content: [{ type: "text", text: JSON.stringify(brief) }], stopReason: "stop", usage: { cost: { total: 0.001 } } };

type Handler = (event: any, ctx: ExtensionContext) => void;
function harness(mode = "tui", initial: unknown[] = []) {
  const handlers = new Map<string, Handler>();
  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, string[] | undefined]> = [];
  const notifications: string[] = [];
  const entries: unknown[] = [];
  let branch = initial;
  let calls = 0;
  let complete = async (_model: unknown, _context: unknown, _options: unknown): Promise<typeof response> => response;
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const ctx = {
    mode,
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      setWidget: (key: string, content: string[] | undefined) => widgets.push([key, content]),
      notify: (text: string) => notifications.push(text) },
    modelRegistry: { find: (provider: string, model: string) => provider === "test" && model === "brief" ? { id: model } : undefined,
      complete: (...args: [unknown, unknown, unknown]) => { calls++; return complete(...args); } },
    sessionManager: { getBranch: () => [...branch] },
  } as unknown as ExtensionContext;
  extension({ on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; },
    appendEntry: (_key: string, data: unknown) => entries.push(data),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  return { ctx, emit, statuses, widgets, notifications, entries, command: (args: string) => command(args, ctx),
    get calls() { return calls; }, setComplete: (fn: typeof complete) => { complete = fn; }, setBranch: (next: unknown[]) => { branch = next; } };
}

test("native footer status remains set through work and idle; only metadata and visible text reach summarizer", async () => {
  const h = harness();
  let prompt = "";
  h.setComplete(async (_model, context) => { prompt = JSON.stringify(context); return response; });
  h.emit("session_start");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /Brief G: — · N: ready/);
  for (const width of [80, 120]) {
    const status = h.statuses.at(-1)!;
    const other = ["another-extension", "other status"] as const;
    const line = [status, other].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join(" ");
    assert.ok(line.slice(0, width).includes(status[1]!), `brief visible at ${width} columns`);
  }
  h.emit("before_agent_start", { prompt: "ship it" });
  assert.equal(h.calls, 1, "initial user prompt starts immediately");
  h.emit("tool_execution_start", { toolName: "bash", args: { password: "SENSITIVE_ARGUMENT" } });
  assert.match(h.statuses.at(-1)?.[1] ?? "", /N: using bash/);
  h.emit("tool_execution_end", { toolName: "bash", isError: false, result: "SENSITIVE_OUTPUT" });
  assert.equal(h.calls, 1, "tool events do not start paid calls");
  h.emit("message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "SENSITIVE_THOUGHT" }, { type: "text", text: "Checked" }] } });
  assert.equal(h.calls, 1, "intermediate assistant messages wait for settlement");
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.emit("agent_settled");
  assert.equal(h.calls, 2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.doesNotMatch(prompt, /SENSITIVE_ARGUMENT|SENSITIVE_OUTPUT|SENSITIVE_THOUGHT/);
  assert.match(prompt, /Checked/);
  assert.match(h.statuses.at(-1)?.[1] ?? "", /Brief G: Ship · N: Review/);
  assert.deepEqual(h.entries, [{ brief }]);
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /test\/brief · 2 calls · \$0\.00200/);
  await h.command("");
  assert.match(h.notifications.at(-1) ?? "", /Goal: Ship[\s\S]*Blocked: —/);
  h.emit("session_shutdown");
  assert.deepEqual(h.statuses.at(-1), [" pi-brief", undefined]);
});

test("a background summary finishing during work does not overwrite the live working indicator", async () => {
  const h = harness();
  let resolve!: (value: typeof response) => void;
  h.setComplete(async () => new Promise((r) => { resolve = r; }));
  h.emit("session_start");
  h.emit("before_agent_start", { prompt: "work" });
  assert.equal(h.calls, 1);
  h.emit("tool_execution_start", { toolName: "bash" });
  resolve(response);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: Ship · N: using bash/);
  h.emit("agent_settled");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: Ship · N: Review/);
  h.emit("session_shutdown");
});

test("startup summarizes recent visible text and shows the same line above the editor", async () => {
  const h = harness("tui", [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Ship the footer" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Footer is visible" }, { type: "thinking", thinking: "SECRET_THOUGHT" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "SECRET_TOOL" }] } },
  ]);
  let prompt = "";
  h.setComplete(async (_model, context) => { prompt = JSON.stringify(context); return response; });
  h.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.calls, 1);
  assert.match(prompt, /Ship the footer/);
  assert.match(prompt, /Footer is visible/);
  assert.doesNotMatch(prompt, /SECRET_THOUGHT|SECRET_TOOL/);
  assert.deepEqual(h.widgets.at(-1)?.[1], [h.statuses.at(-1)?.[1]]);
  h.emit("session_shutdown");
  assert.deepEqual(h.widgets.at(-1), ["pi-brief", undefined]);
});

test("forwards the Pi session id on every summary request", async () => {
  const h = harness();
  (h.ctx.sessionManager as { getSessionId?: () => string }).getSessionId = () => "session-123";
  let sessionId = "";
  h.setComplete(async (_model, _context, options) => {
    sessionId = (options as { sessionId?: string }).sessionId ?? "";
    return response;
  });
  h.emit("session_start");
  h.emit("before_agent_start", { prompt: "ship it" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessionId, "session-123");
  h.emit("session_shutdown");
});

test("shows the provider error instead of only the stop reason", async () => {
  const h = harness();
  h.setComplete(async () => ({ ...response, stopReason: "error", errorMessage: "400 MissingSessionID" }));
  h.emit("session_start");
  h.emit("before_agent_start", { prompt: "work" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /last error: model stopped: error: 400 MissingSessionID/);
  h.emit("session_shutdown");
});

test("failed summary stays visible in the native footer after agent settles", async () => {
  const h = harness();
  let attempts = 0;
  h.setComplete(async () => { attempts++; return { ...response, stopReason: "error" }; });
  h.emit("session_start");
  h.emit("before_agent_start", { prompt: "work" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.emit("agent_settled");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /Brief G: — · N: update failed/);
  h.emit("agent_settled");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /N: update failed/);
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /last error: model stopped: error/);
  assert.equal(attempts, 1);
  h.emit("session_shutdown");
});

test("restores active branch, discards in-flight replies from abandoned branches", async () => {
  const h = harness("tui", [{ type: "custom", customType: "pi-brief", data: { brief } }]);
  let resolve!: (value: typeof response) => void;
  h.setComplete(async () => new Promise((r) => { resolve = r; }));
  h.emit("session_start");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: Ship/);
  h.emit("before_agent_start", { prompt: "old branch" });
  h.setBranch([]);
  h.emit("session_tree");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: —/);
  resolve(response);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.entries.length, 0);
  h.emit("session_shutdown");
});

test("no hidden completion or footer in headless modes", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness(mode);
    h.emit("session_start");
    h.emit("before_agent_start", { prompt: "request" });
    h.emit("agent_settled");
    await h.command("refresh");
    assert.equal(h.calls, 0);
    assert.deepEqual(h.statuses, []);
  }
});

test("configuration accepts nullable USD limit and rejects invalid limits without provider calls", async () => {
  const directory = join(home, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: "test/brief", maxCostUsd: null, maxCalls: 2 }));
  const h = harness();
  h.emit("session_start");
  h.emit("before_agent_start", { prompt: "first" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.emit("before_agent_start", { prompt: "second" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.emit("before_agent_start", { prompt: "third" });
  assert.equal(h.calls, 2);
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /\$0\.00200.*limit reached/);
  h.emit("session_shutdown");
  rmSync(join(directory, "brief.json"));
});

test("configuration errors and missing models report a persistent off footer without calling the provider", () => {
  delete process.env.PI_BRIEF_MODEL;
  const h = harness();
  h.emit("session_start");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /off: configure model/);
  h.emit("session_shutdown");
  const directory = join(home, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: "missing/model", maxCostUsd: -1 }));
  const invalid = harness();
  invalid.emit("session_start");
  assert.match(invalid.statuses.at(-1)?.[1] ?? "", /config error/);
  assert.equal(invalid.calls, 0);
  rmSync(join(directory, "brief.json"));
  process.env.PI_BRIEF_MODEL = "test/brief";
});
