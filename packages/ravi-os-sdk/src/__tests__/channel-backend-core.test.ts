import { describe, expect, it, mock } from "bun:test";
import {
  CHANNEL_BACKEND_SCHEMA_VERSION,
  ChannelIngressRequestSchema,
  ChannelIngressResultSchema,
  ChannelOutputEnvelopeSchema,
  ChannelOutputSinkRegistry,
  createChannelBackendClient,
  type ChannelIngressRequest,
  type ChannelIngressResult,
  type ChannelOutputEnvelope,
} from "../channel-backend.js";

const fixtureDirectory = new URL("./fixtures/channel-backend-core/", import.meta.url);

async function fixture<T>(name: string): Promise<T> {
  return Bun.file(new URL(name, fixtureDirectory)).json() as Promise<T>;
}

describe("channel backend core contract", () => {
  it("parses the projected request, result, and output fixtures", async () => {
    const request = await fixture<ChannelIngressRequest>("ingress-request.json");
    const result = await fixture<ChannelIngressResult>("ingress-result.json");
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");

    expect(ChannelIngressRequestSchema.parse(request)).toEqual(request);
    expect(ChannelIngressResultSchema.parse(result)).toEqual(result);
    expect(ChannelOutputEnvelopeSchema.parse(output)).toEqual(output);
  });

  it("rejects unsupported versions and strips additive request fields", async () => {
    const request = await fixture<ChannelIngressRequest>("ingress-request.json");

    expect(
      ChannelIngressRequestSchema.safeParse({
        ...request,
        schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION + 1,
      }).success,
    ).toBe(false);
    expect(
      ChannelIngressRequestSchema.parse({
        ...request,
        futureField: "ignored",
      }),
    ).not.toHaveProperty("futureField");
  });

  it("enforces accepted/rejected and assistant/error shape invariants", async () => {
    const result = await fixture<ChannelIngressResult>("ingress-result.json");
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");

    expect(
      ChannelIngressResultSchema.safeParse({
        ...result,
        disposition: "rejected",
      }).success,
    ).toBe(false);
    expect(
      ChannelOutputEnvelopeSchema.safeParse({
        ...output,
        kind: "safe_error",
      }).success,
    ).toBe(false);
  });

  it("wraps the generated command without exposing its authorization argument", async () => {
    const request = await fixture<ChannelIngressRequest>("ingress-request.json");
    const result = await fixture<ChannelIngressResult>("ingress-result.json");
    const ingress = mock(async () => result);
    const client = createChannelBackendClient({
      channels: {
        backend: { ingress },
      },
    });

    await expect(client.ingress(request)).resolves.toEqual(result);
    expect(ingress).toHaveBeenCalledWith(request.agentId, request);
  });

  it("routes validated output to exactly one connection-scoped sink", async () => {
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");
    const emit = mock(async (_envelope: ChannelOutputEnvelope) => {});
    const registry = new ChannelOutputSinkRegistry();
    const unregister = registry.register(
      {
        channelKind: output.target.channelKind,
        connectionId: output.target.connectionId,
      },
      { emit },
    );

    await registry.emit(output);
    expect(emit).toHaveBeenCalledWith(output);

    unregister();
    await expect(registry.emit(output)).rejects.toThrow("unavailable");
  });
});
