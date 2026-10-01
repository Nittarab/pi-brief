// Offline aggregation only. This module never imports the extension, model registry or provider runtime.
import { constants, createReadStream, openSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fingerprint, parseDiagnostic, type DiagnosticRecord } from "./diagnostics.ts";

export const reportMaxFileBytes = 32 * 1_048_576;
export const reportMaxTotalBytes = 128 * 1_048_576;
export const reportMaxFiles = 256;
export const reportMaxRecords = 100_000;
type Options = { since?: string; session?: string };
export type ReadDiagnostics = { records: DiagnosticRecord[]; files: number; invalid: number; skipped: number; importedIssues?: number };

export async function readDiagnostics(paths: string[]): Promise<ReadDiagnostics> {
  const result: ReadDiagnostics = { records: [], files: 0, invalid: 0, skipped: 0 };
  let bytes = 0, scanned = 0;
  const visited = new Set<string>();
  const countInput = () => { if (++scanned > reportMaxRecords) throw new Error("diagnostic report exceeds record limit"); };
  const accept = (raw: unknown) => {
    const row = parseDiagnostic(raw);
    if (!row) { result.invalid++; return; }
    if (result.records.length >= reportMaxRecords) throw new Error("diagnostic report exceeds record limit");
    result.records.push(row);
  };
  const visit = async (path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) { result.skipped++; return; }
    if (stat.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.length > 1024) throw new Error("diagnostic directory exceeds entry limit");
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // Do not crawl sessions, credentials, or other extension data in a mistakenly supplied agent directory.
        if (!entry.isDirectory() && /^[a-f0-9-]{36}-\d+\.jsonl$/.test(entry.name)) await visit(join(path, entry.name));
      }
      return;
    }
    if (!stat.isFile()) { result.skipped++; return; }
    if (++result.files > reportMaxFiles || stat.size > reportMaxFileBytes || (bytes += stat.size) > reportMaxTotalBytes) throw new Error("diagnostic report exceeds input limits");
    if (path.endsWith(".json")) {
      let bundle: unknown;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stream = createReadStream(path, { fd, autoClose: true, end: Math.max(0, stat.size - 1) });
      const chunks: Buffer[] = [];
      try { for await (const chunk of stream) chunks.push(Buffer.from(chunk)); }
      finally { stream.destroy(); }
      try { bundle = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { result.invalid++; return; }
      const data = bundle as { schema?: unknown; records?: unknown; invalid?: unknown; skipped?: unknown; conflicts?: unknown; importedIssues?: unknown } | null;
      if (!data || data.schema !== 1 || !Array.isArray(data.records)) { result.invalid++; return; }
      // Preserve evidence of gaps in exported reports, even though invalid raw rows were not exported.
      for (const key of ["invalid", "skipped", "conflicts", "importedIssues"] as const) {
        const count = data[key];
        if (typeof count === "number" && Number.isSafeInteger(count) && count > 0) result.importedIssues = (result.importedIssues ?? 0) + count;
      }
      for (const raw of data.records) { countInput(); accept(raw); }
    } else {
      if (!stat.size) return;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stream = createReadStream(path, { fd, autoClose: true, end: stat.size - 1 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let readError: unknown;
      stream.on("error", (error) => { readError = error; lines.close(); });
      try {
        for await (const line of lines) {
          countInput();
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > 2048) { result.invalid++; continue; }
          try { accept(JSON.parse(line)); } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            result.invalid++;
          }
        }
        if (readError) throw readError;
      } finally { lines.close(); stream.destroy(); }
    }
  };
  for (const path of paths) await visit(path);
  return result;
}

