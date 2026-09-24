import { BriefEnv, type Observation } from "./env.ts";
import { episodes, type Episode } from "./episodes.ts";

export type Policy = (observation: Observation, episode: Episode) => unknown | Promise<unknown>;

export async function rollout(env: BriefEnv, policy: Policy): Promise<{ mean: number; episodes: { name: string; reward: number; goal: string }[] }> {
  const rows = [];
  for (let index = 0; index < env.episodes.length; index += 1) {
    let observation: Observation | null = env.reset(index);
    let reward = 0;
    let goal = "";
    let steps = 0;
    while (observation) {
      const episode = env.episodes[observation.index] as Episode;
      const result = env.step(await policy(observation, episode));
      reward += result.reward;
      goal = result.info.goal;
      steps += 1;
      observation = result.observation;
      if (result.done) break;
    }
    rows.push({ name: env.episodes[index]?.name ?? "", reward: steps ? reward / steps : 0, goal });
  }
  const mean = rows.reduce((sum, row) => sum + row.reward, 0) / (rows.length || 1);
  return { mean: Number(mean.toFixed(3)), episodes: rows };
}

export function oraclePolicy(observation: Observation, episode: Episode): unknown {
  const truth = observation.turns === 1 ? episode.turns.at(-1) : episode.turns[observation.turn];
  const must = truth?.must ?? [];
  return {
    goal: must.length ? must.join(" ") : "—",
    done: "—", now: "—", next: "—", blocked: "—",
    trace: { task: must[0] ?? "wait", pivot: truth?.pivoted ? "new job" : "", drift: "", steps: ["kept the job"] },
  };
}

export function badPolicy(): unknown {
  return {
    goal: "Run the daily standup",
    done: "—", now: "—", next: "—", blocked: "—",
    trace: { task: "Kicked off a standup", pivot: "", drift: "", steps: ["Applied edits"] },
  };
}

export { episodes };
