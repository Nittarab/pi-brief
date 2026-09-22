import assert from "node:assert/strict";
import { test } from "node:test";
import { BriefController, cleanText, footerStatus, isBrief, parseBrief, promptFor, type Brief } from "../src/brief.ts";

const summary: Brief = { goal: "Ship brief", done: "Tests passed", now: "Documenting", next: "Publish", blocked: "—" };
const json = JSON.stringify(summary);

test("parsing requires all string fields, sanitizes control characters and persisted values", () => {
  assert.deepEqual(parseBrief(`\`\`\`json\n${json}\n\`\`\``), summary);
  assert.throws(() => parseBrief('{"goal":"only"}'), /missing brief field/);
  assert.equal(isBrief(["not a brief"]), false);
  assert.equal(cleanText("hello\x1b[31m\r\nworld"), "hello [31m world");
});

test("footer stays short and has goal and current action even when idle", () => {
  assert.equal(footerStatus(summary, "using bash"), "Brief G: Ship brief · N: using bash");
  assert.equal(footerStatus(summary, ""), "Brief G: Ship brief · N: Documenting");
  assert.ok(footerStatus({ ...summary, goal: "g".repeat(140), now: "n".repeat(140) }, "").length <= 64);
  assert.equal(footerStatus(undefined, "off: configure model"), "Brief G: — · N: off: configure model");
});

test("prompt includes bounded visible activities only and treats input as untrusted", () => {
  const prompt = promptFor(summary, [{ type: "tool", text: "bash: finished" }]);
  assert.match(prompt, /untrusted data/);
  assert.doesNotMatch(prompt, /tool output/);
});

test("controller batches updates, accounts for cost, persists only changed briefs and obeys call budget", async () => {
  const changes: boolean[] = [];
  const prompts: string[] = [];
  const c = new BriefController(async (prompt) => { prompts.push(prompt); return { text: json, cost: 0.06 }; },
    (_brief, changed) => changes.push(changed), undefined, 0, 2, 0.10);
  c.add({ type: "user", text: "a" });
  await c.flush();
  c.add({ type: "tool", text: "bash: finished" });
  await c.flush();
  c.add({ type: "assistant", text: "third" });
  await c.flush();
  assert.deepEqual(changes, [true, false]);
  assert.equal(prompts.length, 2);
  assert.equal(c.stats.cost, 0.12);
  assert.equal(c.stats.limit, true);
  assert.equal(c.stats.pending, 1);
  c.close();
});

test("failure retains evidence but never silently retries; explicit retry and new events can retry", async () => {
  let calls = 0;
  const c = new BriefController(async () => { calls++; if (calls === 1) return { text: "bad", cost: 0.01 }; return { text: json, cost: 0.01 }; },
    () => {}, undefined, 0);
  c.add({ type: "user", text: "request" });
  await c.flush();
  await c.flush();
  assert.equal(calls, 1);
  assert.equal(c.stats.pending, 1);
  assert.equal(c.stats.cost, 0.01);
  assert.ok(c.stats.error);
  await c.flush(true);
  assert.equal(calls, 2);
  assert.equal(c.stats.pending, 0);
  c.close();
});

test("rate limit holds even on explicit refresh; closing cancels a pending request", async () => {
  let calls = 0;
  let resolve!: (value: { text: string; cost: number }) => void;
  const c = new BriefController(async () => { calls++; return new Promise((r) => { resolve = r; }); }, () => {}, undefined, 60_000);
  c.add({ type: "user", text: "request" });
  const first = c.flush();
  c.add({ type: "assistant", text: "more" });
  resolve({ text: json, cost: 0 });
  await first;
  await c.flush(true);
  assert.equal(calls, 1);
  c.close();
  assert.equal(c.stats.pending, 0);
});
