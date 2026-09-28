# pi-brief

A short **Goal + Now** line for Pi, with a five-field brief and optional trace.

pi-brief watches the active session, asks the configured model for a compact judgment, checks that judgment against session evidence, and shows the accepted result below the editor. It does not steer the agent or add the brief to the agent's context.

Personal extension by Nittarab for Pi 0.87.1. It is not a Weft plugin and is not published on npm.

## Install

Requires Pi 0.87.1 and Node.js 22.19+.

```sh
pi install git:github.com/Nittarab/pi-brief
```

To try a local checkout without installing it:

```sh
pi -e /absolute/path/to/pi-brief
```

The package declares `pi.extensions: ["./src/index.ts"]`. An installed extension runs with your user privileges. Read the source before installing it.

After `pi update --extensions`, reload or restart Pi. An already-open session does not load the new code by itself.

## Model calls and cost

The default model is `opencode-go/mimo-v2.6-flash`. If that model is available and authenticated in Pi, pi-brief sends bounded session evidence to it automatically. There is no separate opt-in.

The default limit is 80 calls per session branch. There is **no USD cap** unless you set one. If the model is missing, the line shows `off: model not found` and makes no request.

Set `PI_BRIEF_MODEL='provider/model-id'`, or create `~/.pi/agent/brief.json`:

```json
{
  "model": "provider/model-id",
  "maxCalls": 80,
  "maxCostUsd": null
}
```

`{ "model": null }` disables calls. The environment variable overrides only the model in the file. Limits in the file still apply.

Model IDs must match Pi's registry exactly. There is no provider fallback. Configure the provider's authentication in Pi. Invalid settings produce a visible error and no request.

`maxCalls` must be a positive integer. `maxCostUsd` must be `null` or a finite number above zero.

## Use

| Command | Result |
|---|---|
| Goal + Now line | Shows the last accepted goal and current work |
| `/brief` | Shows Goal, Done, Now, Next, and Blocked |
| `/brief status` | Shows model, calls, reported cost, pending work, alignment, and the last error |
| `/brief refresh` | Retries a failed update or summarizes changed evidence |
| `/trace` | Shows or hides the trace in the same widget |
| `/trace on`, `/trace off` | Sets the trace state directly |

Before the first accepted result, the line shows `—`. It does not guess a task from the latest message. Pi's footer does not repeat the line.

Trace marks:

- `●` — accepted goal
- `◇` — decision or reported result
- `!` — user pivot or agent drift

The widget uses at most seven lines. It keeps the task and warning before less important decisions.

`/brief refresh` does not spend again when the evidence has not changed or the branch is empty. It does spend when it retries a failed update or summarizes new evidence.

## What the brief means

The model writes a TL;DR. It does not copy the transcript.

- **Goal** is the user's sustained outcome, including later requirements and prohibitions. A check, acknowledgement, screenshot, path, or skill body does not replace it. A clear new task can replace it without a special keyword. A method change is not a new task.
- **Now** is the current unfinished objective or explicit wait.
- **Done** starts with `Reported:`. It is not independent proof. The extension does not see raw test output, so it cannot verify completion.
- **Next** must follow from the current goal. It is not a new task assigned by the model.
- **Blocked** names an explicit blocker, not every error.
- **Alignment** compares visible assistant work with the user's goal:
  - `aligned` — the visible work serves the goal, even when its wording differs
  - `drifting` — visible work or a committed plan leaves the goal or violates a constraint
  - `unknown` — there is not enough visible assistant evidence

A user-only update can establish a goal, but its alignment stays `unknown`. Tool names alone do not prove what the agent did. The same words can hide a violation, and different words can describe necessary investigation.

The extension checks that goal and pivot citations point to user records, and drift citations point to visible assistant text, on the active branch. **Valid citations prove where a claim came from. They do not prove that the claim is correct.** Check important claims yourself.

## How evidence is selected

The path is:

`active branch → bounded evidence → one model call → validated judgment → branch-local entry and widget`

- The first three user records, up to four cited goal anchors, and recent requests are retained, up to 12 user records.
- Recent visible assistant text has its own budget, so a tool burst cannot remove the user's intent.
- User text starts with a 1,600-character limit. Assistant text starts with 900. Oversized records keep both ends and are marked truncated.
- The serialized evidence is capped at 24,000 characters, including JSON escaping. Omitted and truncated counts are sent with it.
- Skill names, user IDs, and arguments remain. Skill bodies and locations are removed.
- Other branches, thinking, raw tool arguments, and raw tool results are excluded.
- Tool names and error flags are metadata, not proof of a result.

