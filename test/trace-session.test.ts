import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const home = mkdtempSync(join(tmpdir(), "pi-brief-trace-"));
process.env.HOME = home;
process.env.PI_BRIEF_MODEL = "test/brief";
after(() => { rmSync(home, { recursive: true, force: true }); });
const { default: extension } = await import("../src/index.ts");

test("one below-editor widget shows the brief and trace without replacing Pi's footer", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const calls: string[] = [];
  let branch: unknown[] = [];
  let lines: string[] = [];
  let placement = "";
  let footerCalls = 0;
  const theme = { fg: (_color: string, value: string) => value };
  const ctx = {
    mode: "tui",
    ui: {
      setStatus() {}, notify() {},
      setWidget(_key: string, factory?: (_tui: unknown, palette: { fg: (color: string, value: string) => string }) => { render: (width: number) => string[] }, options?: { placement?: string }) {
        placement = options?.placement ?? "";
        lines = factory ? factory({}, theme).render(80) : [];
      },
      setFooter() { footerCalls++; },
    },
    modelRegistry: {
      find: () => ({ id: "brief" }),
      complete: async () => { calls.push("model"); return { content: [{ type: "text", text: JSON.stringify({ goal: "Publish the npm package", done: "—", now: "Review", next: "—", blocked: "—", trace: [{ who: "user", kind: "task", text: "keep one job" }, { who: "agent", kind: "drift", text: "left the brief for publishing" }] }) }], stopReason: "stop", usage: { cost: { total: 0.001 } } }; },
    },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;
  extension({
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { handlers.set(name, handler); return () => {}; },
    appendEntry() {},
    registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, spec.handler); },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);

  emit("session_start");
  assert.equal(placement, "belowEditor");
  assert.match(lines[0], /Goal: — · Now: —/);
  assert.match(lines.join("\n"), /◇ reading/);
  assert.equal(footerCalls, 0);

  branch = [{ id: "u1", type: "message", message: { role: "user", content: "Fix the brief line" } }];
  emit("before_agent_start", { prompt: "Fix the brief line" });
  emit("tool_execution_start", { toolName: "bash", args: { password: "SECRET" } });
  assert.equal(calls.length, 0, "no per-turn trace call");
  assert.doesNotMatch(lines.join("\n"), /tool|bash|SECRET/);

  emit("agent_settled");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.match(lines.slice(1).join("\n"), /keep one job/);
  assert.match(lines.slice(1).join("\n"), /left the brief for publishing/);

  branch = [{ id: "u9", type: "message", message: { role: "user", content: "Write the standup" } }];
  emit("session_tree");
  assert.match(lines.slice(1).join("\n"), /↩ Write the standup/);
  await commands.get("trace")?.("off", ctx);
  assert.equal(lines.length, 1, "/trace off leaves only the brief line");
  assert.equal(footerCalls, 0, "Pi's footer is never touched");

  emit("session_start");
  assert.equal(lines.length, 1, "off stays off across session start");
  await commands.get("trace")?.("on", ctx);
  assert.match(lines.slice(1).join("\n"), /◇ reading|keep one job/);
  assert.equal(footerCalls, 0);
  emit("session_shutdown");
  assert.deepEqual(lines, []);
  assert.equal(footerCalls, 0);
});
