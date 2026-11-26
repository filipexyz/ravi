import { describe, expect, it } from "bun:test";
import { evaluateOwnerDmGuard, isSharedOwnerSessionKey } from "./owner-dm-guard.js";

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
