// No network or paid model calls: exercise the published Pi loader, session and provider runtime.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { completeBrief } from "../src/model.ts";
import { briefSystemPrompt } from "../src/judgment.ts";

const home = mkdtempSync(join(tmpdir(), "pi-brief-runtime-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = home;
process.env.PI_BRIEF_MODEL = "brief-test/vendor/brief";
process.env.PI_OFFLINE = "1";
after(() => rmSync(home, { recursive: true, force: true }));
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };

async function runtimeFixture() {
  const runtime = await ModelRuntime.create({
    authPath: join(home, "auth.json"), modelsPath: null, modelsStorePath: join(home, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const requests: { messages: unknown[]; options: SimpleStreamOptions | undefined }[] = [];
  registry.registerProvider("brief-test", {
    api: "brief-test-api", apiKey: "local-test-key", baseUrl: "https://brief-test.invalid",
    models: [{ id: "vendor/brief", name: "Local test brief", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 700 }],
    streamSimple(model, context, options) {
      requests.push({ messages: [...context.messages], options });
      const prompt = context.messages.find((message) => message.role === "user")?.content;
      const text = typeof prompt === "string" ? prompt : "";
      const marker = "UNTRUSTED_DATA_JSON\n";
      const source = text.includes(marker) ? JSON.parse(text.slice(text.indexOf(marker) + marker.length)).source : undefined;
      const judgment = { goal: "Fix checkout", done: "—", now: "Investigate checkout", next: "—", blocked: "—",
        alignment: source?.activity.some((row: any) => row.role === "assistant" && row.text) ? "aligned" : "unknown",
        evidence: { goal: source?.users.slice(0, 1).map((row: any) => row.id) ?? [], pivot: [], drift: [] },
        trace: { pivot: "", drift: "", steps: [] } };
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: JSON.stringify(judgment) }],
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  return { runtime, registry, requests };
}

test("published Pi runtime resolves auth and normalizes direct and virtual-model requests", async () => {
  const { runtime, registry, requests } = await runtimeFixture();
  const physical = registry.find("brief-test", "vendor/brief")!;
  let routed = false;
  runtime.registerVirtualModel({ provider: "brief-router", id: "auto", name: "Test router", route(request) {
    routed = true;
    assert.equal(request.reason, "direct");
    assert.equal(request.thinkingLevel, "off");
    return { model: physical, thinkingLevel: "off" };
  } });
  for (const model of [physical, registry.find("brief-router", "auto")!]) {
    const result = await completeBrief(registry, model, `${model.provider}/${model.id}`, "Evidence", "session-id", new AbortController().signal);
    assert.equal(result.error, undefined);
    assert.equal(result.cost, 0.001);
  }
  assert.equal(routed, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.messages.map((message: any) => message.role), ["system", "user"]);
    assert.equal((request.messages[0] as any).content, briefSystemPrompt);
    assert.equal(request.options?.apiKey, "local-test-key");
    assert.equal(request.options?.sessionId, "session-id");
    assert.equal(request.options?.maxRetries, 0);
    assert.equal(request.options?.maxTokens, 700);
  }
});

test("published Pi loader and session bind the package in TUI, print, JSON and RPC modes", async () => {
  for (const mode of ["tui", "print", "json", "rpc"] as const) {
    const { runtime, registry, requests } = await runtimeFixture();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
    const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../", import.meta.url))] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getExtensions().extensions.length, 1);
    const sessionManager = SessionManager.inMemory(home);
    sessionManager.appendMessage({ role: "user", content: "Fix checkout", timestamp: Date.now() });
    const uiCalls: string[] = [];
    const ui = { setWidget: (key: string, content: unknown) => uiCalls.push(`${key}:${content ? "shown" : "cleared"}`),
      setStatus: () => uiCalls.push("status"), notify: () => uiCalls.push("notify") } as unknown as ExtensionUIContext;
    const { session } = await createAgentSession({ cwd: home, agentDir: home, modelRuntime: runtime,
      model: registry.find("brief-test", "vendor/brief"), resourceLoader, settingsManager, sessionManager, noTools: "all" });
    const errors: unknown[] = [];
    session.extensionRunner.onError((error) => errors.push(error));
    try {
      await session.bindExtensions({ mode, uiContext: ui });
      assert.ok(session.extensionRunner.getCommand("brief"));
      assert.ok(session.extensionRunner.getCommand("trace"));
      assert.deepEqual(await session.extensionRunner.getCommand("brief")!.getArgumentCompletions!("re"), [{ value: "refresh", label: "refresh" }]);
      await session.prompt("/brief refresh");
      await session.prompt("/brief status");
      await session.prompt("/trace off");
      if (mode === "tui") {
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.options?.sessionId, sessionManager.getSessionId());
        const saved = sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-brief");
        assert.equal(saved.length, 1);
        assert.ok(uiCalls.includes("pi-brief:shown"));
        assert.equal(sessionManager.buildSessionProjection().messages.some((message) => message.role === "custom"), false,
          "brief entries must not participate in agent context");
      } else {
        assert.equal(requests.length, 0);
        assert.deepEqual(uiCalls, []);
      }
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      assert.deepEqual(errors, []);
      if (mode === "tui") assert.equal(uiCalls.at(-1), "pi-brief:cleared");
    } finally { session.dispose(); }
  }
});
