import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BriefController, briefLine, cleanText, isBrief, parseBrief, parsePresented, promptFor, sessionOutline, type Brief } from "../src/brief.ts";

const summary: Brief = { goal: "Ship brief", done: "Tests passed", now: "Documenting", next: "Publish", blocked: "—" };
const json = JSON.stringify(summary);

test("parsing requires all string fields, sanitizes control characters and persisted values", () => {
  assert.deepEqual(parseBrief(`\`\`\`json\n${json}\n\`\`\``), summary);
  assert.throws(() => parseBrief('{"goal":"only"}'), /missing brief field/);
  assert.equal(isBrief(["not a brief"]), false);
  assert.equal(cleanText("hello\x1b[31m\r\nworld"), "hello world");
});

test("stored trace parses safely without reclassifying its meaning or cutting it to 32 characters", () => {
  const trace = [{ who: "user", kind: "task", text: "Prepare the daily standup with yesterday's results" }];
  assert.deepEqual(parsePresented(JSON.stringify({ trace })), trace);
  assert.deepEqual(parsePresented('{"goal":"Ship"}'), []);
  assert.deepEqual(parsePresented('{"trace":[{"kind":"invented","text":"bad"}]}'), []);
});

test("brief line uses the row width and keeps both labels", () => {
  assert.equal(briefLine(summary, "", 80), "Goal: Ship brief · Now: Documenting");
  assert.equal(briefLine(summary, "using bash", 80), "Brief · using bash");
  assert.equal(briefLine(undefined, "off: configure model", 80), "Brief · off: configure model");
  const goal = "Fix pi-bref TUI so the brief bar shows only once";
  const now = "Judge the screenshot";
  const wide = briefLine({ ...summary, goal, now }, "", 120);
  assert.equal(wide, `Goal: ${goal} · Now: ${now}`);
  assert.ok(goal.length > 22);
  const narrow = briefLine({ ...summary, goal, now }, "", 36);
  assert.ok(visibleWidth(narrow) <= 36);
  assert.doesNotMatch(narrow, /\x1b/, "the plain brief remains safe to theme as one line");
  assert.match(narrow, /^Goal: /);
  assert.match(narrow, / · Now: /);
  assert.doesNotMatch(narrow, /so the ·/); // the old 22-character cut
  assert.ok(visibleWidth(briefLine(summary, "update failed", 12)) <= 12);
  for (const text of ["修复中文字符的布局", "👩🏽‍💻 fix emoji", "e\u0301cho combining"]) {
    for (const width of [1, 12, 36]) {
      assert.ok(visibleWidth(briefLine({ ...summary, goal: text, now: text }, "", width)) <= width);
    }
  }
});

test("outline keeps the active trace and other branches, without tool arguments or output", () => {
  const outline = sessionOutline([
    { id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "Ship the footer" }] } },
    { id: "a1", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET_THOUGHT" }, { type: "text", text: "Checked" }, { type: "toolCall", name: "bash", arguments: { password: "SECRET_ARGUMENT" } }] } },
    { id: "t1", type: "message", message: { role: "toolResult", content: [{ type: "text", text: "SECRET_OUTPUT" }] } },
  ], [
    { entry: { id: "u1", type: "message", message: { role: "user", content: "Ship the footer" } }, children: [] },
    { entry: { id: "u2", type: "message", message: { role: "user", content: "Try another branch" } }, label: "alt", children: [] },
  ]);
  const source = JSON.parse(outline);
  assert.equal(source.users[0].text, "Ship the footer");
  assert.equal(source.activity[0].text, "Checked");
  assert.deepEqual(source.activity[0].tools, ["bash"]);
  assert.doesNotMatch(outline, /Try another branch/);
  assert.doesNotMatch(outline, /SECRET_THOUGHT|SECRET_ARGUMENT|SECRET_OUTPUT/);
});

