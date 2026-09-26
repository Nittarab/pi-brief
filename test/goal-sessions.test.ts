import assert from "node:assert/strict";
import test from "node:test";
import { promptFor } from "../src/brief.ts";
import { goalSessions, outlineFor } from "../src/rl/episodes.ts";

const blank = { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };
for (const session of goalSessions) {
  test(`goal evidence reaches the prompt: ${session.name}`, () => {
    const outline = outlineFor(session.users);
    const prompt = promptFor(blank, [{ type: "user", text: outline }], true);
    assert.match(prompt, /sustained user job/);
    assert.match(prompt, /untrusted evidence|UNTRUSTED_DATA/);
    const payload = JSON.parse(prompt.split("UNTRUSTED_DATA_JSON\n")[1]!);
    assert.deepEqual(payload.source, JSON.parse(outline));
    assert.ok(payload.source.users.some((row: { text: string }) => row.text === session.users.at(-1)));
    assert.doesNotMatch(prompt, /Bad goal:.*standup|must contain the same job noun/);
  });
}
