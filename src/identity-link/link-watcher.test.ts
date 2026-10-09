import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readCachedActorBinding, writeCachedActorBinding } from "../cloud-auth/actor-bindings.js";
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
import { getLocalLinkRequest, insertLocalLinkRequest } from "./link-requests-db.js";
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

    expect(result).toEqual({ kept: 1, removed: 1 });
    expect(readCachedActorBinding("contact_luis")).not.toBeNull();
    expect(readCachedActorBinding("contact_ana")).toBeNull();
    // Bindings of another installation are not this session's to check.
    expect(readCachedActorBinding("contact_old")).not.toBeNull();
  });
});
