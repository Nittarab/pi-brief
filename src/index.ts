import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { BriefController, briefLine, cleanText, display, isBrief, parsePresented, sessionOutline, type Brief, type Presented } from "./brief.ts";
import { emptyRail, railColor, renderRail, type Rail } from "./trace.ts";
import { completeBrief, defaultModel } from "./model.ts";
import type { Judgment } from "./judgment.ts";

const key = "pi-brief";
// Older builds wrote this footer key. Clear it so the line is not shown twice.
const footerKey = " pi-brief";
const widgetKey = "pi-brief";
const configPath = () => join(getAgentDir(), "brief.json");

type Config = { model: string };

export function configured(): Config | undefined {
  let settings: unknown = {};
  try { settings = JSON.parse(readFileSync(configPath(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("brief.json must be an object");
  const data = settings as Record<string, unknown>;
  const model = process.env.PI_BRIEF_MODEL?.trim() || (data.model === undefined ? defaultModel : data.model);
  if (model === null) return undefined; // Explicit opt-out: { "model": null }.
  if (typeof model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error("model must be provider/model or null");
  return { model };
}

function routingSessionId(ctx: ExtensionContext, fallback: string): string {
  const read = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId;
  const id = read?.call(ctx.sessionManager);
  return typeof id === "string" && id.trim() ? id.trim() : fallback;
}

function outlineFor(ctx: ExtensionContext, anchors: string[] = []): string {
  return sessionOutline(ctx.sessionManager.getBranch(), [], anchors);
}

function savedJudgment(ctx: ExtensionContext): Judgment | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "custom" || entry.customType !== key) continue;
    const data = entry.data as { version?: number; brief?: unknown; trace?: unknown; goalSources?: unknown; alignment?: unknown } | undefined;
    if (data?.version !== 1 || !isBrief(data.brief)) return undefined;
    const brief = data.brief;
    const presented: Presented[] = parsePresented(JSON.stringify({ trace: data.trace }));
    const alignment = ["aligned", "drifting", "unknown"].includes(String(data.alignment)) ? data.alignment as Judgment["alignment"] : "unknown";
    if ((alignment === "drifting") !== presented.some((row) => row.kind === "drift")) return undefined;
    return {
      brief: { goal: cleanText(brief.goal, 140) || "—", done: cleanText(brief.done, 140) || "—",
        now: cleanText(brief.now, 140) || "—", next: cleanText(brief.next, 140) || "—", blocked: cleanText(brief.blocked, 140) || "—" },
      goalSources: Array.isArray(data.goalSources) ? data.goalSources.filter((id): id is string => typeof id === "string").slice(0, 4) : [],
      presented, alignment,
    };
  }
  return undefined;
}

const traceLines = 6;

export default function piBrief(pi: ExtensionAPI) {
  let controller: BriefController | undefined;
  let modelName: string | undefined;
  let activity = "";
  let rail: Rail = emptyRail();
  let railWanted = true;

  function shownBrief(): Brief {
    return controller?.brief ?? { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };
  }

  function show(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const state = activity === "update failed" || activity.startsWith("off:") || activity.startsWith("config error")
      ? activity : "";
    const warn = Boolean(rail.drift || rail.left);
    ctx.ui.setWidget(widgetKey, (_tui, theme: Theme) => ({
      invalidate() {},
      render(width: number) {
        const text = briefLine(shownBrief(), state, width);
        const brief = theme.fg(warn && !state ? "warning" : "accent", text);
        if (!railWanted) return [brief];
        const trace = renderRail(rail, width, traceLines).filter((line) => line.trim())
          .map((line) => theme.fg(railColor(line), line));
        return [brief, ...trace];
      },
    }), { placement: "belowEditor" });
  }

  function refresh(ctx: ExtensionContext) {
    const presented = controller?.presented ?? [];
    rail = { locked: shownBrief().goal, left: "", drift: presented.find((row) => row.kind === "drift")?.text ?? "", presented };
    show(ctx);
  }

  function start(ctx: ExtensionContext) {
    controller?.close();
    controller = undefined;
    modelName = undefined;
    activity = "";
    rail = emptyRail();
    if (ctx.mode !== "tui") return; // No invisible requests in print, JSON, or RPC.
    let config: Config | undefined;
    try { config = configured(); }
    catch (error) {
      activity = `config error: ${cleanText(error instanceof Error ? error.message : String(error), 30)}`;
      show(ctx);
      return;
    }
    if (!config) {
      activity = "off: disabled";
      show(ctx);
      return;
    }
    const slash = config.model.indexOf("/");
    const model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
    if (!model) {
      activity = "off: model not found";
      show(ctx);
      return;
    }
    modelName = config.model;
    activity = "";
    const restored = savedJudgment(ctx);
    const fallbackSessionId = randomUUID();
    const current = new BriefController((prompt, signal) =>
      completeBrief(ctx.modelRegistry, model, config.model, prompt, routingSessionId(ctx, fallbackSessionId), signal), (brief, changed) => {
      if (controller !== current) return; // A switched session/branch cannot write to the active branch.
      if (changed) pi.appendEntry(key, { version: 1, brief, trace: current.presented, goalSources: current.goalSources, alignment: current.alignment }); // Branch-local, excluded from the agent's context.
      activity = current.stats.error ? "update failed" : "";
      refresh(ctx);
    }, restored?.brief, restored?.presented, restored);
    controller = current;
    refresh(ctx);
    const outline = outlineFor(ctx, current.goalSources);
    if (outline) current.revise(outline);
  }

  pi.on("session_start", (_event, ctx) => {
    rail = emptyRail();
    if (ctx.mode === "tui") ctx.ui.setStatus(footerKey, undefined); // Clear an old build's status once.
    start(ctx);
  });
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    controller?.close(); controller = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(footerKey, undefined);
      if ("setWidget" in ctx.ui) ctx.ui.setWidget(widgetKey, undefined);
    }
  });
  function invalidate(ctx: ExtensionContext) {
    controller?.invalidate();
    if (ctx.mode === "tui") refresh(ctx);
  }
  pi.on("before_agent_start", (_event, ctx) => invalidate(ctx));
  // Retries/continuations and queued steering can bypass before_agent_start.
  pi.on("agent_start", (_event, ctx) => invalidate(ctx));
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") invalidate(ctx);
  });
  // Navigation can await another extension or a branch summary before session_tree.
  pi.on("session_before_tree", (_event, ctx) => invalidate(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    if (!controller) return;
    activity = controller.stats.error ? "update failed" : "";
    refresh(ctx);
    controller.revise(outlineFor(ctx, controller.goalSources));
  });
  pi.registerCommand("brief", {
    description: "Show the session brief; /brief status shows model, calls, cost and errors; /brief refresh retries pending activity",
    getArgumentCompletions: (prefix) => ["status", "refresh"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const action = args.trim();
      if (action && action !== "refresh" && action !== "status") {
        ctx.ui.notify("Use /brief, /brief status, or /brief refresh", "warning"); return;
      }
      const current = controller;
      if (!current) {
        ctx.ui.notify(`Brief ${activity || "off"}. Set PI_BRIEF_MODEL=provider/model or change ${configPath()}.`, "info"); return;
      }
      if (action === "refresh") {
        await ctx.waitForIdle(); // Never summarize an unfinished tool batch.
        if (controller !== current) return;
        current.revise(outlineFor(ctx, current.goalSources), true);
        await current.waitForIdle();
        if (controller !== current) return; // Reload/navigation invalidates this command's context.
        refresh(ctx);
      }
      const s = current.stats;
      ctx.ui.notify(action === "status"
        ? `${modelName} · ${s.calls} calls · $${s.cost.toFixed(5)} · ${s.pending} pending · alignment: ${current.alignment}${s.error ? ` · last error: ${s.error}` : ""}`
        : display(current.brief).join("\n"), "info");
    },
  });
  pi.registerCommand("trace", {
    description: "Show or hide the trace in the widget above Pi's status line",
    getArgumentCompletions: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const action = args.trim();
      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Use /trace, /trace on, or /trace off", "warning"); return;
      }
      railWanted = action === "off" ? false : action === "on" ? true : !railWanted;
      show(ctx);
      ctx.ui.notify(railWanted ? "Trace above Pi's status line" : "Trace off", "info");
    },
  });
}
