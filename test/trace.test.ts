import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, emptyMemory, isPivot, isSuspect, renderRail, sameTask, type TraceMemory, type TraceStep, type TraceUser } from "../src/trace.ts";

function run(users: TraceUser[], steps: TraceStep[] = [], modelGoal = "", modelNow = "", memory: TraceMemory = emptyMemory()) {
  return assess(memory, { users, steps, modelGoal, modelNow });
}

test("simulated stable session keeps the lock and ignores short follow-ups", () => {
  const first = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "ok do it" }],
    [{ role: "user", text: "Fix the brief line" }, { role: "assistant", text: "I will fit the row" }, { role: "tool", text: "bash" }],
    "Fix the brief line",
    "Fit the row",
  );
  assert.equal(first.memory.locked, "Fix the brief line");
  assert.equal(first.rail.drift, "");
  assert.equal(first.rail.suspect, "");
  assert.equal(first.rail.left, "");
  assert.equal(isPivot("ok do it"), false);
  const rail = renderRail(first.rail, 34, 16).join("\n");
  assert.match(rail, /LOCKED/);
  assert.match(rail, /Fix the brief line/);
  assert.match(rail, /\* tool bash/);
  assert.doesNotMatch(rail, /SENSITIVE|password/);
  for (const line of rail.split("\n")) assert.ok(line.length <= 34, line);
});

test("simulated model drift does not move the lock", () => {
  const locked = run([{ id: "u1", text: "Fix the brief line" }]).memory;
  const drifted = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "try again" }],
    [{ role: "user", text: "Fix the brief line" }],
    "Publish the npm package",
    "Review",
    locked,
  );
  assert.equal(drifted.memory.locked, "Fix the brief line");
  assert.match(drifted.rail.drift, /Publish the npm package/);
  assert.equal(sameTask("Fix the brief line", "Fix the brief display"), true);
  assert.equal(sameTask("Fix the brief line", "Publish the npm package"), false);
  const text = renderRail(drifted.rail, 40, 12).join("\n");
  assert.match(text, /! drift Publish the npm package/);
  assert.match(text, /LOCKED/);
});

test("simulated user pivot moves the lock and a side ask does not", () => {
  const locked = run([{ id: "u1", text: "Fix the brief line" }]).memory;
  const side = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "add a right rail" }],
    [{ role: "user", text: "Fix the brief line" }, { role: "user", text: "add a right rail" }],
    "Fix the brief line",
    "Fit the row",
    locked,
  );
  assert.equal(side.memory.locked, "Fix the brief line");
  assert.equal(isSuspect("Fix the brief line", "add a right rail"), true);
  assert.match(side.rail.suspect, /add a right rail/);
  assert.match(renderRail(side.rail, 40, 14).join("\n"), /\? ask add a right rail/);

  const moved = run(
    [{ id: "u1", text: "Fix the brief line" }, { id: "u2", text: "instead, add a right rail" }],
    [{ role: "user", text: "instead, add a right rail" }],
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
  const left = run([{ id: "u9", text: "Write the standup" }], [], "Write the standup", "Draft notes", locked);
  assert.equal(left.memory.locked, "Fix the brief line");
  assert.equal(left.rail.left, "Write the standup");
  assert.match(renderRail(left.rail, 36, 10).join("\n"), /! left Write the standup/);
  const back = run([{ id: "u1", text: "Fix the brief line" }], [], "Fix the brief line", "Fit the row", left.memory);
  assert.equal(back.rail.left, "");
  assert.equal(back.memory.locked, "Fix the brief line");
});

test("rail fills the requested height and never exceeds the width", () => {
  const assessed = run(
    [{ id: "u1", text: "Fix the brief line so the session stays on the task" }],
    Array.from({ length: 12 }, (_, index) => ({ role: "tool" as const, text: `bash ${index}` })),
  );
  const lines = renderRail(assessed.rail, 28, 9);
  assert.equal(lines.length, 9);
  assert.match(lines[0] ?? "", /LOCKED/);
  assert.match(lines.join("\n"), /bash 11/);
  for (const line of lines) assert.ok(line.length <= 28, line);
});
