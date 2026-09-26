import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { caseInput, judgePackets, judgeReport, judgeRubric } from "../src/evaluation.ts";
import { briefSystemPrompt, promptVersion } from "../src/judgment.ts";

const { values } = parseArgs({ options: {
  live: { type: "boolean" }, "max-calls": { type: "string" }, "max-cost-usd": { type: "string" },
  output: { type: "string" }, candidates: { type: "string" }, judge: { type: "string" },
} });
const corpus = JSON.parse(readFileSync(new URL("../test/fixtures/judgment-cases.json", import.meta.url), "utf8"));
const emit = (value) => {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, text); else process.stdout.write(text);
};
if (values.live) {
  const maxCalls = Number(values["max-calls"]), maxCost = Number(values["max-cost-usd"]);
  if (values.candidates || values.judge || !values.output || !Number.isSafeInteger(maxCalls) || maxCalls < corpus.cases.length || !Number.isFinite(maxCost) || maxCost <= 0) {
    throw new Error(`Live calls require --output FILE, --max-calls >= ${corpus.cases.length} and positive --max-cost-usd. Obtain spend approval first. Do not combine with --candidates/--judge.`);
  }
  const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const { configured } = await import("../src/index.ts");
  const { completeBrief } = await import("../src/model.ts");
  const config = configured();
  if (!config) throw new Error("Brief model is disabled; set PI_BRIEF_MODEL or brief.json before evaluation");
  if (config.maxCalls < corpus.cases.length) throw new Error("Configured maxCalls is smaller than the corpus; raise it deliberately or use offline packets");
  const registry = new ModelRegistry(await ModelRuntime.create());
  const [provider, modelId] = config.model.split("/");
  const model = registry.find(provider, modelId);
  if (!model) throw new Error(`Model ${config.model} not found; check Pi's registry`);
  const artifact = { model: config.model, promptVersion, revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()), provenance: corpus.provenance, cost: 0, cases: [] };
  const cap = Math.min(maxCost, config.maxCostUsd ?? Infinity);
  for (const item of corpus.cases) {
    if (artifact.cases.length >= maxCalls || artifact.cost >= cap) { process.exitCode = 1; break; }
    const input = caseInput(item), started = Date.now();
    try {
      const result = await completeBrief(registry, model, config.model, input.prompt, randomUUID(), new AbortController().signal);
      if (!Number.isFinite(result.cost) || result.cost < 0) throw new Error("Provider returned invalid cost; billing is unknown, stop");
      artifact.cost += result.cost;
      artifact.cases.push({ id: item.id, sourceHash: input.sourceHash, raw: result.text, error: result.error, cost: result.cost, ms: Date.now() - started });
      emit(artifact);
      if (result.error) { process.exitCode = 1; break; }
    } catch (error) {
      artifact.cases.push({ id: item.id, sourceHash: input.sourceHash, raw: "", error: String(error), billingUnknown: true, ms: Date.now() - started });
      emit(artifact); process.exitCode = 1; break; // Never retry a potentially billed failure.
    }
  }
  emit(artifact);
  console.error(`Captured ${artifact.cases.length}/${corpus.cases.length} cases; observed USD ${artifact.cost}. This is not a semantic score. The USD cap is post-call, not a guaranteed cap.`);
} else if (values.candidates) {
  const artifact = JSON.parse(readFileSync(values.candidates, "utf8"));
  const packets = judgePackets(corpus.cases, artifact.cases);
  if (values.judge) {
    const report = judgeReport(packets, JSON.parse(readFileSync(values.judge, "utf8")));
    emit(report); process.exitCode = report.pass ? 0 : 1;
  } else emit({ rubric: judgeRubric, provenance: corpus.provenance, packets });
} else {
  if (values.judge) throw new Error("--judge requires --candidates so source/output fingerprints can be verified");
  emit({ promptVersion, systemPrompt: briefSystemPrompt, requests: corpus.cases.map((item) => ({ id: item.id, ...caseInput(item) })) });
}
