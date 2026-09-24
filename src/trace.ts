import { cleanText, type Presented } from "./brief.ts";

export type TraceUser = { id?: string; text: string };
export type TraceStep = { role: "user" | "assistant" | "tool"; text: string };
export type TraceMemory = { locked: string; lockBranch: string };
export type RailStep = { flag: "●" | "◇" | "!" | "?"; text: string };
export type Rail = { locked: string; drift: string; suspect: string; left: string; steps: RailStep[]; presented: Presented[] };

const continuations = new Set([
  "ok", "okay", "yes", "no", "y", "n", "k", "yep", "nope", "do it", "try again", "continue",
  "go", "ship it", "thanks", "thank you", "good", "lgtm", "sure", "fine", "proceed", "go ahead",
  "looks good", "do that", "same", "keep going", "reload", "agreed",
]);
const stops = new Set(["a", "an", "the", "to", "of", "and", "or", "for", "in", "on", "with", "so", "that", "this", "it", "is", "be", "we", "i", "you"]);
const pivot = /\b(new task|instead|forget that|forget the|stop doing|change the goal|different task|different goal|switch to)\b|^actually[, ]/i;

export const emptyMemory = (): TraceMemory => ({ locked: "", lockBranch: "" });
export const emptyRail = (): Rail => ({ locked: "", drift: "", suspect: "", left: "", steps: [], presented: [] });

function contentWords(text: string): string[] {
  return cleanText(text).toLowerCase().replace(/[^a-z0-9+/.-]+/g, " ").split(" ").filter((word) => word && !stops.has(word));
}

function overlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const known = new Set(right);
  return left.filter((word) => known.has(word)).length / Math.min(left.length, right.length);
}

export function sameTask(left: string, right: string): boolean {
  const a = cleanText(left, 140).toLowerCase();
  const b = cleanText(right, 140).toLowerCase();
  if (!a || !b || a === "—" || b === "—") return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return overlap(contentWords(a), contentWords(b)) >= 0.34;
}

function continuation(text: string): boolean {
  const plain = cleanText(text, 140).toLowerCase().replace(/[.!?…,]+$/g, "").trim();
  if (!plain || plain.startsWith("/")) return true;
  if (continuations.has(plain)) return true;
  return contentWords(plain).length <= 2 && plain.split(/\s+/).length <= 4;
}

export function isPivot(text: string): boolean {
  const plain = cleanText(text, 140);
  return Boolean(plain) && !continuation(plain) && pivot.test(plain);
}

export function isSuspect(locked: string, text: string): boolean {
  const plain = cleanText(text, 140);
  if (!locked || !plain || continuation(plain) || isPivot(plain)) return false;
  const words = contentWords(plain);
  return words.length >= 3 && overlap(contentWords(locked), words) < 0.34;
}

function lockText(text: string): string {
  const plain = cleanText(text, 140);
  return plain.replace(/^(?:actually[, ]+|instead[, ]+|new task[:, ]+)/i, "").trim() || plain;
}

export function branchKey(users: TraceUser[]): string {
  const first = users.find((user) => cleanText(user.text, 140));
  return first ? cleanText(first.text, 80) : "";
}

function grounded(text: string, locked: string, users: TraceUser[]): boolean {
  if (sameTask(locked, text)) return true;
  return users.some((user) => sameTask(user.text, text));
}

function driftText(locked: string, users: TraceUser[], goal = "", now = ""): string {
  if (!locked) return "";
  const modelGoal = cleanText(goal, 140);
  const modelNow = cleanText(now, 140);
  if (modelGoal && modelGoal !== "—" && !grounded(modelGoal, locked, users)) return modelGoal;
  if (modelNow && contentWords(modelNow).length >= 3 && !grounded(modelNow, locked, users)) return modelNow;
  return "";
}

