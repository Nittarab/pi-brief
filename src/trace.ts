// Presentation only. Goal and drift semantics belong to the evidence-grounded judgment.
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { cleanText, type Presented } from "./brief.ts";

export type Rail = { locked: string; drift: string; left: string; presented: Presented[] };
export const emptyRail = (): Rail => ({ locked: "", drift: "", left: "", presented: [] });

export function phrase(text: string): string { return cleanText(text, 140) || "—"; }

export function railColor(line: string): "accent" | "thinkingText" | "error" | "warning" | "dim" {
  const icon = line.trimStart()[0];
  if (icon === "!" || icon === "↩") return "error";
  if (icon === "?") return "warning";
  if (icon === "●") return "accent";
  if (icon === "◇") return "thinkingText";
  return "dim";
}

function mark(icon: string, text: string, width: number): string {
  const row = text ? `${icon} ${text}` : icon;
  if (visibleWidth(row) <= width) return row;
  if (width <= 1) return "…";
  return `${sliceByColumn(row, 0, width - 1, true)}…`;
}

export function renderRail(rail: Rail, width: number, height: number): string[] {
  const columns = Math.max(1, Math.floor(width)), rows = Math.max(1, Math.floor(height));
  const presented = rail.presented ?? [];
  const lines = presented.length
    ? presented.map((step) => mark(step.kind === "drift" || step.kind === "pivot" ? "!" : step.who === "agent" ? "◇" : "●", step.text, columns))
    : [mark("●", phrase(rail.locked), columns), mark("◇", "reading", columns)];
  // Task and warning precede decisions; lack of space must not hide the judgment.
  const visible = lines.slice(0, rows);
  while (visible.length < rows) visible.push("");
  return visible;
}
