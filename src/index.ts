import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BriefController, cleanText, display, footerStatus, isBrief, sessionOutline, type Brief } from "./brief.ts";

const key = "pi-brief";
// Footer statuses are sorted by key before Pi truncates the shared line.
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

function outlineFor(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as { getBranch: () => unknown[]; getTree?: () => unknown[] };
  return sessionOutline(manager.getBranch(), manager.getTree?.() ?? []);
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

export default function piBrief(pi: ExtensionAPI) {
  let controller: BriefController | undefined;
  let modelName: string | undefined;
  let activity = "";

  function show(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const state = activity === "update failed" || activity === "limit reached" || activity.startsWith("off:") || activity.startsWith("config error")
      ? activity : "";
    const text = footerStatus(controller?.brief, state);
    const theme = (ctx.ui as { theme?: { fg?: (color: string, value: string) => string } }).theme;
    const shown = theme?.fg ? theme.fg("accent", text) : text;
    ctx.ui.setStatus(footerKey, shown);
    // The native footer can be clipped. Keep the same line directly above the editor.
    if ("setWidget" in ctx.ui) ctx.ui.setWidget(widgetKey, [shown]);
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
        signal, timeoutMs: 30_000, maxRetries: 0, maxTokens: 400, cacheRetention: "none",
        // OpenCode Go rejects requests that omit this routing id. Other providers ignore it.
        sessionId: routingSessionId(ctx, fallbackSessionId),
      });
      return { text: reply.content.filter((part) => part.type === "text").map((part) => part.text).join(""),
        cost: reply.usage.cost.total, error: modelFailure(reply) };
    }, (brief, changed) => {
      if (controller !== current) return; // A switched session/branch cannot write to the active branch.
      if (changed) pi.appendEntry(key, { brief }); // Branch-local, excluded from the agent's context.
      if (activity !== "working" && !activity.startsWith("using ")) {
        activity = current.stats.error ? "update failed" : current.stats.limit ? "limit reached" : "";
      }
      show(ctx);
    }, restored, config.maxCalls, config.maxCostUsd);
    controller = current;
    show(ctx);
    const outline = outlineFor(ctx);
    if (restored && !outline) current.noteOutline("");
    else if (outline) current.revise(outline);
  }

  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    controller?.close(); controller = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setStatus(footerKey, undefined);
      if ("setWidget" in ctx.ui) ctx.ui.setWidget(widgetKey, undefined);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!controller) return;
    activity = controller.stats.error ? "update failed" : controller.stats.limit ? "limit reached" : "";
    show(ctx);
    controller.revise(outlineFor(ctx));
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
        controller.revise(outlineFor(ctx), true);
        while (controller.stats.running) await new Promise((resolve) => setImmediate(resolve));
      }
      const s = controller.stats;
      ctx.ui.notify(action === "status"
        ? `${modelName} · ${s.calls} calls · $${s.cost.toFixed(5)} · ${s.pending} pending${s.limit ? " · limit reached" : ""}${s.error ? ` · last error: ${s.error}` : ""}`
        : display(controller.brief).join("\n"), "info");
    },
  });
}
