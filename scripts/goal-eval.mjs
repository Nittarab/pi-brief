import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promptFor } from "../src/brief.ts";
import { goalSessions, outlineFor } from "../src/rl/episodes.ts";

const blank = { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };
const sessions = goalSessions.map((session) => ({ ...session, outline: outlineFor(session.users), reject: session.forbid }));

function score(goal, session) {
  const text = goal.toLowerCase();
  const missed = session.must.filter((word) => !text.includes(word));
  const hits = session.reject.filter((word) => text.includes(word));
  return { ok: missed.length === 0 && hits.length === 0, missed, hits };
}

const key = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["opencode-go"].key;
let failed = 0;
for (const session of sessions) {
  const prompt = promptFor(blank, [{ type: "user", text: session.outline }], true);
  const response = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "x-opencode-session": randomUUID(),
      "x-opencode-client": "pi",
    },
    body: JSON.stringify({
      model: "mimo-v2.6-flash",
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: "system", content: "Summarize only the provided data. Output one JSON object, without markdown." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = await response.json();
  const raw = body.choices?.[0]?.message?.content ?? body.error?.message ?? JSON.stringify(body).slice(0, 180);
  let goal = raw;
  try { goal = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")).goal; } catch { /* keep raw */ }
  const result = score(String(goal), session);
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? "ok" : "FAIL"} ${session.name}`);
  console.log(`  goal: ${goal}`);
  if (!result.ok) console.log(`  missed: ${result.missed.join(", ") || "—"}  rejected: ${result.hits.join(", ") || "—"}`);
}
process.exitCode = failed ? 1 : 0;
