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

test("simulated session drives the rail without extra model calls", async () => {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const calls: string[] = [];
  let branch: unknown[] = [];
  let rails: string[] = [];
  let footerCleared = false;
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const theme = { fg: (_color: string, value: string) => value };
  const ctx = {
    mode: "tui",
    ui: {
      setStatus() {},
      setWidget() {},
      notify() {},
      setFooter(factory?: (tui: { requestRender: () => void }, theme: { fg: (color: string, value: string) => string }, footerData: { onBranchChange?: (fn: () => void) => void }) => { render: (width: number) => string[] }) {
        if (!factory) { footerCleared = true; rails = []; return; }
        footerCleared = false;
        let component: { render: (width: number) => string[] } | undefined;
        component = factory({ requestRender() { rails = component?.render(80) ?? []; } }, theme, {});
        rails = component.render(80);
      },
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
  const emit = (name: string) => handlers.get(name)?.({}, ctx);
  handlers.get("session_start")?.({}, ctx);
  assert.equal(footerCleared, false);
  assert.match(rails.join("\n"), /◇ reading/);

  branch = [{ id: "u1", type: "message", message: { role: "user", content: "Fix the brief line" } }];
  handlers.get("before_agent_start")?.({ prompt: "Fix the brief line" }, ctx);
  handlers.get("tool_execution_start")?.({ toolName: "bash", args: { password: "SECRET" } }, ctx);
  assert.equal(calls.length, 0, "the live rail does not call the model");
  assert.doesNotMatch(rails.join("\n"), /SECRET/);
  assert.match(rails.join("\n"), /◇ reading/);
  assert.doesNotMatch(rails.join("\n"), /tool|bash|SECRET/);

  handlers.get("agent_settled")?.({}, ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.match(rails.join("\n"), /keep one job/);
  assert.match(rails.join("\n"), /left the brief for publishing/);
  assert.doesNotMatch(rails.join("\n"), /Fix the brief line/);

  branch = [
    { id: "u1", type: "message", message: { role: "user", content: "Fix the brief line" } },
    { id: "u2", type: "message", message: { role: "user", content: "instead, add a right rail" } },
  ];
  handlers.get("before_agent_start")?.({ prompt: "instead, add a right rail" }, ctx);
  assert.doesNotMatch(rails.join("\n"), /add a right rail/);
  assert.equal(calls.length, 1, "a user pivot does not spend a call by itself");

  branch = [{ id: "u9", type: "message", message: { role: "user", content: "Write the standup" } }];
  handlers.get("session_tree")?.({}, ctx);
  assert.match(rails.join("\n"), /↩ Write the standup/);
  assert.match(rails.join("\n"), /Fix the brief line|add a right rail/);
  await commands.get("trace")?.("", ctx);
  assert.equal(footerCleared, true, "/trace restores the built-in status line");
  assert.equal(rails.join("").trim(), "");
});
