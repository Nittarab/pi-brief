# pi-brief

A compact, persistent **Goal + Now** session brief on one line above Pi's editor, with a full five-field brief on demand. Personal open-source Pi extension by Nittarab for Pi 0.87.1; not a Weft plugin.

## Install

Requires Pi 0.87.1 and Node.js 22.19+. Once published, install with `pi install npm:pi-brief`. Until then, from a local checkout use `pi install /absolute/path/to/pi-brief` or try `pi -e /absolute/path/to/pi-brief`. The package declares `pi.extensions: ["./src/index.ts"]` and the `pi-package` discovery keyword. Installing a Pi extension executes code with your user privileges: review the source first.

The brief is **off by default**. Explicitly select the provider/model to use:

```sh
export PI_BRIEF_MODEL='provider/model-id'
```

Or create `~/.pi/agent/brief.json`:

```json
{
  "model": "provider/model-id",
  "maxCalls": 80,
  "maxCostUsd": null
}
```

`PI_BRIEF_MODEL` overrides the file's `model`, while the file's optional limits still apply. Model names must be exact `provider/model-id` identifiers found in Pi's model registry; no automatic fallback to another model/provider. Configure authentication for that provider in Pi separately. Invalid configuration and missing models leave a visible **off/error** line instead of making requests. `maxCalls` is an optional positive integer (default 80 per session/branch). `maxCostUsd` defaults to `null` (no USD limit); set a finite positive number to stop after observed spend reaches it. Reported cost is tracked even with the USD limit off. No minimum request interval is configured. Calls and observed cost reset on session/branch navigation; the latest brief is restored from the active session branch.

## Use

- One line above the editor shows `Goal: … · Now: …`. The footer does not repeat it. Goal is the user task on the active branch. Now is the current objective on that path, not the latest tool. The line does not change on every tool call. It changes only when a summary of the session tree and active agent trace changes the brief. It also reports when disabled, an update failed, or a limit was reached.
- `/brief` displays Goal, Done, Now, Next, and Blocked. The summary reads the `/tree` shape and the active agent trace: user prompts, visible assistant text, and tool names. It does not read tool arguments, tool output, or thinking. Goal stays the same unless the active branch shows that the user changed the task. Other branches are alternatives, not the current task. The model is instructed to mark Done only for verified progress; the brief can still be inaccurate. Check important facts yourself.
- `/brief status` displays selected model, request count, reported USD cost, pending activity, limit state, and last error.
- `/brief refresh` processes pending activity (or retries a failed update) subject to the same limits. It does not spend on an empty queue.

The brief is one widget line above the editor. It does not set a footer status, because that row is shared and Pi can clip it. Goal + Now stays compact (normally under 65 columns). In print/JSON/RPC modes the extension performs no summarization or widget updates.

## Privacy, security, and cost

**Opt in only with a model/provider you trust.** This sends a bounded outline of the session tree and active agent trace: user prompts, visible assistant text, tool names, the previous brief, and the Pi session id. It does not send tool arguments, tool output, or thinking. OpenCode Go requires the session id as `x-opencode-session`; other providers may ignore it. It never sends raw tool arguments, raw tool output, or assistant thinking. However prompts/visible answers and the stored brief **can themselves include secrets or sensitive content**: the instruction to omit secrets is not a redaction guarantee. Do not enable this for sensitive sessions unless you accept disclosure to your chosen provider. Pi session files store generated briefs as branch-local custom entries; protect session files accordingly. Untrusted prompt content is labeled as data, but model output can still be inaccurate or adversarial. This extension does not change the agent's context or insert the brief into it.

Model requests use at most 400 output tokens, a 30-second timeout, zero transport retries, and one in-flight request at a time. There is no timer. A summary runs after the agent settles, or when you change the active `/tree` branch, and only if that outline differs from the last summary. A failed response does not silently retry; `/brief refresh` permits another attempt. The call limit is strict; the optional USD limit checks **reported cost after each call**: a single call can exceed the remaining budget, and provider exceptions/timeouts may bill without returning usage. With `maxCostUsd: null`, spend is tracked but never capped by this extension. Prices, reported usage and USD units depend on the provider; an enabled USD limit is a soft ceiling, **not a guaranteed spending cap**. No cost is incurred unless the model has been explicitly configured and there is activity to summarize. A stale in-flight reply is discarded after session/branch changes; its provider may nevertheless charge for work already sent.

## Development

```sh
npm install
npm run check
npm test
npm pack --dry-run
```

MIT licensed. No account, network service, or telemetry is provided by this extension beyond calls to your selected Pi model provider.
