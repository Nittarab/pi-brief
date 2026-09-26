# pi-brief

A compact **Goal + Now** session brief below Pi's editor, with a five-field brief and optional trace. Personal open-source Pi extension by Nittarab for Pi 0.87.1; not a Weft plugin.

## Install

Requires Pi 0.87.1 and Node.js 22.19+. Install with `pi install git:github.com/Nittarab/pi-brief`, or try a checkout with `pi -e /absolute/path/to/pi-brief`. This package is not published on npm. It declares `pi.extensions: ["./src/index.ts"]`. Extensions execute code with your user privileges: review the source first.

**Automatic model calls:** the default is `opencode-go/mimo-v2.6-flash`, up to 80 calls per session/branch, with **no USD cap**. When that model is available and authenticated, the extension sends bounded session evidence after activity without separate opt-in. If unavailable, it shows `off: model not found` and makes no request. Review the privacy section before installation.

Set `PI_BRIEF_MODEL='provider/model-id'` or create `~/.pi/agent/brief.json`:

```json
{
  "model": "provider/model-id",
  "maxCalls": 80,
  "maxCostUsd": null
}
```

`{ "model": null }` disables calls. The environment variable overrides the file's model; file limits still apply. Model IDs must exist in Pi's registry. There is no provider fallback. Configure authentication through Pi. Invalid settings leave a visible error rather than making requests. `maxCalls` is a positive integer; `maxCostUsd` is null or a finite positive number.

## Use

- **Goal + Now** shows the last accepted brief. Before the first model result it shows `—`, not a guessed task. It is not repeated in Pi's footer.
- **`/trace`**, **`/trace on`**, **`/trace off`** control the trace in the same widget. `●` is the goal, `◇` a decision or reported result, and `!` a user pivot or agent drift. The widget uses at most seven lines and preserves the task and warning before less important decisions.
- **`/brief`** shows Goal, Done, Now, Next and Blocked.
- **`/brief status`** shows model, calls, reported USD cost, pending work, alignment and errors.
- **`/brief refresh`** retries a failed update or processes changed evidence. It does not spend again on an unchanged successful snapshot or an empty branch.

A goal follows the user's sustained outcome, including later requirements and prohibitions. Checks and acknowledgements do not replace it. A clear new task can replace it without saying a special keyword. A change of method is not a new task.

Drift is a **model judgment**, not a word-overlap score. Necessary investigation, tests and approval waits can be aligned even when their words differ from the goal. Work with the same nouns can still violate a constraint. Alignment can be `unknown`: tool names alone do not prove what the agent is doing. The extension checks that goal/pivot citations refer to user messages and drift citations refer to visible assistant text on the active branch. **Valid citations prove provenance, not that the judgment is correct.** Check important claims yourself.

Done is prefixed with **Reported:**. The extension does not see test output and cannot independently verify completion. An assistant's plan is not a result.

## Evidence and lifecycle

The data path is `active branch → bounded evidence → shared prompt/model call → validated judgment → branch-local entry and widget`.

- `src/evidence.ts` keeps user requests separate from recent activity, with stable entry IDs and original order. It retains the first three user records, up to four cited goal anchors, and recent requests, up to 12 users total. Recent visible assistant text has its own budget so a tool burst does not remove user intent.
- User text starts with a 1,600-character limit; assistant text with 900. Oversized records retain both ends and a truncation marker. The serialized evidence is capped at 24,000 characters, including JSON escaping. Omitted and truncated record counts travel with the evidence. Missing middle content can still contain important constraints; this remains a limitation, not proof of alignment or drift.
- Skill expansion bodies are removed, but a request outside the wrapper remains. Other tree branches, thinking, raw tool arguments and raw tool results are excluded. Tool names and error flags are metadata, not result proof.
- `src/judgment.ts` owns one prompt and validates shape, source roles and citations. There are no topic blacklists, noun-overlap thresholds or model-written alternative task labels. The trace task is derived from the accepted goal.
- `src/model.ts` owns request options for both the extension and live evaluation. One call, 700 output tokens, 30-second timeout, zero retries. Only the verified default MiMo model receives the thinking-disable option; alternatives use provider-neutral options.
- A call runs after settlement or branch navigation, not on each tool event. One request is in flight. A later user turn invalidates its result. Branch/session navigation closes it and restores only the selected branch. Empty trace updates clear old warnings. Old ungrounded stored briefs are not restored; the active branch is summarized again.
- Failures retain the last accepted brief, show an error and do not silently retry. Call limits are strict. Observed cost includes malformed and superseded replies when usage is returned. There is no timer. Print, JSON and RPC modes make no summarization calls or widget updates.

