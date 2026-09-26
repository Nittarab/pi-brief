# pi-brief

A compact, persistent **Goal + Now** session brief on one line above Pi's editor, with a full five-field brief on demand. Personal open-source Pi extension by Nittarab for Pi 0.87.1; not a Weft plugin.

## Install

Requires Pi 0.87.1 and Node.js 22.19+. Install the GitHub version with `pi install git:github.com/Nittarab/pi-brief`, or try a local checkout with `pi -e /absolute/path/to/pi-brief`. This package is not yet published on npm. It declares `pi.extensions: ["./src/index.ts"]` and the `pi-package` discovery keyword. Installing a Pi extension executes code with your user privileges: review the source first.

**Automatic model calls:** The default is `opencode-go/mimo-v2.6-flash`, up to 80 calls per session/branch, with **no USD cap** (`maxCostUsd: null`). If that model is available and authenticated in Pi, pi-brief sends the bounded session outline to it after session activity, without a separate opt-in. If it is unavailable, the brief shows `off: model not found` and makes no request. Review [privacy and cost](#privacy-security-and-cost) before installing.

To use a different model, set `PI_BRIEF_MODEL='provider/model-id'`, or create `~/.pi/agent/brief.json`:

```json
{
  "model": "provider/model-id",
  "maxCalls": 80,
  "maxCostUsd": null
}
```

Use `{ "model": null }` in that file to disable model calls. The environment variable overrides the file's `model`; the file's optional limits still apply. Model names must be exact `provider/model-id` identifiers found in Pi's model registry; no automatic fallback to another model/provider. Configure authentication for the selected provider in Pi separately. Invalid configuration and missing models leave a visible **off/error** line instead of making requests. `maxCalls` is an optional positive integer (default 80 per session/branch). `maxCostUsd` defaults to `null` (no USD limit); set a finite positive number to stop after observed spend reaches it. Reported cost is tracked even with the USD limit off. No minimum request interval is configured. Calls and observed cost reset on session/branch navigation; the latest brief is restored from the active session branch.

## Use

- One line above the editor shows the locked user goal and Now. The footer does not repeat it. The line uses the terminal width and cuts a field only when the row is too narrow. The first real user task locks the goal. A skill tag, a screenshot, or a bare file path does not. A check question does not replace it. The model may refine the shown goal only when a later user message adds a requirement. A later user message moves that lock only when it is an explicit new task (`instead`, `new task`, `forget that`, and the same kind of phrase). The model cannot move the lock. If the model goal or Now leaves the lock, the line shows `!` and the old goal stays. It also reports when disabled, an update failed, or a limit was reached.
- `/trace` shows or hides a short trace under the status line. It does not cover the chat, and it does not leave a side column. `/trace` again restores the built-in status line. The session tree is the source. The same `/brief` call returns a trace object: current task, pivot, drift, and up to four decisions. The extension sets the marks. The model does not. Diary lines are dropped. `●` is the current task. `◇` is a decision. `!` is a pivot or drift. `↩` is a branch switch. Until the model answers, the trace says `reading`.
- `/brief` displays Goal, Done, Now, Next, and Blocked. The summary reads the `/tree` shape and the active agent trace: user prompts, visible assistant text, and tool names. It does not read tool arguments, tool output, or thinking. Goal stays the same unless the active branch shows that the user changed the task. Other branches are alternatives, not the current task. The model is instructed to mark Done only for verified progress; the brief can still be inaccurate. Check important facts yourself.
- `/brief status` displays selected model, request count, reported USD cost, pending activity, limit state, and last error.
- `/brief refresh` processes pending activity (or retries a failed update) subject to the same limits. It does not spend on an empty queue.

In a source checkout, an RL environment in `src/rl/` scores a brief against synthetic sessions. `node --experimental-transform-types scripts/rl-rollout.mjs` compares an oracle policy with a bad standup policy. It does not call a model. Add `--model` to score the live prompt. That spends model calls. The brief call disables model thinking only for the verified default MiMo model so the JSON is returned; other configured models receive provider-neutral options. A long reasoning trace was consuming the token budget and leaving the rail empty. `npm test` covers the environment without a model call. `scripts/rl-rollout.mjs --model --public` scores eight short excerpts from the Nebius SWE-agent trajectories dataset (CC-BY-4.0). The full trajectories are not stored here.

The brief is one widget line above the editor, plus an optional trace under a custom footer. The custom footer preserves the path, branch, session name, usage, model, and other extensions' status text through public Pi APIs. Pi does not expose auto-compaction state or experimental indicators to custom footers, so those built-in indicators are not shown while the trace is open. Pi permits only one custom footer: enabling the trace replaces another extension's custom footer, and disabling it restores Pi's built-in footer. The widget fits the locked goal and Now to the terminal width. In print/JSON/RPC modes the extension performs no summarization or UI updates.

## Privacy, security, and cost

**The installed extension is enabled by default when its model is available. Change the model or disable it before running Pi if you do not trust the default provider or do not want automatic model calls.** This sends a bounded outline of the session tree and active agent trace: user prompts, visible assistant text, tool names, the previous brief, and the Pi session id. It does not send tool arguments, tool output, or thinking. OpenCode Go requires the session id as `x-opencode-session`; other providers may ignore it. It never sends raw tool arguments, raw tool output, or assistant thinking. However prompts/visible answers and the stored brief **can themselves include secrets or sensitive content**: the instruction to omit secrets is not a redaction guarantee. Do not enable this for sensitive sessions unless you accept disclosure to your chosen provider. Pi session files store generated briefs as branch-local custom entries; protect session files accordingly. Untrusted prompt content is labeled as data, but model output can still be inaccurate or adversarial. This extension does not change the agent's context or insert the brief into it.

Model requests use at most 700 output tokens, a 30-second timeout, zero transport retries, and one in-flight request at a time. There is no timer. A summary runs after the agent settles, or when you change the active `/tree` branch, and only if that outline differs from the last summary. A failed response does not silently retry; `/brief refresh` permits another attempt. The call limit is strict; the optional USD limit checks **reported cost after each call**: a single call can exceed the remaining budget, and provider exceptions/timeouts may bill without returning usage. With `maxCostUsd: null`, spend is tracked but never capped by this extension. Prices, reported usage and USD units depend on the provider; an enabled USD limit is a soft ceiling, **not a guaranteed spending cap**. The default model can incur cost whenever there is activity to summarize and the provider is available; no explicit configuration is required. A stale in-flight reply is discarded after session/branch changes; its provider may nevertheless charge for work already sent.

## Development

```sh
npm install
npm run check
npm test
npm pack --dry-run
```

MIT licensed. No account, network service, or telemetry is provided by this extension beyond calls to your selected Pi model provider.
