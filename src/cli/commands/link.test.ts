import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import { readCachedActorBinding } from "../../cloud-auth/actor-bindings.js";
import { resolveAmbientLocalIdentity } from "../../cloud-auth/link-identity.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { dbGetContext } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runLink, runUnlink } from "./link.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-link-command-");
});

afterEach(async () => {
  delete process.env.RAVI_CONTEXT_KEY;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("ravi link ambient identity", () => {
  it("links the current contact to the active Console user without identity flags", async () => {
    const context = createContactContext("luis", { platformIdentityId: "wa:5511" });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    const credentials = makeCredentials();
    const upsert = mock(async () => ({
      created: true,
      binding: {
        id: "bind_1",
        contactId: "luis",
        actorPrincipal: "contact:luis",
        consoleUserId: "user_alice",
        orgId: "org_123",
        installationId: "ins_123",
        platformIdentity: { platformIdentityId: "wa:5511", channel: "whatsapp" },
      },
    }));
    const client = {
      me: mock(async () => ({
        user: { id: "user_alice", email: "alice@example.com" },
        organization: { id: "org_123", name: "Acme" },
      })),
      upsertActorBinding: upsert,
    };

    const { output, result } = await captureConsole(() =>
      runLink(
        { json: true },
        {
          client: client as never,
          readCredentials: () => credentials,
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    );
    const payload = JSON.parse(output);

    expect(result).toEqual(payload);
    expect(payload).toMatchObject({
      success: true,
      linked: true,
      binding: {
        contactId: "luis",
        actorPrincipal: "contact:luis",
        consoleUserId: "user_alice",
        orgId: "org_123",
      },
      local: {
        contactId: "luis",
        actorPrincipal: "contact:luis",
      },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "luis",
        organizationId: "org_123",
        installationId: "ins_123",
        consoleUserId: "user_alice",
        platformIdentities: expect.objectContaining({ platformIdentityId: "wa:5511" }),
      }),
      "access-secret",
    );
    expect(readCachedActorBinding("luis")?.consoleUserId).toBe("user_alice");
    expect(dbGetContext(context.contextId)?.metadata).toMatchObject({
      consoleUserId: "user_alice",
      consoleOrgId: "org_123",
    });
  });

  it("is idempotent when Console returns the existing same-user binding", async () => {
    const context = createContactContext("luis");
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    const client = {
      me: mock(async () => ({
        user: { id: "user_alice" },
        organization: { id: "org_123" },
      })),
      upsertActorBinding: mock(async () => ({
        created: false,
        binding: {
          contactId: "luis",
          actorPrincipal: "contact:luis",
          consoleUserId: "user_alice",
          orgId: "org_123",
          installationId: "ins_123",
        },
      })),
    };

    const { result } = await captureConsole(() =>
      runLink(
        { json: true },
        {
          client: client as never,
          readCredentials: () => makeCredentials(),
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    );

    expect(result).toMatchObject({ success: true, linked: true, idempotent: true });
  });

  it("treats a same-user CONFLICT as an idempotent link", async () => {
    const context = createContactContext("luis");
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    const client = {
      me: mock(async () => ({
        user: { id: "user_alice" },
        organization: { id: "org_123" },
      })),
      upsertActorBinding: mock(async () => {
        throw new CloudAuthError("ACTOR_BINDING_CONFLICT", "already bound", { status: 409 });
      }),
      resolveActorBinding: mock(async () => ({
        contactId: "luis",
        actorPrincipal: "contact:luis",
        consoleUserId: "user_alice",
        orgId: "org_123",
        installationId: "ins_123",
      })),
    };

    const { result } = await captureConsole(() =>
      runLink(
        { json: true },
        {
          client: client as never,
          readCredentials: () => makeCredentials(),
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    );

    expect(result).toMatchObject({ success: true, linked: true, idempotent: true });
  });

  it("fails when no Console login is stored", async () => {
    const context = createContactContext("luis");
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    await expect(
      runLink(
        { json: true },
        {
          readCredentials: () => null,
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: expect.stringContaining("ravi login"),
    });
  });

  it("fails when the current context has no resolved contact", async () => {
    const context = createRuntimeContext({
      kind: "turn-runtime",
      metadata: { actorPrincipal: "agent:main" },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    await expect(
      runLink(
        { json: true },
        {
          client: {
            me: mock(async () => ({
              user: { id: "user_alice" },
              organization: { id: "org_123" },
            })),
          } as never,
          readCredentials: () => makeCredentials(),
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "CONTACT_REQUIRED" });
  });

  it("fails when the contact is bound to a different Console user", async () => {
    const context = createContactContext("luis");
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    const client = {
      me: mock(async () => ({
        user: { id: "user_alice" },
        organization: { id: "org_123" },
      })),
      upsertActorBinding: mock(async () => {
        throw new CloudAuthError("ACTOR_BINDING_CONFLICT", "already bound", { status: 409 });
      }),
      resolveActorBinding: mock(async () => ({
        contactId: "luis",
        actorPrincipal: "contact:luis",
        consoleUserId: "user_other",
        orgId: "org_123",
        installationId: "ins_123",
      })),
    };

    await expect(
      runLink(
        { json: true },
        {
          client: client as never,
          readCredentials: () => makeCredentials(),
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "ACTOR_BINDING_CONFLICT" });
  });

  it("unlinks the ambient contact and clears the local cache", async () => {
    const context = createContactContext("luis");
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    const unlink = mock(async () => ({ unlinked: true }));
    const client = {
      me: mock(async () => ({
        user: { id: "user_alice" },
        organization: { id: "org_123" },
      })),
      unlinkActorBinding: unlink,
    };

    const { result } = await captureConsole(() =>
      runUnlink(
        { json: true },
        {
          client: client as never,
          readCredentials: () => makeCredentials(),
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    );

    expect(result).toMatchObject({
      success: true,
      unlinked: true,
      contactId: "luis",
      actorPrincipal: "contact:luis",
    });
    expect(unlink).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "luis", installationId: "ins_123", organizationId: "org_123" }),
      "access-secret",
    );
    expect(readCachedActorBinding("luis")).toBeNull();
  });
});

describe("ambient local identity", () => {
  it("requires a turn/session contact and refuses flag-style substitution", () => {
    try {
      resolveAmbientLocalIdentity({ ...process.env, RAVI_CONTEXT_KEY: "" });
      throw new Error("expected CONTACT_REQUIRED");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("CONTACT_REQUIRED");
      expect((error as CloudAuthError).message).toContain("Do not pass a contact flag");
    }
  });
});

function createContactContext(contactId: string, extras: Record<string, unknown> = {}) {
  return createRuntimeContext({
    kind: "turn-runtime",
    metadata: {
      actorPrincipal: `contact:${contactId}`,
      actor: {
        actorType: "contact",
        contactId,
        channel: "whatsapp",
        ...extras,
      },
    },
  });
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["artifacts:publish"],
    user: { id: "user_alice", email: "alice@example.com" },
    organization: { id: "org_123", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}
