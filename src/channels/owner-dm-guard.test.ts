import { describe, expect, it } from "bun:test";
import {
  evaluateOwnerDmGuard,
  isOperatorChosenDestination,
  isPeerNamingRoutePattern,
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
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: OWNER, explicit: false },
        owners,
      ),
    ).toEqual({ blocked: false, reason: "owner" });
  });

  it("holds a colleague who would land in the shared session", () => {
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: PEER, explicit: false },
        owners,
      ),
    ).toEqual({ blocked: true, reason: "non_owner_dm_to_owner_session", ownerCount: 1 });
  });

  it("holds an unresolved sender: an unknown contact is never the owner", () => {
    for (const senderContactId of [null, undefined, "", "  "]) {
      expect(
        evaluateOwnerDmGuard(
          { peerKind: "dm", sessionKey: "agent:main:main", senderContactId, explicit: false },
          owners,
        ).blocked,
      ).toBe(true);
    }
  });

  it("respects a destination the operator chose for that conversation", () => {
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: PEER, explicit: true },
        owners,
      ),
    ).toEqual({ blocked: false, reason: "explicit" });
  });

  it("does not touch per-peer sessions, groups or channels", () => {
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:dm:U9", senderContactId: PEER, explicit: false },
        owners,
      ),
    ).toEqual({ blocked: false, reason: "not_owner_session" });
    for (const peerKind of ["group", "channel"]) {
      expect(
        evaluateOwnerDmGuard(
          { peerKind, sessionKey: "agent:main:main", senderContactId: PEER, explicit: false },
          owners,
        ),
      ).toEqual({ blocked: false, reason: "not_dm" });
    }
  });

  it("keeps the legacy behaviour while no owner is tagged", () => {
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: PEER, explicit: false },
        { ownerContactIds: () => [] },
      ),
    ).toEqual({ blocked: false, reason: "no_owner_configured" });
  });

  it("treats any tagged owner as the owner when several are tagged", () => {
    const team = { ownerContactIds: () => [OWNER, PEER] };
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: PEER, explicit: false },
        team,
      ).blocked,
    ).toBe(false);
  });

  it("fails closed when the owner set cannot be read", () => {
    expect(
      evaluateOwnerDmGuard(
        { peerKind: "dm", sessionKey: "agent:main:main", senderContactId: OWNER, explicit: false },
        {
          ownerContactIds: () => {
            throw new Error("db locked");
          },
        },
      ),
    ).toEqual({ blocked: true, reason: "non_owner_dm_to_owner_session", ownerCount: 0 });
  });
});

describe("owner DM guard: what counts as the operator's choice", () => {
  const SHARED = "agent:main:main";
  const BRIDGE = "agent:ponte:slack:ravi-slack:dm:U0PEER";

  it("counts only a literal route pattern as naming the peer; any glob is a wildcard", () => {
    for (const pattern of ["U0PEER001", "5511999999999", "thread:1763555555.000100"]) {
      expect(isPeerNamingRoutePattern(pattern)).toBe(true);
    }
    for (const pattern of ["*", "U0*", "*999", "*99*", "", "  ", null, undefined]) {
      expect(isPeerNamingRoutePattern(pattern)).toBe(false);
    }
  });

  it("lets a literal route vouch only for the session it sends the message to", () => {
    const literal = { routePattern: "U0PEER", attachExplicit: false, attachSessionKey: null };
    expect(isOperatorChosenDestination({ ...literal, routeSessionKey: SHARED, landingSessionKey: SHARED })).toBe(true);
    // Routing's earlier attach reroutes the DM to the shared session: the route chose the bridge.
    expect(isOperatorChosenDestination({ ...literal, routeSessionKey: BRIDGE, landingSessionKey: SHARED })).toBe(false);
    expect(
      isOperatorChosenDestination({
        ...literal,
        routePattern: "U0*",
        routeSessionKey: SHARED,
        landingSessionKey: SHARED,
      }),
    ).toBe(false);
  });

  it("lets an explicit attach vouch only for the attached session", () => {
    const attach = { routePattern: "*", routeSessionKey: SHARED, attachSessionKey: SHARED };
    expect(isOperatorChosenDestination({ ...attach, attachExplicit: true, landingSessionKey: SHARED })).toBe(true);
    expect(isOperatorChosenDestination({ ...attach, attachExplicit: false, landingSessionKey: SHARED })).toBe(false);
    expect(
      isOperatorChosenDestination({
        ...attach,
        attachExplicit: true,
        attachSessionKey: BRIDGE,
        landingSessionKey: SHARED,
      }),
    ).toBe(false);
  });
});
