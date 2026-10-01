import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { diagnosticDirectory, fingerprint } from "../src/diagnostics.ts";
import { diagnosticReport, readDiagnostics } from "../src/diagnostic-report.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "pi-brief-test-"));
process.env.HOME = home;
process.env.PI_BRIEF_MODEL = "test/brief";
after(() => rmSync(home, { recursive: true, force: true }));
delete process.env.PI_CODING_AGENT_DIR;
const { default: extension, configured, diagnosticsRequested } = await import("../src/index.ts");
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
  let waitForIdle = async () => {};
  let complete = async (_model: unknown, _context: unknown, _options: unknown) => response();
  const commands = new Map<string, (args: string) => Promise<void>>();
  const ctx = {
    mode,
    waitForIdle: () => waitForIdle(),
    ui: { setStatus: (...args: unknown[]) => statuses.push(args),
      setWidget: (_key: string, content: Widget, options?: { placement?: string }) => { widget = content; if (content) placements.push(options?.placement ?? ""); },
      notify: (text: string) => notifications.push(text) },
    modelRegistry: { find: (provider: string, model: string) => {
      lookups.push(`${provider}/${model}`);
      return ["test/brief", "test/alternate", "test/vendor/brief", "opencode-go/mimo-v2.6-flash"].includes(`${provider}/${model}`) ? { id: model } : undefined;
    }, streamSimple: (...args: [unknown, unknown, unknown]) => { calls++; return { result: () => complete(...args) }; } },
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
    setBranch: (next: unknown[]) => { branch = next; }, setComplete: (fn: typeof complete) => { complete = fn; },
    setWaitForIdle: (fn: typeof waitForIdle) => { waitForIdle = fn; } };
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

test("a user-only branch saves the cited goal without claiming alignment", async () => {
  const h = harness("tui", [user("Diagnose the brief failure")]);
  h.setComplete(async () => response({ ...value, goal: "Diagnose the brief failure", now: "Inspect the failure", alignment: "unknown" }));
  h.emit("session_start"); await tick();
  assert.equal(h.calls, 1);
  assert.equal(h.entries[0].brief.goal, "Diagnose the brief failure");
  assert.equal(h.entries[0].alignment, "unknown");
  assert.match(h.lines()[0]!, /Goal: Diagnose the brief failure/);
  await h.command("status"); assert.doesNotMatch(h.notifications.at(-1)!, /last error:/);
  h.emit("session_shutdown");
});

test("an unsummarized goal exhausts repair visibly and is never saved as a joined sentence", async () => {
  const h = harness("tui", [user("Fix checkout but do not deploy"), assistant()]);
  h.setComplete(async () => response({ ...value, goal: `Fix checkout ${"using local invoice fixtures ".repeat(8)}but do not deploy` }));
  h.emit("session_start"); await tick();
  assert.equal(h.calls, 3);
  assert.equal(h.entries.length, 0);
  assert.match(h.lines()[0]!, /update failed/);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /goal must be a short TL;DR/);
  h.emit("session_shutdown");
});

test("invalid provenance exhausts repair, retains input without more calls; explicit refresh recovers", async () => {
  const h = harness("tui", [user(), assistant()]);
  h.setComplete(async () => response({ ...value, evidence: { goal: ["foreign-branch"], pivot: [], drift: [] } }));
  h.emit("session_start"); await tick();
  assert.match(h.lines()[0]!, /update failed/);
  h.emit("agent_settled"); await tick(); assert.equal(h.calls, 3);
  await h.command("status");
  assert.match(h.notifications.at(-1)!, /3 calls.*\$0.00300.*1 pending.*failed input retained.*invalid brief after 3 calls.*goal evidence/);
  assert.equal(h.entries.length, 0);
  h.setComplete(async () => response()); await h.command("refresh");
  assert.equal(h.calls, 4); assert.match(h.lines()[0]!, /Goal: Fix checkout/);
  h.emit("session_shutdown");
});

