import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { cleanText, type Evidence } from "./evidence.ts";
import { parseJudgment, promptFor, type Judgment } from "./judgment.ts";
export { cleanText, visibleText, sessionOutline } from "./evidence.ts";
export { promptFor } from "./judgment.ts";

export type Brief = { goal: string; done: string; now: string; next: string; blocked: string };
export type Activity = { type: "user" | "assistant" | "tool"; text: string };
export type SummaryResult = { text: string; cost: number; error?: string };
export type Summarize = (prompt: string, signal: AbortSignal) => Promise<SummaryResult>;
export type Presented = { who: "user" | "agent"; kind: "task" | "turn" | "pivot" | "drift"; text: string };
const fields = ["goal", "done", "now", "next", "blocked"] as const;
const blank: Brief = { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };

export function isBrief(value: unknown): value is Brief {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string");
}

export function parseBrief(text: string): Brief {
  const parsed: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!isBrief(parsed)) throw new Error("missing brief field or invalid brief object");
  return Object.fromEntries(fields.map((field) => [field, cleanText(parsed[field], 140) || "—"])) as Brief;
}

// Old session entries can still be read, but live replies use parseJudgment instead.
export function parsePresented(text: string): Presented[] {
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const trace = parsed?.trace;
    if (!Array.isArray(trace)) return [];
    return trace.slice(0, 6).flatMap((row: unknown): Presented[] => {
      if (!row || typeof row !== "object") return [];
      const item = row as Presented;
      if (!["task", "pivot", "drift", "turn"].includes(item.kind) || !["user", "agent"].includes(item.who) || typeof item.text !== "string") return [];
      return [{ who: item.kind === "task" || item.kind === "pivot" ? "user" : "agent", kind: item.kind, text: cleanText(item.text, 140) }];
    });
  } catch { return []; }
}

export function display(brief: Brief, state?: string): string[] {
  const lines = fields.map((field) => `${field[0].toUpperCase()}${field.slice(1)}: ${brief[field]}`);
  return state ? [`Brief · ${state}`, ...lines] : ["Brief", ...lines];
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "…";
  return `${sliceByColumn(text, 0, width - 1, true)}…`;
}

export function briefLine(brief: Brief | undefined, state = "", width = 120): string {
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (limit === 0) return "";
  if (state) return clip(`Brief · ${cleanText(state, 80)}`, limit);
  const goal = cleanText(brief?.goal ?? "—", 140) || "—";
  const now = cleanText(brief?.now ?? "—", 140) || "—";
  const full = `Goal: ${goal} · Now: ${now}`;
  if (visibleWidth(full) <= limit) return full;
  const head = "Goal: ", mid = " · Now: ";
  if (limit <= visibleWidth(head) + visibleWidth(mid)) return clip(full, limit);
  const budget = limit - visibleWidth(head) - visibleWidth(mid);
  const goalColumns = visibleWidth(goal), nowColumns = visibleWidth(now);
  let goalWidth = Math.min(goalColumns, Math.max(1, Math.round(budget * goalColumns / (goalColumns + nowColumns))));
  let nowWidth = budget - goalWidth;
  if (nowWidth > nowColumns) { goalWidth = Math.min(goalColumns, goalWidth + nowWidth - nowColumns); nowWidth = nowColumns; }
  if (nowWidth < 1) { nowWidth = 1; goalWidth = budget - nowWidth; }
  return `${head}${clip(goal, goalWidth)}${mid}${clip(now, nowWidth)}`;
}

export class BriefController {
  private summary: Brief;
  private pending: Activity[] = [];
  private ready = false;
  private abort: AbortController | undefined;
  private running = false;
  private closed = false;
  private failed = false;
  private calls = 0;
  private cost = 0;
  private error: string | undefined;
  private outlineMode = false;
  private sentOutline = "";
  private inFlightOutline = "";
  private shown: Presented[] = [];
  private revision = 0;
  private judgment: Judgment | undefined;

