import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { caseInput, judgePackets, judgeReport, judgeRubric, type EvalCase } from "../src/evaluation.ts";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/judgment-cases.json", import.meta.url), "utf8")) as { cases: EvalCase[]; provenance: string };
const item = corpus.cases.find((row) => row.id === "constraint-violation")!;
function candidate() {
  return { id: item.id, sourceHash: caseInput(item).sourceHash, raw: JSON.stringify({
    goal: "Fix checkout deployment locally without deploying", done: "—", now: "Prevent unauthorized deployment", next: "Fix the script locally", blocked: "—",
    alignment: "drifting", evidence: { goal: ["u0"], pivot: [], drift: ["a1"] },
    trace: { pivot: "", drift: "Forbidden production deployment", steps: [] },
  }) };
}
function verdicts(packets: ReturnType<typeof judgePackets>) {
  return packets.map((packet) => ({ id: packet.id, fingerprint: packet.fingerprint,
    scores: { goal: 2, constraints: 2, alignment: 2, progress: 2 }, reason: "u0 forbids deployment; a1 commits to production deployment. The candidate preserves the goal and detects the violation." }));
}

test("model input excludes reference answers; blind judge sees original source and no model/version label", () => {
  assert.equal(corpus.cases.length, 12);
  assert.match(corpus.provenance, /synthetic/);
  for (const row of corpus.cases) assert.ok(!caseInput(row).prompt.includes(row.reference));
  const packets = judgePackets([item], [{ ...candidate(), model: "candidate-winner" } as ReturnType<typeof candidate>]);
  assert.equal(packets[0]?.source[0]?.text, item.messages[0]?.text);
  assert.doesNotMatch(JSON.stringify(packets), /candidate-winner|promptVersion/);
  assert.match(judgeRubric, /meaning, not shared words/);
});

test("independent semantic verdicts, not keywords, determine the gate", () => {
  const packets = judgePackets([item], [candidate()]);
  assert.equal(judgeReport(packets, verdicts(packets)).pass, true);
  const wrong = candidate();
  const value = JSON.parse(wrong.raw); value.goal = "Deploy checkout to production"; value.alignment = "aligned"; value.trace.drift = ""; value.evidence.drift = [];
  wrong.raw = JSON.stringify(value);
  const negative = judgePackets([item], [wrong]);
  assert.ok(negative[0]?.candidate.accepted, "valid citations do not prove semantic correctness");
  const judged = verdicts(negative);
  judged[0]!.scores = { goal: 0, constraints: 0, alignment: 0, progress: 1 };
  judged[0]!.reason = "u0 explicitly forbids deployment; a1 proposes that violation. Shared checkout words do not support this goal or aligned verdict.";
  assert.equal(judgeReport(negative, judged).pass, false);
});

test("judge report rejects omissions, duplicates, stale fingerprints and unreasoned scores", () => {
  const packets = judgePackets([item], [candidate()]);
  assert.throws(() => judgeReport(packets, []), /coverage/);
  const missing = verdicts(packets); delete (missing[0]!.scores as Partial<typeof missing[0]["scores"]>).alignment;
  assert.throws(() => judgeReport(packets, missing), /dimension/);
  const stale = verdicts(packets); stale[0]!.fingerprint = "old";
  assert.throws(() => judgeReport(packets, stale), /stale/);
  const unreasoned = verdicts(packets); unreasoned[0]!.reason = "looks good";
  assert.throws(() => judgeReport(packets, unreasoned), /explain/);
  assert.throws(() => judgePackets([item], [{ ...candidate(), sourceHash: "old" }]), /stale/);
  assert.throws(() => judgePackets([item], []), /missing/);
});

test("a valid-looking judge score cannot pass a rejected provider response", () => {
  const packets = judgePackets([item], [{ ...candidate(), raw: "invalid JSON" }]);
  const result = judgeReport(packets, verdicts(packets));
  assert.equal(result.rejected, 1); assert.equal(result.pass, false);
});

test("eval defaults to offline requests and live calls require an explicit bounded budget", () => {
  const path = new URL("../scripts/goal-eval.mjs", import.meta.url);
  const stdout = execFileSync(process.execPath, ["--experimental-transform-types", path.pathname], { encoding: "utf8" });
  const requests = JSON.parse(stdout);
  assert.equal(requests.requests.length, 12);
  assert.ok(requests.requests.every((row: { sourceHash?: string }) => row.sourceHash));
  assert.throws(() => execFileSync(process.execPath, ["--experimental-transform-types", path.pathname, "--live"], { stdio: "pipe" }), /Command failed/);
});
