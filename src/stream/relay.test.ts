import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createCliStreamRelay } from "./relay.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stream-relay-fixture.ts", import.meta.url));
const silentFixturePath = fileURLToPath(new URL("./fixtures/stream-relay-silent-fixture.ts", import.meta.url));

describe("cli stream relay", () => {
  const relay = createCliStreamRelay({
    command: process.execPath,
    args: [fixturePath],
    scope: "overlay.whatsapp",
  });

  beforeEach(async () => {
    await relay.start();
  });

  afterEach(async () => {
    await relay.stop();
  });

  it("boots, receives hello, and requests snapshot", async () => {
    const health = relay.health();
    expect(health.status).toBe("running");
    expect(health.hello?.type).toBe("hello");

    const snapshot = await relay.requestSnapshot();
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.body.scope).toBe("overlay.whatsapp");
    expect(relay.health().snapshot?.body.entities.sessions).toEqual([{ name: "dev" }]);
  });

  it("sends commands and receives ack/error", async () => {
    const ack = await relay.sendCommand("ping");
    expect(ack.body.ok).toBe(true);
    expect(ack.body.result).toEqual({ pong: true });

    await expect(relay.sendCommand("fail")).rejects.toMatchObject({
      code: "boom",
      message: "fixture failure",
      retryable: false,
    });
  });

  it("cleans up the child process when startup hello times out", async () => {
    const timedOutRelay = createCliStreamRelay({
      command: process.execPath,
      args: [silentFixturePath],
      scope: "overlay.whatsapp",
      startTimeoutMs: 50,
    });

    await expect(timedOutRelay.start()).rejects.toThrow("Timed out waiting for stream hello after 50ms");

    const health = timedOutRelay.health();
    expect(health.status).toBe("broken");
    expect(health.pid).toBeNull();
    expect(health.lastError).toBe("Timed out waiting for stream hello after 50ms");

    await timedOutRelay.stop();
  });
});
