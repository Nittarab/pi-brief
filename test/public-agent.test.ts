import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BriefEnv } from "../src/rl/env.ts";
import { loadPublicEpisodes, publicEpisodes, type PublicRow } from "../src/rl/public.ts";
import { badPolicy, oraclePolicy, rollout } from "../src/rl/rollout.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-agent.json");

test("public agent excerpts stay on the issue, not the tool diary", async () => {
  const data = JSON.parse(readFileSync(fixture, "utf8")) as { license: string; source: string; rows: PublicRow[] };
  assert.equal(data.license, "cc-by-4.0");
  assert.match(data.source, /SWE-agent-trajectories/);
  const episodes = publicEpisodes(data.rows);
  assert.equal(episodes.length, 8);
  const env = new BriefEnv(episodes);
  const observation = env.reset(0);
  assert.match(observation.outline, /Memset provider/);
  assert.match(JSON.parse(observation.outline).activity[0].text, /To start solving/);
  const oracle = await rollout(env, oraclePolicy);
  const bad = await rollout(new BriefEnv(loadPublicEpisodes(fixture)), badPolicy);
  assert.equal(oracle.mean, 1);
  assert.ok(bad.mean < 0.4, JSON.stringify(bad));
});
