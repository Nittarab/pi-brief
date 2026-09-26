import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyRail, railColor, renderRail } from "../src/trace.ts";

test("rendering preserves the accepted semantic goal and warns only on a validated drift row", () => {
  const rail = { ...emptyRail(), presented: [
    { who: "user" as const, kind: "task" as const, text: "Prepare the daily standup" },
    { who: "agent" as const, kind: "drift" as const, text: "Unrequested production deploy" },
    { who: "agent" as const, kind: "turn" as const, text: "Approval remains required" },
  ] };
  const text = renderRail(rail, 80, 6).join("\n");
  assert.match(text, /● Prepare the daily standup/);
  assert.match(text, /! Unrequested production deploy/);
  assert.equal(railColor("● Prepare the daily standup"), "accent");
  assert.equal(railColor("! Unrequested production deploy"), "error");
  assert.equal(railColor("◇ Approval remains required"), "thinkingText");
  assert.match(renderRail(rail, 80, 2).join("\n"), /! Unrequested/, "decisions cannot evict the warning");
});

test("rail fits narrow, wide and Unicode terminals without hiding the task", () => {
  const rail = { ...emptyRail(), presented: [
    { who: "user" as const, kind: "task" as const, text: "修复终端宽度 👩🏽‍💻 e\u0301" },
    ...Array.from({ length: 12 }, (_, index) => ({ who: "agent" as const, kind: "turn" as const, text: `decision ${index}` })),
  ] };
  for (const width of [1, 10, 25, 120]) {
    const lines = renderRail(rail, width, 5);
    assert.equal(lines.length, 5);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, line);
  }
  assert.match(renderRail(rail, 100, 5)[0] ?? "", /修复/);
  assert.match(renderRail(emptyRail(), 40, 6).join("\n"), /reading/);
});
