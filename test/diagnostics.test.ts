import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BriefController, operationTimeoutMs, type SummaryResult } from "../src/brief.ts";
import { BriefCancellation, DiagnosticLog, diagnosticDirectory, failureCode, fingerprint, parseDiagnostic, validationCode, type DiagnosticEvent, type DiagnosticRecord } from "../src/diagnostics.ts";
import { diagnosticReport, readDiagnostics, reportMaxFileBytes, reportText } from "../src/diagnostic-report.ts";
import { sessionOutline } from "../src/evidence.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const brief = { goal: "Fix checkout", done: "—", now: "Inspect checkout", next: "—", blocked: "—" };
const value = { ...brief, alignment: "aligned", evidence: { goal: ["u1"], pivot: [], drift: [] }, trace: { pivot: "", drift: "", steps: [] } };
const valid = JSON.stringify(value);
const outline = sessionOutline([{ id: "u1", type: "message", message: { role: "user", content: "Fix checkout SECRET_PROMPT" } },
  { id: "a1", type: "message", message: { role: "assistant", content: "Inspecting SECRET_ANSWER" } }]);
const event = (operation = randomUUID(), change: Partial<DiagnosticEvent> = {}): DiagnosticEvent => ({
  event: "operation_start", operation, attempt: 0, repair: false, outcome: "running", code: "none", durationMs: 0, ...change,
});
const record = (change: Partial<DiagnosticRecord> = {}): DiagnosticRecord => ({ ...event(), schema: 1, id: randomUUID(),
  timestamp: "2026-10-01T00:00:00.000Z", installation: randomUUID(), run: randomUUID(), platform: "linux", version: "0.3.17", build: fingerprint("test-build"), promptVersion: "evidence-v7",
  model: "test/brief", session: fingerprint("session"), branch: fingerprint("branch"), ...change });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-brief-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function tracked(replies: SummaryResult[]) {
  const events: DiagnosticEvent[] = [];
  let index = 0;
  const c = new BriefController(async () => {
    assert.ok(index < replies.length, "unexpected extra call");
    return replies[index++]!;
  }, () => {}, brief, [], undefined, () => (event) => events.push(event));
  return { c, events };
}

