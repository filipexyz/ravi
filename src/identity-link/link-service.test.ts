import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readCachedActorBinding, writeCachedActorBinding } from "../cloud-auth/actor-bindings.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { resolveLinkRequester } from "../cloud-auth/link-identity.js";
import { dbGetContext } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  APPROVE_URL,
  bindingPayload,
  createFakeConsole,
  createFakeMessenger,
  createMemoryCredentials,
  linkDeps,
  requestPayload,
  slackTurnContext,
} from "./fake-console.fixture.js";
import { getLocalLinkRequest, listPendingLocalLinkRequestsForContact } from "./link-requests-db.js";
import { requestIdentityLink, unlinkIdentity } from "./link-service.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-identity-link-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function captureError(fn: () => unknown): CloudAuthError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CloudAuthError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

async function captureAsyncError(promise: Promise<unknown>): Promise<CloudAuthError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CloudAuthError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

describe("resolveLinkRequester", () => {
  it("requires a chat turn", () => {
    const error = captureError(() => resolveLinkRequester(null));
    expect(error.code).toBe("CONTACT_REQUIRED");
    expect(error.details).toEqual({ reason: "no_context" });
  });

  it("refuses turns started by an agent or an automation", () => {
    for (const actorPrincipal of ["agent:main", "automation:cron"]) {
      const context = slackTurnContext({ actorPrincipal, actorResolution: "not_applicable" });
      const error = captureError(() => resolveLinkRequester(context));
      expect(error.code).toBe("CONTACT_REQUIRED");
      expect(error.details).toEqual({ reason: "actor_not_human" });
    }
  });

  it("refuses an author that is not a resolved contact", () => {
    const cases = [
      slackTurnContext({ actorPrincipal: "unknown", actorResolution: "missing_contact" }),
      slackTurnContext({ actorResolution: "missing_contact" }),
      // Metadata that names a contact the actor does not match is not trusted.
      slackTurnContext({ actor: { actorType: "contact", contactId: "contact_someone_else", rawSenderId: "U0LUIS" } }),
      createRuntimeContext({ kind: "turn-runtime", metadata: { contactId: "contact_luis" } }),
    ];
    for (const context of cases) {
      const error = captureError(() => resolveLinkRequester(context));
      expect(error.code).toBe("CONTACT_REQUIRED");
      expect(error.details).toEqual({ reason: "missing_contact" });
    }
  });

  it("returns the author of the message and where they asked", () => {
    const requester = resolveLinkRequester(slackTurnContext());
    expect(requester).toMatchObject({
      contactId: "contact_luis",
      actorPrincipal: "contact:contact_luis",
      platformUserId: "U0LUIS",
      displayName: "Luís Filipe",
      origin: {
        channel: "slack",
        accountId: "acme",
        chatId: "C0CHANNEL",
        threadId: "1712345678.000100",
        sourceMessageId: "1712345690.000200",
      },
      platformIdentity: {
        channel: "slack",
        accountId: "acme",
        platformUserId: "U0LUIS",
        platformIdentityId: "pi_luis",
      },
    });
  });
});

