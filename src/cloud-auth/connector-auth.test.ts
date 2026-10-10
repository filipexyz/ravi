import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CloudAuthError } from "./errors.js";
import {
  assertConnectorSessionUser,
  deleteConnectorSession,
  resolveConnectorCloudCredentials,
} from "./connector-auth.js";
import {
  listCloudAuthUserIds,
  readActiveCloudAuthUserId,
  readCloudCredentials,
  readCloudCredentialsForUser,
  writeCloudCredentials,
} from "./storage.js";
import { getOrCreateSession } from "../router/sessions.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { CloudCredentials } from "./types.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-connector-auth-");
});

afterEach(async () => {
  delete process.env.RAVI_CONTEXT_KEY;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("resolveConnectorCloudCredentials", () => {
  it("uses the active session from the terminal", () => {
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));

    const { turn, credentials } = resolveConnectorCloudCredentials();

    expect(credentials.accessToken).toBe("operator-access");
    expect(turn.speaker.kind).toBe("terminal");
  });

  it("uses the active session for the operator's own linked chat", () => {
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));
    // The owner's direct chat, in a session of its own (dmScope per-peer).
    const sessionKey = "agent:main:whatsapp:wa-main:dm:5511999999999";
    getOrCreateSession(sessionKey, "main", stateDir ?? "/tmp");
    const context = createRuntimeContext({
      kind: "turn-runtime",
      sessionKey,
      sessionName: "luis-dm",
      metadata: {
        actorPrincipal: "contact:luis",
        actorResolution: "resolved",
        consoleUserId: "user_operator",
        consoleOrgId: "org_123",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    const { turn, credentials } = resolveConnectorCloudCredentials();

    expect(credentials.accessToken).toBe("operator-access");
    expect(turn.speaker).toEqual({ kind: "owner", contactId: "luis", consoleUserId: "user_operator" });
  });

  it("never borrows another stored user's session for a contact linked to that user", () => {
    writeCloudCredentials(makeCredentials("user_alice", "alice-access"));
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));
    const context = createRuntimeContext({
      kind: "turn-runtime",
      metadata: {
        actorPrincipal: "contact:alice",
        actorResolution: "resolved",
        consoleUserId: "user_alice",
        agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    let caught: unknown;
    try {
      resolveConnectorCloudCredentials();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CloudAuthError);
    expect((caught as CloudAuthError).code).toBe("CONNECTOR_SPEAKER_NOT_OWNER");
    expect((caught as CloudAuthError).exitCode).toBe(3);
  });

  it("does not fall back to the operator session for an unlinked contact", () => {
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));
    const context = createRuntimeContext({
      kind: "turn-runtime",
      metadata: {
        actorPrincipal: "contact:luis",
        actorResolution: "resolved",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    expect(() => resolveConnectorCloudCredentials()).toThrow(CloudAuthError);
  });

  it("asks for ravi login from the terminal when no session is stored", () => {
    let caught: unknown;
    try {
      resolveConnectorCloudCredentials();
    } catch (error) {
      caught = error;
    }

    expect((caught as CloudAuthError).code).toBe("AUTH_REQUIRED");
  });

  it("asks the logged-out owner for ravi login instead of calling them someone else", () => {
    const context = createRuntimeContext({
      kind: "turn-runtime",
      metadata: {
        actorPrincipal: "contact:luis",
        actorResolution: "resolved",
        consoleUserId: "user_operator",
        consoleOrgId: "org_123",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    const caught = catchError(() => resolveConnectorCloudCredentials());

    expect(caught).toBeInstanceOf(CloudAuthError);
    expect((caught as CloudAuthError).code).toBe("AUTH_REQUIRED");
  });

  it("asks for ravi login when the stored session does not say whose it is and a contact speaks", () => {
    const legacy = makeCredentials("user_operator", "operator-access");
    legacy.user = { name: "Operator" };
    writeCloudCredentials(legacy);
    const context = createRuntimeContext({
      kind: "turn-runtime",
      metadata: {
        actorPrincipal: "contact:luis",
        actorResolution: "resolved",
        consoleUserId: "user_operator",
        consoleOrgId: "org_123",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    const caught = catchError(() => resolveConnectorCloudCredentials());

    expect((caught as CloudAuthError).code).toBe("AUTH_REQUIRED");
  });
});

describe("deleteConnectorSession", () => {
  it("forgets a dead session without making another stored user the active one", () => {
    writeCloudCredentials(makeCredentials("user_alice", "alice-access"));
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));
    expect(readActiveCloudAuthUserId()).toBe("user_operator");

    deleteConnectorSession();

    expect(readActiveCloudAuthUserId()).toBeNull();
    expect(readCloudCredentials()).toBeNull();
    expect(listCloudAuthUserIds()).toEqual(["user_alice"]);
    expect(readCloudCredentialsForUser("user_alice")?.accessToken).toBe("alice-access");
    expect((catchError(() => resolveConnectorCloudCredentials()) as CloudAuthError).code).toBe("AUTH_REQUIRED");
  });

  it("removes the only stored session", () => {
    writeCloudCredentials(makeCredentials("user_operator", "operator-access"));

    deleteConnectorSession();

    expect(readActiveCloudAuthUserId()).toBeNull();
    expect(listCloudAuthUserIds()).toEqual([]);
  });
});

describe("assertConnectorSessionUser", () => {
  it("refuses a session the Console says belongs to another user", () => {
    const caught = catchError(() => assertConnectorSessionUser("user_operator", "user_alice"));

    expect(caught).toBeInstanceOf(CloudAuthError);
    expect((caught as CloudAuthError).code).toBe("AUTH_REQUIRED");
  });

  it("accepts the same user and sessions that do not name one", () => {
    expect(() => assertConnectorSessionUser("user_operator", "user_operator")).not.toThrow();
    expect(() => assertConnectorSessionUser(null, "user_alice")).not.toThrow();
    expect(() => assertConnectorSessionUser("user_operator", undefined)).not.toThrow();
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

function makeCredentials(userId: string, accessToken: string): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken,
    refreshToken: `${accessToken}-refresh`,
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["artifacts:publish"],
    user: { id: userId, name: "Operator" },
    organization: { id: "org_123", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