test("active repair keeps the accepted widget and status distinct from retained failed input", async () => {
  const h = harness("tui", [user(), assistant()]);
  h.emit("session_start"); await tick();
  assert.equal(h.entries.length, 1);
  h.setBranch([user(), assistant(), assistant("Checking totals", "a2")]);
  let resolve!: (reply: ReturnType<typeof response>) => void;
  const prompts: string[] = [], options: any[] = [];
  h.setComplete(async (_model, context, opts) => {
    prompts.push((context as any).messages[1].content);
    options.push(opts);
    if (prompts.length === 1) return response({ ...value, now: "Investigating locally ".repeat(12) });
    return new Promise((r) => { resolve = r; });
  });
  const refreshing = h.command("refresh"); await tick();
  assert.equal(h.calls, 3, "one accepted call plus initial rejection and active repair");
  assert.equal(h.entries.length, 1, "rejected output is not persisted");
  assert.equal(h.lines()[0], "Goal: Fix checkout · Now: Investigate checkout");
  await h.command("status");
  assert.match(h.notifications.at(-1)!, /3 calls.*\$0.00200.*0 pending.*repairing \(call 2\/3\)/);
  assert.doesNotMatch(h.notifications.at(-1)!, /failed input retained|last error/);
  assert.ok(prompts[1]!.startsWith(prompts[0]!));
  assert.match(prompts[1]!, /brief now must be a short TL;DR/);
  for (const opts of options) {
    assert.equal(opts.timeoutMs, 30_000);
    assert.equal(opts.maxRetries, 0);
    assert.equal(opts.maxTokens, 700);
    assert.equal(opts.sessionId, "session-123");
  }
  resolve(response({ ...value, now: "Check invoice totals" })); await refreshing;
  assert.equal(h.calls, 3);
  assert.equal(h.entries.length, 2);
  assert.match(h.lines()[0]!, /Now: Check invoice totals/);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /\$0.00300.*idle/);
  h.emit("session_shutdown");
});

test("reload, navigation and shutdown cancel active repairs without applying late results", async () => {
  for (const event of ["session_start", "session_before_tree", "session_before_switch", "session_before_fork", "session_tree", "session_shutdown"]) {
    const h = harness("tui", [user(), assistant()]);
    let resolve!: (reply: ReturnType<typeof response>) => void;
    let repairSignal: AbortSignal | undefined;
    h.setComplete(async (_model, _context, options) => {
      if (h.calls === 1) return response({ ...value, evidence: { goal: ["missing"], pivot: [], drift: [] } });
      repairSignal = (options as any).signal;
      return new Promise((r) => { resolve = r; });
    });
    h.emit("session_start"); await tick();
    assert.equal(h.calls, 2);
    h.setBranch([]); h.emit(event);
    assert.equal(repairSignal?.aborted, true);
    resolve(response()); await tick();
    assert.equal(h.calls, 2);
    assert.equal(h.entries.length, 0);
    assert.doesNotMatch(h.lines().join("\n"), /Fix checkout/);
    h.emit("session_shutdown");
  }
});

test("adapter token-limit output receives complete-object repair while retaining its cost", async () => {
  const h = harness("tui", [user(), assistant()]);
  const prompts: string[] = [];
  h.setComplete(async (_model, context) => {
    prompts.push((context as any).messages[1].content);
    return response(value, prompts.length === 1 ? "length" : "stop");
  });
  h.emit("session_start"); await tick();
  assert.equal(h.calls, 2);
  assert.equal(h.entries.length, 1);
  assert.match(prompts[1]!, /model stopped: length/);
  assert.match(prompts[1]!, /corrected, complete JSON object/);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /2 calls.*\$0.00200.*idle/);
  h.emit("session_shutdown");
});

