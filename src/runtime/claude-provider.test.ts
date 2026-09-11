import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { serve } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeEvent, RuntimeStartRequest } from "./types.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";

let nextMessages: any[] = [];
let queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> = [];
let querySetModelCalls: Array<string | undefined> = [];
let queryCloseCalls = 0;
let queryGate: Promise<void> | null = null;
let releaseQueryGate: (() => void) | null = null;
let nativeSkillNames: string[] = [];
let nativeDiscoveryGate: Promise<void> | undefined;
let consumedPrompts: unknown[] = [];
let nativeDiscoveryCalls = 0;
let onNativeModelTurn: ((env: Record<string, string>) => Promise<void>) | undefined;
let fixtureUpstream: import("bun").Server<undefined> | undefined;
let fixtureModelCalls = 0;

function nativeModelBody(names = nativeSkillNames): string {
  const content = [{ type: "text", text: "authorized prompt" }];
  if (names.length)
    content.unshift({
      type: "text",
      text: `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${names.map((name) => `- ${name}: Native fixture.`).join("\n")}\n</system-reminder>`,
    });
  return JSON.stringify({ model: "fixture-model", max_tokens: 1, messages: [{ role: "user", content }] });
}

function isAsyncPrompt(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (config: Record<string, unknown>) => ({
    type: "sdk",
    name: config.name ?? "mock",
    instance: {
      connect: async () => {},
      close: async () => {},
    },
  }),
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    queryCalls.push(input);
    const messages = [...nextMessages];
    const prompt = input.prompt;
    let nativeEnv: Record<string, string> = {};
    const consumePrompt = (async () => {
      if (isAsyncPrompt(prompt)) {
        for await (const message of prompt) consumedPrompts.push(message);
      } else consumedPrompts.push(prompt);
    })();
    return {
      getSettings: async () => {
        await nativeDiscoveryGate;
        return { effective: { env: nativeEnv }, sources: [], applied: {} };
      },
      applyFlagSettings: async (settings: { env: Record<string, string> }) => {
        nativeEnv = { ...settings.env };
      },
      getContextUsage: async () => {
        nativeDiscoveryCalls++;
        await nativeDiscoveryGate;
        return {
          totalTokens: nativeSkillNames.length * 20,
          categories: [],
          ...(nativeSkillNames.length
            ? {
                skills: {
                  totalSkills: 219,
                  includedSkills: nativeSkillNames.length,
                  tokens: nativeSkillNames.length * 20,
                  skillFrontmatter: nativeSkillNames.map((name) => ({ name, source: "plugin", tokens: 20 })),
                },
              }
            : {}),
        };
      },
      interrupt: async () => {},
      setModel: async (model?: string) => {
        querySetModelCalls.push(model);
      },
      close: () => {
        queryCloseCalls++;
        releaseQueryGate?.();
      },
      async *[Symbol.asyncIterator]() {
        await consumePrompt;
        if (onNativeModelTurn) await onNativeModelTurn(nativeEnv);
        else if (isAsyncPrompt(prompt) && consumedPrompts.length > 0 && nativeEnv.ANTHROPIC_BASE_URL) {
          await (
            await fetch(`${nativeEnv.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST", body: nativeModelBody() })
          ).text();
        }
        if (queryGate) {
          await queryGate;
        }
        for (const message of messages) {
          yield message;
        }
      },
    };
  },
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown, options?: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
    options,
  }),
}));

const { buildClaudeCodeEnvironment, createClaudeRuntimeProvider } = await import("./claude-provider.js");

function makeStartRequest(
  messages: RuntimeStartRequest["prompt"],
  overrides: Partial<RuntimeStartRequest> = {},
): RuntimeStartRequest {
  return {
    prompt: messages,
    model: "claude-sonnet",
    cwd: "/tmp/ravi-claude",
    abortController: new AbortController(),
    systemPromptAppend: "",
    env: { RAVI_MODEL_BROKER_ACTIVE: "1" },
    ...overrides,
  };
}

async function collectEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const output: RuntimeEvent[] = [];
  for await (const event of events) {
    output.push(event);
  }
  return output;
}

function findEventsByType<T extends RuntimeEvent["type"]>(
  events: RuntimeEvent[],
  type: T,
): Array<Extract<RuntimeEvent, { type: T }>> {
  return events.filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createClaudeRuntimeProvider", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    nextMessages = [];
    queryCalls = [];
    querySetModelCalls = [];
    queryCloseCalls = 0;
    queryGate = null;
    releaseQueryGate = null;
    nativeSkillNames = [];
    nativeDiscoveryGate = undefined;
    consumedPrompts = [];
    nativeDiscoveryCalls = 0;
    onNativeModelTurn = undefined;
    await fixtureUpstream?.stop(true);
    fixtureUpstream = undefined;
    fixtureModelCalls = 0;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("bootstraps Claude settings and env", () => {
    tempDir = mkdtempSync(join(tmpdir(), "ravi-claude-provider-"));
    const provider = createClaudeRuntimeProvider();

    const prepared = provider.prepareSession?.({
      agentId: "main",
      cwd: tempDir,
    });

    const settingsPath = join(tempDir, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(prepared).toEqual({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        CLAUDECODE: "",
      },
    });

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.PermissionRequest[0].matcher).toBe("*");
  });

  function policyRequest(names: string[] = ["ravi-system:tasks"]): RuntimeStartRequest {
    fixtureUpstream ??= serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        fixtureModelCalls++;
        return new Response("ok");
      },
    });
    const snapshot: SkillPolicySnapshot = {
      contractVersion: 1,
      id: "claude-policy-1",
      status: names.length ? "ready" : "empty",
      scope: { agentId: "restricted", executionId: "execution-1", contextKey: "context-1" },
      revisions: { policy: "1", permissions: "1", catalog: "1", toolSurface: "1" },
      skills: names.map((id) => ({
        id,
        name: id.split(":").at(-1) ?? id,
        aliases: [],
        resource: {
          path: `/authorized/${id}/SKILL.md`,
          files: [{ path: "SKILL.md", content: "---\nname: tasks\n---\nFixture." }],
        },
        requirements: { kind: "none" },
      })),
      provenance: {},
      diagnostics: [],
    };
    return makeStartRequest(
      (async function* () {
        yield {
          type: "user",
          message: { role: "user", content: "authorized prompt" },
          session_id: "",
          parent_tool_use_id: null,
        };
      })(),
      {
        env: { RAVI_MODEL_BROKER_ACTIVE: "1", ANTHROPIC_BASE_URL: fixtureUpstream.url.origin },
        skillPolicy: snapshot,
        skillNativeNames: Object.fromEntries(names.map((name) => [name, name])),
        skillExposure: { snapshotId: snapshot.id, mode: "native-restricted", preparedIds: names },
        verifySkillPolicy: async () => {},
        verifySkillPolicyAtDispatch: () => {},
        onSkillPolicyInvalidated: () => {},
      },
    );
  }

  it("binds preparation to the central snapshot without adding local skills", () => {
    tempDir = mkdtempSync(join(tmpdir(), "ravi-claude-policy-"));
    const request = policyRequest();
    const prepared = createClaudeRuntimeProvider().prepareSession?.({
      agentId: "restricted",
      cwd: tempDir,
      skillPolicy: request.skillPolicy,
      skillNativeNames: request.skillNativeNames,
      skillExposureMode: "native-restricted",
    });
    expect(prepared).toMatchObject({
      skillExposure: {
        snapshotId: "claude-policy-1",
        mode: "native-restricted",
        preparedIds: ["ravi-system:tasks"],
      },
    });
  });

  it("pins native routing before releasing input and observes the effective payload without token-count calls", async () => {
    nativeSkillNames = ["ravi-system:tasks"];
    nextMessages = [{ type: "result", subtype: "success", session_id: "verified-native" }];
    let releaseDiscovery = () => {};
    nativeDiscoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const handle = createClaudeRuntimeProvider().startSession(policyRequest());
    const pending = collectEvents(handle.events);
    await waitFor(() => queryCalls.length === 1);
    expect(consumedPrompts).toEqual([]);
    releaseDiscovery();
    const events = await pending;
    expect(queryCalls[0]?.options.skills).toEqual(["ravi-system:tasks"]);
    expect(consumedPrompts).toHaveLength(1);
    expect(nativeDiscoveryCalls).toBe(0);
    expect(fixtureModelCalls).toBe(1);
    expect(handle.skillVisibility?.skills).toEqual([
      expect.objectContaining({ id: "ravi-system:tasks", confidence: "observed", state: "advertised" }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider.raw",
        rawEvent: expect.objectContaining({
          type: "skill.exposure.observed",
          snapshotId: "claude-policy-1",
          discoverableIds: ["ravi-system:tasks"],
          evidence: "effective-prompt",
        }),
      }),
    );
  });

  it("keeps an explicit empty snapshot empty at the native SDK boundary", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "verified-empty" }];
    const handle = createClaudeRuntimeProvider().startSession(policyRequest([]));
    await collectEvents(handle.events);
    expect(queryCalls[0]?.options.skills).toEqual([]);
    expect(nativeDiscoveryCalls).toBe(0);
    expect(handle.skillVisibility?.skills).toEqual([]);
  });

  it.each([
    ["unlisted native skill", ["ravi-system:tasks", "personal-secret"]],
    ["missing authorized skill", []],
    ["duplicate skill", ["ravi-system:tasks", "ravi-system:tasks"]],
  ])("refuses to forward the model payload for %s", async (_reason, discovered) => {
    nativeSkillNames = discovered;
    const events = await collectEvents(createClaudeRuntimeProvider().startSession(policyRequest()).events);
    expect(fixtureModelCalls).toBe(0);
    expect(findEventsByType(events, "turn.failed")).toHaveLength(1);
    expect(queryCloseCalls).toBe(1);
  });

  it("does not start an SDK query when the policy is stale", async () => {
    const request = policyRequest();
    request.verifySkillPolicy = async () => {
      throw new Error("Skill policy changed");
    };
    const events = await collectEvents(createClaudeRuntimeProvider().startSession(request).events);
    expect(queryCalls).toHaveLength(0);
    expect(findEventsByType(events, "turn.failed")).toHaveLength(1);
  });

  it("refuses native slash expansion before any SDK query can load an unlisted skill", async () => {
    const request = policyRequest([]);
    request.prompt = (async function* () {
      yield {
        type: "user",
        message: { role: "user", content: "  /fixture-denied arg" },
        session_id: "",
        parent_tool_use_id: null,
      };
    })();
    const events = await collectEvents(createClaudeRuntimeProvider().startSession(request).events);
    expect(queryCalls.length).toBe(0);
    expect(fixtureModelCalls).toBe(0);
    expect(findEventsByType(events, "turn.failed")).toEqual([
      expect.objectContaining({ recoverable: false, error: expect.stringContaining("slash") }),
    ]);
    expect(findEventsByType(events, "turn.failed")[0]?.failureKind).toBeUndefined();
  });

  it("rechecks policy after discovery before releasing the prompt", async () => {
    nativeSkillNames = ["ravi-system:tasks"];
    let checks = 0;
    const request = policyRequest();
    request.verifySkillPolicy = async () => {
      if (++checks === 2) throw new Error("Skill policy changed");
    };
    const events = await collectEvents(createClaudeRuntimeProvider().startSession(request).events);
    expect(queryCalls).toHaveLength(1);
    expect(consumedPrompts).toEqual([]);
    expect(findEventsByType(events, "turn.failed")).toHaveLength(1);
  });

  it("blocks native delegation whose separate skill discovery cannot be restricted", async () => {
    nativeSkillNames = ["ravi-system:tasks"];
    nextMessages = [{ type: "result", subtype: "success", session_id: "verified-no-native-delegation" }];
    const request = policyRequest();
    request.permissionOptions = { disallowedTools: ["WebFetch"] };
    const provider = createClaudeRuntimeProvider();
    await collectEvents(provider.startSession(request).events);
    expect(queryCalls[0]?.options.disallowedTools).toEqual(
      expect.arrayContaining(["WebFetch", "Agent", "Task", "TeamCreate", "SendMessage"]),
    );
    expect(provider.getCapabilities().tools.availableCapabilities).not.toContain("agent.task.start");
    expect(provider.getCapabilities().tools.availableCapabilities).not.toContain("team.create");
  });

  it("closes a policy query only once when the caller closes during preflight", async () => {
    nativeSkillNames = ["ravi-system:tasks"];
    let releaseDiscovery = () => {};
    nativeDiscoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const request = policyRequest();
    const handle = createClaudeRuntimeProvider().startSession(request);
    const pending = collectEvents(handle.events);
    await waitFor(() => queryCalls.length === 1);
    await handle.close?.();
    releaseDiscovery();
    await pending;
    expect(queryCloseCalls).toBe(1);
    expect(consumedPrompts).toEqual([]);
  });

  it("rejects a policy execution without a revision verifier", () => {
    const request = policyRequest();
    request.verifySkillPolicy = undefined;
    expect(() => createClaudeRuntimeProvider().startSession(request)).toThrow("revision verifier");
    expect(queryCalls.length).toBe(0);
  });

  it("fences the SDK's second model request and reports a typed policy failure", async () => {
    let received = 0;
    let revoked = false;
    let notified = 0;
    const upstream = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        received++;
        return new Response("ok");
      },
    });
    nextMessages = [{ type: "result", subtype: "success", session_id: "must-not-complete" }];
    const request = policyRequest([]);
    request.env = { RAVI_MODEL_BROKER_ACTIVE: "1", ANTHROPIC_BASE_URL: upstream.url.origin };
    request.verifySkillPolicyAtDispatch = () => {
      if (revoked) throw new Error("Fixture revoked");
    };
    request.onSkillPolicyInvalidated = () => {
      notified++;
    };
    onNativeModelTurn = async (env) => {
      const base = env.ANTHROPIC_BASE_URL ?? upstream.url.origin;
      await (await fetch(`${base}/v1/messages`, { method: "POST", body: nativeModelBody([]) })).text();
      revoked = true;
      await (await fetch(`${base}/v1/messages`, { method: "POST", body: nativeModelBody([]) })).text();
    };
    try {
      const events = await collectEvents(createClaudeRuntimeProvider().startSession(request).events);
      expect(received).toBe(1);
      expect(notified).toBe(1);
      expect(findEventsByType(events, "turn.complete").length).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ type: "turn.failed", failureKind: "skill-policy" }));
    } finally {
      await upstream.stop(true);
    }
  });

  it("advertises the allowlisted canonical app builder through the Claude plugin", () => {
    const provider = createClaudeRuntimeProvider();
    const pluginPath = join(import.meta.dir, "..", "plugins", "internal", "ravi-dev");
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "build an app" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        {
          plugins: [{ type: "local", path: pluginPath }],
          allowedSkills: ["ravi-dev-app-creator"],
        },
      ),
    );

    expect(session.skillVisibility?.loadedSkills).toEqual([]);
    expect(session.skillVisibility?.skills).toEqual([
      expect.objectContaining({
        id: "app-creator",
        provider: "claude",
        state: "advertised",
        confidence: "declared",
        source: "plugin:ravi-dev/app-creator",
      }),
    ]);
  });

  it("closes the active Claude SDK query idempotently", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-close" }];
    queryGate = new Promise<void>((resolve) => {
      releaseQueryGate = resolve;
    });

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "close" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const eventsPromise = collectEvents(session.events);
    await waitFor(() => queryCalls.length === 1);
    await session.close?.();
    await session.close?.();
    await eventsPromise;

    expect(queryCloseCalls).toBe(1);
  });

  it("normalizes assistant/tool/result events", async () => {
    nextMessages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello from Claude" },
            { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file contents", is_error: false }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "claude-session-1",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    const toolStarted = findEventsByType(events, "tool.started").at(0);
    const assistantMessages = findEventsByType(events, "assistant.message");
    const toolCompleted = findEventsByType(events, "tool.completed").at(0);
    const completions = findEventsByType(events, "turn.complete");

    expect(toolStarted?.toolUse).toEqual({
      id: "tool_1",
      name: "Read",
      input: { file_path: "README.md" },
    });
    expect(assistantMessages.map((event) => event.text)).toContain("Hello from Claude");
    expect(toolCompleted?.toolUseId).toBe("tool_1");
    expect(toolCompleted?.content).toBe("file contents");
    expect(completions[0]?.providerSessionId).toBe("claude-session-1");
    expect(completions[0]?.session).toMatchObject({
      params: {
        sessionId: "claude-session-1",
        skillVisibility: {
          loadedSkills: [],
          skills: [],
        },
      },
      displayId: "claude-session-1",
    });
    expect(completions[0]?.execution).toEqual({
      provider: "anthropic",
      model: null,
      billingType: "api",
    });
    expect(completions[0]?.usage.cacheReadTokens).toBe(2);
    expect(completions[0]?.usage.cacheCreationTokens).toBe(1);
  });

  it("maps error results into turn.failed", async () => {
    nextMessages = [
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "claude-session-2",
        errors: ["Tool execution failed"],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    const failures = findEventsByType(events, "turn.failed");

    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain("Tool execution failed");
    expect(findEventsByType(events, "turn.complete")).toHaveLength(0);
  });

  it("synthesizes a failed turn when the provider stream ends without a terminal result", async () => {
    nextMessages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "partial answer" }],
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    const failures = findEventsByType(events, "turn.failed");

    expect(findEventsByType(events, "assistant.message").map((event) => event.text)).toEqual(["partial answer"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBe("Runtime provider stream ended without a terminal event");
    expect(failures[0]?.rawEvent).toMatchObject({
      type: "stream.ended",
      reason: "missing_terminal_event",
    });
  });

  it("does not empty-join distinct assistant text blocks into one message", async () => {
    nextMessages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "primeiro?" },
            { type: "text", text: "Olá" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "claude-session-mash",
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "oi" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      ),
    );

    const events = await collectEvents(session.events);
    expect(findEventsByType(events, "assistant.message").map((event) => event.text)).toEqual(["primeiro?", "Olá"]);
  });

  it("passes an explicit native executable path when configured", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-3" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        {
          env: {
            RAVI_CLAUDE_CODE_EXECUTABLE: "/opt/ravi/bin/native-runtime",
            PATH: "",
          },
        },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.prompt).toBe("hello");
    expect(queryCalls[0]?.options.effort).toBe("max");
    expect(queryCalls[0]?.options.pathToClaudeCodeExecutable).toBe("/opt/ravi/bin/native-runtime");
  });

  it("maps Ravi xhigh effort to the adapter strongest effort", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-effort" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { effort: "xhigh" },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options.effort).toBe("max");
  });

  it("omits disabled thinking for Claude Fable 5", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-fable-thinking" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { model: "claude-fable-5", thinking: "off" },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options.model).toBe("claude-fable-5");
    expect(queryCalls[0]?.options.thinking).toBeUndefined();
  });

  it("keeps summarized adaptive thinking for Claude Fable 5 verbose mode", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-fable-verbose" }];

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { model: "claude-fable-5", thinking: "verbose" },
      ),
    );

    await collectEvents(session.events);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("updates active and subsequent query models without recreating the provider session", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-model" }];
    queryGate = new Promise<void>((resolve) => {
      releaseQueryGate = resolve;
    });

    let releaseSecondPrompt = () => {};
    const secondPromptReady = new Promise<void>((resolve) => {
      releaseSecondPrompt = resolve;
    });

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "first" },
            session_id: "",
            parent_tool_use_id: null,
          };
          await secondPromptReady;
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "second" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { model: "model-a" },
      ),
    );

    const eventsPromise = collectEvents(session.events);
    await waitFor(() => queryCalls.length === 1);
    await session.setModel?.("model-b");
    expect(querySetModelCalls).toEqual(["model-b"]);
    releaseQueryGate?.();
    await waitFor(() => queryCalls.length === 1 && querySetModelCalls.length === 1);

    queryGate = null;
    releaseSecondPrompt();
    const events = await eventsPromise;

    expect(findEventsByType(events, "turn.complete")).toHaveLength(2);
    expect(queryCalls[0]?.options.model).toBe("model-a");
    expect(queryCalls[1]?.options.model).toBe("model-b");
  });

  it("refreshes Ravi authority env between turns without resetting conversation history", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-session-authority" }];
    const env: Record<string, string> = {
      PATH: "",
      RAVI_CONTEXT_KEY: "rctx_first",
      RAVI_TASK_ID: "task_stale",
    };

    const provider = createClaudeRuntimeProvider();
    const session = provider.startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "first" },
            session_id: "",
            parent_tool_use_id: null,
          };
          env.RAVI_CONTEXT_KEY = "rctx_second";
          delete env.RAVI_TASK_ID;
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "second" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        { env },
      ),
    );

    const events = await collectEvents(session.events);
    expect(queryCalls).toHaveLength(2);
    const firstEnv = queryCalls[0]?.options.env as Record<string, string>;
    const secondEnv = queryCalls[1]?.options.env as Record<string, string>;

    expect(findEventsByType(events, "turn.complete")).toHaveLength(2);
    expect(firstEnv.RAVI_CONTEXT_KEY).toBe("rctx_first");
    expect(firstEnv.RAVI_TASK_ID).toBe("task_stale");
    expect(secondEnv.RAVI_CONTEXT_KEY).toBe("rctx_second");
    expect(secondEnv.RAVI_TASK_ID).toBeUndefined();
    expect(queryCalls[1]?.options.resume).toBe("claude-session-authority");
    expect(secondEnv).not.toBe(firstEnv);
  });

  it("backfills daemon auth env when the runtime env is partial", async () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-daemon-token";

    try {
      const env = buildClaudeCodeEnvironment({
        RAVI_CLAUDE_CODE_EXECUTABLE: "/opt/ravi/bin/native-runtime",
        PATH: "",
      });

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-daemon-token");
      expect(env.PATH).toBe("");
    } finally {
      if (originalToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
      }
    }
  });

  it("never backfills upstream auth into a model-broker runtime", () => {
    const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "daemon-oauth-secret";
    process.env.ANTHROPIC_API_KEY = "daemon-api-secret";
    try {
      const env = buildClaudeCodeEnvironment({
        RAVI_MODEL_BROKER_ACTIVE: "1",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:43123",
      });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:43123");
    } finally {
      if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  it("loads only protected user settings in model-broker mode and excludes malicious project overrides", async () => {
    nextMessages = [{ type: "result", subtype: "success", session_id: "claude-proxy", result: "ok", usage: {} }];
    const handle = createClaudeRuntimeProvider().startSession(
      makeStartRequest(
        (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "hello" },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
        {
          settingSources: ["project"],
          modelBroker: {
            version: 1,
            brokerId: "hub",
            leaseId: "grant_claude_1",
            attemptId: "attempt_claude_1",
            turnId: "turn_claude_1",
            runtimeId: "runtime_a",
            runtimeProvider: "claude",
            model: "claude-sonnet",
            routeRevision: "route_1",
            compatibilityRevision: "compat_claude_1",
            expiresAt: Date.now() + 60_000,
            transport: {
              scheme: "local-http-forwarder-v1",
              protocol: "anthropic-messages",
              origin: "http://127.0.0.1:43123",
              path: "/v1/messages",
              publicHeaders: { "x-public-route": "binding_claude_1" },
            },
            profileRef: "profile_main",
            selectionCompatibilityKey: "selection_main",
            principalIsolation: "cgroup",
          },
          env: {
            RAVI_MODEL_BROKER_ACTIVE: "1",
            CLAUDE_CONFIG_DIR: "/tmp/ravi-model-broker/claude",
          },
        },
      ),
    );
    await collectEvents(handle.events);
    expect(queryCalls[0]?.options.settingSources).toEqual(["user"]);
    expect(queryCalls[0]?.options.settingSources).not.toContain("project");
  });
});
afterAll(() => mock.restore());
