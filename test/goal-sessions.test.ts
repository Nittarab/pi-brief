import assert from "node:assert/strict";
import test from "node:test";
import { promptFor } from "../src/brief.ts";
import { acceptModelGoal, assess, emptyMemory } from "../src/trace.ts";
import { goalSessions, outlineFor } from "../src/rl/episodes.ts";

const blank = { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };

for (const session of goalSessions) {
  test(`synthetic session: ${session.name}`, () => {
    const users = session.users.map((text, index) => ({ id: `u${index}`, text }));
    const locked = assess(emptyMemory(), { users, steps: [] }).memory.locked;
    assert.match(locked, session.lock, locked);
    for (const bad of session.reject) assert.equal(acceptModelGoal(bad, users, locked), "", bad);
    if (session.accept) {
      const accepted = acceptModelGoal(session.accept, users, locked);
      assert.match(accepted, new RegExp(session.must[0] ?? "", "i"));
    }
    const prompt = promptFor(blank, [{ type: "user", text: outlineFor(session.users) }], true);
    assert.match(prompt, /sustained user job/);
    for (const user of session.users) assert.match(prompt, new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40)));
  });
}
