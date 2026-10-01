// Opt-in, local-only metadata. Never serialize prompts, evidence, replies, or error messages.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, constants, closeSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const diagnosticCodes = ["none", "json", "schema", "citation", "length_goal", "length_now", "length_done", "length_next", "length_blocked", "length_trace",
  "output_tokens", "repair_bounds", "authentication", "network", "provider", "request_timeout", "operation_timeout", "usage_invalid", "input", "internal",
  "superseded", "navigation", "reload", "shutdown", "config", "model_missing"] as const;
export type DiagnosticCode = typeof diagnosticCodes[number];
export type CancellationCode = "superseded" | "navigation" | "reload" | "shutdown";
export const diagnosticEvents = ["operation_start", "attempt_start", "attempt_end", "usage", "operation_end", "setup"] as const;
export const diagnosticOutcomes = ["running", "accepted", "rejected", "failed", "cancelled", "superseded"] as const;
export type DiagnosticEvent = {
  event: typeof diagnosticEvents[number];
  operation: string;
  attempt: number;
  repair: boolean;
  outcome: typeof diagnosticOutcomes[number];
  code: DiagnosticCode;
  durationMs: number;
  costUsd?: number;
  late?: boolean;
};
export type DiagnosticSink = (event: DiagnosticEvent) => void;
export type DiagnosticObserver = () => DiagnosticSink;
export type DiagnosticRecord = DiagnosticEvent & {
  schema: 1; id: string; timestamp: string; installation: string; run: string;
  platform: string; version: string; build: string; promptVersion: string; model: string; session: string; branch: string;
};
export const diagnosticMaxFileBytes = 1_048_576;
export const diagnosticMaxFiles = 10;
export const diagnosticMaxAgeMs = 30 * 24 * 60 * 60 * 1000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fingerprintPattern = /^[a-f0-9]{16}$/;
const token = /^[a-zA-Z0-9._+/-]{1,80}$/;
const modelPattern = /^[^\s\x00-\x1f\x7f-\x9f]{1,160}$/u;
const logName = /^[a-f0-9-]{36}-\d+\.jsonl$/;
export const diagnosticDirectory = (agentDir: string) => join(agentDir, "brief-diagnostics");
export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

export class BriefCancellation extends Error {
  constructor(public readonly code: CancellationCode) { super("brief update cancelled"); }
}

export function validationCode(error: unknown): DiagnosticCode {
  if (error instanceof SyntaxError) return "json";
  const message = error instanceof Error ? error.message : "";
  const length = /^brief (goal|now|done|next|blocked) must be a short TL;DR$/.exec(message);
  if (length) return `length_${length[1]}` as DiagnosticCode;
  if (/^brief trace .* must be a short TL;DR$/.test(message)) return "length_trace";
  if (/evidence|alignment|pivot|drift/.test(message)) return "citation";
  return "schema";
}

export function failureCode(error: unknown): DiagnosticCode {
  if (error instanceof BriefCancellation) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "request_timeout";
  const message = error instanceof Error ? error.message : "";
  if (message === "invalid model cost") return "usage_invalid";
  if (/^repair feedback exceeds /.test(message)) return "repair_bounds";
  // Provider categories are best-effort; the underlying message is never persisted.
  if (/\b401\b|\b403\b|unauthori[sz]ed|authentication|api.?key/i.test(message)) return "authentication";
  if (/network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket|\bdns\b/i.test(message)) return "network";
  return "provider";
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

// Explicit projection doubles as the privacy boundary for imported, untrusted reports.
export function parseDiagnostic(value: unknown): DiagnosticRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const row = value as Record<string, unknown>;
  if (row.schema !== 1 || !enumValue(row.event, diagnosticEvents) || !enumValue(row.outcome, diagnosticOutcomes) || !enumValue(row.code, diagnosticCodes)) return;
  for (const key of ["id", "installation", "run", "operation"] as const) if (typeof row[key] !== "string" || !uuid.test(row[key])) return;
  for (const key of ["session", "branch"] as const) if (typeof row[key] !== "string" || !fingerprintPattern.test(row[key])) return;
  for (const key of ["platform", "version", "promptVersion"] as const) if (typeof row[key] !== "string" || !token.test(row[key])) return;
  if (row.build !== "unknown" && (typeof row.build !== "string" || !fingerprintPattern.test(row.build))) return;
  if (typeof row.model !== "string" || !modelPattern.test(row.model)) return;
  if (typeof row.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp)) || new Date(row.timestamp).toISOString() !== row.timestamp) return;
  if (!Number.isInteger(row.attempt) || (row.attempt as number) < 0 || (row.attempt as number) > 3 || typeof row.repair !== "boolean") return;
  if (typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs) || row.durationMs < 0) return;
  if (row.costUsd !== undefined && (typeof row.costUsd !== "number" || !Number.isFinite(row.costUsd) || row.costUsd < 0)) return;
  if (row.late !== undefined && typeof row.late !== "boolean") return;
  if (row.event.startsWith("attempt") || row.event === "usage") { if (row.attempt === 0) return; }
  if (row.event === "usage" && row.costUsd === undefined || row.event !== "usage" && (row.costUsd !== undefined || row.late !== undefined)) return;
  if (["operation_start", "attempt_start", "usage"].includes(row.event)) {
    if (row.outcome !== "running" || row.code !== "none") return;
  } else if (row.outcome === "running" || (row.outcome === "accepted") !== (row.code === "none")) return;
  if (row.event === "operation_start" && (row.attempt !== 0 || row.repair)) return;
  if (row.event === "operation_end" && row.outcome === "rejected") return;
  if (row.event === "setup" && (row.outcome !== "failed" || row.attempt !== 0 || row.repair || !["config", "model_missing"].includes(row.code))) return;
  return {
    schema: 1, id: row.id as string, timestamp: row.timestamp, installation: row.installation as string, run: row.run as string,
    platform: row.platform as string, version: row.version as string, build: row.build as string, promptVersion: row.promptVersion as string, model: row.model,
    session: row.session as string, branch: row.branch as string, event: row.event, operation: row.operation as string,
    attempt: row.attempt as number, repair: row.repair, outcome: row.outcome, code: row.code, durationMs: row.durationMs,
    ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd as number }), ...(row.late === undefined ? {} : { late: row.late }),
  };
}

