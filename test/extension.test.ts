import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "pi-brief-test-"));
process.env.HOME = home;
process.env.PI_BRIEF_MODEL = "test/brief";
after(() => rmSync(home, { recursive: true, force: true }));
const { default: extension } = await import("../src/index.ts");
const user = (text = "Fix checkout", id = "u1") => ({ id, type: "message", message: { role: "user", content: text } });
const assistant = (text = "I am investigating checkout", id = "a1") => ({ id, type: "message", message: { role: "assistant", content: text } });
const brief = { goal: "Fix checkout", done: "—", now: "Investigate checkout", next: "—", blocked: "—" };
const value = { ...brief, alignment: "aligned", evidence: { goal: ["u1"], pivot: [], drift: [] }, trace: { pivot: "", drift: "", steps: [] } };
function response(data: unknown = value, stopReason = "stop") {
  return { content: [{ type: "text", text: JSON.stringify(data) }], stopReason, usage: { cost: { total: 0.001 } }, errorMessage: "" };
}
type Widget = ((tui: unknown, theme: { fg: (color: string, value: string) => string }) => { render: (width: number) => string[] }) | undefined;
type Handler = (event: any, ctx: ExtensionContext) => void;
function harness(mode = "tui", initial: unknown[] = []) {
  const handlers = new Map<string, Handler>();
  const statuses: unknown[] = [], entries: any[] = [], notifications: string[] = [], placements: string[] = [], lookups: string[] = [];
  let branch = initial, calls = 0, widget: Widget;
  let complete = async (_model: unknown, _context: unknown, _options: unknown) => response();
  const commands = new Map<string, (args: string) => Promise<void>>();
  const ctx = {
    mode,
    ui: { setStatus: (...args: unknown[]) => statuses.push(args),
      setWidget: (_key: string, content: Widget, options?: { placement?: string }) => { widget = content; if (content) placements.push(options?.placement ?? ""); },
      notify: (text: string) => notifications.push(text) },
    modelRegistry: { find: (provider: string, model: string) => {
      lookups.push(`${provider}/${model}`);
      return ["test/brief", "test/alternate", "opencode-go/mimo-v2.6-flash"].includes(`${provider}/${model}`) ? { id: model } : undefined;
    }, complete: (...args: [unknown, unknown, unknown]) => { calls++; return complete(...args); } },
    sessionManager: { getBranch: () => branch, getSessionId: () => "session-123" },
  } as unknown as ExtensionContext;
  extension({ on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; },
    appendEntry: (_key: string, data: unknown) => entries.push(data),
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, (args) => options.handler(args, ctx)),
  } as unknown as ExtensionAPI);
  return { ctx, statuses, entries, notifications, placements, lookups,
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    command: (args = "", name = "brief") => commands.get(name)!(args),
    get calls() { return calls; }, lines: (width = 160) => widget?.({}, { fg: (_color, text) => text }).render(width) ?? [],
    setBranch: (next: unknown[]) => { branch = next; }, setComplete: (fn: typeof complete) => { complete = fn; } };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("default path uses structured private evidence and one accepted goal in widget, /brief and persistence", async () => {
  const h = harness(); let prompt = "";
  h.setComplete(async (_model, context) => { prompt = JSON.stringify(context); return response(); });
  h.emit("session_start");
  assert.match(h.lines()[0]!, /Goal: —/);
  h.emit("before_agent_start", { prompt: "Fix checkout" });
  h.emit("tool_execution_start", { toolName: "bash", args: { password: "SECRET_ARGUMENT" } });
  assert.equal(h.calls, 0);
  h.setBranch([user(), assistant(), { id: "t1", type: "message", message: { role: "toolResult", toolName: "bash", content: "SECRET_OUTPUT" } },
    { id: "a2", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET_THOUGHT" }] } }]);
  h.emit("agent_settled"); await tick();
  assert.equal(h.calls, 1);
  assert.doesNotMatch(prompt, /SECRET_/);
  assert.match(prompt, /sustained user job/);
  assert.equal(h.lines()[0], "Goal: Fix checkout · Now: Investigate checkout");
  assert.equal(h.placements.at(-1), "belowEditor");
  assert.deepEqual(h.entries[0].brief, brief);
  assert.deepEqual(h.entries[0].goalSources, ["u1"]);
  assert.equal(h.entries[0].version, 1);
  await h.command(); assert.match(h.notifications.at(-1)!, /Goal: Fix checkout/);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /1 calls.*\$0.00100.*alignment: aligned/);
  h.emit("agent_settled"); await tick(); assert.equal(h.calls, 1);
  await h.command("refresh"); assert.equal(h.calls, 1, "empty refresh does not spend");
  await h.command("off", "trace"); assert.equal(h.lines().length, 1);
  await h.command("on", "trace"); assert.ok(h.lines().length > 1);
  h.emit("session_shutdown"); assert.deepEqual(h.lines(), []);
});

test("branch switch drops the abandoned task and its late response; does not mutate the manager's branch", async () => {
  const original = [user(), assistant()];
  const h = harness("tui", original);
  let resolve!: (value: ReturnType<typeof response>) => void;
  h.setComplete(async () => new Promise((r) => { resolve = r; }));
  h.emit("session_start"); assert.equal(h.calls, 1);
  assert.equal(original[0]?.message.role, "user");
  h.setBranch([]); h.emit("session_tree");
  assert.match(h.lines()[0]!, /Goal: —/);
  resolve(response()); await tick(); assert.equal(h.entries.length, 0);
  h.emit("session_shutdown");
});

test("new user input invalidates an in-flight reply before settlement and preserves latest request tail", async () => {
  const h = harness("tui", [user(), assistant()]);
  const resolvers: Array<(reply: ReturnType<typeof response>) => void> = [];
  const prompts: string[] = [];
  h.setComplete(async (_model, context) => { prompts.push(JSON.stringify(context)); return new Promise((r) => resolvers.push(r)); });
  h.emit("session_start");
  h.emit("before_agent_start", { prompt: "New task: prepare standup" });
  h.setBranch([user(), assistant(), user("Background ".repeat(300) + "New task: prepare standup, do not deploy", "u2")]);
  h.emit("agent_settled");
  resolvers[0]!(response()); await tick();
  assert.equal(h.entries.length, 0);
  assert.equal(h.calls, 2);
  assert.match(prompts[1]!, /prepare standup, do not deploy/);
  resolvers[1]!(response({ ...value, goal: "Prepare standup without deployment", alignment: "unknown", evidence: { goal: ["u2"], pivot: ["u2"], drift: [] }, trace: { pivot: "Prepare standup", drift: "", steps: [] } }));
  await tick(); assert.equal(h.entries.length, 1);
  assert.match(h.lines()[0]!, /Goal: Prepare standup without deployment/);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /\$0.00200/);
  h.emit("session_shutdown");
});

test("invalid provenance is visible, counted and not auto-retried; explicit refresh recovers", async () => {
  const h = harness("tui", [user(), assistant()]);
  h.setComplete(async () => response({ ...value, evidence: { goal: ["foreign-branch"], pivot: [], drift: [] } }));
  h.emit("session_start"); await tick();
  assert.match(h.lines()[0]!, /update failed/);
  h.emit("agent_settled"); await tick(); assert.equal(h.calls, 1);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /goal evidence/);
  assert.equal(h.entries.length, 0);
  h.setComplete(async () => response()); await h.command("refresh");
  assert.equal(h.calls, 2); assert.match(h.lines()[0]!, /Goal: Fix checkout/);
  h.emit("session_shutdown");
});

