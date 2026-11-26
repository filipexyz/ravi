import { describe, expect, it } from "bun:test";
import {
  evaluateOwnerDmGuard,
  isAgentSharedDmSessionKey,
  isDirectPeerRoutePattern,
  isSharedDmSessionPrivateToOwner,
  isSharedOwnerSessionKey,
} from "./owner-dm-guard.js";

const OWNER = "contact-owner";
const PEER = "contact-peer";
const owners = { ownerContactIds: () => [OWNER] };

describe("owner DM guard", () => {
  it("recognises only an agent's shared DM session as the owner's session", () => {
    expect(isSharedOwnerSessionKey("agent:main:main")).toBe(true);
    expect(isSharedOwnerSessionKey("agent:main:dm:5511999999999")).toBe(false);
    expect(isSharedOwnerSessionKey("agent:main:slack:ravi-slack:dm:U123")).toBe(false);
    expect(isSharedOwnerSessionKey("agent:main:slack:channel:C1:thread:1")).toBe(false);
  });

  it("lets the owner into the shared session", () => {
    expect(
      evaluateOwnerDmGuard({ peerKind: "dm", sessionKey: "agent:main:main", senderContactId: OWNER }, owners),
    ).toEqual({ blocked: false, reason: "owner" });
  });

  it("holds a colleague who would land in the shared session, or in a thread under it", () => {
    for (const sessionKey of ["agent:main:main", "agent:main:main:thread:1763555555.000100"]) {
      expect(evaluateOwnerDmGuard({ peerKind: "dm", sessionKey, senderContactId: PEER }, owners)).toEqual({
        blocked: true,
        reason: "non_owner_dm_to_owner_session",
        ownerCount: 1,
      });
    }
  });

  it("holds an unresolved sender: an unknown contact is never the owner", () => {
    for (const senderContactId of [null, undefined, "", "  "]) {
      expect(
        evaluateOwnerDmGuard({ peerKind: "dm", sessionKey: "agent:main:main", senderContactId }, owners).blocked,
      ).toBe(true);
    }
  });

  it("does not touch per-peer sessions, groups or channels", () => {
    expect(
      evaluateOwnerDmGuard({ peerKind: "dm", sessionKey: "agent:main:dm:U9", senderContactId: PEER }, owners),
    ).toEqual({ blocked: false, reason: "not_owner_session" });
    for (const peerKind of ["group", "channel"]) {
      expect(evaluateOwnerDmGuard({ peerKind, sessionKey: "agent:main:main", senderContactId: PEER }, owners)).toEqual({
        blocked: false,
        reason: "not_dm",
      });
    }
  });

  it("keeps the legacy behaviour while no owner is tagged", () => {
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: PEER },
        { ownerContactIds: () => [] },
      ),
    ).toEqual({ blocked: false, reason: "no_owner_configured" });
  });

  it("treats any tagged owner as the owner when several are tagged", () => {
    const team = { ownerContactIds: () => [OWNER, PEER] };
    expect(
      evaluateOwnerDmGuard({ peerKind: "dm", sessionKey: "agent:main:main", senderContactId: PEER }, team).blocked,
    ).toBe(false);
  });

  it("fails closed when the owner set cannot be read", () => {
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: OWNER },
        {
          ownerContactIds: () => {
            throw new Error("db locked");
          },
        },
      ),
    ).toEqual({ blocked: true, reason: "non_owner_dm_to_owner_session", ownerCount: 0 });
  });
});

describe("owner DM guard: the shared session as the owner's own direct session", () => {
  const SHARED = { sessionKey: "agent:main:main", sessionName: "main", contactId: OWNER, chatId: "chat_owner_dm" };
  const OWN_CHATS = new Set(["chat_owner_dm", "chat_owner_thread", "chat_owner_whatsapp"]);
  const deps = {
    ownerContactIds: () => [OWNER],
    routePatternsForSessionName: () => ["5511999999999", "U0OWNER"],
    attachedChatIds: () => ["chat_owner_dm", "chat_owner_thread", "chat_owner_whatsapp"],
    isContactsDirectChat: (chatId: string, contactId: string) => contactId === OWNER && OWN_CHATS.has(chatId),
  };

  it("matches only the exact shared key, never a thread under it or a per-peer key", () => {
    expect(isAgentSharedDmSessionKey("agent:main:main")).toBe(true);
    for (const key of [
      "agent:main:main:thread:1763555555.000100",
      "agent:main:dm:U9",
      "agent::main",
      "main",
      "",
      null,
      undefined,
    ]) {
      expect(isAgentSharedDmSessionKey(key)).toBe(false);
    }
  });

  it("counts a route as safe only when it reaches one direct peer", () => {
    for (const pattern of ["5511999999999", "U0OWNER", "178035101794451", "lid:178035101794451"]) {
      expect(isDirectPeerRoutePattern(pattern)).toBe(true);
    }
    for (const pattern of ["*", "5511*", "*999", "group:120363", "GROUP:C0CHAN", "thread:1763.1", "", " ", null]) {
      expect(isDirectPeerRoutePattern(pattern)).toBe(false);
    }
  });

  it("is the sole owner's when only their own chats are attached and only direct routes name it", () => {
    expect(isSharedDmSessionPrivateToOwner(SHARED, deps)).toBe(true);
  });

  it("is never private to someone who is not the owner", () => {
    expect(isSharedDmSessionPrivateToOwner({ ...SHARED, contactId: PEER }, deps)).toBe(false);
  });

  it("is nobody's while no owner, or more than one, is tagged, or the owners cannot be read", () => {
    for (const ownerContactIds of [
      () => [],
      () => [OWNER, PEER],
      () => {
        throw new Error("db locked");
      },
    ]) {
      expect(isSharedDmSessionPrivateToOwner(SHARED, { ...deps, ownerContactIds })).toBe(false);
    }
  });

  it("is not private while another person's chat is attached to it", () => {
    expect(
      isSharedDmSessionPrivateToOwner(SHARED, {
        ...deps,
        attachedChatIds: () => ["chat_owner_dm", "chat_colleague_dm"],
      }),
    ).toBe(false);
  });

  it("is not private while a route sends a group, a thread or a glob into it", () => {
    for (const pattern of ["group:120363", "thread:1763.1", "*", "U0*"]) {
      expect(
        isSharedDmSessionPrivateToOwner(SHARED, {
          ...deps,
          routePatternsForSessionName: () => ["5511999999999", pattern],
        }),
      ).toBe(false);
    }
  });

  it("trusts the turn's own chat without asking who owns it", () => {
    const isContactsDirectChat = (chatId: string) => chatId !== "chat_turn";
    expect(
      isSharedDmSessionPrivateToOwner(
        { ...SHARED, chatId: "chat_turn" },
        { ...deps, attachedChatIds: () => ["chat_turn", "chat_owner_dm"], isContactsDirectChat },
      ),
    ).toBe(true);
  });

  it("refuses any other session shape, an empty speaker or an unnamed session", () => {
    for (const input of [
      { ...SHARED, sessionKey: "agent:main:main:thread:1763555555.000100" },
      { ...SHARED, sessionKey: "agent:main:dm:U0OWNER" },
      { ...SHARED, contactId: " " },
      { ...SHARED, sessionName: "" },
    ]) {
      expect(isSharedDmSessionPrivateToOwner(input, deps)).toBe(false);
    }
  });
});
