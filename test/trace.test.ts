import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { acceptModelGoal, assess, emptyMemory, isPivot, phrase, railColor, renderRail, sameTask, usersFrom, type TraceMemory, type TraceUser } from "../src/trace.ts";

function run(users: TraceUser[], modelGoal = "", modelNow = "", memory: TraceMemory = emptyMemory()) {
  return assess(memory, { users, modelGoal, modelNow });
}

test("a check question does not replace the sustained goal", () => {
  const users = [
    { text: '<skill name="cto-os-daily-standup">run</skill>' },
    { text: "Can we fix the pi-brief TUI?" },
    { text: "I want the agentic trace presented by the model" },
    { text: "why is the goal daily standup? that clearly is not" },
  ];
  const locked = assess(emptyMemory(), { users }).memory.locked;
  assert.match(locked, /fix the pi-brief TUI/);
  assert.equal(acceptModelGoal("Explain why the goal is standup", users, locked), "");
  assert.equal(acceptModelGoal("Run the daily standup", users, locked), "");
  assert.match(acceptModelGoal("Show a model-written agent trace while the session runs", users, locked), /agent trace/);
});

test("user extraction keeps visible text, not hidden content or tool results", () => {
  assert.deepEqual(usersFrom([
    { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "Ship" }, { type: "thinking", text: "SECRET" }, { type: "text", text: "brief" }] } },
    { type: "message", message: { role: "toolResult", content: "SECRET_OUTPUT" } },
  ]), [{ id: "u1", text: "Ship brief" }]);
});

test("a skill tag does not become the goal", () => {
  const assessed = run([
    { id: "u1", text: '<skill name="cto-os-daily-standup">run the standup</skill>' },
    { id: "u2", text: "/Users/me/CleanShot.png Can we fix the pi-brief TUI?" },
  ]);
  assert.equal(assessed.memory.locked, "Can we fix the pi-brief TUI?");
  assert.doesNotMatch(assessed.memory.locked, /standup|CleanShot/);
  const kept = assess(assessed.memory, {
    users: [
      { id: "u1", text: '<skill name="cto-os-daily-standup">run the standup</skill>' },
      { id: "u2", text: "Can we fix the pi-brief TUI?" },
      { id: "u3", text: "try again" },
    ],
  });
  assert.equal(kept.memory.locked, "Can we fix the pi-brief TUI?");
});

test("simulated stable session keeps the lock and ignores short follow-ups", () => {
  const first = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "ok do it" }],
    "Fix the brief line",
    "Fit the row",
  );
  assert.equal(first.memory.locked, "Fix the brief line");
  assert.equal(first.rail.drift, "");
  assert.equal(first.rail.left, "");
  assert.equal(isPivot("ok do it"), false);
  const rail = renderRail(first.rail, 34, 16).join("\n");
  assert.match(rail, /● Fix the brief line/);
  assert.match(rail, /◇ reading/);
  assert.doesNotMatch(rail, /fit the row|bash|tool/);
  for (const line of rail.split("\n")) assert.ok(line.length <= 34, line);
});

test("simulated model drift does not move the lock", () => {
  const locked = run([{ id: "u1", text: "Fix the brief line" }]).memory;
  const drifted = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "try again" }],
    "Publish the npm package",
    "Review",
    locked,
  );
  assert.equal(drifted.memory.locked, "Fix the brief line");
  assert.match(drifted.rail.drift, /Publish the npm package/);
  assert.equal(sameTask("Fix the brief line", "Fix the brief display"), true);
  assert.equal(sameTask("Fix the brief line", "Publish the npm package"), false);
  const text = renderRail(drifted.rail, 40, 12).join("\n");
  assert.match(text, /! Publish the npm package/);
  assert.match(text, /● Fix the brief line/);
});

test("simulated user pivot moves the lock and a side ask does not", () => {
  const locked = run([{ id: "u1", text: "Fix the brief line" }]).memory;
  const side = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "add a right rail" }],
    "Fix the brief line",
    "Fit the row",
    locked,
  );
  assert.equal(side.memory.locked, "Fix the brief line");
  assert.doesNotMatch(renderRail(side.rail, 40, 14).join("\n"), /add a right rail/);

  const moved = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "instead, add a right rail" }],
    "Fix the brief line",
    "Fit the row",
    locked,
  );
  assert.equal(moved.memory.locked, "add a right rail");
  assert.equal(moved.rail.drift, "");
  assert.match(renderRail(moved.rail, 40, 12).join("\n"), /add a right rail/);
  assert.doesNotMatch(renderRail(moved.rail, 40, 12).join("\n"), /! drift/);
});

test("simulated branch switch keeps the old goal visible", () => {
  const locked = run([{ id: "u1", text: "Fix the brief line" }]).memory;
  const left = run([{ id: "u9", text: "Write the standup" }], "Write the standup", "Draft notes", locked);
  assert.equal(left.memory.locked, "Fix the brief line");
  assert.equal(left.rail.left, "Write the standup");
  assert.match(renderRail(left.rail, 36, 10).join("\n"), /↩ Write the standup/);
  const back = run([{ id: "u1", text: "Fix the brief line" }], "Fix the brief line", "Fit the row", left.memory);
  assert.equal(back.rail.left, "");
  assert.equal(back.memory.locked, "Fix the brief line");
});

test("wording drops skill tags, paths, and process openers", () => {
  assert.equal(phrase('<skill name="cto-os-daily-standup">run</skill>'), "daily standup");
  assert.equal(phrase("/Users/nittarab/Library/Caches/Clop/images/CleanShot 2026.png"), "screenshot");
  assert.equal(phrase("I will look at the screenshot"), "look at the screenshot");
  assert.equal(phrase("ok; can you try to be proactive here"), "be proactive here");
  assert.equal(railColor("● Fix the brief line"), "accent");
  assert.equal(railColor("◇ fit the row"), "thinkingText");
  assert.equal(railColor("? add a right rail"), "warning");
  assert.equal(railColor("! Publish the npm package"), "error");
  assert.equal(railColor(renderRail({ locked: "修复终端宽度 👩🏽‍💻", drift: "", left: "", presented: [] }, 10, 3)[0]), "accent");
});

test("rail fills the requested height and never exceeds the width", () => {
  const assessed = run(
    [{ id: "u1", text: "Fix the brief line so the session stays on the task" }],
  );
  assessed.rail.presented = Array.from({ length: 12 }, (_, index) => ({ who: "agent" as const, kind: "turn" as const, text: `decided ${index}` }));
  const lines = renderRail(assessed.rail, 28, 9);
  assert.equal(lines.length, 9);
  assert.match(lines.join("\n"), /decided 11/);
  assert.doesNotMatch(lines.join("\n"), /Fix the brief line/);
  assert.doesNotMatch(lines.join("\n"), /tool/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 28, line);
  assessed.rail.presented = [{ who: "user", kind: "task", text: "修复终端宽度 👩🏽‍💻 e\u0301" }];
  for (const width of [1, 10, 25]) {
    for (const line of renderRail(assessed.rail, width, 5)) assert.ok(visibleWidth(line) <= width, line);
  }
});