test("empty trace clears prior drift; legacy ungrounded stored brief is not restored", async () => {
  const h = harness("tui", [user(), assistant(), { type: "custom", customType: "pi-brief", data: { brief: { ...brief, goal: "OLD WRONG GOAL" } } }]);
  h.setComplete(async () => response({ ...value, alignment: "drifting", evidence: { goal: ["u1"], pivot: [], drift: ["a1"] }, trace: { pivot: "", drift: "Unrequested deployment", steps: [] } }));
  h.emit("session_start"); assert.doesNotMatch(h.lines()[0]!, /OLD WRONG GOAL/); await tick();
  assert.match(h.lines().join("\n"), /! Unrequested deployment/);
  h.setBranch([user(), assistant(), assistant("I will fix checkout locally", "a2")]);
  h.setComplete(async () => response()); await h.command("refresh");
  assert.doesNotMatch(h.lines().join("\n"), /Unrequested deployment/);
  h.emit("session_shutdown");
});

test("validated entries restore with source anchors and no branch-array reversal", () => {
  const source = [user(), assistant(), { type: "custom", customType: "pi-brief", data: { version: 1, brief, goalSources: ["u1"], trace: [{ who: "user", kind: "task", text: brief.goal }] } }];
  const h = harness("tui", source);
  h.setComplete(async () => new Promise(() => {}));
  h.emit("session_start"); assert.match(h.lines()[0]!, /Goal: Fix checkout/);
  assert.equal(source[0], source.find((row) => "id" in row && row.id === "u1"));
  h.emit("session_shutdown");
});

