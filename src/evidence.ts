// Domain: bounded, role-preserving evidence from the active branch only. No I/O.
export type EvidenceRecord = {
  id: string;
  order: number;
  role: "user" | "assistant" | "toolResult";
  text: string;
  tools?: string[];
  isError?: boolean;
  truncated?: boolean;
};
export type Evidence = {
  version: 1;
  users: EvidenceRecord[];
  activity: EvidenceRecord[];
  coverage: { omittedUsers: number; omittedActivity: number; truncated: number; wrappers: number };
};
export const evidenceLimit = 24_000;

export function cleanText(value: string, max = 600): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: string; text?: string };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join(" ");
}

function bounded(text: string, max: number): { text: string; truncated?: boolean } {
  if (text.length <= max) return { text };
  const head = Math.floor((max - 15) / 2);
  return { text: `${text.slice(0, head)} [truncated] ${text.slice(-(max - head - 15))}`, truncated: true };
}

export function buildEvidence(branch: unknown[], anchors: string[] = []): Evidence {
  const users: EvidenceRecord[] = [];
  const activity: EvidenceRecord[] = [];
  let wrappers = 0;
  for (const [index, raw] of branch.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { id?: string; type?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean } };
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const id = typeof entry.id === "string" && entry.id && entry.id.length <= 128 ? entry.id : `entry-${index}`;
    if (message.role === "user") {
      const original = visibleText(message.content);
      // Remove expansion bodies, not the user's request before/after the wrapper.
      const text = cleanText(original.replace(/<skill\s+name=[^>]*>[\s\S]*?(?:<\/skill>|$)/gi, " "), Infinity);
      if (text !== cleanText(original, Infinity)) wrappers++;
      if (text) users.push({ id, order: index, role: "user", ...bounded(text, 1600) });
    } else if (message.role === "assistant") {
      const tools = Array.isArray(message.content) ? message.content.flatMap((part: unknown) => {
        const item = part as { type?: string; name?: unknown } | null;
        return item?.type === "toolCall" && typeof item.name === "string" ? [cleanText(item.name, 40)] : [];
      }).slice(0, 8) : [];
      const text = cleanText(visibleText(message.content), Infinity);
      if (text || tools.length) activity.push({ id, order: index, role: "assistant", ...bounded(text, 900), ...(tools.length ? { tools } : {}) });
    } else if (message.role === "toolResult") {
      activity.push({ id, order: index, role: "toolResult", text: "", tools: [cleanText(message.toolName ?? "tool", 40)], isError: message.isError === true });
    }
  }
  // Keep task origins, cited refinements and the newest requests. Do not let a tool burst evict user intent.
  const selected = new Set([...users.slice(0, 3), ...users.filter((row) => anchors.slice(0, 4).includes(row.id))]);
  for (const row of [...users].reverse()) { if (selected.size >= 12) break; selected.add(row); }
  const selectedUsers = users.filter((row) => selected.has(row));
  // Prefer visible assistant evidence over tool metadata in a long tool burst.
  const visible = activity.filter((row) => row.role === "assistant" && row.text).slice(-6);
  const recent = new Set([...visible, ...activity.slice(-4)]);
  const result: Evidence = { version: 1, users: selectedUsers, activity: activity.filter((row) => recent.has(row)),
    coverage: { omittedUsers: users.length - selectedUsers.length, omittedActivity: activity.length - recent.size, truncated: 0, wrappers } };
  const records = [...result.users, ...result.activity];
  // JSON escaping counts toward the wire budget too. Preserve both ends while shrinking.
  result.coverage.truncated = records.filter((row) => row.truncated).length;
  while (JSON.stringify(result).length > evidenceLimit) {
    const longest = records.reduce((a, b) => a.text.length >= b.text.length ? a : b);
    Object.assign(longest, bounded(longest.text, Math.max(80, Math.floor(longest.text.length * 0.75))));
    result.coverage.truncated = records.filter((row) => row.truncated).length;
  }
  return result;
}

// The tree argument is deliberately ignored: alternatives cannot authorize the active job.
export function sessionOutline(branch: unknown[], _tree: unknown[] = [], anchors: string[] = []): string {
  const evidence = buildEvidence(branch, anchors);
  return evidence.users.length || evidence.activity.length ? JSON.stringify(evidence) : "";
}
