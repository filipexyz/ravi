import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGeneratedAgentsBridge } from "./agent-instructions.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import type { RuntimeEvent, RuntimeHostServices, RuntimeStartRequest } from "./types.js";

type TransportRequest = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  effort?: string;
  prompt: string;
  resume?: string;
  systemPromptAppend: string;
};

type TurnFactory = (request: TransportRequest) => {
  events: AsyncIterable<Record<string, unknown>>;
  result?: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }>;
  interrupt?: () => Promise<void> | void;
};

function createMockTransport(factories: TurnFactory[]) {
  const calls: TransportRequest[] = [];
  let index = 0;

  return {
    calls,
    transport: {
      startTurn(request: TransportRequest) {
        calls.push(request);
        const factory = factories[index++];
        if (!factory) {
          throw new Error("Missing transport factory for call");
        }
        const value = factory(request);
        return {
          events: value.events,
          result:
            value.result ??
            Promise.resolve({
              exitCode: 0,
              signal: null,
              stderr: "",
            }),
          interrupt: value.interrupt ?? (() => {}),
        };
      },
    },
  };
}

function makePromptGenerator(messages: string[]): RuntimeStartRequest["prompt"] {
  return (async function* () {
    for (const content of messages) {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content },
        session_id: "",
        parent_tool_use_id: null,
      };
    }
  })();
}

