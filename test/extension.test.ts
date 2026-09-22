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
  const notifications: string[] = [];
  const entries: unknown[] = [];
  let branch = initial;
  let calls = 0;
  let complete = async (_model: unknown, _context: unknown, _options: unknown): Promise<typeof response> => { calls++; return response; };
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  const ctx = {
    mode,
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]), notify: (text: string) => notifications.push(text) },
    modelRegistry: { find: (provider: string, model: string) => provider === "test" && model === "brief" ? { id: model } : undefined,
      complete: (...args: [unknown, unknown, unknown]) => complete(...args) },
    sessionManager: { getBranch: () => [...branch] },
  } as unknown as ExtensionContext;
  extension({ on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; },
    appendEntry: (_key: string, data: unknown) => entries.push(data),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  return { ctx, emit, statuses, notifications, entries, command: (args: string) => command(args, ctx),
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
  h.emit("tool_execution_start", { toolName: "bash", args: { password: "SENSITIVE_ARGUMENT" } });
  assert.match(h.statuses.at(-1)?.[1] ?? "", /N: using bash/);
  h.emit("tool_execution_end", { toolName: "bash", isError: false, result: "SENSITIVE_OUTPUT" });
  h.emit("message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "SENSITIVE_THOUGHT" }, { type: "text", text: "Checked" }] } });
  h.emit("agent_settled");
  await h.command("refresh");
  assert.doesNotMatch(prompt, /SENSITIVE_ARGUMENT|SENSITIVE_OUTPUT|SENSITIVE_THOUGHT/);
  assert.match(h.statuses.at(-1)?.[1] ?? "", /Brief G: Ship · N: Review/);
  assert.deepEqual(h.entries, [{ brief }]);
  await h.command("status");
  assert.match(h.notifications.at(-1) ?? "", /test\/brief · 1 calls · \$0\.00100/);
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
  const pending = h.command("refresh");
  h.emit("tool_execution_start", { toolName: "bash" });
  resolve(response);
  await pending;
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: Ship · N: using bash/);
  h.emit("agent_settled");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: Ship · N: Review/);
  h.emit("session_shutdown");
});

test("restores active branch, discards in-flight replies from abandoned branches", async () => {
  const h = harness("tui", [{ type: "custom", customType: "pi-brief", data: { brief } }]);
  let resolve!: (value: typeof response) => void;
  h.setComplete(async () => new Promise((r) => { resolve = r; }));
  h.emit("session_start");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: Ship/);
  h.emit("before_agent_start", { prompt: "old branch" });
  const old = h.command("refresh");
  h.setBranch([]);
  h.emit("session_tree");
  assert.match(h.statuses.at(-1)?.[1] ?? "", /G: —/);
  resolve(response);
  await old;
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