export function extensionVersion(): string {
  try {
    const value = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    return typeof value === "string" && token.test(value) ? value : "unknown";
  } catch { return "unknown"; }
}

export function extensionBuild(): string {
  try {
    const hash = createHash("sha256");
    for (const name of ["brief", "diagnostics", "evidence", "index", "judgment", "model", "trace"]) {
      hash.update(`${name}\0`).update(readFileSync(new URL(`./${name}.ts`, import.meta.url)));
    }
    return hash.digest("hex").slice(0, 16);
  } catch { return "unknown"; }
}

// Capture once when this module is loaded, not after source files change in an open Pi process.
const loadedVersion = extensionVersion();
const loadedBuild = extensionBuild();

function ioCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,24}$/.test(code) ? code : "IO_ERROR";
}

export class DiagnosticLog {
  readonly directory: string;
  private readonly run = randomUUID();
  private installation = "";
  private part = 0;
  private problem: string | undefined;
  private readonly version = loadedVersion;
  readonly build = loadedBuild;

  constructor(agentDir: string, private readonly limits = { maxFileBytes: diagnosticMaxFileBytes, maxFiles: diagnosticMaxFiles, maxAgeMs: diagnosticMaxAgeMs }) {
    this.directory = diagnosticDirectory(agentDir);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) throw new Error("unsafe diagnostics directory");
      chmodSync(this.directory, 0o700);
      const path = join(this.directory, "installation-id");
      try { lstatSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const temporary = join(this.directory, `.installation-${randomUUID()}`);
        writeFileSync(temporary, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
        try {
          // Publish a complete ID atomically; simultaneous Pi processes share the winner's ID.
          try { linkSync(temporary, path); } catch (claimError) { if ((claimError as NodeJS.ErrnoException).code !== "EEXIST") throw claimError; }
        } finally { unlinkSync(temporary); }
      }
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile() || fstatSync(fd).size > 100) throw new Error("invalid installation id");
        this.installation = readFileSync(fd, "utf8").trim();
        if (!uuid.test(this.installation)) throw new Error("invalid installation id");
        fchmodSync(fd, 0o600);
      } finally { closeSync(fd); }
      this.prune();
    } catch (error) { this.problem = ioCode(error); }
  }

  get error(): string | undefined { return this.problem; }

  bind(sessionId: string, branchId: string, model: string, promptVersion: string): DiagnosticSink {
    const metadata = { session: fingerprint(sessionId), branch: fingerprint(branchId), model, promptVersion };
    return (event) => {
      if (this.problem) return;
      try {
        const row = parseDiagnostic({ ...event, ...metadata, schema: 1, id: randomUUID(), timestamp: new Date().toISOString(),
          installation: this.installation, run: this.run, platform: process.platform, version: this.version, build: this.build });
        if (!row) throw new Error("invalid diagnostic metadata");
        const line = `${JSON.stringify(row)}\n`;
        if (Buffer.byteLength(line) > this.limits.maxFileBytes) throw new Error("diagnostic record too large");
        let path = join(this.directory, `${this.run}-${this.part}.jsonl`);
        try {
          if (lstatSync(path).size + Buffer.byteLength(line) > this.limits.maxFileBytes) path = join(this.directory, `${this.run}-${++this.part}.jsonl`);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        try {
          if (!fstatSync(fd).isFile()) throw new Error("unsafe diagnostics file");
          fchmodSync(fd, 0o600);
          appendFileSync(fd, line);
        } finally { closeSync(fd); }
        this.prune();
      } catch (error) { this.problem = ioCode(error); } // Diagnostics must never break a summary or cause a retry.
    };
  }

  private prune(): void {
    const now = Date.now();
    const files = readdirSync(this.directory).filter((name) => logName.test(name)).flatMap((name) => {
      const path = join(this.directory, name);
      try { const stat = lstatSync(path); return stat.isFile() ? [{ path, modified: stat.mtimeMs }] : []; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    }).sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
    for (const [index, file] of files.entries()) {
      if (index >= this.limits.maxFiles || now - file.modified > this.limits.maxAgeMs) {
        try { unlinkSync(file.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
}