test("prompt includes bounded visible activities only and treats input as untrusted", () => {
  const prompt = promptFor(summary, [{ type: "tool", text: "bash: finished" }]);
  assert.match(prompt, /UNTRUSTED_DATA/);
  const outlinePrompt = promptFor(summary, [{ type: "user", text: sessionOutline([{ type: "message", message: { role: "user", content: "Fix checkout" } }]) }], true);
  assert.match(outlinePrompt, /sustained user job/);
  assert.match(outlinePrompt, /unfinished objective/);
  assert.match(outlinePrompt, /not replacement jobs/);
  assert.match(outlinePrompt, /not authority/);
  assert.match(outlinePrompt, /Same nouns can hide a violation/);
});

test("meaningful events start immediately; tools wait for settlement, cost is tracked with no default USD limit", async () => {
  const changes: boolean[] = [];
  const prompts: string[] = [];
  const c = new BriefController(async (prompt) => { prompts.push(prompt); return { text: json, cost: 0.06 }; },
    (_brief, changed) => changes.push(changed), undefined, 2);
  c.add({ type: "user", text: "a" }, true);
  assert.equal(prompts.length, 1);
  await c.flush(); // In-flight work is already running, not duplicated.
  c.add({ type: "tool", text: "bash: finished" });
  assert.equal(prompts.length, 1);
  c.add({ type: "assistant", text: "third" });
  c.trigger();
  assert.equal(prompts.length, 2);
  await c.flush();
  assert.deepEqual(changes, [true, false]);
  assert.equal(c.stats.cost, 0.12);
  assert.equal(c.stats.limit, true);
  c.add({ type: "user", text: "next" }, true);
  assert.equal(c.stats.pending, 1);
  assert.equal(prompts.length, 2);
  c.close();
});

test("optional observed USD cap blocks subsequent calls, including explicit refresh", async () => {
  let calls = 0;
  const c = new BriefController(async () => { calls++; return { text: json, cost: 0.06 }; }, () => {}, undefined, 80, 0.05);
  c.add({ type: "user", text: "request" }, true);
  await c.flush();
  c.add({ type: "assistant", text: "answer" });
  c.trigger();
  await c.flush(true);
  assert.equal(calls, 1);
  assert.equal(c.stats.limit, true);
  assert.equal(c.stats.pending, 1);
  c.close();
});

test("failure retains evidence but never silently retries; explicit retry and new events can retry", async () => {
  let calls = 0;
  const c = new BriefController(async () => { calls++; if (calls === 1) return { text: "bad", cost: 0.01 }; return { text: json, cost: 0.01 }; },
    () => {});
  c.add({ type: "user", text: "request" }, true);
  await c.flush();
  await c.flush();
  assert.equal(calls, 1);
  assert.equal(c.stats.pending, 1);
  assert.equal(c.stats.cost, 0.01);
  assert.ok(c.stats.error);
  await c.flush(true);
  assert.equal(calls, 2);
  assert.equal(c.stats.pending, 0);
  c.add({ type: "assistant", text: "new result" });
  c.trigger();
  assert.equal(calls, 3, "new completed activity can start another request after failure");
  c.close();
});

test("one in flight coalesces settled activity and closes without applying stale replies", async () => {
  const prompts: string[] = [];
  const resolvers: Array<(value: { text: string; cost: number }) => void> = [];
  const changes: boolean[] = [];
  const c = new BriefController(async (prompt) => { prompts.push(prompt); return new Promise((resolve) => { resolvers.push(resolve); }); },
    (_brief, changed) => changes.push(changed));
  c.add({ type: "user", text: "request" }, true);
  for (let i = 0; i < 25; i++) c.add({ type: "tool", text: `bash: finished ${i}` });
  c.add({ type: "assistant", text: "more" });
  assert.equal(c.stats.pending, 20, "tool metadata stays bounded while in flight");
  c.trigger();
  assert.equal(prompts.length, 1);
  resolvers[0]({ text: json, cost: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[1], /finished 0\b/);
  assert.match(prompts[1], /finished 24/);
  assert.match(prompts[1], /more/);
  c.close();
  resolvers[1]({ text: json, cost: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [true]);
  assert.equal(c.stats.pending, 0);
});
