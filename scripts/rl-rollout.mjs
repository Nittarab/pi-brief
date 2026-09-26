// Legacy synthetic keyword smoke only. This is not a semantic or live model evaluation.
import { BriefEnv } from "../src/rl/env.ts";
import { badPolicy, oraclePolicy, rollout } from "../src/rl/rollout.ts";
import { loadPublicEpisodes } from "../src/rl/public.ts";

if (process.argv.includes("--model")) {
  console.error("Live keyword scoring was misleading. Use scripts/goal-eval.mjs with an approved --live call/spend budget, then independent LLM judge packets. No call was made.");
  process.exit(2);
}
const source = process.argv.includes("--public") ? loadPublicEpisodes() : undefined;
const oracle = await rollout(new BriefEnv(source), oraclePolicy);
const bad = await rollout(new BriefEnv(source), badPolicy);
console.log(`Synthetic keyword smoke (not model quality): oracle ${oracle.mean}; negative control ${bad.mean}`);
process.exitCode = oracle.mean > bad.mean ? 0 : 1;