  constructor(
    private readonly summarize: Summarize,
    private readonly onChange: (brief: Brief, changed: boolean) => void,
    initial?: Brief,
    private readonly maxCalls = 80,
    private readonly maxCostUsd: number | null = null,
    initialPresented: Presented[] = [],
    private readonly initialGoalSources: string[] = [],
  ) {
    this.summary = initial ? { ...initial } : { ...blank };
    this.shown = initialPresented.map((step) => ({ ...step }));
  }

  get brief(): Brief { return { ...this.summary }; }
  get presented(): Presented[] { return this.shown.map((step) => ({ ...step })); }
  get goalSources(): string[] { return [...(this.judgment?.goalSources ?? this.initialGoalSources)]; }
  get alignment(): Judgment["alignment"] { return this.judgment?.alignment ?? "unknown"; }
  get stats() { return { calls: this.calls, cost: this.cost, error: this.error, pending: this.pending.length, running: this.running,
    limit: this.calls >= this.maxCalls || (this.maxCostUsd !== null && this.cost >= this.maxCostUsd) }; }

  // A new user turn invalidates old work without spending a call before settlement.
  invalidate(): void { this.revision++; this.pending = []; this.ready = false; this.sentOutline = ""; this.inFlightOutline = ""; }

  add(event: Activity, summarizeNow = false): void {
    if (this.closed) return;
    const text = cleanText(event.text);
    if (!text) return;
    this.outlineMode = false;
    this.pending.push({ type: event.type, text });
    this.pending = this.pending.slice(-20);
    this.failed = false;
    if (summarizeNow) this.trigger();
  }

  revise(outline: string, force = false): void {
    if (this.closed || !outline || outline === this.sentOutline || outline === this.inFlightOutline || outline === this.pending[0]?.text && !this.failed || (!force && this.failed)) return;
    // Already bounded by the evidence builder. Never cut serialized JSON or its newest records.
    this.pending = [{ type: "user", text: outline }];
    this.outlineMode = true;
    this.revision++;
    this.failed = false;
    this.trigger();
  }

  trigger(): void {
    if (this.closed || !this.pending.length || this.failed) return;
    this.ready = true;
    void this.flush();
  }

  async flush(retry = false): Promise<void> {
    if (retry) { this.failed = false; this.ready = true; }
    if (this.closed || this.running || !this.pending.length || this.failed || this.stats.limit) return;
    this.ready = false;
    const activity = this.pending, outline = this.outlineMode, revision = this.revision;
    this.pending = [];
    this.running = true;
    this.inFlightOutline = outline ? activity[0]?.text ?? "" : "";
    this.calls++;
    const abort = new AbortController();
    this.abort = abort;
    try {
      const result = await this.summarize(promptFor(this.summary, activity, outline), abort.signal);
      if (!Number.isFinite(result.cost) || result.cost < 0) throw new Error("invalid model cost");
      this.cost += result.cost; // Malformed and superseded replies may still be billed.
      if (this.closed || abort.signal.aborted || revision !== this.revision) return;
      if (result.error) throw new Error(result.error);
      const judgment = outline ? parseJudgment(result.text, JSON.parse(activity[0]!.text) as Evidence) : undefined;
      const next = judgment?.brief ?? parseBrief(result.text);
      const presented = judgment?.presented ?? parsePresented(result.text);
      this.error = undefined;
      const changed = JSON.stringify(judgment) !== JSON.stringify(this.judgment) || JSON.stringify(presented) !== JSON.stringify(this.shown) || fields.some((field) => next[field] !== this.summary[field]);
      this.shown = presented; // Empty is a valid update; never retain stale drift.
      this.summary = next;
      this.judgment = judgment;
      if (outline) this.sentOutline = activity[0]?.text ?? "";
      this.onChange(this.brief, changed);
    } catch (error) {
      if (!this.closed && !abort.signal.aborted && revision === this.revision) {
        this.error = cleanText(error instanceof Error ? error.message : String(error), 110);
        this.failed = true;
        this.ready = false;
        this.pending = [...activity, ...this.pending].slice(-20);
        this.onChange(this.brief, false);
      }
    } finally {
      if (this.abort === abort) this.abort = undefined;
      this.running = false;
      this.inFlightOutline = "";
      if (this.ready) void this.flush();
    }
  }

  close(): void {
    this.closed = true;
    this.invalidate();
    this.abort?.abort();
  }
}