export function diagnosticReport(input: ReadDiagnostics, options: Options = {}) {
  const since = options.since === undefined ? -Infinity : Date.parse(options.since);
  if (!Number.isFinite(since) && options.since !== undefined) throw new Error("invalid --since timestamp");
  const session = options.session === undefined ? undefined : fingerprint(options.session);
  const seen = new Map<string, string>();
  const records: DiagnosticRecord[] = [];
  let duplicates = 0, conflicts = 0;
  for (const raw of input.records) {
    const row = parseDiagnostic(raw);
    if (!row) { input = { ...input, invalid: input.invalid + 1 }; continue; }
    const encoded = JSON.stringify(row), key = `${row.installation}:${row.id}`;
    const previous = seen.get(key);
    if (previous !== undefined) { if (previous === encoded) duplicates++; else conflicts++; continue; }
    seen.set(key, encoded);
    if (Date.parse(row.timestamp) < since || session !== undefined && row.session !== session && row.session !== options.session) continue;
    records.push(row);
  }
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  type Operation = { start?: DiagnosticRecord; end?: DiagnosticRecord; rejected: boolean; failureCodes: Set<string> };
  type Attempt = { start?: DiagnosticRecord; end?: DiagnosticRecord; cost?: number; costConflict?: boolean };
  const operations = new Map<string, Operation>(), attempts = new Map<string, Attempt>();
  const installations = new Map<string, { id: string; platforms: Set<string>; versions: Set<string>; builds: Set<string> }>();
  const failures: DiagnosticRecord[] = [];
  const byCode: Record<string, number> = {};
  let setupFailures = 0, costOverflow = false;
  for (const row of records) {
    const installation = installations.get(row.installation) ?? { id: row.installation, platforms: new Set(), versions: new Set(), builds: new Set() };
    installation.platforms.add(row.platform); installation.versions.add(row.version); installation.builds.add(row.build); installations.set(row.installation, installation);
    if (row.event === "setup") { setupFailures++; failures.push(row); byCode[row.code] = (byCode[row.code] ?? 0) + 1; continue; }
    const opKey = `${row.installation}:${row.operation}`;
    const operation = operations.get(opKey) ?? { rejected: false, failureCodes: new Set() };
    operations.set(opKey, operation);
    if (row.event === "operation_start") operation.start = row;
    if (row.event === "operation_end") operation.end = row;
    if (row.event === "attempt_start" || row.event === "attempt_end" || row.event === "usage") {
      const key = `${opKey}:${row.attempt}`;
      const attempt = attempts.get(key) ?? {};
      attempts.set(key, attempt);
      if (row.event === "attempt_start") attempt.start = row;
      if (row.event === "attempt_end") {
        attempt.end = row;
        if (row.outcome === "rejected") operation.rejected = true;
        if (["rejected", "failed"].includes(row.outcome)) operation.failureCodes.add(row.code);
      }
      // Repeated exports are deduplicated by event ID; only one reported cost per attempt is counted.
      if (row.event === "usage") {
        if (attempt.cost !== undefined && attempt.cost !== row.costUsd) { conflicts++; attempt.costConflict = true; }
        attempt.cost ??= row.costUsd;
      }
    }
    if (row.event === "attempt_end" && ["rejected", "failed"].includes(row.outcome) || row.event === "operation_end" && row.outcome === "failed") {
      failures.push(row);
      if (row.event === "attempt_end") byCode[row.code] = (byCode[row.code] ?? 0) + 1;
    }
  }
  const opValues = [...operations.values()], attemptValues = [...attempts.values()];
  // Same-millisecond event ordering must not double-count the terminal operation failure.
  for (const op of opValues) if (op.end?.outcome === "failed" && !op.failureCodes.has(op.end.code)) byCode[op.end.code] = (byCode[op.end.code] ?? 0) + 1;
  let cost = 0, compensation = 0;
  for (const attempt of attemptValues) {
    // Same-timestamp UUID ordering is arbitrary; compensate for floating-point accumulation error.
    const value = (attempt.costConflict ? 0 : attempt.cost ?? 0) - compensation;
    const sum = cost + value;
    if (Number.isFinite(sum)) { compensation = (sum - cost) - value; cost = sum; }
    else costOverflow = true;
  }
  const warnings = ["Only retained diagnostics since logging was enabled are covered; old unrecorded failures cannot be reconstructed.",
    "Logging is best-effort and subject to retention, crashes and filesystem errors. No complete-history or live-model-accuracy claim."];
  if (!records.length) warnings.push("No diagnostic records found. This is not evidence of zero failures.");
  if (input.invalid || input.skipped || conflicts || input.importedIssues) warnings.push("Some input records or source reports were invalid, skipped, conflicting or incomplete; the report is incomplete.");
  if (costOverflow) warnings.push("Reported costs exceeded numeric limits; total cost is unknown.");
  return {
    schema: 1 as const, metadataOnly: true, files: input.files, invalid: input.invalid, skipped: input.skipped, importedIssues: input.importedIssues ?? 0, duplicates, conflicts,
    first: records[0]?.timestamp ?? null, last: records.at(-1)?.timestamp ?? null,
    installations: [...installations.values()].map((item) => ({ id: item.id, platforms: [...item.platforms].sort(), versions: [...item.versions].sort(), builds: [...item.builds].sort() })),
    totals: {
      operations: operations.size, accepted: opValues.filter((op) => op.end?.outcome === "accepted").length,
      recovered: opValues.filter((op) => op.rejected && op.end?.outcome === "accepted").length,
      failed: opValues.filter((op) => op.end?.outcome === "failed").length,
      cancelled: opValues.filter((op) => ["cancelled", "superseded"].includes(op.end?.outcome ?? "")).length,
      incompleteOperations: opValues.filter((op) => !op.start || !op.end).length,
      attempts: attempts.size, rejectedAttempts: attemptValues.filter((attempt) => attempt.end?.outcome === "rejected").length,
      incompleteAttempts: attemptValues.filter((attempt) => !attempt.start || !attempt.end).length,
      usageUnknownAttempts: attemptValues.filter((attempt) => attempt.cost === undefined || attempt.costConflict).length,
      reportedCostUsd: costOverflow ? null : cost, setupFailures,
    },
    byCode, failures, warnings, records, // Metadata-only records make JSON exports mergeable without sharing sessions.
  };
}

export function reportText(report: ReturnType<typeof diagnosticReport>, details = false): string {
  const s = report.totals;
  const lines = ["pi-brief diagnostics (offline, retained history only)",
    `${report.installations.length} installations · ${s.operations} operations · ${s.attempts} attempts`,
    `${s.accepted} accepted (${s.recovered} repaired) · ${s.failed} failed · ${s.cancelled} cancelled/superseded · ${s.setupFailures} setup failures`,
    `${s.rejectedAttempts} rejected attempts · ${s.incompleteOperations} incomplete operations · ${s.incompleteAttempts} incomplete attempts`,
    `Reported cost: ${s.reportedCostUsd === null ? "unknown" : `$${s.reportedCostUsd.toFixed(5)}`} · ${s.usageUnknownAttempts} attempts without returned usage`,
    `Invalid records: ${report.invalid} · skipped files: ${report.skipped} · duplicates: ${report.duplicates} · conflicts: ${report.conflicts} · source-report issues: ${report.importedIssues}`,
    ...Object.entries(report.byCode).sort().map(([code, count]) => `${code}: ${count}`)];
  if (details) for (const row of report.failures) lines.push(`${row.timestamp} ${row.platform}/${row.installation.slice(0, 8)} session:${row.session} branch:${row.branch} ${row.version}/${row.build} ${row.model} ${row.event} call:${row.attempt} ${row.code}`);
  lines.push(...report.warnings.map((warning) => `Note: ${warning}`));
  return lines.join("\n");
}
