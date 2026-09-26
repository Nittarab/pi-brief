import { sessionOutline } from "../evidence.ts";

export type TurnTruth = {
  user: string;
  must: string[];
  forbid: string[];
  pivoted?: boolean;
};

export type Episode = {
  name: string;
  turns: TurnTruth[];
  lock: RegExp;
  accept?: string;
  reject: string[];
  must: string[];
  forbid: string[];
  outline?: string;
};

export const episodes: Episode[] = [
  {
    name: "skill then trace",
    turns: [
      { user: '<skill name="cto-os-daily-standup"> run the standup', must: [], forbid: ["standup", "skill"] },
      { user: "Can we fix the pi-brief TUI? one line on top and one on the bottom", must: ["pi-brief"], forbid: ["standup"] },
      { user: "does this do the job?", must: ["pi-brief"], forbid: ["does this", "standup"] },
      { user: "I want an agentic trace on the right that shows when the goal changes", must: ["trace"], forbid: ["standup"] },
      { user: "present that trace with the model. Do not copy the tree", must: ["trace"], forbid: ["standup", "copy the tree"] },
      { user: "why is the goal daily standup? that clearly is not", must: ["trace"], forbid: ["standup", "explain", "why is the goal"] },
      { user: "if you re-analyze this transcript, what is the goal?", must: ["trace"], forbid: ["standup", "what is the goal"] },
    ],
    lock: /fix the pi-brief TUI/,
    accept: "Show a model-written agent trace while the session runs",
    reject: ["Run the daily standup", "Explain why the goal is standup", "what is the goal?"],
    must: ["trace"],
    forbid: ["standup", "explain", "hilarious", "skill", "what is the goal"],
  },
  {
    name: "explicit pivot",
    turns: [
      { user: "Fix the brief footer", must: ["footer"], forbid: ["pricing"] },
      { user: "instead, write the pricing page", must: ["pricing"], forbid: ["footer"], pivoted: true },
      { user: "try again", must: ["pricing"], forbid: ["footer", "try again"] },
    ],
    lock: /pricing page/,
    reject: ["Fix the brief footer", "Run the daily standup"],
    must: ["pricing"],
    forbid: ["footer", "brief"],
  },
  {
    name: "checks do not move the job",
    turns: [
      { user: "Add tests for the brief parser", must: ["test"], forbid: [] },
      { user: "try again", must: ["test"], forbid: ["try again"] },
      { user: "do it", must: ["test"], forbid: ["do it"] },
      { user: "does this work?", must: ["test"], forbid: ["does this"] },
      { user: "what is the goal?", must: ["test"], forbid: ["what is the goal"] },
    ],
    lock: /Add tests for the brief parser/,
    reject: ["does this work?", "try again", "what is the goal?"],
    must: ["test"],
    forbid: ["does this", "try again", "what is the goal"],
  },
  {
    name: "skill then a different product",
    turns: [
      { user: '<skill name="cto-os-daily-standup"> run the standup', must: [], forbid: ["standup", "skill"] },
      { user: "Ship the homepage copy", must: ["homepage"], forbid: ["standup"] },
      { user: "looks good", must: ["homepage"], forbid: ["standup", "looks good"] },
    ],
    lock: /Ship the homepage copy/,
    reject: ["Run the daily standup", "cto-os-daily-standup"],
    must: ["homepage"],
    forbid: ["standup", "skill"],
  },
];

export function usersOf(episode: Episode): string[] {
  return episode.turns.map((turn) => turn.user);
}

export function outlineFor(users: string[]): string {
  return sessionOutline(users.map((text, index) => ({ id: `u${index}`, type: "message", message: { role: "user", content: text } }))) || JSON.stringify({ version: 1, users: [], activity: [], coverage: { omittedUsers: 0, omittedActivity: 0, truncated: 0, wrappers: users.length } });
}

export const goalSessions = episodes.map((episode) => ({
  name: episode.name,
  users: usersOf(episode),
  lock: episode.lock,
  accept: episode.accept,
  reject: episode.reject,
  must: episode.must,
  forbid: episode.forbid,
}));