export function assess(memory: TraceMemory, input: {
  users: TraceUser[];
  steps: TraceStep[];
  modelGoal?: string;
  modelNow?: string;
  inFlight?: string;
}): { memory: TraceMemory; rail: Rail } {
  const users = input.users.map((user) => ({ id: user.id, text: cleanText(user.text, 140) })).filter((user) => user.text);
  let locked = memory.locked;
  let lockBranch = memory.lockBranch;
  const key = branchKey(users);
  if (!locked && users[0]) {
    locked = lockText(users[0].text);
    lockBranch = key;
  }
  if (lockBranch && key === lockBranch) {
    for (const user of users) if (isPivot(user.text)) locked = lockText(user.text);
  }
  const latest = users.at(-1)?.text ?? "";
  const onLockBranch = !lockBranch || key === lockBranch;
  const suspect = onLockBranch && isSuspect(locked, latest) ? latest : "";
  const left = lockBranch && key !== lockBranch ? (users[0]?.text ?? "—") : "";
  const steps = input.steps.filter((step) => step.role !== "tool" && cleanText(step.text, 80)).map((step) => ({
    flag: step.role === "assistant" ? "◇" as const : isPivot(step.text) ? "!" as const : "●" as const,
    text: cleanText(step.text, 80),
  }));
  return {
    memory: { locked, lockBranch },
    rail: { locked, drift: driftText(locked, users, input.modelGoal, input.modelNow), suspect, left, steps, presented: [] },
  };
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: string; text?: string };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join(" ");
}

type Loose = { id?: string; type?: string; message?: { role?: string; content?: unknown } };

export function usersFrom(branch: unknown[]): TraceUser[] {
  const users: TraceUser[] = [];
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Loose;
    if (item.type !== "message" || item.message?.role !== "user") continue;
    const text = cleanText(visibleText(item.message.content), 140);
    if (text) users.push({ id: item.id, text });
  }
  return users;
}

export function stepsFrom(branch: unknown[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Loose;
    if (item.type !== "message" || !item.message) continue;
    if (item.message.role === "user") {
      const text = cleanText(visibleText(item.message.content), 80);
      if (text) steps.push({ role: "user", text });
    } else if (item.message.role === "assistant") {
      const text = cleanText(visibleText(item.message.content), 80);
      if (text) steps.push({ role: "assistant", text });
    }
  }
  return steps;
}

export function phrase(text: string): string {
  let value = cleanText(text, 240);
  const skill = value.match(/<skill\s+name="([^"]+)"/i)?.[1];
  if (skill) value = skill.replace(/^cto-os-/, "").replace(/-/g, " ");
  else {
    value = value.replace(/<[^>]+>/g, " ");
    const path = value.match(/(?:^|\s)(\/(?:Users|home|tmp)\/\S+)/);
    if (path && value.trim().split(/\s+/).length <= 3) {
      const base = path[1]?.split("/").pop() ?? "";
      value = /cleanshot|\.png$|screenshot/i.test(base) ? "screenshot" : base;
    }
    value = value.replace(/^(?:ok[,;:]?\s+)+/i, "");
    value = value.replace(/^(?:can you\s+(?:try to\s+)?|please\s+)/i, "");
    value = value.replace(/^(?:i will\s+|i'll\s+|i cannot\s+|i can't\s+)/i, "");
    value = value.replace(/^(?:the|a)\s+/i, "");
  }
  return cleanText(value, 80) || "—";
}

export function railColor(line: string): "accent" | "thinkingText" | "error" | "warning" | "dim" {
  const icon = line.trimStart()[0];
  if (icon === "!" || icon === "↩") return "error";
  if (icon === "?") return "warning";
  if (icon === "●") return "accent";
  if (icon === "◇") return "thinkingText";
  return "dim";
}

function clipLine(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return "…";
  const raw = text.slice(0, width - 1);
  const space = raw.lastIndexOf(" ");
  const base = space >= Math.ceil((width - 1) / 2) ? raw.slice(0, space) : raw.trimEnd();
  return `${base || raw}…`;
}

function mark(icon: string, text: string, width: number): string {
  const row = text ? `${icon} ${text}` : icon;
  return clipLine(row, width);
}

export function renderRail(rail: Rail, width: number, height: number): string[] {
  const columns = Math.max(4, Math.floor(width));
  const rows = Math.max(1, Math.floor(height));
  const presented = rail.presented ?? [];
  const header: string[] = [];
  if (!presented.length) header.push(mark("●", phrase(rail.locked) || "—", columns));
  if (rail.drift && !presented.some((step) => step.kind === "drift")) header.push(mark("!", phrase(rail.drift), columns));
  if (rail.left) header.push(mark("↩", phrase(rail.left), columns));
  const room = Math.max(0, rows - header.length);
  const spine = presented.length
    ? presented.map((step) => mark(step.kind === "drift" || step.kind === "pivot" ? "!" : step.who === "agent" ? "◇" : "●", step.text, columns))
    : [mark("◇", "reading", columns)];
  const visible = spine.length > room ? [mark("…", "", columns), ...spine.slice(-(Math.max(0, room - 1)))] : spine;
  const lines = [...header, ...visible];
  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}
