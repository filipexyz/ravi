import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  deleteCachedActorBinding,
  readCachedActorBinding,
  writeCachedActorBinding,
} from "../cloud-auth/actor-bindings.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  CONSOLE_URL,
  bindingPayload,
  createFakeConsole,
  createFakeMessenger,
  createMemoryCredentials,
  linkDeps,
  requestPayload,
} from "./fake-console.fixture.js";
import { completeLocalLinkRequest, getLocalLinkRequest, insertLocalLinkRequest } from "./link-requests-db.js";
import { processPendingLinkRequests, revalidateCachedBindings } from "./link-watcher.js";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-identity-watch-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function recordPending(overrides: Partial<Parameters<typeof insertLocalLinkRequest>[0]> = {}) {
  return insertLocalLinkRequest({
    id: "lr_1",
    consoleUrl: CONSOLE_URL,
    installationId: "ins_console",
    contactId: "contact_luis",
    displayName: "Luís Filipe",
    origin: {
      channel: "slack",
      accountId: "acme",
      chatId: "C0CHANNEL",
      sourceMessageId: "1712345690.000200",
    },
    dm: { channel: "slack", accountId: "acme", chatId: "D0LUIS" },
    expiresAt: NOW + 10 * 60_000,
    now: NOW,
    ...overrides,
  });
}

function answerPoll(fake: ReturnType<typeof createFakeConsole>, body: unknown, status = 200) {
  fake.on((call) =>
    call.method === "GET" && call.path === "/api/cli/link/requests/lr_1" ? { status, body } : undefined,
  );
}

