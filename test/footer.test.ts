import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { footerLines } from "../src/footer.ts";

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, total: number) =>
  ({ input, output, cacheRead, cacheWrite, cost: { total } });
const entries = [
  { type: "message", message: { role: "assistant", usage: usage(20, 10, 80, 0, 0.12) } },
  { type: "usage", usage: usage(5, 0, 0, 20, 0.05) },
  { type: "compaction", usage: usage(3, 4, 0, 0, 0.03) },
  { type: "message", message: { role: "toolResult", usage: usage(2, 1, 0, 0, 0.01) } },
];
const context = {
  model: { id: "sample-model", provider: "sample", contextWindow: 128_000, reasoning: true },
  thinkingLevel: "off",
  getContextUsage: () => ({ tokens: 92_800, contextWindow: 128_000, percent: 72.5 }),
  modelRegistry: { isUsingOAuth: () => true, getProvider: () => ({ auth: { oauth: { isSubscription: true } } }) },
  sessionManager: {
    getEntries: () => entries, getCwd: () => `${process.env.HOME}/projects/pi-brief`, getSessionName: () => "review",
  },
} as unknown as ExtensionContext;
const data = {
  getGitBranch: () => "main",
  getAvailableProviderCount: () => 2,
  getExtensionStatuses: () => new Map([["zeta", "Zed\nstatus"], ["alpha", "Alpha status"]]),
} as unknown as ReadonlyFooterDataProvider;
const theme = { fg: (_color: string, text: string) => text } as Theme;

test("trace footer retains path, branch, name, other statuses and all usage entry types", () => {
  const lines = footerLines(context, theme, data, 120);
  assert.match(lines[0], /~\/projects\/pi-brief \(main\) • review/);
  assert.match(lines[1], /↑30 ↓15 R80 W20 CH80\.0% \$0\.210 \(sub\) 72\.5%\/128k/);
  assert.match(lines[1], /\(sample\) sample-model • thinking off/);
  assert.doesNotMatch(lines[1], /\(auto\)/, "auto-compaction state is not exposed to extensions");
  assert.deepEqual(lines[2], "Alpha status Zed status");
});

test("unknown context matches Pi's zero display without inventing auto-compaction state", () => {
  const unknown = { ...context, getContextUsage: () => undefined } as ExtensionContext;
  assert.match(footerLines(unknown, theme, data, 120)[1], /0\.0%\/128k/);
  assert.doesNotMatch(footerLines(unknown, theme, data, 120)[1], /\(auto\)/);
});

test("footer lines fit terminal columns with wide text and ANSI theme codes", () => {
  const colored = { fg: (_color: string, text: string) => `\x1b[33m${text}\x1b[0m` } as Theme;
  const wide = { ...context, model: { ...context.model!, id: "模型👩🏽‍💻" } } as ExtensionContext;
  for (const width of [1, 8, 25, 60]) {
    for (const line of footerLines(wide, colored, data, width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
    }
  }
});
