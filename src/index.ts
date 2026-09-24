import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { BriefController, briefLine, cleanText, display, isBrief, parsePresented, sessionOutline, type Brief, type Presented } from "./brief.ts";
import { assess, emptyMemory, emptyRail, isWrapper, phrase, railColor, renderRail, usersFrom, type Rail, type TraceMemory } from "./trace.ts";

const key = "pi-brief";
// Older builds wrote this footer key. Clear it so the line is not shown twice.
const footerKey = " pi-brief";
const widgetKey = "pi-brief";
const configPath = join(homedir(), ".pi", "agent", "brief.json");

type Config = { model: string; maxCalls: number; maxCostUsd: number | null };

function configured(): Config | undefined {
  let settings: unknown = {};
  try { settings = JSON.parse(readFileSync(configPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("brief.json must be an object");
  const data = settings as Record<string, unknown>;
  const model = process.env.PI_BRIEF_MODEL?.trim() || data.model;
  if (model === undefined || model === "") return undefined;
  if (typeof model !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(model)) throw new Error("model must be provider/model");
  const maxCalls = data.maxCalls === undefined ? 80 : data.maxCalls;
  if (typeof maxCalls !== "number" || !Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error("invalid maxCalls");
  const maxCostUsd = data.maxCostUsd === undefined ? null : data.maxCostUsd;
  if (maxCostUsd !== null && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
    throw new Error("invalid maxCostUsd");
  }
  return { model, maxCalls, maxCostUsd };
}

function routingSessionId(ctx: ExtensionContext, fallback: string): string {
  const read = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId;
  const id = read?.call(ctx.sessionManager);
  return typeof id === "string" && id.trim() ? id.trim() : fallback;
}

function modelFailure(reply: { stopReason: string; errorMessage?: string }): string | undefined {
  if (reply.stopReason === "stop") return undefined;
  const detail = cleanText(reply.errorMessage ?? "", 90);
  return detail ? `model stopped: ${reply.stopReason}: ${detail}` : `model stopped: ${reply.stopReason}`;
}

function outlineFor(ctx: ExtensionContext, lock = ""): string {
  const manager = ctx.sessionManager as { getBranch: () => unknown[]; getTree?: () => unknown[] };
  const tree = sessionOutline(manager.getBranch(), manager.getTree?.() ?? []);
  if (!tree) return "";
  const task = lock && !isWrapper(lock) ? phrase(lock) : "";
  return task ? `Locked task: ${task}\n${tree}` : tree;
}

function savedPresented(ctx: ExtensionContext): Presented[] {
  for (const entry of ctx.sessionManager.getBranch().reverse()) {
    if (entry.type === "custom" && entry.customType === key) {
      const data = entry.data as { trace?: unknown } | undefined;
      return Array.isArray(data?.trace) ? parsePresented(JSON.stringify({ trace: data.trace })) : [];
    }
  }
  return [];
}

function savedBrief(ctx: ExtensionContext): Brief | undefined {
  for (const entry of ctx.sessionManager.getBranch().reverse()) {
    if (entry.type === "custom" && entry.customType === key) {
      const data = entry.data as { brief?: unknown } | undefined;
      const brief = data?.brief;
      if (isBrief(brief)) return {
        goal: cleanText(brief.goal, 140) || "—", done: cleanText(brief.done, 140) || "—",
        now: cleanText(brief.now, 140) || "—", next: cleanText(brief.next, 140) || "—",
        blocked: cleanText(brief.blocked, 140) || "—",
      };
    }
  }
  return undefined;
}

const railWidth = 34;
const railMinColumns = 100;

export default function piBrief(pi: ExtensionAPI) {
  let controller: BriefController | undefined;
  let modelName: string | undefined;
  let activity = "";
  let memory: TraceMemory = emptyMemory();
  let rail: Rail = emptyRail();
  let pendingUser = "";
  let inFlight = "";
  let railWanted = true;
  let railOpen = false;
  let closeRail: (() => void) | undefined;
  let hideRail: ((hidden: boolean) => void) | undefined;
  let paintRail: (() => void) | undefined;

  function shownBrief(): Brief {
    const model = controller?.brief ?? { goal: "—", done: "—", now: "—", next: "—", blocked: "—" };
    const goal = phrase(memory.locked || model.goal);
    const now = rail.drift ? `! ${phrase(rail.drift)}` : rail.left ? "! left path" : phrase(model.now);
    return { ...model, goal, now };
  }

  function show(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const state = activity === "update failed" || activity === "limit reached" || activity.startsWith("off:") || activity.startsWith("config error")
      ? activity : "";
    const warn = Boolean(rail.drift || rail.left);
    // One line only, fitted to the row. The footer shares a truncated row.
    ctx.ui.setStatus(footerKey, undefined);
    ctx.ui.setWidget(widgetKey, (_tui, theme: Theme) => ({
      invalidate() {},
      render(width: number) {
        const text = briefLine(shownBrief(), state, width);
        return [theme.fg(warn && !state ? "warning" : "accent", text)];
      },
    }));
    paintRail?.();
  }

  function refresh(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    const users = usersFrom(branch);
    if (pendingUser && users.at(-1)?.text !== pendingUser) users.push({ text: pendingUser });
    const next = assess(memory, {
      users, steps: [], modelGoal: controller?.brief.goal, modelNow: controller?.brief.now, inFlight,
    });
    memory = next.memory;
    rail = { ...next.rail, presented: controller?.presented ?? [] };
    show(ctx);
  }

  function openRail(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || railOpen || typeof ctx.ui.custom !== "function") return;
    railOpen = true;
    void ctx.ui.custom((tui, theme, _keys, done) => {
      closeRail = () => { closeRail = undefined; hideRail = undefined; paintRail = undefined; railOpen = false; done(undefined); };
      paintRail = () => tui.requestRender();
      return {
        invalidate() {},
        render(width: number) {
          const lines = renderRail(rail, width, Math.max(8, tui.terminal.rows));
          return lines.map((line) => theme.fg(railColor(line), line));
        },
      };
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "right-center", width: railWidth, maxHeight: "100%", margin: 0, nonCapturing: true,
        visible: (columns) => railWanted && columns >= railMinColumns,
      },
      onHandle: (handle) => { hideRail = (hidden) => handle.setHidden(hidden); },
    }).catch(() => { railOpen = false; closeRail = undefined; });
  }

  function start(ctx: ExtensionContext) {
    controller?.close();
    controller = undefined;
    modelName = undefined;
    activity = "";
    if (ctx.mode !== "tui") return; // No invisible requests in print, JSON, or RPC.
    let config: Config | undefined;
    try { config = configured(); }
    catch (error) {
      activity = `config error: ${cleanText(error instanceof Error ? error.message : String(error), 30)}`;
      show(ctx);
      return;
    }
    if (!config) {
      activity = "off: configure model";
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
    const restored = savedBrief(ctx);
    const fallbackSessionId = randomUUID();
    const current = new BriefController(async (prompt, signal) => {
      const reply = await ctx.modelRegistry.complete(model, {
        systemPrompt: "Summarize only the provided data. Output one JSON object, without markdown.",
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, {
        signal, timeoutMs: 30_000, maxRetries: 0, maxTokens: 700, cacheRetention: "none",
        // OpenCode Go rejects requests that omit this routing id. Other providers ignore it.
        sessionId: routingSessionId(ctx, fallbackSessionId),
      });
      return { text: reply.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
        cost: reply.usage.cost.total, error: modelFailure(reply) };
    }, (brief, changed) => {
      if (controller !== current) return; // A switched session/branch cannot write to the active branch.
      if (changed) pi.appendEntry(key, { brief, trace: current.presented }); // Branch-local, excluded from the agent's context.
      if (activity !== "working" && !activity.startsWith("using ")) {
        activity = current.stats.error ? "update failed" : current.stats.limit ? "limit reached" : "";
      }
      refresh(ctx);
    }, restored, config.maxCalls, config.maxCostUsd, savedPresented(ctx));
    controller = current;
    refresh(ctx);
    const outline = outlineFor(ctx, memory.locked);
    if (restored && !outline) current.noteOutline("");
    else if (outline) current.revise(outline);
  }

  pi.on("session_start", (_event, ctx) => {
    memory = emptyMemory();
    rail = emptyRail();
    pendingUser = "";
    inFlight = "";
    closeRail?.();
    start(ctx);
    openRail(ctx);
  });
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    controller?.close(); controller = undefined;
    closeRail?.();
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(footerKey, undefined);
      if ("setWidget" in ctx.ui) ctx.ui.setWidget(widgetKey, undefined);
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    pendingUser = cleanText(event.prompt, 140);
    if (ctx.mode === "tui") refresh(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    inFlight = cleanText(event.toolName, 24);
    if (ctx.mode === "tui") refresh(ctx);
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    inFlight = "";
    if (ctx.mode === "tui") refresh(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!controller) return;
    pendingUser = "";
    inFlight = "";
    activity = controller.stats.error ? "update failed" : controller.stats.limit ? "limit reached" : "";
    refresh(ctx);
    controller.revise(outlineFor(ctx, memory.locked));
  });
  pi.registerCommand("brief", {
    description: "Show the session brief; /brief status shows model, calls, cost and errors; /brief refresh retries pending activity",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action && action !== "refresh" && action !== "status") {
        ctx.ui.notify("Use /brief, /brief status, or /brief refresh", "warning"); return;
      }
      if (!controller) {
        ctx.ui.notify(`Brief off. Set PI_BRIEF_MODEL=provider/model or configure ${configPath}.`, "info"); return;
      }
      if (action === "refresh") {
        controller.revise(outlineFor(ctx, memory.locked), true);
        while (controller.stats.running) await new Promise((resolve) => setImmediate(resolve));
      }
      const s = controller.stats;
      ctx.ui.notify(action === "status"
        ? `${modelName} · ${s.calls} calls · $${s.cost.toFixed(5)} · ${s.pending} pending${s.limit ? " · limit reached" : ""}${s.error ? ` · last error: ${s.error}` : ""}`
        : display(controller.brief).join("\n"), "info");
    },
  });
  pi.registerCommand("trace", {
    description: "Show or hide the right-side trace rail",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Use /trace, /trace on, or /trace off", "warning"); return;
      }
      railWanted = action === "off" ? false : action === "on" ? true : !railWanted;
      if (railWanted) openRail(ctx);
      hideRail?.(!railWanted);
      paintRail?.();
      ctx.ui.notify(railWanted ? "Trace rail on" : "Trace rail off", "info");
    },
  });
}
