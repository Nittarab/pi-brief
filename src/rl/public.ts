import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Episode } from "./episodes.ts";

export type PublicRow = { instance_id: string; title: string; must: string[]; agent: string };

const forbid = ["applied", "submitted", "reproduce", "kicked off", "declared"];

export function publicEpisodes(rows: PublicRow[]): Episode[] {
  return rows.map((row) => {
    return {
      name: row.instance_id,
      turns: [{ user: row.title, must: row.must, forbid }],
      lock: new RegExp(row.must[0] ?? row.title, "i"),
      reject: ["Run the daily standup", row.agent],
      must: row.must,
      forbid,
      outline: ["Active agent trace (latest last):", `- user: ${row.title}`, `- assistant: ${row.agent}`].join("\n"),
    };
  });
}

export function loadPublicEpisodes(path = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/public-agent.json")): Episode[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { rows: PublicRow[] };
  return publicEpisodes(data.rows);
}
