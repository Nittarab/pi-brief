# Changelog

Notable changes to pi-brief, newest first. Dates refer to Git release tags, not npm publication.

## [Unreleased]

### Added

- This changelog, linked from the README and included in future npm packages.

## [0.3.17] — 2026-10-01

### Fixed

- Invalid summaries now receive validation feedback instead of stopping after one model call. Each update allows at most three calls: the first request and two repairs.
- Repair requests include the original evidence and output contract, the latest rejected response, the exact validation error, and an instruction to return a corrected, complete JSON object. Every response runs through the same validation checks.
- An explicit retry after validation exhaustion retains feedback when the evidence and previous brief are unchanged. New evidence starts fresh.
- Overlong legacy activity summaries are rejected rather than silently truncated.
- Superseding work and pre-navigation events abort active requests and prevent stale replies or further repairs from being applied.

### Changed

- `/brief status` distinguishes summarizing, active repair, idle, and retained failed input. Exhausted repairs show a final error and permit manual retry.
- The last accepted brief remains visible during repair. Rejected replies are never persisted as accepted briefs.
- Every attempt counts toward usage reporting, including rejected replies and late returned cost after cancellation.
- Token-limit stops are treated as correctable incomplete output, never accepted as partial summaries. Authentication, network, provider failures, other non-success stop reasons, invalid cost, and timeouts are not repaired.
- Repairs reuse one evidence snapshot and preserve the existing privacy exclusions. Rejected output is untrusted data; serialized repair feedback is capped at 8,000 characters and fails explicitly if oversized.
- Updates have a 75-second total-operation deadline in addition to each request's existing 30-second deadline. Cancellation cannot guarantee that an uncooperative provider stops processing or billing.
- Prompt version is `evidence-v7`.

### Testing

- Added mocked coverage for successful repairs, three-call exhaustion, exact feedback, JSON/schema/length/citation failures, token-limit stops, provider failures, privacy bounds, deadlines, cancellation, supersession, retained briefs, and usage accounting. These tests do not establish live model accuracy.

## [0.3.16] — 2026-09-30

### Changed

- Support Pi 0.99.1 through provider-neutral `streamSimple()` calls, transcript system messages, request-time authentication, and virtual-model routing.
- Respect `PI_CODING_AGENT_DIR` for configuration and allow model IDs containing slashes.
- Include bounded nested-tool names and statuses in evidence, excluding nested arguments, error text, and result payloads.
- Wait for agent settlement before manual refresh and safely invalidate replies across queued user input, continuations, reload, and navigation.
- Add argument completion to `/brief` and `/trace`; keep print, JSON, and RPC modes free of summary calls and widgets.
- Remove session-wide runtime call and spending limits. Legacy `maxCalls` and `maxCostUsd` settings are ignored; calls and reported cost remain visible in status.
- Use wildcard host-package peers and Pi 0.99.1 development dependencies. Add a `prepublishOnly` gate that runs the typecheck and full tests.

### Testing

- Added in-memory provider and published Pi runtime integration coverage for authentication, routing, resource loading, sessions, and headless modes without network or paid model calls.

[Unreleased]: https://github.com/Nittarab/pi-brief/compare/v0.3.17...HEAD
[0.3.17]: https://github.com/Nittarab/pi-brief/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/Nittarab/pi-brief/compare/v0.3.15...v0.3.16