describe("requestIdentityLink", () => {
  it("sends the approval link only to the author, privately, and keeps it out of the result", async () => {
    const fake = createFakeConsole();
    fake.on((call) =>
      call.method === "POST" && call.path === "/api/cli/link/requests"
        ? {
            status: 201,
            body: { version: 1, status: "pending", request: requestPayload("pending"), approveUrl: APPROVE_URL },
          }
        : undefined,
    );
    const credentials = createMemoryCredentials();
    const { messenger, sent } = createFakeMessenger({ email: "luis@example.com", dmChatId: "D0LUIS" });

    const result = await requestIdentityLink(slackTurnContext(), linkDeps(fake, credentials, messenger));

    expect(result).toEqual({ success: true, status: "dm_sent", linked: false, expiresAt: "2026-10-09T12:10:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("ravi_lr_secret_token");
    expect(fake.calls.find((call) => call.path === "/api/cli/link/requests")?.body).toEqual({
      contactId: "contact_luis",
      platformIdentities: {
        channel: "slack",
        accountId: "acme",
        platformUserId: "U0LUIS",
        platformIdentityId: "pi_luis",
      },
      requester: { displayName: "Luís Filipe" },
      expectedEmail: "luis@example.com",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({ channel: "slack", accountId: "acme", chatId: "U0LUIS" });
    expect(sent[0]?.privateLink).toBe(true);
    expect(sent[0]?.text).toContain(`[Abrir e aprovar o vínculo](${APPROVE_URL})`);
    expect(sent[0]?.text).toContain("vale por 10 minutos e funciona uma vez");

    const local = getLocalLinkRequest("lr_1");
    expect(local).toMatchObject({
      status: "pending",
      contactId: "contact_luis",
      installationId: "ins_console",
      dm: { channel: "slack", accountId: "acme", chatId: "D0LUIS" },
      origin: { chatId: "C0CHANNEL", threadId: "1712345678.000100" },
    });
    expect(JSON.stringify(local)).not.toContain("ravi_lr_secret_token");
  });

  it("reports an existing link without sending anything or creating a request", async () => {
    const fake = createFakeConsole();
    fake.on((call) =>
      call.method === "POST" && call.path === "/api/cli/link/requests"
        ? { body: { version: 1, status: "already_linked", binding: bindingPayload() } }
        : undefined,
    );
    const { messenger, sent } = createFakeMessenger();
    const context = slackTurnContext();

    const result = await requestIdentityLink(context, linkDeps(fake, createMemoryCredentials(), messenger));

    expect(result).toEqual({ success: true, status: "already_linked", linked: true });
    expect(sent).toHaveLength(0);
    expect(listPendingLocalLinkRequestsForContact("contact_luis")).toHaveLength(0);
    expect(readCachedActorBinding("contact_luis")?.consoleUserId).toBe("user_luis");
    expect(dbGetContext(context.contextId)?.metadata).toMatchObject({
      consoleUserId: "user_luis",
      consoleOrgId: "org_acme",
    });
  });

  it("cancels the Console request and fails clearly when the private message cannot be sent", async () => {
    const fake = createFakeConsole();
    fake.on((call) => {
      if (call.method === "POST" && call.path === "/api/cli/link/requests") {
        return {
          status: 201,
          body: { version: 1, status: "pending", request: requestPayload("pending"), approveUrl: APPROVE_URL },
        };
      }
      if (call.method === "DELETE" && call.path === "/api/cli/link/requests/lr_1") {
        return { body: { version: 1, request: requestPayload("cancelled"), binding: null } };
      }
      return undefined;
    });
    const { messenger } = createFakeMessenger({ fail: true });

    const error = await captureAsyncError(
      requestIdentityLink(slackTurnContext(), linkDeps(fake, createMemoryCredentials(), messenger)),
    );

    expect(error.code).toBe("LINK_DM_FAILED");
    expect(error.message).not.toContain("ravi_lr_secret_token");
    expect(error.message).not.toContain("U0LUIS");
    expect(fake.linkCalls()).toEqual(["POST /api/cli/link/requests", "DELETE /api/cli/link/requests/lr_1"]);
    expect(getLocalLinkRequest("lr_1")).toBeNull();
  });

  it("replaces the previous pending request when asked again", async () => {
    const fake = createFakeConsole();
    let next = 1;
    fake.on((call) =>
      call.method === "POST" && call.path === "/api/cli/link/requests"
        ? {
            status: 201,
            body: {
              version: 1,
              status: "pending",
              request: requestPayload("pending", { id: `lr_${next++}` }),
              approveUrl: APPROVE_URL,
            },
          }
        : undefined,
    );
    const { messenger, sent } = createFakeMessenger({ dmChatId: "D0LUIS" });
    const deps = linkDeps(fake, createMemoryCredentials(), messenger);

    await requestIdentityLink(slackTurnContext(), deps);
    await requestIdentityLink(slackTurnContext(), deps);

    expect(sent).toHaveLength(2);
    expect(getLocalLinkRequest("lr_1")?.status).toBe("cancelled");
    expect(listPendingLocalLinkRequestsForContact("contact_luis").map((request) => request.id)).toEqual(["lr_2"]);
  });

  it("does nothing for an author that is not a resolved contact", async () => {
    const fake = createFakeConsole();
    const { messenger, sent } = createFakeMessenger();
    const error = await captureAsyncError(
      requestIdentityLink(
        slackTurnContext({ actorPrincipal: "unknown", actorResolution: "missing_contact" }),
        linkDeps(fake, createMemoryCredentials(), messenger),
      ),
    );
    expect(error.code).toBe("CONTACT_REQUIRED");
    expect(fake.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("refuses channels it cannot reach privately before calling the Console", async () => {
    const fake = createFakeConsole();
    const { messenger } = createFakeMessenger();
    const error = await captureAsyncError(
      requestIdentityLink(
        slackTurnContext(),
        linkDeps(fake, createMemoryCredentials(), messenger, {
          resolveAccount: (accountId) => ({ kind: "omni", accountId: accountId ?? "", instanceId: "omni-1" }),
        }),
      ),
    );
    expect(error.code).toBe("LINK_DM_UNSUPPORTED");
    expect(fake.calls).toHaveLength(0);
  });

  it("asks for ravi login when the daemon host has no Console session", async () => {
    const fake = createFakeConsole();
    const credentials = createMemoryCredentials();
    credentials.deleteCredentials();
    const { messenger } = createFakeMessenger();
    const error = await captureAsyncError(
      requestIdentityLink(slackTurnContext(), linkDeps(fake, credentials, messenger)),
    );
    expect(error.code).toBe("AUTH_REQUIRED");
  });

  it("adopts the Console's installation id for a session stored with a local one", async () => {
    const fake = createFakeConsole();
    fake.on((call) =>
      call.method === "POST" && call.path === "/api/cli/link/requests"
        ? { body: { version: 1, status: "already_linked", binding: bindingPayload() } }
        : undefined,
    );
    const credentials = createMemoryCredentials("ins_local_random");
    const { messenger } = createFakeMessenger();

    await requestIdentityLink(slackTurnContext(), linkDeps(fake, credentials, messenger));

    expect(credentials.current?.installationId).toBe("ins_console");
  });
});

describe("unlinkIdentity", () => {
  it("cancels pending requests, removes the Console link and clears the cache", async () => {
    const fake = createFakeConsole();
    fake.on((call) => {
      if (call.method === "POST" && call.path === "/api/cli/link/requests") {
        return {
          status: 201,
          body: { version: 1, status: "pending", request: requestPayload("pending"), approveUrl: APPROVE_URL },
        };
      }
      if (call.method === "DELETE" && call.path === "/api/cli/link/requests/lr_1") {
        return { body: { version: 1, request: requestPayload("cancelled"), binding: null } };
      }
      if (call.method === "POST" && call.path === "/api/cli/link/unlink") {
        return { body: { binding: bindingPayload() } };
      }
      return undefined;
    });
    const { messenger } = createFakeMessenger({ dmChatId: "D0LUIS" });
    const deps = linkDeps(fake, createMemoryCredentials(), messenger);
    await requestIdentityLink(slackTurnContext(), deps);
    writeCachedActorBinding({ ...bindingPayload(), platformIdentity: null });

    const result = await unlinkIdentity(slackTurnContext(), deps);

    expect(result).toEqual({ success: true, status: "unlinked", linked: false });
    expect(fake.calls.find((call) => call.path === "/api/cli/link/unlink")?.body).toEqual({
      contactId: "contact_luis",
    });
    expect(fake.linkCalls()).toContain("DELETE /api/cli/link/requests/lr_1");
    expect(getLocalLinkRequest("lr_1")?.status).toBe("cancelled");
    expect(readCachedActorBinding("contact_luis")).toBeNull();
  });

  it("reports not_linked when there was nothing to remove", async () => {
    const fake = createFakeConsole();
    fake.on((call) =>
      call.method === "POST" && call.path === "/api/cli/link/unlink" ? { body: { binding: null } } : undefined,
    );
    const { messenger } = createFakeMessenger();
    const result = await unlinkIdentity(slackTurnContext(), linkDeps(fake, createMemoryCredentials(), messenger));
    expect(result).toEqual({ success: true, status: "not_linked", linked: false });
  });
});
