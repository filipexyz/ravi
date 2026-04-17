import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGeneratedAgentsBridge } from "./agent-instructions.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import type { RuntimeEvent, RuntimeStartRequest } from "./types.js";

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
    expect(completions[0]?.execution?.model).toBe("gpt-5.4");
  });

  it("normalizes unsupported max effort to the strongest Codex effort", async () => {
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
    const session = provider.startSession(makeStartRequest(["hello"], { effort: "max" }));

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
