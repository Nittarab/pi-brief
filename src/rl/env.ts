import { promptFor, type Brief } from "../brief.ts";
import { episodes, outlineFor, usersOf, type Episode, type TurnTruth } from "./episodes.ts";
import { parseAction, scoreBrief } from "./reward.ts";

const blank: Brief = { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };

export type PromptBuilder = (previous: Brief, outline: string) => string;

export type Observation = {
  episode: string;
  index: number;
  turn: number;
  turns: number;
  outline: string;
  previous: Brief;
  prompt: string;
};

export type StepResult = {
  observation: Observation | null;
  reward: number;
  done: boolean;
  info: { parts: Record<string, number>; goal: string; episode: string };
};

export class BriefEnv {
  private cursor = 0;
  private turn = 0;
  private previous: Brief = { ...blank };
  private episode: Episode = episodes[0] as Episode;

  constructor(
    private readonly source: Episode[] = episodes,
    private readonly mode: "episode" | "turn" = "episode",
    private readonly prompt: PromptBuilder = (previous, outline) => promptFor(previous, [{ type: "user", text: outline }], true),
  ) {}

  get episodes(): Episode[] { return this.source; }

  reset(index = 0): Observation {
    this.cursor = ((index % this.source.length) + this.source.length) % this.source.length;
    this.turn = 0;
    this.previous = { ...blank };
    this.episode = this.source[this.cursor] as Episode;
    return this.observe();
  }

  step(action: unknown): StepResult {
    const parsed = parseAction(action);
    const truth = this.truth();
    const scored = parsed ? scoreBrief(parsed, truth, this.pivoted()) : { total: 0, parts: { parse: 0 } };
    if (parsed) this.previous = { goal: parsed.goal, done: parsed.done, now: parsed.now, next: parsed.next, blocked: parsed.blocked };
    const done = this.mode === "episode" || this.turn >= this.episode.turns.length - 1;
    const info = { parts: scored.parts, goal: parsed?.goal ?? "", episode: this.episode.name };
    if (done) return { observation: null, reward: scored.total, done: true, info };
    this.turn += 1;
    return { observation: this.observe(), reward: scored.total, done: false, info };
  }

  private truth(): TurnTruth {
    if (this.mode === "episode") return this.episode.turns.at(-1) as TurnTruth;
    return this.episode.turns[this.turn] as TurnTruth;
  }

  private pivoted(): boolean {
    if (this.mode === "turn") return Boolean(this.episode.turns[this.turn]?.pivoted);
    return this.episode.turns.some((turn) => turn.pivoted);
  }

  private observe(): Observation {
    const users = this.mode === "episode" ? usersOf(this.episode) : usersOf(this.episode).slice(0, this.turn + 1);
    const outline = outlineFor(users);
    return {
      episode: this.episode.name,
      index: this.cursor,
      turn: this.turn,
      turns: this.mode === "episode" ? 1 : this.episode.turns.length,
      outline,
      previous: { ...this.previous },
      prompt: this.prompt(this.previous, outline),
    };
  }
}