describe("processPendingLinkRequests", () => {
  it("caches the approved binding and confirms in the private chat and the original thread, once", async () => {
    recordPending();
    const fake = createFakeConsole();
    answerPoll(fake, { version: 1, request: requestPayload("approved"), binding: bindingPayload() });
    const { messenger, sent } = createFakeMessenger();
    const deps = linkDeps(fake, createMemoryCredentials(), messenger);

    expect(await processPendingLinkRequests(deps)).toBe(0);
    await processPendingLinkRequests(deps);

    expect(getLocalLinkRequest("lr_1")?.status).toBe("approved");
    expect(readCachedActorBinding("contact_luis")?.consoleUserId).toBe("user_luis");
    expect(sent.map((message) => message.target)).toEqual([
      { channel: "slack", accountId: "acme", chatId: "D0LUIS" },
      // A top-level Slack message gets its answer in a thread under it.
      { channel: "slack", accountId: "acme", chatId: "C0CHANNEL", threadId: "1712345690.000200" },
    ]);
    expect(sent[0]?.text).toContain(`${CONSOLE_URL}/link`);
    expect(sent[1]?.text).toBe("Vínculo confirmado para Luís. ✓");
  });

  it("confirms once in the private chat when the request came from it", async () => {
    recordPending({ origin: { channel: "slack", accountId: "acme", chatId: "D0LUIS" } });
    const fake = createFakeConsole();
    answerPoll(fake, { version: 1, request: requestPayload("approved"), binding: bindingPayload() });
    const { messenger, sent } = createFakeMessenger();

    await processPendingLinkRequests(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target.chatId).toBe("D0LUIS");
  });

  it("tells the person privately when they deny or the link expires", async () => {
    for (const status of ["denied", "expired"] as const) {
      recordPending({ id: `lr_${status}` });
      const fake = createFakeConsole();
      fake.on((call) =>
        call.path === `/api/cli/link/requests/lr_${status}`
          ? { body: { version: 1, request: requestPayload(status, { id: `lr_${status}` }), binding: null } }
          : undefined,
      );
      const { messenger, sent } = createFakeMessenger();

      await processPendingLinkRequests(linkDeps(fake, createMemoryCredentials(), messenger));

      expect(getLocalLinkRequest(`lr_${status}`)?.status).toBe(status);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.target).toEqual({ channel: "slack", accountId: "acme", chatId: "D0LUIS" });
    }
    expect(readCachedActorBinding("contact_luis")).toBeNull();
  });

  it("closes an approved request whose link was already revoked without confirming it", async () => {
    recordPending();
    const fake = createFakeConsole();
    answerPoll(fake, { version: 1, request: requestPayload("approved"), binding: null });
    const { messenger, sent } = createFakeMessenger();

    expect(await processPendingLinkRequests(linkDeps(fake, createMemoryCredentials(), messenger))).toBe(0);

    expect(getLocalLinkRequest("lr_1")?.status).toBe("approved");
    expect(readCachedActorBinding("contact_luis")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("does not cache a binding for a request an unlink cancelled while the poll was in flight", async () => {
    recordPending();
    const fake = createFakeConsole();
    fake.on((call) => {
      if (call.method !== "GET" || call.path !== "/api/cli/link/requests/lr_1") return undefined;
      completeLocalLinkRequest("lr_1", "cancelled", NOW);
      return { body: { version: 1, request: requestPayload("approved"), binding: bindingPayload() } };
    });
    const { messenger, sent } = createFakeMessenger();

    await processPendingLinkRequests(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(getLocalLinkRequest("lr_1")?.status).toBe("cancelled");
    expect(readCachedActorBinding("contact_luis")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("keeps waiting while the request is pending", async () => {
    recordPending();
    const fake = createFakeConsole();
    answerPoll(fake, { version: 1, request: requestPayload("pending"), binding: null });
    const { messenger, sent } = createFakeMessenger();

    expect(await processPendingLinkRequests(linkDeps(fake, createMemoryCredentials(), messenger))).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("drops a request the Console no longer knows", async () => {
    recordPending();
    const fake = createFakeConsole();
    answerPoll(fake, { error: { code: "NOT_FOUND", message: "Link request not found." } }, 404);
    const { messenger, sent } = createFakeMessenger();

    await processPendingLinkRequests(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(getLocalLinkRequest("lr_1")?.status).toBe("failed");
    expect(sent).toHaveLength(0);
  });

  it("leaves requests of another Console session alone until long after they expire", async () => {
    recordPending({ id: "lr_other", installationId: "ins_previous" });
    recordPending({ id: "lr_stale", installationId: "ins_previous", expiresAt: NOW - 2 * 60 * 60_000 });
    const fake = createFakeConsole();
    const { messenger } = createFakeMessenger();

    await processPendingLinkRequests(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(fake.linkCalls()).toEqual([]);
    expect(getLocalLinkRequest("lr_other")?.status).toBe("pending");
    expect(getLocalLinkRequest("lr_stale")?.status).toBe("failed");
  });
});

describe("revalidateCachedBindings", () => {
  it("drops cached links the Console revoked and refreshes the live ones", async () => {
    writeCachedActorBinding({ ...bindingPayload(), platformIdentity: null });
    writeCachedActorBinding({
      ...bindingPayload({ id: "bind_2", contactId: "contact_ana", actorPrincipal: "contact:contact_ana" }),
      consoleUserId: "user_ana",
      platformIdentity: null,
    });
    writeCachedActorBinding({
      ...bindingPayload({ id: "bind_3", contactId: "contact_old", actorPrincipal: "contact:contact_old" }),
      installationId: "ins_previous",
      platformIdentity: null,
    });
    const fake = createFakeConsole();
    fake.on((call) => {
      if (call.path === "/api/cli/link?contactId=contact_luis")
        return { body: { version: 1, binding: bindingPayload() } };
      if (call.path === "/api/cli/link?contactId=contact_ana") return { body: { version: 1, binding: null } };
      return undefined;
    });
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(result).toEqual({ kept: 1, removed: 1, discovered: 0 });
    expect(readCachedActorBinding("contact_luis")).not.toBeNull();
    expect(readCachedActorBinding("contact_ana")).toBeNull();
    // Bindings of another installation are not this session's to check.
    expect(readCachedActorBinding("contact_old")).not.toBeNull();
  });

  it("does not bring back a binding an unlink removed while the check was in flight", async () => {
    writeCachedActorBinding({ ...bindingPayload(), platformIdentity: null });
    const fake = createFakeConsole();
    fake.on((call) => {
      if (call.path !== "/api/cli/link?contactId=contact_luis") return undefined;
      deleteCachedActorBinding("contact_luis");
      return { body: { version: 1, binding: bindingPayload() } };
    });
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(result).toEqual({ kept: 0, removed: 0, discovered: 0 });
    expect(readCachedActorBinding("contact_luis")).toBeNull();
  });

  it("keeps a binding that replaced the checked one while the check was in flight", async () => {
    writeCachedActorBinding({ ...bindingPayload(), platformIdentity: null });
    const fake = createFakeConsole();
    fake.on((call) => {
      if (call.path !== "/api/cli/link?contactId=contact_luis") return undefined;
      // Unlinked and linked again to the same person: a new binding id.
      writeCachedActorBinding({ ...bindingPayload({ id: "bind_new" }), platformIdentity: null });
      return { body: { version: 1, binding: null } };
    });
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(result).toEqual({ kept: 0, removed: 0, discovered: 0 });
    expect(readCachedActorBinding("contact_luis")?.id).toBe("bind_new");
  });
});

// The Console's answer to `GET /api/cli/link?consoleUserId=` (no contact): the
// plural list, each entry in the shape of ravi-console `publicBinding`
// (src/server/console/ravi-link.ts:278-279 and :358-373).
const OWNER_UUID = "8d576898-bfc1-49dc-b532-8f896e496728";
const INSTALLATION_UUID = "0b9f4c1e-2a57-4d8e-9c3b-6f1a2d7e8b90";
const ORG_UUID = "5e2d8a41-7c6b-4f03-a9e1-3b8c0d4f6a12";

function serverBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "1f6c2b9a-3d4e-4a5b-8c7d-9e0f1a2b3c4d",
    installationId: INSTALLATION_UUID,
    organizationId: ORG_UUID,
    consoleUserId: OWNER_UUID,
    contactId: "d8f3d5ad489d",
    platformIdentities: {},
    status: "active",
    linkedBy: OWNER_UUID,
    linkedAt: "2026-11-01T12:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-01T12:00:00.000Z",
    ...overrides,
  };
}

function ownerCredentials(overrides: Record<string, unknown> = {}) {
  const credentials = createMemoryCredentials(INSTALLATION_UUID);
  credentials.writeCredentials({
    ...credentials.current!,
    user: { id: OWNER_UUID },
    organization: { id: ORG_UUID },
    ...overrides,
  });
  return credentials;
}

/** Answers the owner list (plural) and the per-contact confirmation (singular). */
function answerOwnerLinks(
  fake: ReturnType<typeof createFakeConsole>,
  list: Record<string, unknown>[],
  byContact: (contactId: string) => Record<string, unknown> | null = (contactId) =>
    list.find((entry) => entry.contactId === contactId) ?? null,
) {
  fake.on((call) => {
    if (call.path === `/api/cli/link?consoleUserId=${OWNER_UUID}`) return { body: { version: 1, bindings: list } };
    const prefix = "/api/cli/link?contactId=";
    if (call.path.startsWith(prefix))
      return { body: { version: 1, binding: byContact(call.path.slice(prefix.length)) } };
    return undefined;
  });
}

describe("revalidateCachedBindings discovers the login owner's link", () => {
  it("caches a Console link of the login owner that never reached this installation", async () => {
    const fake = createFakeConsole();
    answerOwnerLinks(fake, [serverBinding()]);
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, ownerCredentials(), messenger));

    expect(result).toEqual({ kept: 0, removed: 0, discovered: 1 });
    expect(readCachedActorBinding("d8f3d5ad489d")?.consoleUserId).toBe(OWNER_UUID);
    expect(readCachedActorBinding("d8f3d5ad489d")?.installationId).toBe(INSTALLATION_UUID);
  });

  it("caches every contact of the owner on this installation and skips other entries", async () => {
    const fake = createFakeConsole();
    answerOwnerLinks(fake, [
      serverBinding(),
      serverBinding({ id: "2a7d3c0b-4e5f-4b6c-9d8e-0f1a2b3c4d5e", contactId: "wa_contact" }),
      serverBinding({
        id: "3b8e4d1c-5f60-4c7d-8e9f-1a2b3c4d5e6f",
        contactId: "elsewhere",
        installationId: "other-install",
      }),
      { version: 1, broken: true },
    ]);
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, ownerCredentials(), messenger));

    expect(result.discovered).toBe(2);
    expect(readCachedActorBinding("d8f3d5ad489d")).not.toBeNull();
    expect(readCachedActorBinding("wa_contact")).not.toBeNull();
    expect(readCachedActorBinding("elsewhere")).toBeNull();
  });

  it("does not look up the owner's contacts again when they are already cached", async () => {
    writeCachedActorBinding({ ...bindingPayload(), consoleUserId: "user_operator", platformIdentity: null });
    const fake = createFakeConsole();
    fake.on((call) => {
      if (call.path === "/api/cli/link?consoleUserId=user_operator")
        return { body: { version: 1, bindings: [{ ...bindingPayload(), consoleUserId: "user_operator" }] } };
      if (call.path === "/api/cli/link?contactId=contact_luis")
        return { body: { version: 1, binding: { ...bindingPayload(), consoleUserId: "user_operator" } } };
      return undefined;
    });
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(result).toEqual({ kept: 1, removed: 0, discovered: 0 });
    // One contact lookup: the revalidation's, not a second one for discovery.
    expect(fake.linkCalls().filter((call) => call.includes("contactId="))).toEqual([
      "GET /api/cli/link?contactId=contact_luis",
    ]);
  });

  it("caches nothing when the owner has no link on this installation", async () => {
    const none = createFakeConsole();
    answerOwnerLinks(none, []);
    const elsewhere = createFakeConsole();
    answerOwnerLinks(elsewhere, [serverBinding({ installationId: "other-install" })]);
    const { messenger } = createFakeMessenger();

    expect((await revalidateCachedBindings(linkDeps(none, ownerCredentials(), messenger))).discovered).toBe(0);
    expect((await revalidateCachedBindings(linkDeps(elsewhere, ownerCredentials(), messenger))).discovered).toBe(0);
    expect(readCachedActorBinding("d8f3d5ad489d")).toBeNull();
  });

  it("does not cache a link the Console stopped confirming for the contact (unlinked in flight)", async () => {
    const fake = createFakeConsole();
    answerOwnerLinks(fake, [serverBinding()], () => null);
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, ownerCredentials(), messenger));

    expect(result.discovered).toBe(0);
    expect(readCachedActorBinding("d8f3d5ad489d")).toBeNull();
  });

  it("replaces an entry cached for another installation with this installation's link", async () => {
    writeCachedActorBinding({
      ...bindingPayload({ id: "bind_old", contactId: "contact_owner", actorPrincipal: "contact:contact_owner" }),
      consoleUserId: "user_operator",
      installationId: "ins_previous",
      platformIdentity: null,
    });
    const fake = createFakeConsole();
    const owner = {
      ...bindingPayload({ id: "bind_owner", contactId: "contact_owner" }),
      consoleUserId: "user_operator",
    };
    fake.on((call) => {
      if (call.path === "/api/cli/link?consoleUserId=user_operator") return { body: { version: 1, bindings: [owner] } };
      if (call.path === "/api/cli/link?contactId=contact_owner") return { body: { version: 1, binding: owner } };
      return undefined;
    });
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, createMemoryCredentials(), messenger));

    expect(result.discovered).toBe(1);
    expect(readCachedActorBinding("contact_owner")?.installationId).toBe("ins_console");
  });
});

describe("owner discovery with nothing cached never touches the stored session", () => {
  it("skips an expired session without calling the Console", async () => {
    const fake = createFakeConsole();
    answerOwnerLinks(fake, [serverBinding()]);
    const credentials = ownerCredentials({ accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" });
    const before = credentials.current;
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, credentials, messenger));

    expect(result).toEqual({ kept: 0, removed: 0, discovered: 0 });
    expect(fake.calls).toEqual([]);
    expect(credentials.current).toBe(before);
  });

  it("neither refreshes nor deletes the session when the Console rejects the token", async () => {
    const fake = createFakeConsole();
    fake.on((call) =>
      call.path === `/api/cli/link?consoleUserId=${OWNER_UUID}`
        ? { status: 401, body: { error: { code: "AUTH_EXPIRED", message: "expired" } } }
        : undefined,
    );
    const credentials = ownerCredentials();
    const before = credentials.current;
    const { messenger } = createFakeMessenger();

    const result = await revalidateCachedBindings(linkDeps(fake, credentials, messenger));

    expect(result).toEqual({ kept: 0, removed: 0, discovered: 0 });
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /api/cli/link?consoleUserId=${OWNER_UUID}`,
    ]);
    expect(credentials.current).toBe(before);
  });
});
