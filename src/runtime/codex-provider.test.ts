import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGeneratedAgentsBridge } from "./agent-instructions.js";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import type { RuntimeEvent, RuntimeStartRequest } from "./types.js";

type TransportRequest = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  model?: string;
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
