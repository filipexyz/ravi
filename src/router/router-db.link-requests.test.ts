import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  completeLocalLinkRequest,
  getLocalLinkRequest,
  insertLocalLinkRequest,
  listPendingLocalLinkRequests,
  pruneLocalLinkRequests,
} from "../identity-link/link-requests-db.js";
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
