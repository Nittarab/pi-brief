import { BriefEnv } from "../src/rl/env.ts";
import { badPolicy, oraclePolicy, rollout } from "../src/rl/rollout.ts";

const oracle = await rollout(new BriefEnv(), oraclePolicy);
const bad = await rollout(new BriefEnv(), badPolicy);
console.log(`oracle ${oracle.mean}`);
console.log(`bad    ${bad.mean}`);
for (const row of oracle.episodes) console.log(`  ${row.name}: ${row.reward}`);

const usePublic = process.argv.includes("--public");
if (!process.argv.includes("--model")) {
  console.log("Pass --model to score the live prompt. Add --public to use the CC-BY-4.0 agent excerpts. That spends model calls.");
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
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: "system", content: "Summarize only the provided data. Output one JSON object, without markdown." },
        { role: "user", content: observation.prompt },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json();
  if (!body.choices?.[0]?.message?.content) throw new Error(body.error?.message ?? `model status ${response.status}`);
  return body.choices[0].message.content;
}

const { fileURLToPath } = await import("node:url");
const { loadPublicEpisodes } = await import("../src/rl/public.ts");
const fixture = fileURLToPath(new URL("../test/fixtures/public-agent.json", import.meta.url));
const source = usePublic ? loadPublicEpisodes(fixture) : undefined;
const scored = await Promise.all(new BriefEnv(source).episodes.map(async (_episode, index) => {
  const env = new BriefEnv(source);
  const observation = env.reset(index);
  const started = Date.now();
  try {
    const action = await modelPolicy(observation);
    const result = env.step(action);
    return { name: observation.episode, reward: result.reward, goal: result.info.goal, parts: result.info.parts, raw: String(action).slice(0, 500), ms: Date.now() - started };
  } catch (error) {
    return { name: observation.episode, reward: 0, goal: "", parts: {}, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}));
const mean = scored.reduce((sum, row) => sum + row.reward, 0) / scored.length;
console.log(`model  ${mean.toFixed(3)}`);
for (const row of scored) {
  console.log(`  ${row.reward.toFixed(2)} ${row.name} ${row.ms}ms ${row.error ?? row.goal} ${JSON.stringify(row.parts)}`);
  if (row.reward < 1) console.log(`    ${row.raw ?? ""}`);
}
process.exit(mean >= 1 ? 0 : 1);
