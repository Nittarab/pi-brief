#!/usr/bin/env node
// Run with: node --experimental-transform-types scripts/brief-report.mjs
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { diagnosticDirectory } from "../src/diagnostics.ts";
import { diagnosticReport, readDiagnostics, reportText } from "../src/diagnostic-report.ts";

try {
  const { values } = parseArgs({ options: {
    logs: { type: "string", multiple: true }, since: { type: "string" }, session: { type: "string" },
    json: { type: "boolean" }, details: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: node --experimental-transform-types scripts/brief-report.mjs [--logs FILE_OR_DIR ...] [--since ISO_TIME] [--session SESSION_ID_OR_KEY] [--details] [--json]\nDefaults to <PI_CODING_AGENT_DIR or ~/.pi/agent>/brief-diagnostics. Reads local JSONL logs or metadata-only JSON reports. No model calls, session-directory scans, or network requests.");
  } else {
    if (values.since && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(values.since)) throw new Error("--since requires an ISO timestamp with timezone");
    const paths = values.logs?.map((path) => resolve(path)) ?? [diagnosticDirectory(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"))];
    const report = diagnosticReport(await readDiagnostics(paths), { since: values.since, session: values.session });
    console.log(values.json ? JSON.stringify(report, null, 2) : reportText(report, values.details));
    if (report.invalid || report.skipped || report.conflicts || report.importedIssues || report.totals.reportedCostUsd === null) process.exitCode = 1;
  }
} catch (error) {
  const code = error?.code;
  // Never echo filesystem paths, input contents, or arbitrary imported error strings.
  const known = error instanceof Error && /^(diagnostic (?:report|directory) exceeds |invalid --since|--since requires )/.test(error.message);
  console.error(`Cannot produce a complete diagnostics report: ${known ? error.message : typeof code === "string" && /^[A-Z_]{1,24}$/.test(code) ? code : "invalid arguments or unreadable input"}.`);
  process.exitCode = 1;
}
