import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPiRuntimeProvider,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
  type PiRpcStartInput,
  type PiRpcTransport,
} from "./pi-provider.js";
import type { RuntimeEvent, RuntimePromptMessage, RuntimeStartRequest } from "./types.js";

interface TestQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
}

class FakePiRpcTransport implements PiRpcTransport {
  readonly events: TestQueue<PiRpcEvent> = createTestQueue<PiRpcEvent>();
  readonly starts: PiRpcStartInput[] = [];
  readonly commands: PiRpcCommand[] = [];

  responseFor?: (command: PiRpcCommand) => PiRpcResponse | undefined;
  closed = false;

  async start(input: PiRpcStartInput): Promise<void> {
    this.starts.push(input);
  }

  async send(command: PiRpcCommand): Promise<PiRpcResponse> {
    this.commands.push(command);
    const response = this.responseFor?.(command);
    if (response) {
      return response;
    }
    return defaultResponse(command);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  pushEvent(event: PiRpcEvent): void {
    this.events.push(event);
  }

  endEvents(): void {
    this.events.end();
  }
}

describe("Pi runtime provider", () => {
  it("advertises an explicit subprocess RPC capability matrix", () => {
    expect(createPiRuntimeProvider().getCapabilities()).toMatchObject({
      runtimeControl: {
        supported: true,
      },
      dynamicTools: {
        mode: "none",
      },
      execution: {
        mode: "subprocess-rpc",
      },
      sessionState: {
        mode: "file-backed",
        requiresCwdMatch: true,
      },
      tools: {
        permissionMode: "provider-native",
        supportsParallelCalls: false,
      },
      terminalEvents: {
        guarantee: "adapter",
      },
    });
  });

  it("normalizes a successful Pi RPC run into canonical runtime events", async () => {
    const transport = new FakePiRpcTransport();
    transport.responseFor = (command) => {
      if (command.type === "get_state") {
        return piResponse(command, {
          model: { provider: "openai", id: "gpt-5.5" },
          thinkingLevel: "high",
          isStreaming: false,
          isCompacting: false,
          sessionFile: "/tmp/pi-session.jsonl",
          sessionId: "pi-session-1",
          sessionName: "pi dev",
          messageCount: 2,
          pendingMessageCount: 0,
        });
      }
      return defaultResponse(command);
    };

    transport.pushEvent({ type: "agent_start" });
    transport.pushEvent({ type: "turn_start" });
    transport.pushEvent({
      type: "message_update",
      message: assistantMessage("partial"),
      assistantMessageEvent: { type: "text_delta", delta: "ola" },
    });
    transport.pushEvent({
      type: "message_end",
      message: assistantMessage("olá mundo"),
    });
    transport.pushEvent({
      type: "agent_end",
      messages: [assistantMessage("olá mundo")],
    });

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("faz um teste")).events,
    );

    expect(events.map((event) => event.type)).toContain("text.delta");
    expect(events.find((event) => event.type === "assistant.message")).toMatchObject({
      type: "assistant.message",
      text: "olá mundo",
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn.complete",
      providerSessionId: "/tmp/pi-session.jsonl",
      session: {
        displayId: "pi dev",
        params: {
          cwd: "/tmp",
          sessionFile: "/tmp/pi-session.jsonl",
          sessionId: "pi-session-1",
          modelProvider: "openai",
          modelId: "gpt-5.5",
        },
      },
      execution: {
        provider: "openai",
        model: "gpt-5.5",
        billingType: "unknown",
      },
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
      },
    });
    expect(transport.starts[0]).toMatchObject({
      cwd: "/tmp",
      modelArg: "openai/gpt-5.5",
      thinkingLevel: "high",
    });
    expect(transport.closed).toBe(true);
  });

  it("emits a failed terminal event when Pi rejects a prompt", async () => {
    const transport = new FakePiRpcTransport();
    transport.responseFor = (command) => {
      if (command.type === "prompt") {
        return {
          id: command.id,
          type: "response",
          command: "prompt",
          success: false,
          error: "already streaming",
        };
      }
      return defaultResponse(command);
    };

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("falha")).events,
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "turn.failed",
        error: "already streaming",
        recoverable: true,
      }),
    ]);
  });

  it("switches to a valid file-backed session before prompting", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-pi-provider-"));
    const sessionFile = join(cwd, "session.jsonl");
    writeFileSync(sessionFile, "{}");

    const transport = new FakePiRpcTransport();
    transport.pushEvent({
      type: "agent_end",
      messages: [assistantMessage("fim")],
    });

    await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(
        createStartRequest("continua", {
          cwd,
          resumeSession: {
            displayId: "session",
            params: {
              sessionFile,
              cwd,
            },
          },
        }),
      ).events,
    );

    expect(transport.commands.map((command) => command.type)).toEqual([
      "switch_session",
      "get_state",
      "prompt",
      "get_state",
    ]);
    expect(transport.commands[0]).toMatchObject({
      type: "switch_session",
      sessionPath: sessionFile,
    });
  });

  it("maps Pi aborted turns to a single interrupted terminal event", async () => {
    const transport = new FakePiRpcTransport();
    transport.pushEvent({
      type: "turn_end",
      message: assistantMessage("", { stopReason: "aborted", errorMessage: "aborted by user" }),
      toolResults: [],
    });
    transport.pushEvent({
      type: "agent_end",
      messages: [],
    });

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("aborta")).events,
    );

    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.complete")).toHaveLength(0);
  });

  it("routes runtime control commands to Pi RPC", async () => {
    const transport = new FakePiRpcTransport();
    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("controle"));

    await expect(handle.setModel?.("openai/gpt-5.5")).resolves.toBeUndefined();
    await expect(
      handle.control?.({
        operation: "thinking.set",
        text: "xhigh",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handle.control?.({
        operation: "turn.steer",
        text: "muda o plano",
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(transport.commands).toEqual([
      expect.objectContaining({ type: "set_model", provider: "openai", modelId: "gpt-5.5" }),
      expect.objectContaining({ type: "set_thinking_level", level: "xhigh" }),
      expect.objectContaining({ type: "steer", message: "muda o plano" }),
    ]);
  });
});

function createStartRequest(text: string, overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    prompt: onePrompt(text),
    model: "openai/gpt-5.5",
    effort: "high",
    cwd: "/tmp",
    abortController: new AbortController(),
    systemPromptAppend: "Ravi runtime instructions",
    ...overrides,
  };
}

async function* onePrompt(text: string): AsyncGenerator<RuntimePromptMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: text,
    },
    session_id: "session",
    parent_tool_use_id: null,
  };
}

async function collectRuntimeEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function assistantMessage(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    responseId: "resp-1",
    usage: {
      input: 12,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 19,
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function defaultResponse(command: PiRpcCommand): PiRpcResponse {
  return piResponse(command, {});
}

function piResponse(command: PiRpcCommand, data: unknown): PiRpcResponse {
  return {
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    data,
  };
}

function createTestQueue<T>(): TestQueue<T> {
  const values: T[] = [];
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  let ended = false;
  let failure: unknown;

  return {
    push(value) {
      if (ended || failure) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      if (ended || failure) {
        return;
      }
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()!.resolve({ value: undefined as T, done: true });
      }
    },
    fail(error) {
      if (ended || failure) {
        return;
      }
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()!.reject(error);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift()!, done: false });
          }
          if (failure) {
            return Promise.reject(failure);
          }
          if (ended) {
            return Promise.resolve({ value: undefined as T, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}
