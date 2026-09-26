import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const path = relative(resolve(home), resolve(cwd));
  if (path === "") return "~";
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path) ? `~${sep}${path}` : cwd;
}

/** The public footer APIs do not expose auto-compaction state or experimental-mode indicators. */
export function footerLines(ctx: ExtensionContext, theme: Theme, data: ReadonlyFooterDataProvider, width: number): string[] {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHit: number | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    const usage = entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
      ? entry.usage
      : entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
        ? entry.message.usage : undefined;
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      cacheHit = prompt > 0 ? usage.cacheRead / prompt * 100 : undefined;
    }
  }

  let pwd = shortCwd(ctx.sessionManager.getCwd());
  const branch = data.getGitBranch();
  if (branch) pwd += ` (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) pwd += ` • ${sessionName}`;

  const stats: string[] = [];
  if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
  if ((totals.cacheRead || totals.cacheWrite) && cacheHit !== undefined) stats.push(`CH${cacheHit.toFixed(1)}%`);
  const model = ctx.model;
  const provider = model && ctx.modelRegistry.getProvider(model.provider);
  const subscribed = Boolean(model && (model.provider === "kimi-coding" ||
    (ctx.modelRegistry.isUsingOAuth(model) && provider?.auth.oauth?.isSubscription)));
  if (totals.cost || subscribed) stats.push(`$${totals.cost.toFixed(3)}${subscribed ? " (sub)" : ""}`);

  const context = ctx.getContextUsage();
  const window = context?.contextWindow ?? model?.contextWindow ?? 0;
  const percent = context?.percent;
  const contextText = `${percent === null ? "?" : `${(percent ?? 0).toFixed(1)}%`}/${formatTokens(window)}`;
  const contextColor = percent != null && percent > 90 ? "error" : percent != null && percent > 70 ? "warning" : "dim";
  const statsPrefix = stats.length ? theme.fg("dim", `${stats.join(" ")} `) : "";
  const left = statsPrefix + theme.fg(contextColor, contextText);
  const leftLine = truncateToWidth(left, width, "...");
  const modelName = model?.id ?? "no-model";
  const thinking = model?.reasoning ? ` • ${ctx.thinkingLevel === "off" || !ctx.thinkingLevel ? "thinking off" : ctx.thinkingLevel}` : "";
  const plainRight = modelName + thinking;
  const withProvider = model && data.getAvailableProviderCount() > 1 ? `(${model.provider}) ${plainRight}` : plainRight;
  const rightText = visibleWidth(leftLine) + 2 + visibleWidth(withProvider) <= width ? withProvider : plainRight;
  const right = truncateToWidth(rightText, Math.max(0, width - visibleWidth(leftLine) - 2), "");
  const pad = " ".repeat(Math.max(0, width - visibleWidth(leftLine) - visibleWidth(right)));
  const lines = [truncateToWidth(theme.fg("dim", pwd), width, "..."), leftLine + pad + theme.fg("dim", right)];

  const statuses = [...data.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
  if (statuses.length) lines.push(truncateToWidth(statuses.join(" "), width, "..."));
  return lines;
}
