import { describe, expect, it, mock } from "bun:test";
import { ChannelOutputSinkRegistry as RuntimeSinkRegistry } from "../../../../src/channels/backend.js";
import {
  ChannelOutputHandoffError as RuntimeHandoffError,
  createChannelOutputHandoffIdentity,
} from "../../../../src/channels/output-handoff.js";
import {
  ChannelOutputHandoffError as SdkHandoffError,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  ChannelIngressRequestSchema,
  ChannelIngressResultSchema,
  ChannelOutputEnvelopeSchema,
  ChannelOutputSinkRegistry,
  createChannelBackendClient,
  type ChannelIngressRequest,
  type ChannelIngressResult,
  type ChannelOutputEnvelope,
  type ChannelOutputEmissionContext,
  type ChannelOutputHandoffConfirmation,
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
    await expect(registry.emit(output)).rejects.toMatchObject({ evidence: {
      disposition: "not_started", code: "SINK_UNAVAILABLE", operationFinished: true,
    } });
  });

  it("refuses unknown restricted sinks and preserves context and unclassified completion in both entry points", async () => {
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");
    const registry = new ChannelOutputSinkRegistry();
    const generic = mock(async () => {});
    const context = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint: "a".repeat(64),
    };
    const unregister = registry.register(output.target, { emit: generic });
    await expect(registry.emit(output, context)).rejects.toMatchObject({ evidence: {
      disposition: "not_started", code: "UNSUPPORTED_CAPABILITY",
    } });
    await expect(registry.tryEmit(output, context)).rejects.toMatchObject({ evidence: {
      disposition: "not_started", code: "UNSUPPORTED_CAPABILITY",
    } });
    expect(generic).not.toHaveBeenCalled();
    unregister();
    const contexts: Array<ChannelOutputEmissionContext | undefined> = [];
    registry.register(output.target, {
      handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      async emit(_output, restriction) { contexts.push(restriction); },
    });
    await expect(registry.emit(output, context)).resolves.toBeUndefined();
    await expect(registry.tryEmit(output, context)).resolves.toBe(true);
    expect(contexts).toEqual([context, context]);
  });

  it.each([
    ["without a restriction", "a".repeat(64), undefined],
    ["with a matching fingerprint", "a".repeat(64), "a".repeat(64)],
    ["with a mismatching fingerprint", "b".repeat(64), "a".repeat(64)],
  ] as const)("preserves unfinished unknown evidence %s", async (_name, requestFingerprint, expectedRequestFingerprint) => {
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");
    const registry = new ChannelOutputSinkRegistry();
    const evidence = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1 as const,
      identity: createChannelOutputHandoffIdentity(output),
      idempotencyKey: output.outputId,
      requestFingerprint,
      disposition: "unknown" as const,
      operationFinished: false,
      code: "OUTCOME_UNKNOWN" as const,
    };
    const context = expectedRequestFingerprint === undefined ? undefined : {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint,
    };
    const contexts: Array<ChannelOutputEmissionContext | undefined> = [];
    registry.register(output.target, {
      handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      async emit(_output, restriction) {
        contexts.push(restriction);
        throw new RuntimeHandoffError(evidence);
      },
    });

    for (const method of ["emit", "tryEmit"] as const) {
      await expect(registry[method](output, context)).rejects.toHaveProperty("evidence", evidence);
    }
    expect(contexts).toEqual([context, context]);
    expect(context?.expectedRequestFingerprint).toBe(expectedRequestFingerprint);
  });

  it("normalizes a finished pre-save fingerprint mismatch to conflict", async () => {
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");
    const registry = new ChannelOutputSinkRegistry();
    const evidence = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1 as const,
      identity: createChannelOutputHandoffIdentity(output),
      idempotencyKey: output.outputId,
      requestFingerprint: "b".repeat(64),
      disposition: "finished_pre_save_missing" as const,
      operationFinished: true as const,
      code: "SQLITE_BUSY" as const,
    };
    const context = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint: "a".repeat(64),
    };
    registry.register(output.target, {
      handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      async emit() {
        throw new RuntimeHandoffError(evidence);
      },
    });

    for (const method of ["emit", "tryEmit"] as const) {
      await expect(registry[method](output, context)).rejects.toHaveProperty("evidence", {
        ...evidence,
        disposition: "conflict",
        code: "REQUEST_FINGERPRINT_CONFLICT",
      });
    }
    expect(context.expectedRequestFingerprint).toBe("a".repeat(64));
  });

  it("validates runtime-produced identity and the pinned fingerprint with the independent SDK mirror", async () => {
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");
    const registry = new ChannelOutputSinkRegistry();
    const confirmation: ChannelOutputHandoffConfirmation = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1,
      identity: createChannelOutputHandoffIdentity(output),
      idempotencyKey: output.outputId,
      requestFingerprint: "a".repeat(64),
      durableSaveConfirmed: true,
      disposition: "deferred",
    };
    registry.register(output.target, {
      handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      async emit() { return confirmation; },
    });
    const context = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint: confirmation.requestFingerprint,
    };
    await expect(registry.emit(output, context)).resolves.toEqual(confirmation);
    await expect(registry.emit({ ...output, content: [{ type: "text", text: "changed" }] }, context))
      .rejects.toMatchObject({ evidence: { disposition: "unknown", code: "INVALID_CONFIRMATION" } });
    await expect(registry.emit(output, { ...context, expectedRequestFingerprint: "b".repeat(64) }))
      .rejects.toMatchObject({ evidence: { disposition: "unknown", code: "INVALID_CONFIRMATION" } });
  });

  it("accepts cross-package typed evidence only from a known capable sink", async () => {
    const output = await fixture<ChannelOutputEnvelope>("output-envelope.json");
    const registry = new ChannelOutputSinkRegistry();
    const evidence = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1 as const,
      identity: createChannelOutputHandoffIdentity(output),
      idempotencyKey: output.outputId,
      requestFingerprint: "a".repeat(64),
      disposition: "finished_pre_save_missing" as const,
      operationFinished: true as const,
      code: "SQLITE_BUSY" as const,
    };
    const emit = mock(async () => { throw new RuntimeHandoffError(evidence); });
    const unregister = registry.register(output.target, { emit });
    await expect(registry.emit(output)).rejects.toMatchObject({ evidence: {
      disposition: "unknown", code: "UNCLASSIFIED",
    } });
    expect(emit).toHaveBeenCalledTimes(1);
    unregister();
    registry.register(output.target, { handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY, emit });
    await expect(registry.emit(output)).rejects.toMatchObject({ evidence });
  });
  it("accepts SDK typed evidence only from a sink that declares the known capability", async () => {
    const envelope = await fixture<ChannelOutputEnvelope>("output-envelope.json");
    const registry = new RuntimeSinkRegistry();
    const evidence = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: 1 as const,
      identity: createChannelOutputHandoffIdentity(envelope),
      idempotencyKey: envelope.outputId,
      requestFingerprint: "a".repeat(64),
      disposition: "finished_pre_save_missing" as const,
      operationFinished: true as const,
      code: "SQLITE_BUSY" as const,
    };
    const emit = mock(async () => { throw new SdkHandoffError(evidence); });
    const unregister = registry.register(envelope.target, { emit });
    await expect(registry.emit(envelope)).rejects.toMatchObject({ evidence: {
      disposition: "unknown", code: "UNCLASSIFIED",
    } });
    expect(emit).toHaveBeenCalledTimes(1);
    unregister();
    registry.register(envelope.target, { handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY, emit });
    await expect(registry.emit(envelope)).rejects.toMatchObject({ evidence });
  });
});
