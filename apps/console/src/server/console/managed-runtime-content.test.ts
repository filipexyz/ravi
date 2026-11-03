import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  ManagedRuntimeContentError,
  managedRuntimeContentCodecFromKey,
  type ManagedRuntimeContentScope,
} from "./managed-runtime-content";

const scope: ManagedRuntimeContentScope = {
  organizationId: "c4d497f2-1124-44f4-9f1a-b23a7714cc32",
  projectId: "a0d3ed5f-d559-40d2-b3fd-1df77d82382a",
  instanceId: "d04a603f-18df-43c6-968b-cef5f7077a3a",
  sessionId: "078f7453-35b4-4774-8104-7df32d053722",
  commandId: "eb766947-4be2-465b-b6d4-431f5c93be4a",
  purpose: "command_input",
};

describe("Managed Runtime content encryption", () => {
  test("round-trips content without plaintext in the durable envelope", () => {
    const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 7));
    const value = { prompt: "marker-super-private-value" };
    const envelope = codec.encrypt(value, scope);

    expect(JSON.stringify(envelope)).not.toContain(value.prompt);
    expect(codec.decrypt(envelope, scope)).toEqual(value);
  });

  test("binds ciphertext to organization, instance, session, command, and purpose", () => {
    const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 8));
    const envelope = codec.encrypt({ prompt: "hello" }, scope);

    expect(() =>
      codec.decrypt(envelope, { ...scope, instanceId: crypto.randomUUID() }),
    ).toThrow(
      new ManagedRuntimeContentError("managed_runtime_content_scope_mismatch"),
    );
  });

  test("keeps the legacy command AAD stable", () => {
    const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 10));
    const envelope = codec.encrypt({ prompt: "hello" }, scope);
    const expectedAad = [
      "ravi.managed-runtime.content/v1",
      `organization:${scope.organizationId}`,
      `project:${scope.projectId}`,
      `instance:${scope.instanceId}`,
      `session:${scope.sessionId}`,
      `command:${scope.commandId}`,
      "purpose:command_input",
    ].join("\n");

    expect(envelope.aadHash).toBe(
      createHash("sha256").update(expectedAad).digest("base64url"),
    );
  });

  test("binds chat messages to the exact binding, mirror, and actor", () => {
    const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 11));
    const chatScope: ManagedRuntimeContentScope = {
      ...scope,
      sessionId: null,
      commandId: null,
      chatId: "778d5017-7f19-4074-8fc9-94a0cda91aa3",
      messageId: "d562c54d-1f56-41b3-92e4-0df24b83c6f4",
      actorId: "user_001",
      purpose: "chat_message",
    };
    const envelope = codec.encrypt({ text: "private chat" }, chatScope);

    for (const changed of [
      { ...chatScope, chatId: crypto.randomUUID() },
      { ...chatScope, messageId: crypto.randomUUID() },
      { ...chatScope, actorId: "user_002" },
    ]) {
      expect(() => codec.decrypt(envelope, changed)).toThrow(
        new ManagedRuntimeContentError("managed_runtime_content_scope_mismatch"),
      );
    }
  });

  test("rejects malformed keys and tampered ciphertext", () => {
    expect(() => managedRuntimeContentCodecFromKey(Buffer.alloc(31))).toThrow(
      new ManagedRuntimeContentError("managed_runtime_content_key_invalid"),
    );

    const codec = managedRuntimeContentCodecFromKey(Buffer.alloc(32, 9));
    const envelope = codec.encrypt({ response: "ok" }, {
      ...scope,
      purpose: "command_result",
    });
    envelope.ciphertext = `${String(envelope.ciphertext).slice(0, -1)}A`;
    expect(() =>
      codec.decrypt(envelope, { ...scope, purpose: "command_result" }),
    ).toThrow(
      new ManagedRuntimeContentError("managed_runtime_content_decrypt_failed"),
    );
  });
});
