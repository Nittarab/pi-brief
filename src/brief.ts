import { randomUUID } from "node:crypto";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { BriefCancellation, failureCode, validationCode, type CancellationCode, type DiagnosticCode, type DiagnosticEvent, type DiagnosticObserver, type DiagnosticSink } from "./diagnostics.ts";
import { cleanText, type Evidence } from "./evidence.ts";
import { parseBriefFields, parseJudgment, promptFor, repairPromptFor, type Judgment } from "./judgment.ts";
export { cleanText, visibleText, sessionOutline } from "./evidence.ts";
export { promptFor } from "./judgment.ts";

export type Brief = { goal: string; done: string; now: string; next: string; blocked: string };
export type Activity = { type: "user" | "assistant" | "tool"; text: string };
export type SummaryResult = { text: string; cost: number; error?: string; repairable?: boolean };
export type Summarize = (prompt: string, signal: AbortSignal, reportCost?: (cost: number) => void) => Promise<SummaryResult>;
export type Presented = { who: "user" | "agent"; kind: "task" | "turn" | "pivot" | "drift"; text: string };
const fields = ["goal", "done", "now", "next", "blocked"] as const;
const blank: Brief = { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };
export const maxSummaryCalls = 3;
export const operationTimeoutMs = 75_000;
type AttemptState = { number: number; repair: boolean; startedAt: number; started: boolean; finished: boolean };

export function isBrief(value: unknown): value is Brief {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return fields.every((field) => typeof (value as Record<string, unknown>)[field] === "string");
}