test("durable metadata is private, shared per installation, and drops arbitrary data", async (t) => {
  const root = fixture(t);
  const log = new DiagnosticLog(root);
  const sink = log.bind("SECRET_SESSION_ID", "SECRET_BRANCH_ID", "test/brief", "evidence-v7");
  sink({ ...event(), prompt: "SECRET_PROMPT", text: "SECRET_REPLY", errorMessage: "SECRET_PROVIDER", model: "SECRET_OVERRIDE" } as DiagnosticEvent);
  assert.equal(log.error, undefined);
  const read = await readDiagnostics([log.directory]);
  assert.equal(read.records.length, 1);
  const row = read.records[0]!;
  assert.equal(row.model, "test/brief");
  assert.equal(row.session, fingerprint("SECRET_SESSION_ID"));
  assert.equal(row.branch, fingerprint("SECRET_BRANCH_ID"));
  assert.doesNotMatch(JSON.stringify(read), /SECRET_|prompt":|errorMessage/);
  assert.equal(statSync(log.directory).mode & 0o777, 0o700);
  for (const name of readdirSync(log.directory)) assert.equal(statSync(join(log.directory, name)).mode & 0o777, 0o600);
  const second = new DiagnosticLog(root);
  second.bind("session-2", "branch-2", "test/brief", "evidence-v7")(event());
  const records = (await readDiagnostics([log.directory])).records;
  assert.equal(new Set(records.map((row) => row.installation)).size, 1);
  assert.equal(new Set(records.map((row) => row.run)).size, 2);
});

test("log rotation and retention are bounded, and old records expire", async (t) => {
  const root = fixture(t);
  const log = new DiagnosticLog(root, { maxFileBytes: 900, maxFiles: 3, maxAgeMs: 1000 });
  const sink = log.bind("session", "branch", "test/brief", "evidence-v7");
  for (let index = 0; index < 12; index++) sink(event());
  assert.equal(log.error, undefined);
  const paths = readdirSync(log.directory).filter((name) => name.endsWith(".jsonl")).map((name) => join(log.directory, name));
  assert.equal(paths.length, 3);
  for (const path of paths) assert.ok(statSync(path).size <= 900);
  for (const path of paths) utimesSync(path, new Date(0), new Date(0));
  new DiagnosticLog(root, { maxFileBytes: 900, maxFiles: 3, maxAgeMs: 1000 });
  assert.equal(readdirSync(log.directory).filter((name) => name.endsWith(".jsonl")).length, 0);
  const report = diagnosticReport(await readDiagnostics([log.directory]));
  assert.match(reportText(report), /not evidence of zero failures/);
});

test("unsafe or unwritable destinations do not throw into model work", async (t) => {
  const root = fixture(t), destination = join(root, "outside");
  writeFileSync(destination, "do not modify");
  symlinkSync(destination, diagnosticDirectory(root));
  const log = new DiagnosticLog(root);
  assert.ok(log.error);
  assert.doesNotThrow(() => log.bind("session", "branch", "test/brief", "evidence-v7")(event()));
  assert.equal(readFileSync(destination, "utf8"), "do not modify");
  const root2 = fixture(t), log2 = new DiagnosticLog(root2);
  const sink = log2.bind("session", "branch", "test/brief", "evidence-v7");
  rmSync(log2.directory, { recursive: true });
  sink(event());
  assert.ok(log2.error);
});

test("invalid and symlinked installation IDs are rejected without overwriting them", (t) => {
  for (const linked of [false, true]) {
    const root = fixture(t), log = new DiagnosticLog(root), path = join(log.directory, "installation-id");
    rmSync(path);
    if (linked) { const target = join(root, "private"); writeFileSync(target, "SECRET_ID"); symlinkSync(target, path); }
    else writeFileSync(path, "SECRET_ID");
    const next = new DiagnosticLog(root);
    assert.ok(next.error);
    assert.equal(readFileSync(path, "utf8"), "SECRET_ID");
  }
});

test("rejected replies, successful repair, and exhaustion are observable without retaining contents", async () => {
  for (const succeeds of [true, false]) {
    const { c, events } = tracked(succeeds ? [{ text: JSON.stringify({ ...value, now: "SECRET_REPLY ".repeat(15) }), cost: 0.01 }, { text: valid, cost: 0.02 }]
      : Array.from({ length: 3 }, () => ({ text: '{"SECRET_BROKEN_JSON"', cost: 0.01 })));
    c.revise(outline); await c.waitForIdle();
    assert.equal(events.filter((row) => row.event === "attempt_start").length, succeeds ? 2 : 3);
    assert.equal(events.filter((row) => row.event === "attempt_end").length, succeeds ? 2 : 3);
    assert.equal(events.filter((row) => row.event === "operation_end").length, 1);
    assert.equal(events.at(-1)?.outcome, succeeds ? "accepted" : "failed");
    assert.equal(events.at(-1)?.code, succeeds ? "none" : "json");
    assert.equal(events.find((row) => row.event === "attempt_end")?.code, succeeds ? "length_now" : "json");
    assert.doesNotMatch(JSON.stringify(events), /SECRET_|checkout|TL;DR|errorMessage|text":/);
    c.close();
  }
});

test("provider failure is recorded once, with a category but no provider error details", async () => {
  const { c, events } = tracked([{ text: "SECRET_PROVIDER_BODY", cost: 0.01, error: "401 Invalid API key SECRET_TOKEN" }]);
  c.revise(outline); await c.waitForIdle();
  assert.equal(c.stats.calls, 1);
  assert.equal(events.find((row) => row.event === "attempt_end")?.code, "authentication");
  assert.equal(events.at(-1)?.code, "authentication");
  assert.doesNotMatch(JSON.stringify(events), /SECRET_|Invalid API/);
  c.close();
});

test("navigation and shutdown finish cancelled operations, and late costs remain attributed to the old attempt", async () => {
  for (const cancellation of ["navigation", "shutdown", "reload"] as const) {
    const events: DiagnosticEvent[] = [];
    let resolve!: (result: SummaryResult) => void;
    const c = new BriefController(() => new Promise((r) => { resolve = r; }), () => {}, brief, [], undefined, () => (row) => events.push(row));
    c.revise(outline);
    if (cancellation === "navigation") c.invalidate(cancellation); else c.close(cancellation);
    await tick();
    assert.equal(events.at(-1)?.event, "operation_end");
    assert.equal(events.at(-1)?.code, cancellation);
    const operation = events[0]!.operation;
    resolve({ text: "SECRET_LATE_BODY", cost: 0.02 }); await tick();
    assert.equal(events.at(-1)?.event, "usage");
    assert.equal(events.at(-1)?.operation, operation);
    assert.equal(events.at(-1)?.late, true);
    assert.equal(events.filter((row) => row.event === "operation_end").length, 1);
    assert.equal(c.stats.cost, 0.02);
    assert.deepEqual(c.brief, brief);
    assert.doesNotMatch(JSON.stringify(events), /SECRET_/);
    c.close();
  }
});

test("operation deadlines and diagnostics observer failures preserve bounded behavior", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, operationTimeoutMs); return deadline.signal; });
  const events: DiagnosticEvent[] = [];
  const c = new BriefController(() => new Promise(() => {}), () => {}, brief, [], undefined, () => (row) => events.push(row));
  c.revise(outline); deadline.abort(new DOMException("SECRET_TIMEOUT", "TimeoutError")); await c.waitForIdle();
  assert.equal(events.at(-1)?.code, "operation_timeout");
  assert.equal(c.stats.calls, 1);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_/);
  c.close();
  t.mock.restoreAll();
  for (const factory of [() => { throw new Error("broken logger"); }, () => () => { throw new Error("broken sink"); }]) {
    const c = new BriefController(async () => ({ text: valid, cost: 0.01 }), () => {}, brief, [], undefined, factory);
    c.revise(outline); await c.waitForIdle();
    assert.equal(c.stats.calls, 1);
    assert.equal(c.stats.error, undefined);
    assert.equal(c.stats.cost, 0.01);
    c.close();
  }
});