test("thrown authentication failure is visible and does not attempt output repair", async () => {
  const h = harness("tui", [user(), assistant()]);
  h.setComplete(async () => { throw new Error("401 Missing API key"); });
  h.emit("session_start"); await tick();
  assert.equal(h.calls, 1);
  assert.equal(h.entries.length, 0);
  await h.command("status");
  assert.match(h.notifications.at(-1)!, /failed input retained.*401 Missing API key/);
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

test("restored drift alignment agrees with its warning before and after a startup failure", async () => {
  const source = [user(), assistant(), { type: "custom", customType: "pi-brief", data: {
    version: 1, brief, goalSources: ["u1"], alignment: "drifting", trace: [
      { who: "user", kind: "task", text: brief.goal }, { who: "agent", kind: "drift", text: "Forbidden deployment" },
    ],
  } }];
  const h = harness("tui", source);
  let resolve!: (value: ReturnType<typeof response>) => void;
  h.setComplete(async () => new Promise((r) => { resolve = r; }));
  h.emit("session_start");
  assert.match(h.lines().join("\n"), /! Forbidden deployment/);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /alignment: drifting/);
  resolve(response(value, "error")); await tick();
  assert.match(h.lines().join("\n"), /! Forbidden deployment/);
  await h.command("status"); assert.match(h.notifications.at(-1)!, /alignment: drifting.*last error/);
  h.emit("session_shutdown");
});

test("headless modes neither call providers nor update UI", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const h = harness(mode, [user(), assistant()]); h.emit("session_start"); h.emit("before_agent_start", { prompt: "request" }); h.emit("agent_settled");
    await h.command("refresh"); await h.command("status"); await h.command("on", "trace");
    assert.equal(h.calls, 0); assert.deepEqual(h.statuses, []); assert.deepEqual(h.lines(), []); assert.deepEqual(h.notifications, []);
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

test("config disables calls and rejects invalid model settings", async () => {
  const directory = join(home, ".pi", "agent"); mkdirSync(directory, { recursive: true });
  const path = join(directory, "brief.json"); delete process.env.PI_BRIEF_MODEL;
  try {
    for (const [config, status] of [[{ model: null }, "off: disabled"], [{ model: "missing/model" }, "off: model not found"], [{ model: "invalid" }, "config error"], [[], "config error"]] as const) {
      writeFileSync(path, JSON.stringify(config)); const h = harness("tui", [user(), assistant()]); h.emit("session_start");
      assert.ok(h.lines()[0]!.includes(status)); assert.equal(h.calls, 0); h.emit("session_shutdown");
    }
  } finally { rmSync(path); process.env.PI_BRIEF_MODEL = "test/brief"; }
});

test("legacy spending-limit settings are ignored while usage reporting and deduplication remain", async () => {
  const directory = join(home, ".pi", "agent"); mkdirSync(directory, { recursive: true });
  const path = join(directory, "brief.json"); delete process.env.PI_BRIEF_MODEL;
  const h = harness("tui", [user(), assistant()]);
  try {
    writeFileSync(path, JSON.stringify({ model: "test/brief", maxCalls: 1, maxCostUsd: 0.0005 }));
    assert.deepEqual(configured(), { model: "test/brief" });
    h.emit("session_start"); await tick(); await h.command("refresh");
    assert.equal(h.calls, 1, "unchanged evidence still does not make another request");
    h.setBranch([user(), assistant(), assistant("I am checking checkout totals", "a2")]);
    await h.command("refresh");
    assert.equal(h.calls, 2, "new evidence updates regardless of old call/cost settings");
    assert.match(h.lines()[0]!, /Goal: Fix checkout/);
    await h.command("status");
    assert.match(h.notifications.at(-1)!, /2 calls.*\$0.00200/);
    assert.doesNotMatch(h.notifications.at(-1)!, /limit reached/);
    writeFileSync(path, JSON.stringify({ model: "test/brief", maxCalls: "removed", maxCostUsd: -1 }));
    assert.deepEqual(configured(), { model: "test/brief" });
  } finally { h.emit("session_shutdown"); rmSync(path); process.env.PI_BRIEF_MODEL = "test/brief"; }
});

test("slash-containing model IDs use the exact registry ID", async () => {
  process.env.PI_BRIEF_MODEL = "test/vendor/brief";
  try {
    const h = harness("tui", [user(), assistant()]);
    h.emit("session_start"); await tick();
    assert.deepEqual(h.lookups, ["test/vendor/brief"]);
    assert.equal(h.calls, 1);
    assert.match(h.lines()[0]!, /Goal: Fix checkout/);
    h.emit("session_shutdown");
  } finally { process.env.PI_BRIEF_MODEL = "test/brief"; }
});

test("brief.json follows Pi's agent-directory override and errors report the actual path", async () => {
  const directory = join(home, "custom-agent"); mkdirSync(directory, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = directory;
  delete process.env.PI_BRIEF_MODEL;
  try {
    writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: null }));
    assert.equal(configured(), undefined);
    const h = harness("tui", [user(), assistant()]); h.emit("session_start");
    assert.equal(h.calls, 0);
    await h.command("status");
    assert.ok(h.notifications.at(-1)!.includes(join(directory, "brief.json")));
    assert.match(h.notifications.at(-1)!, /off: disabled/);
    h.emit("session_shutdown");
    writeFileSync(join(directory, "brief.json"), JSON.stringify({ model: "test/vendor/brief" }));
    assert.equal(configured()?.model, "test/vendor/brief");
  } finally { delete process.env.PI_CODING_AGENT_DIR; process.env.PI_BRIEF_MODEL = "test/brief"; }
});

test("refresh waits for Pi settlement rather than summarizing an unfinished batch", async () => {
  const h = harness(); h.emit("session_start");
  let idle!: () => void;
  h.setWaitForIdle(() => new Promise((resolve) => { idle = resolve; }));
  const refreshing = h.command("refresh");
  h.setBranch([user(), assistant("I am still running tools")]);
  await tick(); assert.equal(h.calls, 0);
  h.setBranch([user(), assistant()]); h.emit("agent_settled");
  idle(); await refreshing;
  assert.equal(h.calls, 1, "manual refresh reuses the settled evidence");
  assert.match(h.notifications.at(-1)!, /Goal: Fix checkout/);
  h.emit("session_shutdown");
});