test("headless modes neither call providers nor update UI", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness(mode, [user(), assistant()]); h.emit("session_start"); h.emit("before_agent_start", { prompt: "request" }); h.emit("agent_settled");
    await h.command("refresh"); assert.equal(h.calls, 0); assert.deepEqual(h.statuses, []); assert.deepEqual(h.lines(), []);
  }
});

test("default and overrides share bounded request options and session routing, with thinking disabled only for MiMo", async () => {
  for (const name of [undefined, "test/alternate"]) {
    if (name) process.env.PI_BRIEF_MODEL = name; else delete process.env.PI_BRIEF_MODEL;
    const h = harness("tui", [user(), assistant()]); let options: any;
    h.setComplete(async (_model, _context, opts) => { options = opts; return response(); });
    h.emit("session_start"); await tick();
    assert.deepEqual(h.lookups, [name ?? "opencode-go/mimo-v2.6-flash"]);
    assert.equal(options.sessionId, "session-123"); assert.equal(options.maxRetries, 0); assert.equal(options.timeoutMs, 30000);
    assert.equal(options.samplingParams?.chat_template_kwargs.enable_thinking, name ? undefined : false);
    h.emit("session_shutdown");
  }
  process.env.PI_BRIEF_MODEL = "test/brief";
});

test("config disables calls, rejects bad settings and observes the per-branch call cap", async () => {
  const directory = join(home, ".pi", "agent"); mkdirSync(directory, { recursive: true });
  const path = join(directory, "brief.json"); delete process.env.PI_BRIEF_MODEL;
  for (const [config, status] of [[{ model: null }, "off: disabled"], [{ model: "missing/model" }, "off: model not found"], [{ maxCostUsd: -1 }, "config error"]] as const) {
    writeFileSync(path, JSON.stringify(config)); const h = harness("tui", [user(), assistant()]); h.emit("session_start");
    assert.ok(h.lines()[0]!.includes(status)); assert.equal(h.calls, 0); h.emit("session_shutdown");
  }
  writeFileSync(path, JSON.stringify({ model: "test/brief", maxCalls: 1, maxCostUsd: null }));
  const h = harness("tui", [user(), assistant()]); h.emit("session_start"); await tick(); await h.command("refresh");
  assert.equal(h.calls, 1); assert.match(h.lines()[0]!, /limit reached/); h.emit("session_shutdown");
  rmSync(path); process.env.PI_BRIEF_MODEL = "test/brief";
});

test("provider stop reason and detail remain visible without retry", async () => {
  const h = harness("tui", [user(), assistant()]); h.setComplete(async () => ({ ...response(value, "error"), errorMessage: "400 MissingSessionID" }));
  h.emit("session_start"); await tick(); await h.command("status");
  assert.match(h.notifications.at(-1)!, /model stopped: error: 400 MissingSessionID/); h.emit("session_shutdown");
});