test("failure codes cover privacy-safe classifications", () => {
  assert.equal(failureCode(new BriefCancellation("reload")), "reload");
  assert.equal(failureCode(new DOMException("SECRET_TIMEOUT", "TimeoutError")), "request_timeout");
  assert.equal(failureCode(new Error("network disconnected SECRET_TOKEN")), "network");
  assert.equal(failureCode(new Error("invalid model cost")), "usage_invalid");
  assert.equal(failureCode(new Error("repair feedback exceeds 8000 characters")), "repair_bounds");
  assert.equal(validationCode(new Error("invalid goal evidence")), "citation");
  assert.equal(validationCode(new Error("brief goal missing")), "schema");
  assert.equal(validationCode(new Error("brief trace step must be a short TL;DR")), "length_trace");
});

function sample(installation = randomUUID(), platform = "linux", session = "session") {
  const operation = randomUUID(), run = randomUUID();
  const base = { installation, platform, operation, run, session: fingerprint(session) };
  return [record({ ...base, event: "operation_start" }), record({ ...base, event: "attempt_start", attempt: 1 }),
    record({ ...base, event: "usage", attempt: 1, costUsd: 0.01 }), record({ ...base, event: "attempt_end", attempt: 1, outcome: "rejected", code: "json" }),
    record({ ...base, event: "attempt_start", attempt: 2, repair: true }), record({ ...base, event: "usage", attempt: 2, repair: true, costUsd: 0.02 }),
    record({ ...base, event: "attempt_end", attempt: 2, repair: true, outcome: "accepted" }),
    record({ ...base, event: "operation_end", attempt: 2, repair: true, outcome: "accepted" })];
}

test("Linux/Mac aggregation and JSON export/import deduplicate records and costs", async (t) => {
  const root = fixture(t);
  const linux = sample(), mac = sample(randomUUID(), "darwin", "mac-session");
  const path = join(root, "linux.jsonl"), macPath = join(root, "mac.jsonl");
  writeFileSync(path, linux.map((row) => JSON.stringify({ ...row, prompt: "SECRET_PROMPT" })).join("\n") + "\n");
  writeFileSync(macPath, mac.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const report = diagnosticReport(await readDiagnostics([path, macPath]));
  assert.equal(report.installations.length, 2);
  assert.equal(report.totals.operations, 2);
  assert.equal(report.totals.attempts, 4);
  assert.equal(report.totals.recovered, 2);
  assert.equal(report.totals.failed, 0);
  assert.ok(Math.abs((report.totals.reportedCostUsd ?? NaN) - 0.06) < 1e-12);
  assert.equal(report.byCode.json, 2);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_|prompt":/);
  const json = join(root, "report.json"); writeFileSync(json, JSON.stringify(report));
  const imported = diagnosticReport(await readDiagnostics([path, json, macPath]));
  assert.equal(imported.duplicates, 16);
  assert.deepEqual(imported.totals, report.totals);
  const filtered = diagnosticReport(await readDiagnostics([json]), { session: "mac-session" });
  assert.equal(filtered.totals.operations, 1);
  assert.equal(filtered.totals.reportedCostUsd, 0.03);
});

test("reports separate failed operations from rejected attempts and incomplete/unknown-usage history", () => {
  const rows = sample();
  const final = rows.at(-1)!;
  final.outcome = "failed"; final.code = "provider";
  rows[6]!.outcome = "failed"; rows[6]!.code = "provider";
  const report = diagnosticReport({ records: rows.filter((row) => row.event !== "usage"), files: 1, invalid: 0, skipped: 0 });
  assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.rejectedAttempts, 1);
  assert.equal(report.byCode.provider, 1);
  assert.equal(report.totals.usageUnknownAttempts, 2);
  const partial = diagnosticReport({ records: [rows[1]!], files: 1, invalid: 0, skipped: 0 });
  assert.equal(partial.totals.incompleteOperations, 1);
  assert.equal(partial.totals.incompleteAttempts, 1);
  assert.match(reportText(partial), /No complete-history/);
});

