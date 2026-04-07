import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createStdioSupervisor, parseStdioProtocolLine } from "./stdio-supervisor.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stdio-supervisor-fixture.ts", import.meta.url));

function createFixtureSupervisor() {
  return createStdioSupervisor({
    command: process.execPath,
    args: [fixturePath],
  });
}

function waitForEvent<T>(
  emitter: EventEmitter,
  eventName: string,
  predicate: (value: T) => boolean = () => true,
  timeoutMs = 2_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);
    timer.unref?.();

    const listener = (value: T) => {
      if (!predicate(value)) {
        return;
      }
      cleanup();
      resolve(value);
    };

    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(eventName, listener as (...args: unknown[]) => void);
    };

    emitter.on(eventName, listener as (...args: unknown[]) => void);
  });
}

describe("stdio supervisor", () => {
  let supervisor = createFixtureSupervisor();

  beforeEach(() => {
    supervisor = createFixtureSupervisor();
  });

  afterEach(async () => {
    await supervisor.stop().catch(() => undefined);
  });

  it("parses stdout JSON events and tracks lifecycle health", async () => {
    const readyPromise = waitForEvent<{ type: string; event: string }>(supervisor.events, "protocol-event", (event) => {
      return event.type === "event" && event.event === "ready";
    });

    await supervisor.start();
    const readyEvent = await readyPromise;

    expect(readyEvent.event).toBe("ready");
    expect(supervisor.health().state).toBe("running");
    expect(supervisor.health().pid).toBeNumber();

    await supervisor.stop();
    expect(supervisor.health().state).toBe("stopped");
  });

  it("supports stdin commands with ack/result and ack/error semantics", async () => {
    await supervisor.start();

    const ackPromise = waitForEvent<{ id: string; command: string }>(supervisor.events, "command-ack", (event) => {
      return event.command === "ping";
    });
    const resultPromise = supervisor.sendCommand({
      command: "ping",
      args: ["alpha"],
      payload: { mode: "test" },
    });

    const [ack, result] = await Promise.all([ackPromise, resultPromise]);

    expect(ack.command).toBe("ping");
    expect(result.type).toBe("command.result");
    expect(result.result).toMatchObject({
      pong: true,
      args: ["alpha"],
      payload: { mode: "test" },
    });

    const errorPromise = waitForEvent<{ id: string; command: string; message: string }>(
      supervisor.events,
      "command-error",
      (event) => event.command === "fail",
    );

    await expect(
      supervisor.sendCommand({
        command: "fail",
        payload: { reason: "focused-test" },
      }),
    ).rejects.toThrow("simulated adapter failure");

    const commandError = await errorPromise;
    expect(commandError.command).toBe("fail");
  });

  it("marks invalid protocol output as broken and observable", async () => {
    await supervisor.start();

    const protocolErrorPromise = waitForEvent<{ line: string; reason: string }>(supervisor.events, "protocol-error");

    await expect(
      supervisor.sendCommand({
        command: "emit-invalid-event",
      }),
    ).rejects.toThrow(/protocol/i);

    const protocolError = await protocolErrorPromise;
    expect(protocolError.reason).toContain("protocol");
    expect(supervisor.health().state).toBe("broken");
    expect(supervisor.health().lastProtocolError?.reason).toContain("protocol");
  });

  it("marks unexpected clean exits as broken instead of stopped", async () => {
    await supervisor.start();

    await expect(
      supervisor.sendCommand({
        command: "exit-clean",
      }),
    ).rejects.toThrow("Supervisor process exited (0)");

    expect(supervisor.health().state).toBe("broken");
    expect(supervisor.health().lastError).toContain("unexpectedly");
  });
});

describe("stdio protocol parser", () => {
  it("accepts strict JSON event lines and rejects malformed protocol output", () => {
    const ok = parseStdioProtocolLine('{"type":"event","event":"tick","payload":{"value":1}}');
    const bad = parseStdioProtocolLine('{"type":"event","payload":{"value":1}}');

    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.message.type).toBe("event");
    }

    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.reason).toContain("event");
    }
  });
});
