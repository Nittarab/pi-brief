import { BriefEnv } from "../src/rl/env.ts";
import { badPolicy, oraclePolicy, rollout } from "../src/rl/rollout.ts";

const oracle = await rollout(new BriefEnv(), oraclePolicy);
const bad = await rollout(new BriefEnv(), badPolicy);
console.log(`oracle ${oracle.mean}`);
console.log(`bad    ${bad.mean}`);
for (const row of oracle.episodes) console.log(`  ${row.name}: ${row.reward}`);

if (!process.argv.includes("--model")) {
  console.log("Pass --model to score the live prompt. That spends model calls.");
  process.exit(oracle.mean > bad.mean ? 0 : 1);
}

const { randomUUID } = await import("node:crypto");
const { readFileSync } = await import("node:fs");
const { homedir } = await import("node:os");
const { join } = await import("node:path");
const key = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["opencode-go"].key;

async function modelPolicy(observation) {
  const response = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-opencode-session": randomUUID(),
      "x-opencode-client": "pi",
    },
    body: JSON.stringify({
      model: "mimo-v2.6-flash",
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: "system", content: "Summarize only the provided data. Output one JSON object, without markdown." },
        { role: "user", content: observation.prompt },
      ],
    }),
  });
  const body = await response.json();
  return body.choices?.[0]?.message?.content ?? "";
}

const live = await rollout(new BriefEnv(), modelPolicy);
console.log(`model  ${live.mean}`);
for (const row of live.episodes) console.log(`  ${row.reward.toFixed(2)} ${row.name}: ${row.goal}`);
process.exit(live.mean >= 0.7 ? 0 : 1);
