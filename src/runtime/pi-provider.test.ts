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

  responseFor?: (command: PiRpcCommand) => PiRpcResponse | Promise<PiRpcResponse> | undefined;
  startError?: Error;
  closed = false;
  closeCalls = 0;

  async start(input: PiRpcStartInput): Promise<void> {
    this.starts.push(input);
    if (this.startError) throw this.startError;
  }

  async send(command: PiRpcCommand): Promise<PiRpcResponse> {
    this.commands.push(command);
    const response = await this.responseFor?.(command);
    if (response) {
      return response;
    }
    return defaultResponse(command);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeCalls++;
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

  it("closes the Pi RPC transport idempotently", async () => {
    const transport = new FakePiRpcTransport();
    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("close"));

    await handle.close?.();
    await handle.close?.();

    expect(transport.closeCalls).toBe(1);
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

  it("preserves trusted error identity when the Pi transport throws", async () => {
    const transport = new FakePiRpcTransport();
    transport.responseFor = (command) => {
      if (command.type === "prompt") throw new RangeError("credential unavailable");
      return defaultResponse(command);
    };

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("falha interna")).events,
    );

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "credential unavailable",
      errorName: "RangeError",
      caughtException: true,
      recoverable: true,
    });
  });

  it("marks non-Error Pi transport throws as caught exceptions", async () => {
    const transport = new FakePiRpcTransport();
    transport.responseFor = (command) => {
      if (command.type === "prompt") throw "token expired";
      return defaultResponse(command);
    };

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("falha não tipada")).events,
    );

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "token expired",
      caughtException: true,
      recoverable: true,
    });
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
      "set_steering_mode",
      "prompt",
      "get_state",
    ]);
    expect(transport.commands[0]).toMatchObject({
      type: "switch_session",
      sessionPath: sessionFile,
    });
  });

  it("maps locally interrupted Pi turns to a single interrupted terminal event", async () => {
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

    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("aborta"));
    await handle.interrupt();
    const events = await collectRuntimeEvents(handle.events);

    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.complete")).toHaveLength(0);
  });

  it("maps a spontaneous Pi aborted turn to a replayable target failure", async () => {
    const transport = new FakePiRpcTransport();
    transport.pushEvent({
      type: "turn_end",
      message: assistantMessage("", { stopReason: "aborted" }),
      toolResults: [],
    });

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("nao interrompa")).events,
    );

    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "Pi turn aborted without a local interrupt request",
      targetFailure: true,
      recoverable: true,
    });
  });

  it("waits for Pi interrupt control acceptance before trusting an aborted event", async () => {
    const transport = new FakePiRpcTransport();
    let resolveAbort!: (response: PiRpcResponse) => void;
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    transport.responseFor = (command) => {
      if (command.type === "prompt") {
        markPromptStarted();
        return defaultResponse(command);
      }
      if (command.type === "abort") {
        return new Promise<PiRpcResponse>((resolve) => {
          resolveAbort = resolve;
        });
      }
      return defaultResponse(command);
    };
    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("controle concorrente"));
    const eventsPromise = collectRuntimeEvents(handle.events);
    await promptStarted;

    const controlPromise = handle.control?.({ operation: "turn.interrupt" });
    transport.pushEvent({
      type: "turn_end",
      message: assistantMessage("", { stopReason: "aborted" }),
      toolResults: [],
    });
    resolveAbort({ id: "abort-rejected", type: "response", command: "abort", success: false, error: "rejected" });

    await expect(controlPromise).resolves.toMatchObject({ ok: false });
    const events = await eventsPromise;
    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", targetFailure: true });
  });

  it("keeps an accepted Pi interrupt monotonic when a later interrupt is rejected", async () => {
    const transport = new FakePiRpcTransport();
    let abortCalls = 0;
    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    transport.responseFor = (command) => {
      if (command.type === "prompt") markPromptStarted();
      if (command.type === "abort" && ++abortCalls === 2) {
        return { id: command.id, type: "response", command: "abort", success: false, error: "rejected" };
      }
      return defaultResponse(command);
    };
    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("controle monotônico"));
    const eventsPromise = collectRuntimeEvents(handle.events);
    await promptStarted;

    await expect(handle.control?.({ operation: "turn.interrupt" })).resolves.toMatchObject({ ok: true });
    await expect(handle.control?.({ operation: "turn.interrupt" })).resolves.toMatchObject({ ok: false });
    transport.pushEvent({
      type: "turn_end",
      message: assistantMessage("", { stopReason: "aborted" }),
      toolResults: [],
    });
    transport.pushEvent({ type: "agent_end", messages: [] });

    const events = await eventsPromise;
    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
  });

  it("aggregates overlapping Pi interrupt decisions for the active turn", async () => {
    const transport = new FakePiRpcTransport();
    const abortResolvers: Array<(response: PiRpcResponse) => void> = [];
    let markPromptStarted!: () => void;
    let markBothAbortsStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    const bothAbortsStarted = new Promise<void>((resolve) => {
      markBothAbortsStarted = resolve;
    });
    transport.responseFor = (command) => {
      if (command.type === "prompt") markPromptStarted();
      if (command.type === "abort") {
        return new Promise<PiRpcResponse>((resolve) => {
          abortResolvers.push(resolve);
          if (abortResolvers.length === 2) markBothAbortsStarted();
        });
      }
      return defaultResponse(command);
    };
    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("controle sobreposto"));
    const eventsPromise = collectRuntimeEvents(handle.events);
    await promptStarted;

    const firstInterrupt = handle.control?.({ operation: "turn.interrupt" });
    const secondInterrupt = handle.control?.({ operation: "turn.interrupt" });
    await bothAbortsStarted;
    transport.pushEvent({
      type: "turn_end",
      message: assistantMessage("", { stopReason: "aborted" }),
      toolResults: [],
    });
    transport.pushEvent({ type: "agent_end", messages: [] });
    abortResolvers[1]?.({
      id: "abort-rejected",
      type: "response",
      command: "abort",
      success: false,
      error: "rejected",
    });
    abortResolvers[0]?.({ id: "abort-accepted", type: "response", command: "abort", success: true, data: {} });

    await expect(firstInterrupt).resolves.toMatchObject({ ok: true });
    await expect(secondInterrupt).resolves.toMatchObject({ ok: false });
    const events = await eventsPromise;
    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(0);
  });

  it("does not let a late Pi interrupt acceptance contaminate the next turn", async () => {
    const transport = new FakePiRpcTransport();
    let resolveAbort!: (response: PiRpcResponse) => void;
    let promptCount = 0;
    let markFirstPromptStarted!: () => void;
    let markSecondPromptStarted!: () => void;
    const firstPromptStarted = new Promise<void>((resolve) => {
      markFirstPromptStarted = resolve;
    });
    const secondPromptStarted = new Promise<void>((resolve) => {
      markSecondPromptStarted = resolve;
    });
    transport.responseFor = (command) => {
      if (command.type === "prompt") {
        promptCount += 1;
        if (promptCount === 1) markFirstPromptStarted();
        if (promptCount === 2) markSecondPromptStarted();
      }
      if (command.type === "abort") {
        return new Promise<PiRpcResponse>((resolve) => {
          resolveAbort = resolve;
        });
      }
      return defaultResponse(command);
    };
    const handle = createPiRuntimeProvider({ transport }).startSession(
      createStartRequest("first", { prompt: multiplePrompts("first", "second") }),
    );
    const eventsPromise = collectRuntimeEvents(handle.events);
    await firstPromptStarted;

    const lateInterrupt = handle.control?.({ operation: "turn.interrupt" });
    transport.pushEvent({ type: "agent_end", messages: [assistantMessage("first turn completed")] });
    await secondPromptStarted;
    resolveAbort({ id: "late-abort", type: "response", command: "abort", success: true, data: {} });
    transport.pushEvent({
      type: "turn_end",
      message: assistantMessage("", { stopReason: "aborted" }),
      toolResults: [],
    });
    transport.pushEvent({ type: "agent_end", messages: [] });

    await expect(lateInterrupt).resolves.toMatchObject({ ok: true });
    const events = await eventsPromise;
    expect(events.filter((event) => event.type === "turn.complete")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn.interrupted")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "turn.failed", targetFailure: true });
  });

  it("normalizes Pi bootstrap failures into a replayable target failure", async () => {
    const transport = new FakePiRpcTransport();
    transport.startError = new Error("Pi bootstrap unavailable");

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("fail over")).events,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn.failed",
      error: "Pi bootstrap unavailable",
      errorName: "Error",
      caughtException: true,
      targetFailure: true,
      recoverable: true,
      rawEvent: { type: "transport.start_failed" },
    });
  });

  it("fails closed when Pi bootstrap throws after the transport starts", async () => {
    const transport = new FakePiRpcTransport();
    transport.responseFor = (command) => {
      if (command.type === "set_steering_mode") throw new RangeError("synthetic bootstrap invariant");
      return defaultResponse(command);
    };

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("do not fail over")).events,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn.failed",
      error: "synthetic bootstrap invariant",
      errorName: "RangeError",
      caughtException: true,
      recoverable: false,
      rawEvent: { type: "bootstrap.failed" },
    });
    expect(events[0]).not.toHaveProperty("targetFailure");
  });

  it("does not let a trailing Pi agent_end complete the next turn", async () => {
    const scenarios = [
      {
        name: "error",
        firstTurn: assistantMessage("", { stopReason: "error", errorMessage: "first turn failed" }),
        expectedTerminal: "turn.failed",
        interruptLocally: false,
      },
      {
        name: "accepted abort",
        firstTurn: assistantMessage("", { stopReason: "aborted" }),
        expectedTerminal: "turn.interrupted",
        interruptLocally: true,
      },
      {
        name: "spontaneous abort",
        firstTurn: assistantMessage("", { stopReason: "aborted" }),
        expectedTerminal: "turn.failed",
        interruptLocally: false,
      },
    ] as const;

    for (const scenario of scenarios) {
      const transport = new FakePiRpcTransport();
      transport.pushEvent({
        type: "turn_end",
        message: scenario.firstTurn,
        toolResults: [],
      });
      transport.pushEvent({ type: "agent_end", messages: [assistantMessage(`stale ${scenario.name}`)] });
      transport.pushEvent({ type: "agent_start" });
      transport.pushEvent({ type: "agent_end", messages: [assistantMessage("second turn completed")] });

      const handle = createPiRuntimeProvider({ transport }).startSession(
        createStartRequest("first", { prompt: multiplePrompts("first", "second") }),
      );
      if (scenario.interruptLocally) await handle.interrupt();
      const events = await collectRuntimeEvents(handle.events);
      const completion = events.find((event) => event.type === "turn.complete");

      expect(events.filter((event) => event.type === scenario.expectedTerminal)).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn.complete")).toHaveLength(1);
      expect(completion).toMatchObject({
        type: "turn.complete",
        rawEvent: {
          type: "agent_end",
          messages: [{ content: [{ type: "text", text: "second turn completed" }] }],
        },
      });
      expect(
        transport.commands.filter((command) => command.type === "prompt").map((command) => command.message),
      ).toEqual(["first", "second"]);
    }
  });

  it("routes inactive runtime control commands to safe Pi RPC operations", async () => {
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
    ).resolves.toMatchObject({
      ok: true,
      data: {
        response: {
          data: {
            queued: true,
            reason: "provider_starting",
          },
        },
      },
      state: {
        activeTurn: false,
      },
    });
    await expect(
      handle.control?.({
        operation: "turn.follow_up",
        text: "continua depois",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "Pi turn.follow_up requires an active turn",
      state: {
        activeTurn: false,
      },
    });

    expect(transport.commands).toEqual([
      expect.objectContaining({ type: "set_model", provider: "openai", modelId: "gpt-5.5" }),
      expect.objectContaining({ type: "set_thinking_level", level: "xhigh" }),
    ]);
  });

  it("flushes pre-start steering through Pi before the first prompt instead of host prompt concatenation", async () => {
    const transport = new FakePiRpcTransport();
    transport.pushEvent({ type: "agent_end", messages: [assistantMessage("fim")] });
    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("primeira"));

    await expect(
      handle.control?.({
        operation: "turn.steer",
        text: "segunda",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        response: {
          data: {
            queued: true,
          },
        },
      },
    });

    await collectRuntimeEvents(handle.events);

    expect(transport.commands.map((command) => command.type)).toEqual([
      "get_state",
      "set_steering_mode",
      "steer",
      "prompt",
      "get_state",
    ]);
    expect(transport.commands).toContainEqual(expect.objectContaining({ type: "steer", message: "segunda" }));
    expect(transport.commands).toContainEqual(expect.objectContaining({ type: "prompt", message: "primeira" }));
  });

  it("routes active turn steering to Pi RPC", async () => {
    const transport = new FakePiRpcTransport();
    let releasePrompt: (() => void) | undefined;
    const promptStarted = new Promise<void>((resolve) => {
      transport.responseFor = (command) => {
        if (command.type !== "prompt") {
          return defaultResponse(command);
        }
        resolve();
        return new Promise<PiRpcResponse>((finish) => {
          releasePrompt = () => finish(defaultResponse(command));
        });
      };
    });

    const handle = createPiRuntimeProvider({ transport }).startSession(createStartRequest("controle ativo"));
    const eventsPromise = collectRuntimeEvents(handle.events);

    await promptStarted;
    await expect(
      handle.control?.({
        operation: "turn.steer",
        text: "muda o plano",
      }),
    ).resolves.toMatchObject({
      ok: true,
      state: {
        activeTurn: true,
      },
    });

    releasePrompt?.();
    transport.pushEvent({ type: "agent_end", messages: [assistantMessage("fim")] });

    await expect(eventsPromise).resolves.toContainEqual(expect.objectContaining({ type: "turn.complete" }));
    expect(transport.commands).toContainEqual(expect.objectContaining({ type: "set_steering_mode", mode: "all" }));
    expect(transport.commands).toContainEqual(expect.objectContaining({ type: "steer", message: "muda o plano" }));
  });

  it("does not reconfigure steering mode when Pi already drains steering messages together", async () => {
    const transport = new FakePiRpcTransport();
    transport.responseFor = (command) => {
      if (command.type === "get_state") {
        return piResponse(command, { steeringMode: "all" });
      }
      return defaultResponse(command);
    };
    transport.pushEvent({ type: "agent_end", messages: [] });

    await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("sem reconfigurar")).events,
    );

    expect(transport.commands).not.toContainEqual(expect.objectContaining({ type: "set_steering_mode" }));
  });

  it("maps Pi queue updates to canonical queued/thinking status", async () => {
    const transport = new FakePiRpcTransport();
    transport.pushEvent({ type: "agent_start" });
    transport.pushEvent({ type: "queue_update", steering: ["muda o plano"], followUp: [] });
    transport.pushEvent({ type: "queue_update", steering: [], followUp: [] });
    transport.pushEvent({ type: "agent_end", messages: [assistantMessage("fim")] });

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("controle fila")).events,
    );

    expect(events).toContainEqual(expect.objectContaining({ type: "status", status: "queued" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "status", status: "thinking" }));
  });

  it("sends channel prompts as regular Pi prompts", async () => {
    const transport = new FakePiRpcTransport();
    transport.pushEvent({ type: "agent_end", messages: [] });

    await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("segunda")).events,
    );

    const promptCommand = transport.commands.find((command) => command.type === "prompt");
    expect(promptCommand).toMatchObject({
      type: "prompt",
      message: "segunda",
    });
    expect(promptCommand).not.toHaveProperty("streamingBehavior");
  });

  it("retries a prompt rejected with 'already processing' until pi settles", async () => {
    const transport = new FakePiRpcTransport();
    let promptAttempts = 0;
    transport.responseFor = (command) => {
      if (command.type !== "prompt") return undefined;
      promptAttempts += 1;
      if (promptAttempts < 3) {
        return {
          id: command.id,
          type: "response",
          command: "prompt",
          success: false,
          error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        };
      }
      return defaultResponse(command);
    };
    transport.pushEvent({ type: "agent_end", messages: [assistantMessage("ok")] });

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("retry")).events,
    );

    expect(promptAttempts).toBeGreaterThanOrEqual(3);
    expect(events.map((event) => event.type)).not.toContain("turn.failed");
    expect(events.at(-1)).toMatchObject({ type: "turn.complete" });
    const promptCommands = transport.commands.filter((command) => command.type === "prompt");
    expect(promptCommands.length).toBeGreaterThanOrEqual(3);
    expect(promptCommands[0]).not.toHaveProperty("streamingBehavior");
  });

  it("surfaces turn.failed after exhausting busy retries", async () => {
    const transport = new FakePiRpcTransport();
    transport.responseFor = (command) => {
      if (command.type !== "prompt") return undefined;
      return {
        id: command.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "Agent is already processing. Specify streamingBehavior to queue.",
      };
    };

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({ transport }).startSession(createStartRequest("busy")).events,
    );

    const promptCount = transport.commands.filter((command) => command.type === "prompt").length;
    expect(promptCount).toBe(6); // initial + 5 backoff retries
    expect(events.at(-1)).toMatchObject({ type: "turn.failed" });
  });

  it("restarts a dead Pi RPC transport before sending a prompt", async () => {
    const deadTransport = new FakePiRpcTransport();
    deadTransport.responseFor = (command) => {
      if (command.type === "prompt") {
        throw new Error("Pi RPC transport is not connected");
      }
      return defaultResponse(command);
    };

    const liveTransport = new FakePiRpcTransport();
    liveTransport.pushEvent({
      type: "agent_end",
      messages: [assistantMessage("recuperado")],
    });

    const transports = [deadTransport, liveTransport];
    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({
        transportFactory: () => transports.shift() ?? liveTransport,
      }).startSession(createStartRequest("continua")).events,
    );

    expect(events.map((event) => event.type)).not.toContain("turn.failed");
    expect(events.at(-1)).toMatchObject({ type: "turn.complete" });
    expect(deadTransport.closed).toBe(true);
    expect(liveTransport.starts).toHaveLength(1);
    expect(liveTransport.commands).toContainEqual(
      expect.objectContaining({
        type: "prompt",
        message: "continua",
      }),
    );
    expect(liveTransport.commands.find((command) => command.type === "prompt")).not.toHaveProperty("streamingBehavior");
  });

  it("fails closed when Pi post-start bootstrap throws during transport restart", async () => {
    const deadTransport = new FakePiRpcTransport();
    deadTransport.responseFor = (command) => {
      if (command.type === "prompt") throw new Error("Pi RPC process exited");
      return defaultResponse(command);
    };
    const replacementTransport = new FakePiRpcTransport();
    replacementTransport.responseFor = (command) => {
      if (command.type === "set_steering_mode") throw new RangeError("synthetic restart invariant");
      return defaultResponse(command);
    };
    const transports = [deadTransport, replacementTransport];

    const events = await collectRuntimeEvents(
      createPiRuntimeProvider({
        transportFactory: () => transports.shift() ?? replacementTransport,
      }).startSession(createStartRequest("restart safely")).events,
    );

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      error: "synthetic restart invariant",
      errorName: "RangeError",
      caughtException: true,
      recoverable: false,
      rawEvent: { type: "bootstrap.failed" },
    });
    expect(events.at(-1)).not.toHaveProperty("targetFailure");
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

async function* multiplePrompts(...texts: string[]): AsyncGenerator<RuntimePromptMessage> {
  for (const text of texts) {
    yield* onePrompt(text);
  }
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