test("refresh does not notify or dereference a stale controller after shutdown/navigation", async () => {
  for (const event of ["session_shutdown", "session_tree"]) {
    const h = harness("tui", [user(), assistant()]);
    h.setComplete(async () => new Promise(() => {}));
    h.emit("session_start");
    const refreshing = h.command("refresh"); await tick();
    h.setBranch([]); h.emit(event);
    await refreshing;
    assert.deepEqual(h.notifications, []);
    assert.equal(h.calls, 1);
    h.emit("session_shutdown");
  }
});

test("a session replacement during Pi's idle wait cancels refresh before spending", async () => {
  const h = harness(); h.emit("session_start");
  let idle!: () => void;
  h.setWaitForIdle(() => new Promise((resolve) => { idle = resolve; }));
  const refreshing = h.command("refresh");
  h.emit("session_shutdown"); idle(); await refreshing;
  assert.equal(h.calls, 0); assert.deepEqual(h.notifications, []);
});

test("queued users, continuations and pre-navigation invalidate stale replies without a new call", async () => {
  for (const [name, event] of [["message_start", { message: { role: "user", content: "New task" } }], ["agent_start", {}], ["session_before_tree", {}], ["session_before_switch", {}], ["session_before_fork", {}]] as const) {
    const h = harness("tui", [user(), assistant()]);
    let resolve!: (reply: ReturnType<typeof response>) => void;
    h.setComplete(async () => new Promise((r) => { resolve = r; }));
    h.emit("session_start"); h.emit(name, event);
    resolve(response()); await tick();
    assert.equal(h.calls, 1); assert.equal(h.entries.length, 0);
    h.emit("session_shutdown");
  }
});

test("diagnostics are opt-in, visible in status, and do not pollute session entries or model inputs", async () => {
  const directory = join(home, "diagnostics-agent"); mkdirSync(directory, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const disabled = harness("tui", [user(), assistant()]);
    disabled.emit("session_start"); await tick();
    assert.equal(existsSync(diagnosticDirectory(directory)), false);
    await disabled.command("status"); assert.match(disabled.notifications.at(-1)!, /diagnostics: off/);
    disabled.emit("session_shutdown");
    writeFileSync(join(directory, "brief.json"), JSON.stringify({ diagnostics: true }));
    assert.equal(diagnosticsRequested(), true);
    const h = harness("tui", [user("Fix checkout SECRET_USER"), assistant()]);
    const prompts: string[] = [];
    h.setComplete(async (_model, context) => {
      prompts.push(JSON.stringify(context));
      return prompts.length === 1 ? response({ ...value, now: "SECRET_REPLY ".repeat(20) }) : response();
    });
    h.emit("session_start"); await tick();
    const report = diagnosticReport(await readDiagnostics([diagnosticDirectory(directory)]));
    assert.equal(h.calls, 2);
    assert.equal(report.totals.recovered, 1);
    assert.equal(report.totals.reportedCostUsd, 0.002);
    assert.equal(report.records[0]?.session, fingerprint("session-123"));
    assert.equal(h.entries.length, 1);
    assert.deepEqual(Object.keys(h.entries[0]).sort(), ["alignment", "brief", "goalSources", "trace", "version"]);
    assert.doesNotMatch(JSON.stringify(report), /SECRET_|session-123/);
    assert.doesNotMatch(prompts.join("\n"), /installation-id|brief-diagnostics|operation_start|attempt_end/);
    await h.command("status"); assert.match(h.notifications.at(-1)!, /diagnostics: on .*brief-diagnostics/);
    h.emit("session_shutdown");
  } finally { delete process.env.PI_CODING_AGENT_DIR; }
});

