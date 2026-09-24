import type { TurnTruth } from "./episodes.ts";

export type BriefAction = {
  goal: string;
  done: string;
  now: string;
  next: string;
  blocked: string;
  trace?: { task?: string; pivot?: string; drift?: string; steps?: string[] };
};

const diary = /^(applied|repeated|declared|asked|edited|kicked off|ran |checked|rewrote|finalizing|awaiting)\b/i;

export function parseAction(action: unknown): BriefAction | undefined {
  const value = typeof action === "string" ? parseJson(action) : action;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.goal !== "string") return undefined;
  const trace = row.trace && typeof row.trace === "object" && !Array.isArray(row.trace)
    ? row.trace as { task?: unknown; pivot?: unknown; drift?: unknown; steps?: unknown }
    : undefined;
  return {
    goal: row.goal,
    done: typeof row.done === "string" ? row.done : "—",
    now: typeof row.now === "string" ? row.now : "—",
    next: typeof row.next === "string" ? row.next : "—",
    blocked: typeof row.blocked === "string" ? row.blocked : "—",
    trace: trace ? {
      task: typeof trace.task === "string" ? trace.task : "",
      pivot: typeof trace.pivot === "string" ? trace.pivot : "",
      drift: typeof trace.drift === "string" ? trace.drift : "",
      steps: Array.isArray(trace.steps) ? trace.steps.filter((step): step is string => typeof step === "string") : [],
    } : undefined,
  };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); }
  catch { return undefined; }
}

function marked(value?: string): boolean {
  const text = value?.trim() ?? "";
  return Boolean(text) && text !== "—";
}

export function scoreBrief(action: BriefAction, truth: TurnTruth, pivoted = Boolean(truth.pivoted)): { total: number; parts: Record<string, number> } {
  const goal = action.goal.toLowerCase();
  const task = action.trace?.task?.toLowerCase() ?? "";
  const steps = action.trace?.steps ?? [];
  const parts = {
    goal: truth.must.every((word) => goal.includes(word.toLowerCase())) ? 0.45 : 0,
    clean: truth.forbid.every((word) => !goal.includes(word.toLowerCase())) ? 0.25 : 0,
    task: truth.must.length === 0 || truth.must.some((word) => task.includes(word.toLowerCase())) ? 0.15 : 0,
    diary: steps.every((step) => !diary.test(step)) ? 0.1 : 0,
    pivot: marked(action.trace?.pivot) === pivoted ? 0.05 : 0,
  };
  const total = Number(Object.values(parts).reduce((sum, part) => sum + part, 0).toFixed(2));
  return { total, parts };
}
