import assert from "node:assert/strict";
import test from "node:test";
import { BriefEnv } from "../src/rl/env.ts";
import { badPolicy, oraclePolicy, rollout } from "../src/rl/rollout.ts";

test("the RL environment separates an oracle brief from a standup brief", async () => {
  const oracle = await rollout(new BriefEnv(), oraclePolicy);
  const bad = await rollout(new BriefEnv(), badPolicy);
  assert.ok(oracle.mean >= 0.9, JSON.stringify(oracle));
  assert.ok(bad.mean <= 0.4, JSON.stringify(bad));
  assert.ok(oracle.mean > bad.mean);
});

test("a turn-level episode scores each user message and then ends", () => {
  const env = new BriefEnv(undefined, "turn");
  const first = env.reset(1);
  assert.equal(first.episode, "explicit pivot");
  assert.match(first.prompt, /sustained user job/);
  assert.match(first.outline, /Fix the brief footer/);
  assert.doesNotMatch(first.outline, /pricing page/);
  const mid = env.step({ goal: "footer", done: "—", now: "—", next: "—", blocked: "—", trace: { task: "footer", pivot: "", steps: [] } });
  assert.equal(mid.done, false);
  assert.match(mid.observation?.outline ?? "", /pricing page/);
  const last = env.step({ goal: "Run the daily standup", done: "—", now: "—", next: "—", blocked: "—", trace: { task: "standup", pivot: "", steps: ["Applied edits"] } });
  assert.equal(last.done, false);
  assert.ok(last.reward < 0.5);
  const end = env.step({ goal: "pricing", done: "—", now: "—", next: "—", blocked: "—", trace: { task: "pricing", pivot: "", steps: ["kept the job"] } });
  assert.equal(end.done, true);
  assert.equal(end.observation, null);
});

test("a malformed action scores zero and does not throw", () => {
  const env = new BriefEnv();
  env.reset(0);
  const result = env.step("not json");
  assert.equal(result.reward, 0);
  assert.equal(result.done, true);
});