function makeStartRequest(messages: string[], overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    prompt: makePromptGenerator(messages),
    model: "gpt-5",
    cwd: "/tmp/ravi-codex",
    abortController: new AbortController(),
    systemPromptAppend: "",
    env: { PATH: process.env.PATH ?? "" },
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

describe("createCodexRuntimeProvider", () => {
  it("synchronizes plugin-backed skills during provider bootstrap", () => {
    const synced: Array<{ type: "local"; path: string }> = [];
    const provider = createCodexRuntimeProvider({
      syncSkills: (plugins) => {
        synced.push(...plugins);
        return ["ravi-system-agents-manager"];
      },
    });

    const result = provider.prepareSession?.({
      agentId: "main",
      cwd: "/tmp/ravi-codex",
      plugins: [{ type: "local", path: "/tmp/ravi/plugins/ravi-system" }],
    });

    expect(result).toEqual({});
    expect(synced).toEqual([{ type: "local", path: "/tmp/ravi/plugins/ravi-system" }]);
  });

  it("materializes the global Codex bash hook in ~/.codex/hooks.json", () => {
    const home = mkdtempSync(join(tmpdir(), "ravi-codex-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const provider = createCodexRuntimeProvider();
      provider.prepareSession?.({
        agentId: "main",
        cwd: "/tmp/ravi-codex",
        plugins: [],
      });

      const hooksPath = join(home, ".codex", "hooks.json");
      expect(existsSync(hooksPath)).toBe(true);

      const payload = JSON.parse(readFileSync(hooksPath, "utf8"));
      const preToolUse = Array.isArray(payload?.hooks?.PreToolUse) ? payload.hooks.PreToolUse : [];
      const raviHookGroup = preToolUse.find(
        (group: any) =>
          group?.matcher === "^Bash$" &&
          Array.isArray(group?.hooks) &&
          group.hooks.some((handler: any) => handler?.statusMessage === "ravi codex bash permission gate"),
      );

      expect(raviHookGroup).toBeDefined();
      expect(raviHookGroup.hooks[0]?.command).toContain("context");
      expect(raviHookGroup.hooks[0]?.command).toContain("codex-bash-hook");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("builds Codex-local start handlers from generic runtime host services", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-provider-"));
    const toolSpec = {
      name: "tools_list",
      description: "List tools",
      inputSchema: { type: "object" },
    };
    const capabilityRequests: Array<Parameters<RuntimeHostServices["authorizeCapability"]>[0]> = [];
    const hostServices: RuntimeHostServices = {
      authorizeCapability: async (request) => {
        capabilityRequests.push(request);
        return { allowed: true, inherited: false };
      },
      authorizeCommandExecution: async (request) => ({
        approved: true,
        inherited: true,
        updatedInput: request.input,
      }),
      authorizeToolUse: async (request) => ({
        approved: true,
        inherited: true,
        updatedInput: request.input,
      }),
      requestUserInput: async () => ({ approved: true, answers: { choice: "A" } }),
      listDynamicTools: () => [toolSpec],
      executeDynamicTool: async (request) => ({
        success: true,
        contentItems: [{ type: "inputText", text: `ran ${request.toolName}` }],
      }),
    };

    const provider = createCodexRuntimeProvider({ defaultModel: "gpt-5", syncSkills: () => [] });
    const prepared = await provider.prepareSession?.({
      agentId: "main",
      cwd,
      plugins: [],
      hostServices,
    });

    expect(prepared?.startRequest?.dynamicTools).toEqual([toolSpec]);
    await expect(
      prepared?.startRequest?.approveRuntimeRequest?.({
        kind: "permission",
        method: "item/permissions/requestApproval",
        input: { permissions: { "use:tool:Bash": true } },
      }),
    ).resolves.toMatchObject({
      approved: true,
      inherited: false,
      permissions: { "use:tool:Bash": true },
    });
    expect(capabilityRequests[0]).toMatchObject({
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
    });

    await expect(
      prepared?.startRequest?.handleRuntimeToolCall?.({
        toolName: "tools_list",
        callId: "call_1",
        arguments: {},
      }),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ type: "inputText", text: "ran tools_list" }],
    });
  });

  it("passes dynamic tools when bootstrapping a resumed app-server thread", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-resume-tools-"));
    const command = join(cwd, "fake-codex-app-server.mjs");
    const requestsPath = join(cwd, "thread-requests.jsonl");
    const toolSpec = {
      name: "tools_list",
      description: "List tools",
      inputSchema: { type: "object" },
    };

    writeFileSync(
      command,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const requestsPath = ${JSON.stringify(requestsPath)};
const rl = createInterface({ input: process.stdin });
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.id && (message.method === "thread/start" || message.method === "thread/resume")) {
    appendFileSync(requestsPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    send({
      id: message.id,
      result: { thread: { id: message.params.threadId ?? "thread_new" }, model: "gpt-5.4", modelProvider: "openai" },
    });
    return;
  }
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread_prev", turn: { id: "turn_resume", status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread_prev", turn: { id: "turn_resume", status: "completed" } },
    });
  }
});
`,
    );
    chmodSync(command, 0o755);

    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest(["resume"], {
        cwd,
        resume: "thread_prev",
        dynamicTools: [toolSpec],
      }),
    );

    const events = await collectEvents(session.events);
    const threadRequests = readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(findEventsByType(events, "turn.complete")).toHaveLength(1);
    expect(threadRequests).toHaveLength(1);
    expect(threadRequests[0]?.method).toBe("thread/resume");
    expect(threadRequests[0]?.params.threadId).toBe("thread_prev");
    expect(threadRequests[0]?.params.dynamicTools).toEqual([toolSpec]);
  });

  it("maps CLI completion events and composes prompts with system instructions", async () => {
    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_1" };
          yield { type: "turn.started" };
          yield { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Hello world" } };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 11,
              cached_input_tokens: 3,
              output_tokens: 7,
            },
          };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest(["Hello"], {
        model: "sonnet",
        resume: "thread_prev",
        systemPromptAppend: "You are Ravi.",
      }),
    );

    const events = await collectEvents(session.events);
    const assistantMessages = findEventsByType(events, "assistant.message").map((event) => event.text);
    const completions = findEventsByType(events, "turn.complete");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBeUndefined();
    expect(calls[0]?.resume).toBe("thread_prev");
    expect(calls[0]?.prompt).toBe("Hello");
    expect(calls[0]?.systemPromptAppend).toContain("You are Ravi.");
    expect(calls[0]?.systemPromptAppend).toContain("Ravi may install native Codex skills");
    expect(assistantMessages).toEqual(["Hello world"]);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.providerSessionId).toBe("thread_1");
    expect(completions[0]?.session).toEqual({
      params: { sessionId: "thread_1", cwd: "/tmp/ravi-codex" },
      displayId: "thread_1",
    });
    expect(completions[0]?.execution).toEqual({
      provider: "openai",
      model: null,
      billingType: "subscription",
    });
    expect(completions[0]?.usage.inputTokens).toBe(11);
    expect(completions[0]?.usage.outputTokens).toBe(7);
    expect(completions[0]?.usage.cacheReadTokens).toBe(3);
  });

  it("chains resumed thread ids only after completed turns", async () => {
    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_1" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_2" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["turn one", "turn two"]));

    await collectEvents(session.events);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.resume).toBeUndefined();
    expect(calls[1]?.resume).toBe("thread_1");
  });

  it("passes through explicit Codex model overrides", async () => {
    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_model" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["hello"], { model: "gpt-5.4" }));

    const events = await collectEvents(session.events);
    const completions = findEventsByType(events, "turn.complete");

    expect(calls[0]?.model).toBe("gpt-5.4");
    expect(calls[0]?.effort).toBe("xhigh");
    expect(completions[0]?.execution?.model).toBe("gpt-5.4");
  });

  it("uses xhigh as the Codex effort when the requested effort is invalid", async () => {
    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_effort" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["hello"], { effort: "invalid" as never }));

    await collectEvents(session.events);

    expect(calls[0]?.effort).toBe("xhigh");
  });

  it("loads workspace instructions from AGENTS.md into the Codex system prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-provider-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n\nUse the Ravi skills when helpful.\n");

    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_instructions" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest(["hello"], {
        cwd,
        systemPromptAppend: "Runtime rules go here.",
      }),
    );

    await collectEvents(session.events);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPromptAppend).toContain(`Workspace instructions loaded from ${join(cwd, "AGENTS.md")}`);
    expect(calls[0]?.systemPromptAppend).toContain("Use the Ravi skills when helpful.");
    expect(calls[0]?.systemPromptAppend).toContain("Runtime rules go here.");
  });

  it("does not duplicate workspace instructions when the runtime prompt already carries them", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-provider-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n\nThis should not be loaded twice.\n");

    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_deduped_instructions" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest(["hello"], {
        cwd,
        systemPromptAppend: [
          "## Workspace Instructions",
          "",
          "Workspace instructions loaded from runtime.",
          "",
          "## Runtime",
          "",
          "Runtime rules go here.",
        ].join("\n"),
      }),
    );

    await collectEvents(session.events);

    expect(calls).toHaveLength(1);
    const systemPromptAppend = calls[0]?.systemPromptAppend ?? "";
    expect(systemPromptAppend.match(/## Workspace Instructions/g)?.length).toBe(1);
    expect(systemPromptAppend).toContain("Workspace instructions loaded from runtime.");
    expect(systemPromptAppend).not.toContain("This should not be loaded twice.");
  });

  it("migrates legacy CLAUDE.md workspaces before loading Codex instructions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-provider-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Main Agent\n\nUse the Ravi skills when helpful.\n");
    writeFileSync(join(cwd, "AGENTS.md"), buildGeneratedAgentsBridge());

    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_legacy_instructions" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest(["hello"], {
        cwd,
        systemPromptAppend: "Runtime rules go here.",
      }),
    );

    await collectEvents(session.events);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPromptAppend).toContain(`Workspace instructions loaded from ${join(cwd, "AGENTS.md")}`);
    expect(calls[0]?.systemPromptAppend).toContain("Use the Ravi skills when helpful.");
  });

  it("prepareSession creates a CLAUDE.md compatibility bridge for AGENTS-first workspaces", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-provider-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n\nUse the Ravi skills when helpful.\n");

    const provider = createCodexRuntimeProvider({ defaultModel: "gpt-5" });
    provider.prepareSession?.({ agentId: "main", cwd, plugins: [] });

    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
  });

  it("includes synchronized Ravi skill names in the Codex system prompt", async () => {
    const { calls, transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_skills" };
          yield { type: "turn.started" };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({
      transport: transport as any,
      defaultModel: "gpt-5",
      syncSkills: () => ["ravi-system-events", "ravi-system-agents-manager"],
    });

    provider.prepareSession?.({
      agentId: "main",
      cwd: "/tmp/ravi-codex",
      plugins: [{ type: "local", path: "/tmp/ravi/plugins/ravi-system" }],
    });

    const session = provider.startSession(makeStartRequest(["hello"]));
    await collectEvents(session.events);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.systemPromptAppend).toContain("Ravi synchronized these Codex skills for this session:");
    expect(calls[0]?.systemPromptAppend).toContain("- ravi-system-events");
    expect(calls[0]?.systemPromptAppend).toContain("- ravi-system-agents-manager");
  });

  it("maps agent message delta events into runtime text.delta chunks", async () => {
    const { transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_delta" };
          yield { type: "turn.started" };
          yield { type: "agent_message.delta", delta: "Hello" };
          yield { type: "agent_message.delta", delta: " world" };
          yield { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Hello world" } };
          yield {
            type: "turn.completed",
            usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 },
            model: "gpt-5.4",
            model_provider: "openai",
          };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["hello"]));

    const events = await collectEvents(session.events);
    const deltas = findEventsByType(events, "text.delta").map((event) => event.text);
    const completions = findEventsByType(events, "turn.complete");

    expect(deltas).toEqual(["Hello", " world"]);
    expect(completions[0]?.execution).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      billingType: "subscription",
    });
  });

  it("emits explicit tool lifecycle events for command execution and file changes", async () => {
    const { transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_tools" };
          yield { type: "turn.started" };
          yield {
            type: "item.started",
            item: {
              id: "cmd_1",
              type: "command_execution",
              command: "/bin/zsh -lc pwd",
              status: "in_progress",
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: "cmd_1",
              type: "command_execution",
              command: "/bin/zsh -lc pwd",
              aggregated_output: "/tmp/ravi-codex\n",
              exit_code: 0,
              status: "completed",
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: "fc_1",
              type: "file_change",
              changes: [{ path: "/tmp/ravi-codex/hi.txt", kind: "add" }],
              status: "completed",
            },
          };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["tools"]));

    const events = await collectEvents(session.events);
    const toolStarts = findEventsByType(events, "tool.started");
    const toolCompleted = findEventsByType(events, "tool.completed");

    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0]?.toolUse).toEqual({
      id: "cmd_1",
      name: "shell",
      input: { command: "/bin/zsh -lc pwd" },
    });
    expect(toolStarts[1]?.toolUse).toEqual({
      id: "fc_1",
      name: "file_change",
      input: { changes: [{ path: "/tmp/ravi-codex/hi.txt", kind: "add" }] },
    });
    expect(toolCompleted[0]?.toolUseId).toBe("cmd_1");
    expect(toolCompleted[0]?.toolName).toBe("shell");
    expect(toolCompleted[0]?.content).toBe("/tmp/ravi-codex\n");
    expect(toolCompleted[1]?.toolUseId).toBe("fc_1");
    expect(toolCompleted[1]?.toolName).toBe("file_change");
    expect(toolCompleted[1]?.content).toEqual([{ path: "/tmp/ravi-codex/hi.txt", kind: "add" }]);
  });

  it("emits native thread, turn, and item graph events with compatibility events", async () => {
    const { transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_graph", thread: { id: "thread_graph", title: "Graph" } };
          yield {
            type: "turn.started",
            thread_id: "thread_graph",
            turn_id: "turn_graph",
            turn: { id: "turn_graph", status: "in_progress" },
          };
          yield {
            type: "item.started",
            thread_id: "thread_graph",
            turn_id: "turn_graph",
            item: {
              id: "cmd_graph",
              type: "command_execution",
              command: "pwd",
              status: "in_progress",
              parent_id: "turn_graph",
            },
          };
          yield {
            type: "item.completed",
            thread_id: "thread_graph",
            turn_id: "turn_graph",
            item: {
              id: "cmd_graph",
              type: "command_execution",
              command: "pwd",
              aggregated_output: "/tmp/ravi-codex\n",
              status: "completed",
              parent_id: "turn_graph",
            },
          };
          yield {
            type: "agent_message.delta",
            thread_id: "thread_graph",
            turn_id: "turn_graph",
            item_id: "msg_graph",
            delta: "done",
          };
          yield {
            type: "item.completed",
            thread_id: "thread_graph",
            turn_id: "turn_graph",
            item: {
              id: "msg_graph",
              type: "agent_message",
              text: "done",
              status: "completed",
              parent_id: "turn_graph",
            },
          };
          yield {
            type: "turn.completed",
            thread_id: "thread_graph",
            turn_id: "turn_graph",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["graph"]));

    const events = await collectEvents(session.events);
    const threadStarted = findEventsByType(events, "thread.started");
    const turnStarted = findEventsByType(events, "turn.started");
    const itemStarted = findEventsByType(events, "item.started");
    const itemCompleted = findEventsByType(events, "item.completed");
    const deltas = findEventsByType(events, "text.delta");
    const toolStarts = findEventsByType(events, "tool.started");
    const toolCompleted = findEventsByType(events, "tool.completed");
    const assistantMessages = findEventsByType(events, "assistant.message");
    const completions = findEventsByType(events, "turn.complete");

    expect(threadStarted[0]?.thread).toEqual({ id: "thread_graph", title: "Graph" });
    expect(threadStarted[0]?.metadata?.thread?.id).toBe("thread_graph");
    expect(turnStarted[0]?.turn).toEqual({ id: "turn_graph", status: "in_progress" });
    expect(turnStarted[0]?.metadata?.thread?.id).toBe("thread_graph");
    expect(itemStarted[0]?.item).toEqual({
      id: "cmd_graph",
      type: "command_execution",
      status: "in_progress",
      parentId: "turn_graph",
    });
    expect(itemCompleted.map((event) => event.item.id)).toEqual(["cmd_graph", "msg_graph"]);
    expect(deltas[0]?.text).toBe("done");
    expect(deltas[0]?.metadata?.item?.id).toBe("msg_graph");
    expect(toolStarts).toHaveLength(1);
    expect(toolCompleted).toHaveLength(1);
    expect(assistantMessages[0]?.text).toBe("done");
    expect(completions[0]?.providerSessionId).toBe("thread_graph");
    expect(completions[0]?.metadata?.turn?.id).toBe("turn_graph");
  });

  it("maps app-server notifications into the runtime event graph", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-app-server-"));
    const command = join(cwd, "fake-codex-app-server.mjs");
    writeFileSync(
      command,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.id && (message.method === "thread/start" || message.method === "thread/resume")) {
    send({
      id: message.id,
      result: {
        thread: { id: "thread_app", title: "App thread" },
        model: "gpt-5.4",
        modelProvider: "openai",
      },
    });
    return;
  }
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread_app", title: "App thread" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread_app", turn: { id: "turn_app", status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        item: {
          id: "cmd_app",
          type: "commandExecution",
          command: "pwd",
          status: "inProgress",
          parentItemId: "turn_app",
          processId: 123,
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          id: "cmd_app",
          type: "commandExecution",
          command: "pwd",
          status: "completed",
          aggregatedOutput: "/tmp/ravi-codex\\n",
          exitCode: 0,
          parentItemId: "turn_app",
          processId: 123,
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { delta: "done", itemId: "msg_app" },
    });
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          id: "msg_app",
          type: "agentMessage",
          text: "done",
          status: "completed",
          parentItemId: "turn_app",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { tokenUsage: { last: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 3 } } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread_app", turn: { id: "turn_app", status: "completed" } },
    });
  }
});
`,
    );
    chmodSync(command, 0o755);

    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["app-server"], { cwd }));

    const events = await collectEvents(session.events);
    const threadStarted = findEventsByType(events, "thread.started");
    const turnStarted = findEventsByType(events, "turn.started");
    const itemStarted = findEventsByType(events, "item.started");
    const toolStarted = findEventsByType(events, "tool.started");
    const assistantMessages = findEventsByType(events, "assistant.message");
    const completions = findEventsByType(events, "turn.complete");

    expect(threadStarted[0]?.thread).toEqual({ id: "thread_app", title: "App thread" });
    expect(turnStarted[0]?.turn).toEqual({ id: "turn_app", status: "in_progress" });
    expect(itemStarted[0]?.item).toEqual({
      id: "cmd_app",
      type: "command_execution",
      status: "in_progress",
      parentId: "turn_app",
    });
    expect(itemStarted[0]?.metadata?.source).toBe("codex.app-server");
    expect(toolStarted[0]?.toolUse).toEqual({
      id: "cmd_app",
      name: "shell",
      input: { command: "pwd" },
    });
    expect(assistantMessages[0]?.text).toBe("done");
    expect(completions[0]?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheCreationTokens: 0,
    });
    expect(completions[0]?.metadata?.thread?.id).toBe("thread_app");
    expect(completions[0]?.metadata?.turn?.id).toBe("turn_app");
  });

  it("executes app-server thread control requests through runtime control", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-thread-control-"));
    const command = join(cwd, "fake-codex-app-server.mjs");
    const logPath = join(cwd, "requests.jsonl");
    writeFileSync(
      command,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const logPath = process.env.RAVI_CODEX_TEST_LOG;
const log = (message) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ method: message.method, params: message.params ?? {} }) + "\\n");
};
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && message.method) log(message);

  if (message.id && message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.id && message.method === "thread/start") {
    send({
      id: message.id,
      result: { thread: { id: "thread_control", title: "Control thread" }, model: "gpt-5.4", modelProvider: "openai" },
    });
    return;
  }
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread_control", title: "Control thread" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread_control", turn: { id: "turn_control", status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread_control", turn: { id: "turn_control", status: "completed" } },
    });
    return;
  }
  if (message.id && message.method === "thread/list") {
    send({ id: message.id, result: { threads: [{ id: "thread_control", title: "Control thread" }], nextCursor: null } });
    return;
  }
  if (message.id && message.method === "thread/read") {
    send({
      id: message.id,
      result: {
        thread: { id: message.params.threadId, title: "Control thread" },
        turns: message.params.includeTurns ? [{ id: "turn_control", status: "completed" }] : [],
      },
    });
    return;
  }
  if (message.id && message.method === "thread/rollback") {
    send({ id: message.id, result: { thread: { id: message.params.threadId }, rolledBackTurns: message.params.numTurns } });
    return;
  }
  if (message.id && message.method === "thread/fork") {
    send({ id: message.id, result: { thread: { id: "thread_forked", cwd: message.params.cwd ?? null } } });
  }
});
`,
    );
    chmodSync(command, 0o755);

    let releasePrompt!: () => void;
    const promptDone = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const abortController = new AbortController();
    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest([], {
        cwd,
        abortController,
        env: { PATH: process.env.PATH ?? "", RAVI_CODEX_TEST_LOG: logPath },
        prompt: (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "control" },
            session_id: "",
            parent_tool_use_id: null,
          };
          await promptDone;
        })(),
      }),
    );

    const iterator = session.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("Codex session ended before turn completion");
        }
        if (next.value.type === "turn.complete") {
          break;
        }
      }

      const list = await session.control?.({ operation: "thread.list", limit: 3, searchTerm: "Control" });
      const read = await session.control?.({ operation: "thread.read", includeTurns: false });
      const rollback = await session.control?.({ operation: "thread.rollback", numTurns: 2 });
      const fork = await session.control?.({ operation: "thread.fork", cwd: cwd, path: "forked" });

      expect(list?.ok).toBe(true);
      expect(read?.ok).toBe(true);
      expect(rollback?.ok).toBe(true);
      expect(fork?.ok).toBe(true);
      expect(read?.state?.threadId).toBe("thread_control");
      expect(rollback?.data?.rolledBackTurns).toBe(2);
      expect((fork?.data?.thread as Record<string, unknown> | undefined)?.id).toBe("thread_forked");

      const requests = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "thread/start",
        "turn/start",
        "thread/list",
        "thread/read",
        "thread/rollback",
        "thread/fork",
      ]);
      expect(requests.find((request) => request.method === "thread/read")?.params).toMatchObject({
        threadId: "thread_control",
        includeTurns: false,
      });
      expect(requests.find((request) => request.method === "thread/fork")?.params).toMatchObject({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        persistExtendedHistory: true,
      });
    } finally {
      abortController.abort();
      releasePrompt();
      await iterator.return?.();
    }
  });

  it("steers and interrupts an active app-server turn through runtime control", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-turn-control-"));
    const command = join(cwd, "fake-codex-app-server.mjs");
    const logPath = join(cwd, "requests.jsonl");
    writeFileSync(
      command,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const logPath = process.env.RAVI_CODEX_TEST_LOG;
const log = (message) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ method: message.method, params: message.params ?? {} }) + "\\n");
};
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && message.method) log(message);

  if (message.id && message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.id && message.method === "thread/start") {
    send({
      id: message.id,
      result: { thread: { id: "thread_turn_control", title: "Turn control" }, model: "gpt-5.4", modelProvider: "openai" },
    });
    return;
  }
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread_turn_control", title: "Turn control" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread_turn_control", turn: { id: "turn_live", status: "inProgress" } },
    });
    return;
  }
  if (message.id && message.method === "turn/steer") {
    send({ id: message.id, result: { accepted: true, expectedTurnId: message.params.expectedTurnId } });
    return;
  }
  if (message.id && message.method === "turn/interrupt") {
    send({ id: message.id, result: { accepted: true } });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread_turn_control", turn: { id: "turn_live", status: "interrupted" } },
    });
  }
});
`,
    );
    chmodSync(command, 0o755);

    let releasePrompt!: () => void;
    const promptDone = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const abortController = new AbortController();
    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest([], {
        cwd,
        abortController,
        env: { PATH: process.env.PATH ?? "", RAVI_CODEX_TEST_LOG: logPath },
        prompt: (async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: "control" },
            session_id: "",
            parent_tool_use_id: null,
          };
          await promptDone;
        })(),
      }),
    );

    const iterator = session.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("Codex session ended before turn start");
        }
        if (next.value.type === "turn.started") {
          break;
        }
      }

      const steer = await session.control?.({ operation: "turn.steer", text: "use this detail" });
      const interrupt = await session.control?.({ operation: "turn.interrupt" });

      expect(steer?.ok).toBe(true);
      expect(steer?.data?.accepted).toBe(true);
      expect(interrupt?.ok).toBe(true);
      expect(interrupt?.data).toMatchObject({
        interrupted: true,
        pending: false,
        threadId: "thread_turn_control",
        turnId: "turn_live",
      });

      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          throw new Error("Codex session ended before turn interrupt event");
        }
        if (next.value.type === "turn.interrupted") {
          break;
        }
      }

      const requests = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const steerRequest = requests.find((request) => request.method === "turn/steer");
      expect(steerRequest?.params).toMatchObject({
        threadId: "thread_turn_control",
        expectedTurnId: "turn_live",
        input: [{ type: "text", text: "use this detail", text_elements: [] }],
      });
      expect(requests.find((request) => request.method === "turn/interrupt")?.params).toEqual({
        threadId: "thread_turn_control",
        turnId: "turn_live",
      });
    } finally {
      abortController.abort();
      releasePrompt();
      await iterator.return?.();
    }
  });

  it("routes app-server approval requests through the runtime approval handler", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-approval-"));
    const command = join(cwd, "fake-codex-app-server.mjs");
    writeFileSync(
      command,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const responses = {};
const expected = ["cmd_req", "file_req", "perm_req", "input_req"];
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
};
const finishIfReady = () => {
  if (!expected.every((id) => responses[id])) return;
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      item: {
        id: "msg_approval",
        type: "agentMessage",
        text: JSON.stringify(responses),
        status: "completed",
        parentItemId: "turn_approval",
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } } },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread_approval", turn: { id: "turn_approval", status: "completed" } },
  });
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && !message.method) {
    responses[message.id] = message.result;
    finishIfReady();
    return;
  }
  if (message.id && message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.id && (message.method === "thread/start" || message.method === "thread/resume")) {
    send({
      id: message.id,
      result: {
        thread: { id: "thread_approval", title: "Approval thread" },
        model: "gpt-5.4",
        modelProvider: "openai",
      },
    });
    return;
  }
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({
      jsonrpc: "2.0",
      method: "thread/started",
      params: { thread: { id: "thread_approval", title: "Approval thread" } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread_approval", turn: { id: "turn_approval", status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      id: "cmd_req",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "pwd",
        item: {
          id: "cmd_approval",
          type: "commandExecution",
          command: "pwd",
          status: "inProgress",
          parentItemId: "turn_approval",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: "file_req",
      method: "item/fileChange/requestApproval",
      params: {
        item: {
          id: "file_approval",
          type: "fileChange",
          changes: [{ path: "hello.txt", kind: "add" }],
          status: "inProgress",
          parentItemId: "turn_approval",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: "perm_req",
      method: "item/permissions/requestApproval",
      params: {
        permissions: [{ permission: "use", objectType: "tool", objectId: "Bash" }],
      },
    });
    send({
      jsonrpc: "2.0",
      id: "input_req",
      method: "item/tool/requestUserInput",
      params: {
        questions: [
          {
            id: "choice",
            question: "Pick one",
            options: [{ label: "A", description: "alpha" }, { label: "B" }],
          },
        ],
      },
    });
  }
});
`,
    );
    chmodSync(command, 0o755);

    const approvalRequests: Array<Parameters<NonNullable<RuntimeStartRequest["approveRuntimeRequest"]>>[0]> = [];
    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest(["approval"], {
        cwd,
        approveRuntimeRequest: async (request) => {
          approvalRequests.push(request);
          if (request.kind === "file_change") {
            return { approved: false, reason: "file changes require review" };
          }
          if (request.kind === "permission") {
            return { approved: true, inherited: false, permissions: { Bash: true } };
          }
          if (request.kind === "user_input") {
            return { approved: true, answers: { choice: "A" } };
          }
          return { approved: true, inherited: true };
        },
      }),
    );

    const events = await collectEvents(session.events);
    const assistantText = findEventsByType(events, "assistant.message")[0]?.text ?? "{}";
    const approvalResponses = JSON.parse(assistantText);
    const requested = findEventsByType(events, "approval.requested");
    const resolved = findEventsByType(events, "approval.resolved");

    expect(approvalRequests.map((request) => request.kind)).toEqual([
      "command_execution",
      "file_change",
      "permission",
      "user_input",
    ]);
    expect(approvalRequests[0]?.metadata?.source).toBe("codex.app-server");
    expect(approvalRequests[0]?.metadata?.thread?.id).toBe("thread_approval");
    expect(approvalRequests[0]?.metadata?.turn?.id).toBe("turn_approval");
    expect(approvalRequests[0]?.metadata?.item?.id).toBe("cmd_approval");
    expect(requested).toHaveLength(4);
    expect(resolved).toHaveLength(4);
    expect(resolved.find((event) => event.approval.kind === "file_change")?.approval).toMatchObject({
      approved: false,
      reason: "file changes require review",
    });
    expect(approvalResponses.cmd_req.decision).toBe("acceptForSession");
    expect(approvalResponses.file_req.decision).toBe("deny");
    expect(approvalResponses.file_req.reason).toBe("file changes require review");
    expect(approvalResponses.perm_req.permissions).toEqual({ Bash: true });
    expect(approvalResponses.input_req.answers).toEqual({ choice: "A" });
  });

  it("routes app-server dynamic tool calls through the runtime tool handler", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-tool-call-"));
    const command = join(cwd, "fake-codex-app-server.mjs");
    writeFileSync(
      command,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
};

let toolResponse;
const finishIfReady = () => {
  if (!toolResponse) return;
  send({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      item: {
        id: "msg_tool",
        type: "agentMessage",
        text: JSON.stringify(toolResponse),
        status: "completed",
        parentItemId: "turn_tool",
      },
    },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread_tool", turn: { id: "turn_tool", status: "completed" } },
  });
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && !message.method) {
    if (message.id === "tool_req") {
      if (message.jsonrpc !== "2.0") throw new Error("tool response must include jsonrpc 2.0");
      if (!Array.isArray(message.result?.content_items)) throw new Error("tool response must use content_items");
      if (message.result?.contentItems) throw new Error("tool response must not use contentItems");
    }
    toolResponse = message.result;
    finishIfReady();
    return;
  }
  if (message.id && message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.id && (message.method === "thread/start" || message.method === "thread/resume")) {
    send({
      id: message.id,
      result: { thread: { id: "thread_tool", title: "Tool thread" }, model: "gpt-5.4", modelProvider: "openai" },
    });
    return;
  }
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread_tool", title: "Tool thread" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread_tool", turn: { id: "turn_tool", status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      id: "tool_req",
      method: "item/tool/call",
      params: {
        callId: "dyn_tool_1",
        threadId: "thread_tool",
        turnId: "turn_tool",
        tool: "tools_list",
        arguments: { verbose: true },
      },
    });
  }
});
`,
    );
    chmodSync(command, 0o755);

    const toolRequests: Array<Parameters<NonNullable<RuntimeStartRequest["handleRuntimeToolCall"]>>[0]> = [];
    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession(
      makeStartRequest(["tool"], {
        cwd,
        handleRuntimeToolCall: async (request) => {
          toolRequests.push(request);
          return {
            success: true,
            contentItems: [{ type: "inputText", text: "tool output" }],
          };
        },
      }),
    );

    const events = await collectEvents(session.events);
    const response = JSON.parse(findEventsByType(events, "assistant.message")[0]?.text ?? "{}");
    const toolStarted = findEventsByType(events, "tool.started");
    const toolCompleted = findEventsByType(events, "tool.completed");

    expect(toolRequests).toHaveLength(1);
    expect(toolRequests[0]?.toolName).toBe("tools_list");
    expect(toolRequests[0]?.callId).toBe("dyn_tool_1");
    expect(toolRequests[0]?.arguments).toEqual({ verbose: true });
    expect(toolRequests[0]?.metadata?.source).toBe("codex.app-server");
    expect(toolRequests[0]?.metadata?.thread?.id).toBe("thread_tool");
    expect(toolRequests[0]?.metadata?.turn?.id).toBe("turn_tool");
    expect(toolRequests[0]?.metadata?.item?.id).toBe("dyn_tool_1");
    expect(toolStarted[0]?.toolUse).toEqual({
      id: "dyn_tool_1",
      name: "tools_list",
      input: { verbose: true },
    });
    expect(toolStarted[0]?.metadata?.item?.type).toBe("dynamic_tool_call");
    expect(toolCompleted[0]?.toolUseId).toBe("dyn_tool_1");
    expect(toolCompleted[0]?.toolName).toBe("tools_list");
    expect(toolCompleted[0]?.content).toEqual([{ type: "inputText", text: "tool output" }]);
    expect(toolCompleted[0]?.isError).toBe(false);
    expect(response).toEqual({
      success: true,
      content_items: [{ type: "inputText", text: "tool output" }],
    });
  });

  it("denies app-server command approvals when no runtime approval handler is available", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-approval-deny-"));
    const command = join(cwd, "fake-codex-app-server.mjs");
    writeFileSync(
      command,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + "\\n");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id && !message.method) {
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          id: "msg_deny",
          type: "agentMessage",
          text: JSON.stringify(message.result),
          status: "completed",
          parentItemId: "turn_deny",
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread_deny", turn: { id: "turn_deny", status: "completed" } },
    });
    return;
  }
  if (message.id && message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.id && (message.method === "thread/start" || message.method === "thread/resume")) {
    send({ id: message.id, result: { thread: { id: "thread_deny" }, model: "gpt-5", modelProvider: "openai" } });
    return;
  }
  if (message.id && message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "thread_deny" } } });
    send({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "thread_deny", turn: { id: "turn_deny", status: "inProgress" } },
    });
    send({
      jsonrpc: "2.0",
      id: "cmd_deny_req",
      method: "item/commandExecution/requestApproval",
      params: { command: "pwd", item: { id: "cmd_deny", type: "commandExecution", command: "pwd" } },
    });
  }
});
`,
    );
    chmodSync(command, 0o755);

    const provider = createCodexRuntimeProvider({ command, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["deny"], { cwd }));

    const events = await collectEvents(session.events);
    const response = JSON.parse(findEventsByType(events, "assistant.message")[0]?.text ?? "{}");

    expect(response.decision).toBe("deny");
    expect(response.reason).toContain("No Ravi approval handler");
    expect(findEventsByType(events, "approval.resolved")[0]?.approval.approved).toBe(false);
  });

  it("emits turn.interrupted and continues with the next turn", async () => {
    let rejectInterruptedTurn: ((error: Error) => void) | undefined;
    const { calls, transport } = createMockTransport([
      () => {
        const interruptedPromise = new Promise<never>((_, reject) => {
          rejectInterruptedTurn = reject;
        });
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "thread_interrupt" };
            yield { type: "turn.started" };
            yield { type: "item.completed", item: { id: "item_partial", type: "agent_message", text: "partial" } };
            await interruptedPromise;
          })(),
          interrupt: () => {
            rejectInterruptedTurn?.(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          },
        };
      },
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_2" };
          yield { type: "turn.started" };
          yield { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "second turn done" } };
          yield { type: "turn.completed", usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 2 } };
        })(),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["first", "second"]));

    const seen: RuntimeEvent[] = [];
    let interrupted = false;

    for await (const event of session.events) {
      seen.push(event);
      if (!interrupted && event.type === "assistant.message") {
        interrupted = true;
        await session.interrupt();
      }
    }

    const interruptions = findEventsByType(seen, "turn.interrupted");
    const completions = findEventsByType(seen, "turn.complete");
    const assistantMessages = findEventsByType(seen, "assistant.message").map((event) => event.text);

    expect(interrupted).toBe(true);
    expect(interruptions).toHaveLength(1);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.providerSessionId).toBe("thread_2");
    expect(assistantMessages).toContain("partial");
    expect(assistantMessages).toContain("second turn done");
    expect(calls[0]?.resume).toBeUndefined();
    expect(calls[1]?.resume).toBeUndefined();
  });

  it("maps failed CLI turns into turn.failed", async () => {
    const { transport } = createMockTransport([
      () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread_failed" };
          yield { type: "turn.started" };
          yield { type: "error", message: "bad model" };
          yield { type: "turn.failed", error: { message: "bad model" } };
        })(),
        result: Promise.resolve({
          exitCode: 1,
          signal: null,
          stderr: "",
        }),
      }),
    ]);

    const provider = createCodexRuntimeProvider({ transport: transport as any, defaultModel: "gpt-5" });
    const session = provider.startSession(makeStartRequest(["fail this"]));

    const events = await collectEvents(session.events);
    const failures = findEventsByType(events, "turn.failed");

    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain("bad model");
    expect(failures[0]?.recoverable).toBe(true);
  });
});