Missing middle text can still hide an important constraint. Omission is not evidence of alignment or drift.

## Update lifecycle

- A summary runs after the agent settles or when the active branch changes. It does not run on every tool event.
- One request is in flight. A later user turn invalidates its result.
- Branch or session navigation closes the old request and restores only the selected branch.
- A new accepted trace replaces the old one, so an old drift warning does not remain without support.
- Old stored briefs without the current evidence version are not restored. The active branch is summarized again.
- A failed update keeps the last accepted brief, shows the error, and does not retry automatically.
- Print, JSON, and RPC modes make no summary calls and show no widget.

Each call allows 700 output tokens, times out after 30 seconds, and has zero transport retries. The current prompt version is `evidence-v5`.

The model must return short lines: Goal and Now under 90 characters, other brief fields under 110, and trace lines under 80. Overlong prose is rejected. It is not joined with an ellipsis and presented as a summary.

## Privacy and spending limits

**Calls are enabled by default when the configured model is available. Disable or change the model before starting Pi if you do not trust its provider or do not want automatic calls.**

A request can include user prompts, visible assistant text, tool names, tool error flags, the previous brief, and the Pi session ID. OpenCode Go requires the session ID for routing. Other providers may ignore it.

The request does not include raw tool arguments, raw tool output, or thinking. Prompts and visible answers can still contain secrets. The instruction to omit secrets is **not redaction**. Do not enable pi-brief for a sensitive session unless you accept disclosure to the selected provider.

Generated briefs, trace rows, and source IDs are stored as custom session entries. They are excluded from the agent's context. Protect session files. The extension labels untrusted content as data and checks citations, but it cannot prevent a wrong or adversarial model judgment.

`maxCostUsd` is checked against **reported cost after each call**. One call can exceed the remaining limit. A timeout or provider exception can bill without returned usage. This is a soft ceiling, not a guaranteed spending cap. With `maxCostUsd: null`, cost is tracked but not capped. Counts and observed cost reset when the branch or session changes. An aborted call may still bill.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Tests cover evidence bounds, privacy exclusions, citations, branch restoration, superseded replies, TL;DR limits, headless behavior, and cost limits. Passing tests do **not** prove live model accuracy.

The semantic fixture is `test/fixtures/judgment-cases.json`. It contains 14 synthetic cases. References are withheld from the summarizer. Judge packets include the original fixture so the judge can detect information lost by the evidence pipeline. This is a regression set, not a held-out generalization benchmark.

Generate offline requests with no model call:

```sh
node --experimental-transform-types scripts/goal-eval.mjs --output /tmp/brief-requests.json
```

An approved live run uses the configured Pi model and the same adapter as the extension. It requires both budgets and an output path:

```sh
node --experimental-transform-types scripts/goal-eval.mjs --live \
  --max-calls 14 --max-cost-usd 0.25 --output /tmp/brief-candidates.json
```

This command spends money. The command example is not authorization. It runs one case at a time, saves each response, and stops on provider failure without retry. The USD ceiling is checked after the call. Missing cases cannot pass.

Create a blind packet, have a separate judge score it, and validate the verdict:

```sh
node --experimental-transform-types scripts/goal-eval.mjs \
  --candidates /tmp/brief-candidates.json --output /tmp/brief-judge-packet.json
```

```sh
node --experimental-transform-types scripts/goal-eval.mjs \
  --candidates /tmp/brief-candidates.json --judge /tmp/brief-verdicts.json
```

The judge scores goal fidelity, constraints, alignment, and progress from 0 to 2. Every score must be 2. Missing cases, invalid replies, incomplete scores, and stale fingerprints fail. Valid JSON or shared keywords do not pass. Use separate held-out cases before reporting a prompt improvement as general accuracy.

`src/rl/` remains only as an offline keyword smoke test, including eight CC-BY-4.0 Nebius SWE-agent excerpts. `scripts/rl-rollout.mjs --public` runs it without a model. Its score measures hand-authored keyword rules, not model quality. `--model` refuses and points to the semantic evaluation above.

## License

MIT. pi-brief provides no account, network service, or telemetry beyond calls to the selected model provider.
