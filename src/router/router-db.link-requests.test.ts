import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  completeLocalLinkRequest,
  getLocalLinkRequest,
  insertLocalLinkRequest,
  listPendingLocalLinkRequests,
  pruneLocalLinkRequests,
} from "../identity-link/link-requests-db.js";
import {
  clearContactLinkState,
  enterAwaitingDm,
  getContactLinkState,
  LINK_STATE_TTL_MS,
  markLinkSent,
  reopenAwaitingDm,
} from "../identity-link/link-states-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-link-requests-db-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function insert(id: string, now: number) {
  return insertLocalLinkRequest({
    id,
    consoleUrl: "https://console.example",
    installationId: "ins_console",
    contactId: "contact_luis",
    displayName: null,
    origin: null,
    dm: { channel: "slack", accountId: "acme", chatId: "D0LUIS" },
    expiresAt: now + 600_000,
    now,
  });
}

describe("cloud_link_requests", () => {
  it("lets exactly one caller move a pending request to a terminal status", () => {
    insert("lr_1", 1_000);

    expect(completeLocalLinkRequest("lr_1", "approved", 2_000)).toBe(true);
    // A second daemon sharing the database sees the row already claimed.
    expect(completeLocalLinkRequest("lr_1", "approved", 2_001)).toBe(false);
    expect(completeLocalLinkRequest("lr_1", "cancelled", 2_002)).toBe(false);

    expect(getLocalLinkRequest("lr_1")).toMatchObject({ status: "approved", completedAt: 2_000, origin: null });
    expect(listPendingLocalLinkRequests()).toEqual([]);
  });

  it("does not overwrite a request recorded twice and prunes only old finished rows", () => {
    insert("lr_old", 1_000);
    insert("lr_old", 5_000);
    insert("lr_live", 1_000);
    completeLocalLinkRequest("lr_old", "expired", 2_000);

    expect(getLocalLinkRequest("lr_old")?.createdAt).toBe(1_000);
    expect(pruneLocalLinkRequests(3_000)).toBe(1);
    expect(getLocalLinkRequest("lr_old")).toBeNull();
    expect(getLocalLinkRequest("lr_live")?.status).toBe("pending");
  });
});

describe("contact_link_states", () => {
  const enter = (now: number) =>
    enterAwaitingDm({
      contactId: "contact_luis",
      channel: "whatsapp",
      accountId: "wa-main",
      agentId: "vendas",
      displayName: "Luís",
      origin: { channel: "whatsapp", accountId: "wa-main", chatId: "120363000000000000@g.us" },
      now,
    });

  it("keeps a sent link that is still valid when the person is refused again", () => {
    enter(1_000);
    markLinkSent({
      contactId: "contact_luis",
      requestId: "lr_1",
      requestExpiresAt: 601_000,
      dmChatId: "5511999999999@s.whatsapp.net",
      routePattern: "5511999999999",
      now: 2_000,
    });

    expect(enter(3_000)).toMatchObject({ status: "link_sent", requestId: "lr_1", routePattern: "5511999999999" });
    // Once that link expired, a new refusal puts the person back to awaiting their private message.
    expect(enter(700_000).status).toBe("awaiting_dm");
  });

  it("reopens only the request it was given, and drops expired or cleared states", () => {
    enter(1_000);
    markLinkSent({
      contactId: "contact_luis",
      requestId: "lr_1",
      requestExpiresAt: 601_000,
      dmChatId: "dm",
      routePattern: null,
      now: 2_000,
    });

    expect(reopenAwaitingDm("contact_luis", "lr_other", 3_000)).toBe(false);
    expect(reopenAwaitingDm("contact_luis", "lr_1", 3_000)).toBe(true);
    expect(getContactLinkState("contact_luis", 3_000)).toMatchObject({ status: "awaiting_dm", requestId: null });

    expect(getContactLinkState("contact_luis", 1_000 + LINK_STATE_TTL_MS)).toBeNull();
    enter(4_000);
    expect(clearContactLinkState("contact_luis")).toBe(true);
    expect(getContactLinkState("contact_luis", 4_000)).toBeNull();
  });
});