## Privacy, security and cost

**The extension is enabled by default when its model is available. Disable or change the model before using Pi if you do not trust that provider or do not want automatic calls.**

Evidence contains user prompts, visible assistant text, tool names/error flags, the previous brief and the Pi session ID. OpenCode Go requires the session ID for routing. It never sends raw tool arguments, raw tool output or thinking. Prompts and visible answers can themselves contain secrets. The model's instruction to omit secrets is **not a redaction guarantee**. Do not enable this for sensitive sessions unless you accept disclosure to the selected provider. The larger evidence budget sends more visible text than earlier versions.

Generated briefs, trace rows and source IDs are stored as custom session entries, excluded from the agent's context. Protect those files. Untrusted content is encoded as data and citations are checked, but semantic hallucinations and prompt injection remain possible. The extension does not steer the main agent or insert its brief into the agent's context.

The optional USD limit is checked against **reported cost after each call**. One call can exceed the remaining limit. Timeouts and provider exceptions can bill without returning usage. This is a soft ceiling, not a guaranteed spending cap. With `maxCostUsd: null`, spend is tracked but not capped. Limits reset on branch/session navigation. Aborted calls may still bill.

## Tests and LLM judging

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Unit and extension-harness tests cover evidence bounds/privacy, citations, branch restoration, superseded replies, warning clearing, headless behavior and cost limits. They do **not** establish live model accuracy.

`test/fixtures/judgment-cases.json` contains 12 synthetic acceptance cases. Their natural-language references are fixed before a candidate run. References are withheld from the summarizer. Judge packets include the original, untruncated fixture so the judge can detect information lost by the pipeline. This corpus is a regression set, not an independent generalization benchmark.

Offline requests (no model call):

```sh
node --experimental-transform-types scripts/goal-eval.mjs --output /tmp/brief-requests.json
```

An **approved** live run uses the configured Pi model and the same adapter as the extension. Both budgets and an output path are required:

```sh
node --experimental-transform-types scripts/goal-eval.mjs --live \
  --max-calls 12 --max-cost-usd 0.25 --output /tmp/brief-candidates.json
```

This command spends money; the example is not authorization. It runs sequentially, saves each response and stops on provider failure without retry. The USD ceiling is post-call. If a limit stops the run early, missing cases cannot pass.

Make a blind packet for an independent LLM judge, then validate its returned JSON array:

```sh
node --experimental-transform-types scripts/goal-eval.mjs \
  --candidates /tmp/brief-candidates.json --output /tmp/brief-judge-packet.json
# Give the packet's rubric and cases to a separate LLM; save its verdict array.
node --experimental-transform-types scripts/goal-eval.mjs \
  --candidates /tmp/brief-candidates.json --judge /tmp/brief-verdicts.json
```

The judge scores goal fidelity, constraints, alignment and progress (0/1/2), with source-cited reasons. The gate requires all four scores to be 2 for every case. Missing cases, bad model replies, incomplete scores and stale source/output fingerprints fail closed. Model/version labels are hidden from the judge. Valid JSON and shared keywords alone do not pass. Use separate training and held-out cases for further prompt tuning; do not report this small synthetic set as universal accuracy.

The older `src/rl/` keyword environment remains only as an offline smoke/control test, including eight CC-BY-4.0 Nebius SWE-agent excerpts. `scripts/rl-rollout.mjs --public` runs it without a model. Its oracle score measures its hand-authored keyword rules, **not model quality**; `--model` now refuses and points to the semantic evaluation above.

MIT licensed. No network service or telemetry beyond calls to the selected Pi provider.
