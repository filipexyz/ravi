import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createCliStreamRelay } from "./relay.js";

const fixturePath = fileURLToPath(new URL("./fixtures/stream-relay-fixture.ts", import.meta.url));

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

    const nextEvent = new Promise<any>((resolve) => {
      relay.events.once("event", resolve);
    });

    const outlineAck = await relay.sendCommand("placeholder.outline", {
      componentId: "timeline",
      selector: "main [data-testid='conversation-panel-body']",
    });
    expect(outlineAck.body.ok).toBe(true);
    expect(outlineAck.body.result).toMatchObject({
      accepted: true,
      emitted: "overlay.whatsapp.command.requested",
    });

    const event = await nextEvent;
    expect(event.topic).toBe("overlay.whatsapp.command.requested");
    expect(event.body).toMatchObject({
      name: "placeholder.outline",
      args: {
        componentId: "timeline",
      },
    });

    await expect(relay.sendCommand("fail")).rejects.toMatchObject({
      code: "boom",
      message: "fixture failure",
      retryable: false,
    });
  });
});