export function parseBrief(text: string): Brief {
  const parsed: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!isBrief(parsed)) throw new Error("missing brief field or invalid brief object");
  return parseBriefFields(parsed);
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
  private attempt = 0;
  private repairing = false;
  private retryPrompt: { original: string; prompt: string } | undefined;
  private calls = 0;
  private cost = 0;
  private error: string | undefined;
  private outlineMode = false;
  private sentOutline = "";
  private inFlightOutline = "";
  private shown: Presented[] = [];
  private revision = 0;
  private judgment: Judgment | undefined;
  private idleWaiters = new Set<() => void>();

  constructor(
    private readonly summarize: Summarize,
    private readonly onChange: (brief: Brief, changed: boolean) => void,
    initial?: Brief,
    initialPresented: Presented[] = [],
    private readonly initialProvenance?: Pick<Judgment, "goalSources" | "alignment">,
    private readonly diagnostics?: DiagnosticObserver,
  ) {
    this.summary = initial ? { ...initial } : { ...blank };
    this.shown = initialPresented.map((step) => ({ ...step }));
  }

  get brief(): Brief { return { ...this.summary }; }
  get presented(): Presented[] { return this.shown.map((step) => ({ ...step })); }
  get goalSources(): string[] { return [...(this.judgment?.goalSources ?? this.initialProvenance?.goalSources ?? [])]; }
  get alignment(): Judgment["alignment"] { return this.judgment?.alignment ?? this.initialProvenance?.alignment ?? "unknown"; }
  get stats() { return { calls: this.calls, cost: this.cost, error: this.error, pending: this.pending.length, running: this.running,
    failed: this.failed, attempt: this.attempt, repairing: this.running && !this.failed && !this.abort?.signal.aborted && this.repairing }; }

  waitForIdle(): Promise<void> {
    if (this.closed || !this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private releaseWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  // A new user turn invalidates old work without spending a call before settlement.
  invalidate(reason: CancellationCode = "superseded"): void {
    this.revision++;
    this.abort?.abort(new BriefCancellation(reason));
    this.pending = [];
    this.ready = false;
    this.failed = false;
    this.error = undefined;
    this.retryPrompt = undefined;
    this.sentOutline = "";
    this.inFlightOutline = "";
  }

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
    this.abort?.abort(new BriefCancellation("superseded"));
    this.failed = false;
    this.trigger();
  }

  trigger(): void {
    if (this.closed || !this.pending.length || this.failed) return;
    this.ready = true;
    void this.flush();
  }

  private diagnosticSink(): DiagnosticSink {
    let sink: DiagnosticSink | undefined;
    try { sink = this.diagnostics?.(); } catch { /* Observability cannot affect model work. */ }
    return (event) => { try { sink?.(event); } catch { /* No retry or brief failure on logging errors. */ } };
  }

  private async request(prompt: string, signal: AbortSignal, operation: string, state: AttemptState, record: DiagnosticSink): Promise<SummaryResult> {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      this.calls++;
      state.started = true;
      state.startedAt = Date.now();
      record({ event: "attempt_start", operation, attempt: state.number, repair: state.repair, outcome: "running", code: "none", durationMs: 0 });
      // Account before the stale/abort gate. The adapter can report late usage even after cancellation.
      let reported = false;
      const reportCost = (cost: number) => {
        if (!Number.isFinite(cost) || cost < 0) throw new Error("invalid model cost");
        if (!reported) {
          this.cost += cost;
          reported = true;
          record({ event: "usage", operation, attempt: state.number, repair: state.repair, outcome: "running", code: "none",
            durationMs: Math.max(0, Date.now() - state.startedAt), costUsd: cost, late: state.finished });
        }
      };
      const result = this.summarize(prompt, signal, reportCost).then((result) => {
        reportCost(result.cost);
        return result;
      });
      return await Promise.race([result, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async flush(retry = false): Promise<void> {
    if (retry) { this.failed = false; this.ready = true; }
    if (this.closed || this.running || !this.pending.length || this.failed) return;
    this.ready = false;
    const activity = this.pending, outline = this.outlineMode, revision = this.revision;
    this.pending = [];
    this.running = true;
    this.inFlightOutline = outline ? activity[0]?.text ?? "" : "";
    this.error = undefined;
    const abort = new AbortController();
    this.abort = abort;
    const deadline = AbortSignal.timeout(operationTimeoutMs);
    const signal = AbortSignal.any([abort.signal, deadline]);
    const record = this.diagnosticSink(), operation = randomUUID(), startedAt = Date.now();
    let active: AttemptState | undefined;
    let outcome: DiagnosticEvent["outcome"] = "failed", code: DiagnosticCode = "input";
    const finishAttempt = (result: DiagnosticEvent["outcome"], reason: DiagnosticCode) => {
      if (!active?.started || active.finished) return;
      active.finished = true;
      record({ event: "attempt_end", operation, attempt: active.number, repair: active.repair, outcome: result, code: reason,
        durationMs: Math.max(0, Date.now() - active.startedAt) });
    };
    record({ event: "operation_start", operation, attempt: 0, repair: false, outcome: "running", code: "none", durationMs: 0 });
    try {
      // Freeze both evidence and previous brief for the entire validation-and-repair operation.
      const source = outline ? JSON.parse(activity[0]!.text) as Evidence : undefined;
      const original = promptFor(this.summary, activity, outline);
      // Manual retry of identical input also includes feedback, rather than repeating a failed prompt.
      let prompt = this.retryPrompt?.original === original ? this.retryPrompt.prompt : original;
      this.retryPrompt = undefined;
      for (let attempt = 1; attempt <= maxSummaryCalls; attempt++) {
        signal.throwIfAborted();
        if (this.closed || revision !== this.revision) return;
        this.attempt = attempt;
        this.repairing = prompt !== original;
        if (this.repairing) this.onChange(this.brief, false); // Retain the last accepted brief during repair.
        active = { number: attempt, repair: this.repairing, startedAt: Date.now(), started: false, finished: false };
        code = "internal";
        const result = await this.request(prompt, signal, operation, active, record);
        if (this.closed || abort.signal.aborted || revision !== this.revision) return;
        signal.throwIfAborted();
        // Transport, authentication and provider failures are not output-validation failures.
        if (result.error && !result.repairable) throw new Error(result.error);
        let judgment: Judgment | undefined, next: Brief, presented: Presented[];
        try {
          // A token-limit stop is an incomplete output, never an accepted partial judgment.
          if (result.error) throw new Error(result.error);
          judgment = source ? parseJudgment(result.text, source) : undefined;
          next = judgment?.brief ?? parseBrief(result.text);
          presented = judgment?.presented ?? parsePresented(result.text);
        } catch (error) {
          const validationError = error instanceof Error ? error.message : String(error);
          code = result.repairable ? "output_tokens" : validationCode(error);
          finishAttempt("rejected", code);
          try { prompt = repairPromptFor(original, result.text, validationError); }
          catch (boundsError) { code = "repair_bounds"; throw boundsError; }
          if (attempt === maxSummaryCalls) {
            this.retryPrompt = { original, prompt }; // Bounded feedback for an explicit retry, never an automatic call.
            throw new Error(`invalid brief after ${maxSummaryCalls} calls: ${validationError}; /brief refresh to retry`);
          }
          continue;
        }
        finishAttempt("accepted", "none");
        code = "internal";
        const changed = JSON.stringify(judgment) !== JSON.stringify(this.judgment) || JSON.stringify(presented) !== JSON.stringify(this.shown) || fields.some((field) => next[field] !== this.summary[field]);
        this.shown = presented; // Empty is a valid update; never retain stale drift.
        this.summary = next;
        this.judgment = judgment;
        if (outline) this.sentOutline = activity[0]?.text ?? "";
        this.onChange(this.brief, changed);
        outcome = "accepted";
        code = "none";
        return;
      }
    } catch (error) {
      if (deadline.aborted && !abort.signal.aborted) code = "operation_timeout";
      else if (active?.started && !active.finished) code = failureCode(error);
      if (!this.closed && !abort.signal.aborted && revision === this.revision) {
        this.error = deadline.aborted ? "brief update timed out after 75 seconds; /brief refresh to retry"
          : cleanText(error instanceof Error ? error.message : String(error), 240);
        this.failed = true;
        this.ready = false;
        this.pending = [...activity, ...this.pending].slice(-20);
        this.onChange(this.brief, false);
      }
    } finally {
      if (abort.signal.aborted || revision !== this.revision || this.closed) {
        code = abort.signal.reason instanceof BriefCancellation ? abort.signal.reason.code : "superseded";
        outcome = code === "superseded" || code === "navigation" ? "superseded" : "cancelled";
      }
      finishAttempt(outcome, code);
      record({ event: "operation_end", operation, attempt: active?.started ? active.number : 0, repair: active?.repair ?? false,
        outcome, code, durationMs: Math.max(0, Date.now() - startedAt) });
      if (this.abort === abort) this.abort = undefined;
      this.running = false;
      this.attempt = 0;
      this.repairing = false;
      this.inFlightOutline = "";
      if (this.ready) void this.flush();
      if (!this.running) this.releaseWaiters();
    }
  }

  close(reason: CancellationCode = "shutdown"): void {
    this.closed = true;
    this.invalidate(reason);
    this.releaseWaiters();
  }
}
