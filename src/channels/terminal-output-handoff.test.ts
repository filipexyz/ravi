import { describe, expect, it } from "bun:test";
import type { ChannelOutputEnvelope } from "./backend.js";
import {
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  ChannelOutputHandoffError,
  createChannelOutputHandoffIdentity,
  type ChannelOutputEmissionContext,
  type ChannelOutputHandoffConfirmation,
} from "./output-handoff.js";
import { handoffTerminalOutputWithRecovery, type TerminalOutputHandoffState } from "./terminal-output-handoff.js";

const fingerprint = "a".repeat(64);
const alternateFingerprint = "b".repeat(64);

describe("bounded terminal text handoff", () => {
  it("pins the first prepared request and retries only that completed pre-save absence", async () => {
    const output = envelope();
    const calls: Array<{ output: ChannelOutputEnvelope; context?: ChannelOutputEmissionContext }> = [];
    const states: TerminalOutputHandoffState[] = [];
    const result = await handoffTerminalOutputWithRecovery(
      output,
      async (value, context) => {
        calls.push({ output: value, context });
        if (calls.length === 1) throw missing(value);
        return confirmed(value, "deferred");
      },
      { mayEmit: () => true, onState: (state) => states.push(state) },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.context).toBeUndefined();
    expect(calls[1]!.context).toEqual({
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint: fingerprint,
    });
    expect(calls[1]!.output).toEqual(calls[0]!.output);
    expect(Object.isFrozen(calls[1]!.output.content)).toBe(true);
    expect(Object.isFrozen(output.content)).toBe(false);
    expect(result?.disposition).toBe("deferred");
    expect(states.map((state) => state.status)).toEqual(["retry_scheduled", "handed_off"]);
  });

  it("exhausts at three calls without replaying a provider or changing the pin", async () => {
    const contexts: Array<ChannelOutputEmissionContext | undefined> = [];
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async (output, context) => {
          contexts.push(context);
          throw missing(output);
        },
        { mayEmit: () => true },
      ),
    ).rejects.toMatchObject({ outcome: { status: "retry_exhausted", attempt: 3 } });
    expect(contexts).toEqual([
      undefined,
      { capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY, expectedRequestFingerprint: fingerprint },
      { capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY, expectedRequestFingerprint: fingerprint },
    ]);
  });

  it("rejects a later prepared fingerprint instead of replacing the first pin", async () => {
    let calls = 0;
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async (output) => {
          calls += 1;
          throw missing(output, calls === 1 ? fingerprint : alternateFingerprint);
        },
        { mayEmit: () => true },
      ),
    ).rejects.toMatchObject({ outcome: { status: "non_retryable" } });
    expect(calls).toBe(2);
  });

  it("does not replay a generic exception even if its message names SQLITE_BUSY", async () => {
    let calls = 0;
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async () => {
          calls += 1;
          throw new Error("SQLITE_BUSY: unavailable before save");
        },
        { mayEmit: () => true },
      ),
    ).rejects.toMatchObject({ outcome: { status: "outcome_unknown" } });
    expect(calls).toBe(1);
  });

  it("keeps a still-running timeout unknown and does not resend", async () => {
    let calls = 0;
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async (output) => {
          calls += 1;
          throw new ChannelOutputHandoffError({
            capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
            schemaVersion: 1,
            identity: createChannelOutputHandoffIdentity(output),
            disposition: "unknown",
            operationFinished: false,
            code: "TRANSPORT_FAILED",
          });
        },
        { mayEmit: () => true },
      ),
    ).rejects.toMatchObject({ outcome: { status: "outcome_unknown" } });
    expect(calls).toBe(1);
  });

  it("does not invent a job fingerprint or retry a job-less refusal", async () => {
    let calls = 0;
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async (output) => {
          calls += 1;
          throw new ChannelOutputHandoffError({
            capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
            schemaVersion: 1,
            identity: createChannelOutputHandoffIdentity(output),
            disposition: "not_started",
            operationFinished: true,
            code: "UNSUPPORTED_CAPABILITY",
          });
        },
        { mayEmit: () => true },
      ),
    ).rejects.toMatchObject({ outcome: { status: "non_retryable" } });
    expect(calls).toBe(1);
  });

  it("settles generic success as unclassified without another call", async () => {
    let calls = 0;
    const states: TerminalOutputHandoffState[] = [];
    const result = await handoffTerminalOutputWithRecovery(
      envelope(),
      async () => {
        calls += 1;
      },
      {
        mayEmit: () => true,
        onState: (state) => states.push(state),
      },
    );
    expect(result).toBeUndefined();
    expect(calls).toBe(1);
    expect(states.map((state) => state.status)).toEqual(["unclassified"]);
  });

  it("does not accept a malformed generic acknowledgement as durable", async () => {
    let calls = 0;
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async () => {
          calls += 1;
          return { ok: true } as unknown as ChannelOutputHandoffConfirmation;
        },
        { mayEmit: () => true },
      ),
    ).rejects.toMatchObject({ outcome: { status: "outcome_unknown", errorCode: "INVALID_CONFIRMATION" } });
    expect(calls).toBe(1);
  });

  for (const disposition of ["pending", "deferred", "published", "suppressed"] as const) {
    it(`settles matching ${disposition} save once without claiming platform delivery`, async () => {
      let calls = 0;
      let owner = true;
      const result = await handoffTerminalOutputWithRecovery(
        envelope(),
        async (output) => {
          calls += 1;
          owner = false;
          return confirmed(output, disposition);
        },
        { mayEmit: () => owner },
      );
      expect(calls).toBe(1);
      expect(result?.durableSaveConfirmed).toBe(true);
      expect(result?.disposition).toBe(disposition);
    });
  }

  it("cancels the next attempt when the captured owner is replaced during the wait", async () => {
    let owner = true;
    let calls = 0;
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async (output) => {
          calls += 1;
          throw missing(output);
        },
        {
          mayEmit: () => owner,
          onState: (state) => {
            if (state.status === "retry_scheduled")
              queueMicrotask(() => {
                owner = false;
              });
          },
        },
      ),
    ).rejects.toMatchObject({ outcome: { status: "owner_lost" } });
    expect(calls).toBe(1);
  });

  it("rejects another output identity even when its key appears unchanged", async () => {
    let calls = 0;
    await expect(
      handoffTerminalOutputWithRecovery(
        envelope(),
        async (output) => {
          calls += 1;
          throw missing({ ...output, target: { ...output.target, conversationId: "another-conversation" } });
        },
        { mayEmit: () => true },
      ),
    ).rejects.toMatchObject({ outcome: { status: "non_retryable" } });
    expect(calls).toBe(1);
  });
});

