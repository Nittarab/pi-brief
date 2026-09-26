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
  const widgets: Array<[string, Widget]> = [];
  const notifications: string[] = [];
  const entries: unknown[] = [];
  let branch = initial;
  let calls = 0;
  const modelLookups: string[] = [];
  let complete = async (_model: unknown, _context: unknown, _options: unknown): Promise<typeof response> => response;
  const commands = new Map<string, (args: string) => Promise<void>>();
  const ctx = {
    mode,
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
      setWidget: (key: string, content: Widget) => widgets.push([key, content]),
      notify: (text: string) => notifications.push(text) },
    modelRegistry: { find: (provider: string, model: string) => {
      modelLookups.push(`${provider}/${model}`);
      return ["test/brief", "test/alternate", "opencode-go/mimo-v2.6-flash"].includes(`${provider}/${model}`) ? { id: model } : undefined;
    }, complete: (...args: [unknown, unknown, unknown]) => { calls++; return complete(...args); } },
    sessionManager: { getBranch: () => [...branch] },
  } as unknown as ExtensionContext;
  extension({ on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; },
    appendEntry: (_key: string, data: unknown) => entries.push(data),
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commands.set(name, (args: string) => options.handler(args, ctx));
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  return { ctx, emit, statuses, widgets, notifications, entries, modelLookups, command: (args: string, name = "brief") => {
    const run = commands.get(name);
    if (!run) throw new Error(`missing command ${name}`);
    return run(args);
  },
    get calls() { return calls; }, setComplete: (fn: typeof complete) => { complete = fn; }, setBranch: (next: unknown[]) => { branch = next; } };
}

type Widget = string[] | ((tui: unknown, theme: { fg: (color: string, value: string) => string }) => { render: (width: number) => string[] }) | undefined;

function shown(widgets: Array<[string, Widget]>, width = 160): string {
  const content = widgets.at(-1)?.[1];
  if (Array.isArray(content)) return content[0] ?? "";
  if (typeof content === "function") return content({}, { fg: (_color, value) => value }).render(width)[0] ?? "";
  return "";
}

test("brief stays above the editor through work and idle; only metadata and visible text reach summarizer", async () => {
  const h = harness();
  let prompt = "";
  h.setComplete(async (_model, context) => { prompt = JSON.stringify(context); return response; });
  h.emit("session_start");
  assert.match(shown(h.widgets), /Goal: — · Now: —/);
  assert.equal(h.statuses.at(-1)?.[1], undefined, "footer does not repeat the brief");
  h.emit("before_agent_start", { prompt: "ship it" });
  h.emit("tool_execution_start", { toolName: "bash", args: { password: "SENSITIVE_ARGUMENT" } });
  h.emit("tool_execution_end", { toolName: "bash", isError: false, result: "SENSITIVE_OUTPUT" });
  h.emit("message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "SENSITIVE_THOUGHT" }, { type: "text", text: "Checked" }] } });
  assert.equal(h.calls, 0, "tool events and the prompt do not start paid calls");
  assert.match(shown(h.widgets), /Goal: ship it/);
  assert.equal(h.statuses.at(-1)?.[1], undefined);
  h.setBranch([
    { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "ship it" }] } },
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "SENSITIVE_THOUGHT" }, { type: "text", text: "Checked" }, { type: "toolCall", name: "bash", arguments: { password: "SENSITIVE_ARGUMENT" } }] } },
    { id: "t1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "SENSITIVE_OUTPUT" }] } },
  ]);
  h.emit("agent_settled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.calls, 1);
  assert.doesNotMatch(prompt, /SENSITIVE_ARGUMENT|SENSITIVE_OUTPUT|SENSITIVE_THOUGHT/);
  assert.match(prompt, /Checked/);
  assert.match(prompt, /Keep goal unchanged/);
  assert.match(shown(h.widgets), /Goal: ship it · Now: Review/);
  assert.equal(h.statuses.at(-1)?.[1], undefined);
  assert.deepEqual(h.entries, [{ brief, trace: [] }]);
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /test\/brief · 1 calls · \$0\.00100/);
  await h.command("");
  assert.match(h.notifications.at(-1) ?? "", /Goal: Ship[\s\S]*Blocked: —/);
  h.emit("session_shutdown");
  assert.deepEqual(h.statuses.at(-1), [" pi-brief", undefined]);
  assert.deepEqual(h.widgets.at(-1), ["pi-brief", undefined]);
});

test("widget shows the full task when the row is wide", () => {
  const goal = "Fix pi-bref TUI so the brief bar shows only once";
  const h = harness("tui", [
    { type: "custom", customType: "pi-brief", data: { brief: { ...brief, goal, now: "Judge the screenshot" } } },
  ]);
  h.emit("session_start");
  assert.match(shown(h.widgets, 140), /brief bar shows only once/);
  assert.ok(shown(h.widgets, 36).length <= 36);
  assert.equal(h.statuses.at(-1)?.[1], undefined);
  h.emit("session_shutdown");
});

