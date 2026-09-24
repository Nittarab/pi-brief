import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promptFor } from "../src/brief.ts";

const blank = { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };
const sessions = [
  {
    name: "skill then trace",
    outline: `Active agent trace (latest last):
- user: <skill name="cto-os-daily-standup"> run the standup
- user: Can we fix the pi-brief TUI? one line on top and one on the bottom
- user: does this do the job?
- user: I want an agentic trace on the right that shows when the goal changes
- user: present that trace with the model. Do not copy the tree
- user: why is the goal daily standup? that clearly is not
- user: if you re-analyze this transcript, what is the goal?`,
    must: ["trace"],
    reject: ["standup", "explain", "hilarious", "skill", "what is the goal"],
  },
  {
    name: "explicit pivot",
    outline: `Active agent trace (latest last):
- user: Fix the brief footer
- user: instead, write the pricing page
- user: try again`,
    must: ["pricing"],
    reject: ["footer", "brief"],
  },
  {
    name: "checks do not move the job",
    outline: `Active agent trace (latest last):
- user: Add tests for the brief parser
- user: try again
- user: do it
- user: does this work?
- user: what is the goal?`,
    must: ["test"],
    reject: ["does this", "try again", "what is the goal"],
  },
  {
    name: "skill then a different product",
    outline: `Active agent trace (latest last):
- user: <skill name="cto-os-daily-standup"> run the standup
- user: Ship the homepage copy
- user: looks good`,
    must: ["homepage"],
    reject: ["standup", "skill"],
  },
];

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