test("diagnostic branch identity is frozen before navigation, including late usage", async () => {
  const directory = join(home, "diagnostics-navigation"); mkdirSync(directory, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    writeFileSync(join(directory, "brief.json"), JSON.stringify({ diagnostics: true }));
    const h = harness("tui", [user(), assistant()]);
    let resolve!: (value: ReturnType<typeof response>) => void;
    h.setComplete(async () => new Promise((r) => { resolve = r; }));
    h.emit("session_start");
    h.setBranch([user("Prepare standup", "u2")]); h.emit("session_before_tree"); await tick();
    h.setComplete(async () => response({ ...value, goal: "Prepare standup", alignment: "unknown", evidence: { goal: ["u2"], pivot: [], drift: [] } }));
    h.emit("session_tree"); await tick();
    resolve(response()); await tick();
    const report = diagnosticReport(await readDiagnostics([diagnosticDirectory(directory)]));
    const cancelled = report.records.find((row) => row.event === "operation_end" && row.code === "navigation")!;
    const old = report.records.filter((row) => row.operation === cancelled.operation);
    assert.ok(old.every((row) => row.branch === fingerprint("a1")));
    assert.equal(old.find((row) => row.event === "usage")?.late, true);
    assert.equal(report.totals.cancelled, 1);
    assert.equal(report.totals.accepted, 1);
    assert.equal(report.totals.reportedCostUsd, 0.002);
    assert.equal(h.entries.length, 1);
    h.emit("session_shutdown");
  } finally { delete process.env.PI_CODING_AGENT_DIR; }
});

test("diagnostics record setup failures and log errors cannot break valid briefs", async () => {
  const directory = join(home, "diagnostics-setup"); mkdirSync(directory, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    writeFileSync(join(directory, "brief.json"), JSON.stringify({ diagnostics: true }));
    process.env.PI_BRIEF_MODEL = "missing/brief";
    const missing = harness("tui", [user(), assistant()]); missing.emit("session_start"); await tick();
    assert.equal(missing.calls, 0);
    assert.equal(diagnosticReport(await readDiagnostics([diagnosticDirectory(directory)])).byCode.model_missing, 1);
    missing.emit("session_shutdown");
    process.env.PI_BRIEF_MODEL = "test/brief";
    rmSync(diagnosticDirectory(directory), { recursive: true, force: true });
    writeFileSync(diagnosticDirectory(directory), "not a directory");
    const h = harness("tui", [user(), assistant()]); h.emit("session_start"); await tick();
    assert.equal(h.calls, 1); assert.equal(h.entries.length, 1);
    await h.command("status"); assert.match(h.notifications.at(-1)!, /diagnostics: unavailable/);
    assert.doesNotMatch(h.notifications.at(-1)!, /last error/);
    h.emit("session_shutdown");
  } finally { delete process.env.PI_CODING_AGENT_DIR; process.env.PI_BRIEF_MODEL = "test/brief"; }
});

test("headless modes do not create diagnostics even with logging enabled", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const directory = join(home, `diagnostics-${mode}`); mkdirSync(directory, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      writeFileSync(join(directory, "brief.json"), JSON.stringify({ diagnostics: true }));
      const h = harness(mode, [user(), assistant()]); h.emit("session_start"); await tick();
      assert.equal(h.calls, 0);
      assert.equal(existsSync(diagnosticDirectory(directory)), false);
      h.emit("session_shutdown");
    } finally { delete process.env.PI_CODING_AGENT_DIR; }
  }
});

test("diagnostics config and environment overrides are explicit and validated", () => {
  const directory = join(home, "diagnostics-config"); mkdirSync(directory, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const path = join(directory, "brief.json");
    writeFileSync(path, JSON.stringify({ diagnostics: true }));
    assert.deepEqual(configured(), { model: "test/brief", diagnostics: true });
    process.env.PI_BRIEF_DIAGNOSTICS = "0";
    assert.deepEqual(configured(), { model: "test/brief" });
    process.env.PI_BRIEF_DIAGNOSTICS = "1";
    writeFileSync(path, JSON.stringify({ diagnostics: false }));
    assert.deepEqual(configured(), { model: "test/brief", diagnostics: true });
    process.env.PI_BRIEF_DIAGNOSTICS = "yes"; assert.throws(() => configured(), /must be 0 or 1/);
    delete process.env.PI_BRIEF_DIAGNOSTICS;
    writeFileSync(path, JSON.stringify({ diagnostics: "yes" })); assert.throws(() => configured(), /must be boolean/);
  } finally { delete process.env.PI_CODING_AGENT_DIR; delete process.env.PI_BRIEF_DIAGNOSTICS; }
});

test("provider stop reason and detail remain visible without retry", async () => {
  const h = harness("tui", [user(), assistant()]); h.setComplete(async () => ({ ...response(value, "error"), errorMessage: "400 MissingSessionID" }));
  h.emit("session_start"); await tick(); await h.command("status");
  assert.match(h.notifications.at(-1)!, /model stopped: error: 400 MissingSessionID/);
  assert.equal(h.calls, 1);
  h.emit("session_shutdown");
});