test("tool activity does not replace the stable Goal and Now line", async () => {
  const h = harness("tui", [
    { id: "u1", type: "message", message: { role: "user", content: "Ship" } },
    { type: "custom", customType: "pi-brief", data: { brief } },
  ]);
  h.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.emit("tool_execution_start", { toolName: "bash" });
  assert.match(shown(h.widgets), /Goal: Ship · Now: Review/);
  assert.equal(h.statuses.at(-1)?.[1], undefined);
  assert.equal(h.calls, 1, "startup reads the current trace once");
  h.emit("agent_settled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.calls, 1, "the same trace does not start another call");
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
  assert.match(shown(h.widgets), /Goal: Ship the footer · Now: Review/);
  assert.equal(h.statuses.at(-1)?.[1], undefined);
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
  h.setBranch([{ type: "message", message: { role: "user", content: "ship it" } }]);
  h.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessionId, "session-123");
  h.emit("session_shutdown");
});

test("shows the provider error instead of only the stop reason", async () => {
  const h = harness();
  h.setComplete(async () => ({ ...response, stopReason: "error", errorMessage: "400 MissingSessionID" }));
  h.setBranch([{ type: "message", message: { role: "user", content: "work" } }]);
  h.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /last error: model stopped: error: 400 MissingSessionID/);
  h.emit("session_shutdown");
});

test("failed summary stays visible above the editor after agent settles", async () => {
  const h = harness();
  let attempts = 0;
  h.setComplete(async () => { attempts++; return { ...response, stopReason: "error" }; });
  h.setBranch([{ type: "message", message: { role: "user", content: "work" } }]);
  h.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  h.emit("agent_settled");
  assert.match(shown(h.widgets), /Brief · update failed/);
  assert.equal(h.statuses.at(-1)?.[1], undefined);
  h.emit("agent_settled");
  assert.match(shown(h.widgets), /update failed/);
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /last error: model stopped: error/);
  assert.equal(attempts, 1);
  h.emit("session_shutdown");
});

test("restores active branch, discards in-flight replies from abandoned branches", async () => {
  const h = harness("tui", [
    { id: "u1", type: "message", message: { role: "user", content: "old branch" } },
    { type: "custom", customType: "pi-brief", data: { brief } },
  ]);
  let resolve!: (value: typeof response) => void;
  h.setComplete(async () => new Promise((r) => { resolve = r; }));
  h.emit("session_start");
  assert.match(shown(h.widgets), /Goal: old branch/);
  assert.equal(h.calls, 1);
  h.setBranch([]);
  h.emit("session_tree");
  assert.match(shown(h.widgets), /Goal: old branch/);
  assert.match(shown(h.widgets), /left path/);
  assert.equal(h.statuses.at(-1)?.[1], undefined);
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
    assert.deepEqual(h.widgets, []);
  }
});

test("configuration accepts nullable USD limit and rejects invalid limits without provider calls", async () => {
  const directory = join(home, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: "test/brief", maxCostUsd: null, maxCalls: 2 }));
  const h = harness();
  h.emit("session_start");
  for (const prompt of ["first", "second", "third"]) {
    h.setBranch([{ type: "message", message: { role: "user", content: prompt } }]);
    h.emit("agent_settled");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(h.calls, 2);
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /\$0\.00200.*limit reached/);
  h.emit("session_shutdown");
  rmSync(join(directory, "brief.json"));
});

test("the built-in default runs without a config file and file/env overrides win", async () => {
  const directory = join(home, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  delete process.env.PI_BRIEF_MODEL;
  const initial = [{ type: "message", message: { role: "user", content: "Ship it" } }];
  const defaults = harness("tui", initial);
  defaults.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(defaults.modelLookups, ["opencode-go/mimo-v2.6-flash"]);
  assert.equal(defaults.calls, 1);
  defaults.emit("session_shutdown");

  writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: "test/alternate" }));
  const file = harness();
  file.emit("session_start");
  assert.deepEqual(file.modelLookups, ["test/alternate"]);
  file.emit("session_shutdown");

  process.env.PI_BRIEF_MODEL = "test/brief";
  const env = harness();
  env.emit("session_start");
  assert.deepEqual(env.modelLookups, ["test/brief"]);
  env.emit("session_shutdown");
  rmSync(join(directory, "brief.json"));
});

test("users can disable the default; invalid config and missing models make no provider calls", () => {
  const directory = join(home, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  delete process.env.PI_BRIEF_MODEL;
  writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: null }));
  const disabled = harness();
  disabled.emit("session_start");
  assert.match(shown(disabled.widgets), /off: disabled/);
  assert.deepEqual(disabled.modelLookups, []);
  assert.equal(disabled.calls, 0);
  disabled.emit("session_shutdown");

  writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: "missing/model", maxCostUsd: -1 }));
  const invalid = harness();
  invalid.emit("session_start");
  assert.match(shown(invalid.widgets), /config error/);
  assert.equal(invalid.calls, 0);
  invalid.emit("session_shutdown");

  writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: "missing/model" }));
  const missing = harness();
  missing.emit("session_start");
  assert.match(shown(missing.widgets), /off: model not found/);
  assert.deepEqual(missing.modelLookups, ["missing/model"]);
  assert.equal(missing.calls, 0);
  missing.emit("session_shutdown");
  rmSync(join(directory, "brief.json"));
  process.env.PI_BRIEF_MODEL = "test/brief";
});