function envelope(): ChannelOutputEnvelope {
  return {
    protocol: "ravi.channel.backend",
    schemaVersion: 1,
    outputId: "terminal-output",
    correlationId: "request-one",
    causationId: "request-one",
    binding: {
      channelInstanceId: "slack-one",
      agentId: "agent-one",
      chatId: "chat-one",
      messageId: "message-one",
      sessionId: "session-one",
      turnId: "turn-one",
    },
    target: { channelKind: "slack", connectionId: "slack-one", conversationId: "conversation-one" },
    kind: "assistant_message",
    content: [{ type: "text", text: "Complete reply\nsecond line" }],
    emittedAt: "2026-11-04T06:00:00.000Z",
  };
}

function missing(output: ChannelOutputEnvelope, requestFingerprint = fingerprint): ChannelOutputHandoffError {
  return new ChannelOutputHandoffError({
    capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
    schemaVersion: 1,
    identity: createChannelOutputHandoffIdentity(output),
    idempotencyKey: output.outputId,
    requestFingerprint,
    disposition: "finished_pre_save_missing",
    operationFinished: true,
    code: "SQLITE_BUSY",
  });
}

function confirmed(
  output: ChannelOutputEnvelope,
  disposition: ChannelOutputHandoffConfirmation["disposition"],
): ChannelOutputHandoffConfirmation {
  return {
    capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
    schemaVersion: 1,
    identity: createChannelOutputHandoffIdentity(output),
    idempotencyKey: output.outputId,
    requestFingerprint: fingerprint,
    durableSaveConfirmed: true,
    disposition,
  };
}
