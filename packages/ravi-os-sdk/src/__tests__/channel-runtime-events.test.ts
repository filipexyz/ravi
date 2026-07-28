import { describe, expect, it, mock } from "bun:test";
import {
  CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
  ChannelInterruptRequestSchema,
  ChannelInterruptResultSchema,
  ChannelRuntimeReadbackRequestSchema,
  ChannelRuntimeReadbackResultSchema,
  ChannelTerminalOutputEventSchema,
  KnownChannelRuntimeEventSchema,
  createChannelRuntimeClient,
  type ChannelInterruptRequest,
  type ChannelInterruptResult,
  type ChannelRuntimeReadbackRequest,
  type ChannelRuntimeReadbackResult,
  type KnownChannelRuntimeEvent,
} from "../channel-runtime-events.js";

const fixtureDirectory = new URL("./fixtures/channel-runtime-events/", import.meta.url);

async function fixture<T>(name: string): Promise<T> {
  return Bun.file(new URL(name, fixtureDirectory)).json() as Promise<T>;
}

describe("channel runtime events contract", () => {
  it("parses every projected event fixture", async () => {
    for (const name of [
      "event-state.json",
      "event-delta.json",
      "event-assistant-message.json",
      "event-tool.json",
      "event-approval-requested.json",
      "event-approval-resolved.json",
      "event-terminal.json",
    ]) {
      const event = await fixture<KnownChannelRuntimeEvent>(name);
      expect(KnownChannelRuntimeEventSchema.parse(event)).toEqual(event);
    }
  });

  it("parses interrupt and readback request/result fixtures", async () => {
    const interruptRequest = await fixture<ChannelInterruptRequest>("interrupt-request.json");
    const interruptResult = await fixture<ChannelInterruptResult>("interrupt-result.json");
    const readbackRequest = await fixture<ChannelRuntimeReadbackRequest>("readback-request.json");
    const readbackResult = await fixture<ChannelRuntimeReadbackResult>("readback-result.json");

    expect(ChannelInterruptRequestSchema.parse(interruptRequest)).toEqual(interruptRequest);
    expect(ChannelInterruptResultSchema.parse(interruptResult)).toEqual(interruptResult);
    expect(ChannelRuntimeReadbackRequestSchema.parse(readbackRequest)).toEqual(readbackRequest);
    expect(ChannelRuntimeReadbackResultSchema.parse(readbackResult)).toEqual(readbackResult);
  });

  it("rejects unsupported versions and malformed terminal or interrupt results", async () => {
    const interruptRequest = await fixture<ChannelInterruptRequest>("interrupt-request.json");
    const interruptResult = await fixture<ChannelInterruptResult>("interrupt-result.json");
    const terminal = await fixture<KnownChannelRuntimeEvent>("event-terminal.json");

    expect(
      ChannelInterruptRequestSchema.safeParse({
        ...interruptRequest,
        schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION + 1,
      }).success,
    ).toBe(false);
    expect(
      ChannelInterruptResultSchema.safeParse({
        ...interruptResult,
        disposition: "rejected",
      }).success,
    ).toBe(false);
    expect(
      ChannelTerminalOutputEventSchema.safeParse({
        ...terminal,
        payload: {
          state: "completed",
        },
      }).success,
    ).toBe(false);
  });

  it("wraps generated interrupt and readback commands with the binding agent id", async () => {
    const interruptRequest = await fixture<ChannelInterruptRequest>("interrupt-request.json");
    const interruptResult = await fixture<ChannelInterruptResult>("interrupt-result.json");
    const readbackRequest = await fixture<ChannelRuntimeReadbackRequest>("readback-request.json");
    const readbackResult = await fixture<ChannelRuntimeReadbackResult>("readback-result.json");
    const interrupt = mock(async () => interruptResult);
    const readback = mock(async () => readbackResult);
    const client = createChannelRuntimeClient({
      channels: {
        backend: {
          runtime: {
            interrupt,
            readback,
          },
        },
      },
    });

    await expect(client.interrupt(interruptRequest)).resolves.toEqual(interruptResult);
    await expect(client.readback(readbackRequest)).resolves.toEqual(readbackResult);
    expect(interrupt).toHaveBeenCalledWith(interruptRequest.binding.agentId, interruptRequest);
    expect(readback).toHaveBeenCalledWith(readbackRequest.binding.agentId, readbackRequest);
  });
});
