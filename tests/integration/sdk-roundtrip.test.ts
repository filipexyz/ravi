/**
 * End-to-end round-trip test for `@ravi-os/sdk`.
 *
 * Uses the live gateway + the typed `RaviClient` driven by `createHttpTransport`
 * to verify the full pipeline matches the contract the codegen emitted:
 *   - URL routing (groupSegments + command → /api/v1/...)
 *   - Flat JSON body (id passed positionally → `{ id }` on the wire)
 *   - 2xx JSON response surfaced unchanged to the caller
 *   - 4xx ValidationError mapped through `errors.ts`
 *
 * `artifacts.show` is the gateway piloto and matches the existing gateway
 * smoke test, so any drift here also bubbles in the gateway test.
 */

import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ArtifactsCommands } from "../../src/cli/commands/artifacts.js";
import { ChatMessageCommands, ChatsCommands } from "../../src/cli/commands/chats.js";
import { SessionCommands } from "../../src/cli/commands/sessions.js";
import { buildRegistry } from "../../src/cli/registry-snapshot.js";
import { createArtifact } from "../../src/artifacts/store.js";
import { saveMessage } from "../../src/db.js";
import { getOrCreateSession } from "../../src/router/sessions.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  RAVI_RUNTIME_CONTEXT_ENV_KEYS,
} from "../../src/test/ravi-state.js";
import type { ContextRecord } from "../../src/router/router-db.js";
import { startGateway, type GatewayHandle } from "../../src/sdk/gateway/server.js";

import { RaviClient } from "../../packages/ravi-os-sdk/src/index.js";
import { createHttpTransport } from "../../packages/ravi-os-sdk/src/transport/http.js";
import { RaviValidationError } from "../../packages/ravi-os-sdk/src/errors.js";

const registry = buildRegistry([ArtifactsCommands, ChatsCommands, ChatMessageCommands, SessionCommands]);
const allowedContext: ContextRecord = {
  contextId: "ctx_sdk_roundtrip",
  contextKey: "rctx_sdk_roundtrip",
  kind: "test-runtime",
  agentId: "sdk-roundtrip-agent",
  capabilities: [
    { permission: "execute", objectType: "group", objectId: "artifacts", source: "test" },
    { permission: "execute", objectType: "group", objectId: "sessions", source: "test" },
    { permission: "access", objectType: "session", objectId: "managed-sdk-roundtrip", source: "test" },
    { permission: "mutate", objectType: "agent", objectId: "main", source: "test" },
  ],
  metadata: { authorityMode: "delegated" },
  createdAt: Date.now(),
};

let stateDir: string | null = null;
let handle: GatewayHandle | null = null;
let canonicalChatGrantId: string | null = null;
const originalRuntimeContextEnv = new Map(RAVI_RUNTIME_CONTEXT_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  for (const key of RAVI_RUNTIME_CONTEXT_ENV_KEYS) delete process.env[key];
  stateDir = await createIsolatedRaviState("ravi-sdk-roundtrip-");
  canonicalChatGrantId = null;
  handle = startGateway({
    host: "127.0.0.1",
    port: 0,
    registry,
    auth: {
      resolveContext(token) {
        if (token !== allowedContext.contextKey) return null;
        return {
          ...allowedContext,
          capabilities: [
            ...allowedContext.capabilities,
            ...(canonicalChatGrantId
              ? [{ permission: "mutate", objectType: "chat", objectId: canonicalChatGrantId, source: "test" }]
              : []),
          ],
        };
      },
    },
  });
});

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  canonicalChatGrantId = null;
  for (const key of RAVI_RUNTIME_CONTEXT_ENV_KEYS) {
    const value = originalRuntimeContextEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function buildClient(): RaviClient {
  const transport = createHttpTransport({
    baseUrl: handle!.url,
    contextKey: allowedContext.contextKey,
  });
  return new RaviClient(transport);
}

describe("SDK round-trip — RaviClient over http transport", () => {
  it("artifacts.show returns the artifact payload with an authorized runtime context", async () => {
    const artifact = createArtifact({
      kind: "report",
      title: "SDK round-trip smoke",
      summary: "Created by the @ravi-os/sdk round-trip integration test.",
      tags: ["sdk", "roundtrip"],
    });

    const client = buildClient();
    const result = (await client.artifacts.show(artifact.id)) as {
      artifact: { id: string; kind: string };
      links: unknown[];
      events: unknown[];
    };

    expect(result.artifact.id).toBe(artifact.id);
    expect(result.artifact.kind).toBe("report");
    expect(Array.isArray(result.links)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("sessions.read returns normalized history instead of an empty gateway envelope", async () => {
    const sessionName = "managed-sdk-roundtrip";
    getOrCreateSession("agent:sdk-roundtrip-agent:managed", allowedContext.agentId!, stateDir!, {
      name: sessionName,
    });
    saveMessage(sessionName, "user", "pergunta remota");
    saveMessage(sessionName, "assistant", "resposta remota");

    const result = await buildClient().sessions.read(sessionName, { count: "10" });

    expect("messages" in result).toBe(true);
    if (!("messages" in result)) throw new Error("sessions.read did not return history");
    expect(result.transcript.source).toBe("chat-db");
    expect(result.messages.map((message) => message.text)).toEqual(["pergunta remota", "resposta remota"]);
  });

  it("creates canonical chats and actor messages idempotently through the generated client", async () => {
    const client = buildClient();
    const ensured = await client.chats.ensure("actor-sdk-roundtrip", "main", "request-sdk-roundtrip");
    const retriedEnsure = await client.chats.ensure("actor-sdk-roundtrip", "main", "request-sdk-roundtrip");

    expect(ensured.disposition).toBe("created");
    expect(retriedEnsure.disposition).toBe("existing");
    expect(retriedEnsure.chat.id).toBe(ensured.chat.id);
    canonicalChatGrantId = ensured.chat.id;

    const created = await client.chats.messages.create(
      ensured.chat.id,
      "actor-sdk-roundtrip",
      "message-sdk-roundtrip",
      "hello through the generated SDK",
    );
    const duplicate = await client.chats.messages.create(
      ensured.chat.id,
      "actor-sdk-roundtrip",
      "message-sdk-roundtrip",
      "hello through the generated SDK",
    );

    expect(created.disposition).toBe("created");
    expect(created.message.state).toBe("created");
    expect(created.message.revision).toBe(1);
    expect(duplicate.disposition).toBe("duplicate");
    expect(duplicate.messageId).toBe(created.messageId);
  });

  it("maps 4xx validation errors to RaviValidationError", async () => {
    // Hit the transport directly with a body that violates the input schema
    // (missing required `id`). The typed RaviClient method would never let us
    // express this — that's the point: the transport is the seam where the
    // error mapping lives, and that's what we're verifying.
    const transport = createHttpTransport({
      baseUrl: handle!.url,
      contextKey: allowedContext.contextKey,
    });
    let caught: unknown;
    try {
      await transport.call({
        groupSegments: ["artifacts"],
        command: "show",
        body: {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RaviValidationError);
    const validation = caught as RaviValidationError;
    expect(validation.command).toBe("artifacts.show");
    expect(Array.isArray(validation.issues)).toBe(true);
    expect(validation.issues.some((i) => i.path?.[0] === "id")).toBe(true);
  });
});
