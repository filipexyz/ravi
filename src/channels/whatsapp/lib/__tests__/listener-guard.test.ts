import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Logger } from "../foundation.js";
import { guardListener } from "../utils/listener-guard.js";

function spyLogger() {
  return {
    debug: mock((_message: string, _data?: Record<string, unknown>) => {}),
    info: mock((_message: string, _data?: Record<string, unknown>) => {}),
    warn: mock((_message: string, _data?: Record<string, unknown>) => {}),
    error: mock((_message: string, _data?: Record<string, unknown>) => {}),
  } satisfies Logger;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("guardListener", () => {
  it("turns a rejecting async listener into a logged, reported error (no unhandled rejection)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const log = spyLogger();
      const onError = mock((_error: unknown) => {});
      const ev = new EventEmitter();
      ev.on(
        "connection.update",
        guardListener({ event: "connection.update", instanceId: "i1", log, onError }, async () => {
          throw new Error("clearAuthState failed");
        }),
      );
      ev.emit("connection.update", {});
      await settle();
      expect(rejections).toEqual([]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: "clearAuthState failed" });
      expect(log.error.mock.calls[0]?.[1]).toMatchObject({ event: "connection.update", instanceId: "i1" });
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("catches synchronous throws so emit() does not throw into Baileys", () => {
    const log = spyLogger();
    const ev = new EventEmitter();
    ev.on(
      "messages.upsert",
      guardListener({ event: "messages.upsert", instanceId: "i1", log }, () => {
        throw new Error("sync boom");
      }),
    );
    expect(() => ev.emit("messages.upsert", {})).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("passes arguments through and swallows a failing reporter", async () => {
    const log = spyLogger();
    const seen: unknown[] = [];
    const guarded = guardListener(
      {
        event: "messages.update",
        instanceId: "i1",
        log,
        onError: () => {
          throw new Error("reporter broke");
        },
      },
      async (value: number) => {
        seen.push(value);
        if (value > 1) throw new Error("bad value");
      },
    );
    guarded(1);
    guarded(2);
    await settle();
    expect(seen).toEqual([1, 2]);
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});