test("malformed records, future schemas, truncated lines and symlinks are reported, never echoed", async (t) => {
  const root = fixture(t);
  const path = join(root, "bad.jsonl"), rows = sample();
  writeFileSync(path, [JSON.stringify(rows[0]), "SECRET_BROKEN_LINE", JSON.stringify({ ...rows[1], schema: 2, text: "SECRET_FUTURE_BODY" }),
    JSON.stringify({ ...rows[2], costUsd: -1 }), '{"SECRET_INCOMPLETE":'].join("\n"));
  const linked = join(root, "linked.jsonl"); symlinkSync(path, linked);
  const report = diagnosticReport(await readDiagnostics([path, linked]));
  assert.equal(report.invalid, 4);
  assert.equal(report.skipped, 1);
  assert.doesNotMatch(JSON.stringify(report), /SECRET_/);
  assert.equal(parseDiagnostic({ ...rows[0], timestamp: "not a time" }), undefined);
  assert.equal(parseDiagnostic({ ...rows[0], code: "SECRET_ERROR_CODE" }), undefined);
  assert.equal(parseDiagnostic({ ...rows[0], outcome: "failed" }), undefined);
  assert.equal(parseDiagnostic({ ...rows[0], event: "operation_end", outcome: "rejected", code: "json" }), undefined);
  assert.equal(parseDiagnostic({ ...rows[0], timestamp: "2026-02-31T00:00:00.000Z" }), undefined);
  const exported = join(root, "incomplete.json"); writeFileSync(exported, JSON.stringify(report));
  const imported = diagnosticReport(await readDiagnostics([exported]));
  assert.equal(imported.importedIssues, 5);
  assert.match(reportText(imported), /report is incomplete/);
});

test("directory inputs do not discover session transcripts, credential files or nested directories", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "2026-10-01_session.jsonl"), '{"type":"session","cwd":"SECRET_CWD"}\n');
  writeFileSync(join(root, "auth.json"), '{"token":"SECRET_TOKEN"}');
  const read = await readDiagnostics([root]);
  assert.equal(read.files, 0);
  assert.equal(read.invalid, 0);
  assert.match(reportText(diagnosticReport(read)), /not evidence of zero failures/);
  assert.doesNotMatch(JSON.stringify(read), /SECRET_/);
});

test("same-ID conflicts warn, and costs cannot overflow silently", () => {
  const rows = sample();
  const conflict = { ...rows[0]!, model: "other/brief" };
  const report = diagnosticReport({ records: [...rows, conflict], files: 1, invalid: 0, skipped: 0 });
  assert.equal(report.conflicts, 1);
  assert.match(reportText(report), /incomplete/);
  const conflictedCost = diagnosticReport({ records: [...rows, { ...rows[2]!, id: randomUUID(), costUsd: 0.04 }], files: 1, invalid: 0, skipped: 0 });
  assert.equal(conflictedCost.conflicts, 1);
  assert.equal(conflictedCost.totals.usageUnknownAttempts, 1);
  assert.equal(conflictedCost.totals.reportedCostUsd, 0.02);
  rows[2]!.costUsd = Number.MAX_VALUE; rows[5]!.costUsd = Number.MAX_VALUE;
  assert.equal(diagnosticReport({ records: rows, files: 1, invalid: 0, skipped: 0 }).totals.reportedCostUsd, null);
});

test("offline CLI supports defaults, exports, filters and safe failure on missing/oversized input", (t) => {
  const root = fixture(t), logs = diagnosticDirectory(root);
  const log = new DiagnosticLog(root);
  const sink = log.bind("session", "branch", "test/brief", "evidence-v7");
  sink(event());
  const script = new URL("../scripts/brief-report.mjs", import.meta.url).pathname;
  const run = (...args: string[]) => execFileSync(process.execPath, ["--experimental-transform-types", script, ...args],
    { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: root } });
  assert.match(run(), /offline, retained history only/);
  const report = JSON.parse(run("--json"));
  assert.equal(report.files, 1);
  assert.match(run("--details", "--since", "2026-01-01T00:00:00Z"), /diagnostics/);
  assert.match(run("--help"), /No model calls/);
  const missing = spawnSync(process.execPath, ["--experimental-transform-types", script, "--logs", join(root, "SECRET_MISSING_PATH")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr, /SECRET_/);
  const oversized = join(logs, "huge.jsonl");
  createSparseFile(oversized, reportMaxFileBytes + 1);
  const result = spawnSync(process.execPath, ["--experimental-transform-types", script, "--logs", oversized], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds input limits/);
});

// Sparse input avoids allocating a large buffer just to test the size guard.
function createSparseFile(path: string, size: number): void {
  const fd = openSync(path, "w");
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
}
