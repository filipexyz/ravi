import { describe, expect, it } from "bun:test";
import type { ContextRecord } from "../router/router-db.js";
import { resolveConnectorTurn } from "../link/connector-turn.js";
import { turnActorContactId, unattributedTurnRefusal } from "../cloud-auth/turn-actor.js";
import { resolveAccessActor } from "./actor.js";

const NOW = 10_000;
function context(id: string, sessionKey: string, metadata: Record<string, unknown>): ContextRecord {
  return {
    contextId: id,
    contextKey: `test-only-${id}`,
    kind: "turn-runtime",
    agentId: "worker",
    sessionKey,
    sessionName: sessionKey,
    capabilities: [],
    createdAt: 1_000,
    expiresAt: 20_000,
    metadata,
  };
}

function fixture() {
  const human = context("human", "parent", {
    actorPrincipal: "contact:alice",
    actorResolution: "resolved",
    actor: { actorType: "contact", contactId: "alice" },
    consoleUserId: "operator",
    consoleOrgId: "org",
    agentIdentityCompartment: "chat:original",
  });
  const child = context("child", "daughter", {
    actorPrincipal: "agent:worker",
    actorResolution: "not_applicable",
    relayCallerContactId: "alice",
    agentIdentityCompartment: "chat:daughter",
    turnOrigin: {
      protocol: "ravi.runtime.turn-origin",
      schemaVersion: 1,
      producer: "session-relay",
      action: "execute",
      principal: { type: "agent", id: "worker" },
      session: { key: "parent" },
      callerContextId: human.contextId,
      delegation: { callerSessionKey: "parent", targetSessionKey: "daughter", admittedAt: 2_000 },
    },
  });
  child.createdAt = 3_000;
  const records = new Map([
    [human.contextId, human],
    [child.contextId, child],
  ]);
  const deps = {
    readCredentials: () => null,
    getAgentName: () => null,
    turn: {
      env: { RAVI_CONTEXT_KEY: child.contextKey },
      now: NOW,
      activeUserId: "operator",
      activeOrgId: "org",
      ownerName: "Operator",
      runtimeContext: { present: true, record: child },
      getContextById: (id: string) => records.get(id) ?? null,
      getContactStatus: () => "allowed" as string | null,
    },
  };
  return { human, child, records, deps, origin: child.metadata!.turnOrigin as any };
}

describe("verified delegation of Console actor", () => {
  it("uses the human link for both preflight and header, never operator fallback or connector authority", () => {
    const { deps } = fixture();
    expect(resolveAccessActor(deps)).toEqual({ kind: "contact", contactId: "alice", agent: { id: "worker" } });
    expect(unattributedTurnRefusal(deps.turn.env, deps)).toBeNull();
    expect(turnActorContactId(deps.turn.env, deps)).toBe("alice");
    expect(resolveConnectorTurn(deps.turn).ok).toBe(false);
  });

  it.each(["turn_context_completed", "turn_context_rotated", "stale_turn_context_reclaimed"])(
    "keeps admitted work attributable after %s and caller credential expiry",
    (reason) => {
      const { human, deps } = fixture();
      human.revokedAt = 4_000;
      human.expiresAt = 5_000;
      human.metadata!.revocationReason = reason;
      expect(resolveAccessActor(deps)).toEqual({ kind: "contact", contactId: "alice", agent: { id: "worker" } });
    },
  );

  it.each(["pending", "discovered"])(
    "preserves attribution for resolved %s group members without granting capabilities",
    (status) => {
      const { child, deps } = fixture();
      deps.turn.getContactStatus = () => status;
      expect(resolveAccessActor(deps)).toMatchObject({ kind: "contact", contactId: "alice" });
      expect(child.capabilities).toEqual([]);
      expect(resolveConnectorTurn(deps.turn).ok).toBe(false);
    },
  );

  it("follows admitted report and continuation edges, not the session's latest speaker", () => {
    const { human, child, records, deps, origin } = fixture();
    const intermediate = context("report", "parent", {
      actorPrincipal: "agent:worker",
      actorResolution: "not_applicable",
      turnOrigin: {
        ...origin,
        session: { key: "original" },
        callerContextId: "human",
        delegation: { callerSessionKey: "original", targetSessionKey: "parent", admittedAt: 1_500 },
      },
    });
    human.sessionKey = "original";
    intermediate.createdAt = 1_700;
    records.set(intermediate.contextId, intermediate);
    origin.callerContextId = intermediate.contextId;
    child.metadata!.relayCallerContactId = "mallory";
    expect(resolveAccessActor(deps)).toMatchObject({ kind: "contact", contactId: "alice" });
  });

  it("does not expire a valid delegation merely because work needed many continuations", () => {
    const { child, records, deps, origin } = fixture();
    let previous = child;
    for (let index = 0; index < 40; index++) {
      const next = context(`continuation-${index}`, `session-${index}`, {
        actorPrincipal: "agent:worker",
        actorResolution: "not_applicable",
        turnOrigin: {
          ...origin,
          session: { key: previous.sessionKey },
          callerContextId: previous.contextId,
          delegation: {
            callerSessionKey: previous.sessionKey,
            targetSessionKey: `session-${index}`,
            admittedAt: 3_001 + index * 2,
          },
        },
      });
      next.createdAt = 3_002 + index * 2;
      records.set(next.contextId, next);
      previous = next;
    }
    deps.turn.runtimeContext.record = previous;
    expect(resolveAccessActor(deps)).toMatchObject({ kind: "contact", contactId: "alice" });
  });

  it.each([
    "missing caller",
    "missing admission",
    "expired current",
    "revoked current",
    "expired at admission",
    "revoked before admission",
    "explicit revoke",
    "profile revoked",
    "withdrawn then completed",
    "wrong target",
    "wrong caller session",
    "wrong emitter",
    "future admission",
    "unresolved person",
    "unknown person",
    "blocked person",
    "missing person",
    "cycle",
    "unbound agent",
    "automation",
    "spoofed CLI child",
    "CLI agent change",
    "CLI session change",
  ])("refuses %s for preflight and header", (fault) => {
    const { human, child, records, deps, origin } = fixture();
    switch (fault) {
      case "missing caller":
        records.delete(human.contextId);
        break;
      case "missing admission":
        delete origin.delegation;
        break;
      case "expired current":
        child.expiresAt = NOW;
        break;
      case "revoked current":
        child.revokedAt = NOW - 1;
        break;
      case "expired at admission":
        human.expiresAt = 2_000;
        break;
      case "revoked before admission":
        human.revokedAt = 1_900;
        human.metadata!.revocationReason = "turn_context_rotated";
        break;
      case "explicit revoke":
        human.revokedAt = 4_000;
        human.metadata!.revocationReason = "session_context_reset";
        break;
      case "profile revoked":
        human.metadata!.permissionProfileRevokedAt = 4_000;
        break;
      case "withdrawn then completed":
        human.revokedAt = 5_000;
        human.metadata!.revocationReason = "turn_context_completed";
        human.metadata!.authorityRevokedAt = 4_000;
        break;
      case "wrong target":
        origin.delegation.targetSessionKey = "sister";
        break;
      case "wrong caller session":
        origin.delegation.callerSessionKey = "unrelated";
        break;
      case "wrong emitter":
        origin.principal.id = "another-agent";
        break;
      case "future admission":
        origin.delegation.admittedAt = NOW + 1;
        break;
      case "unresolved person":
        human.metadata!.actorResolution = "missing_contact";
        break;
      case "unknown person":
        human.metadata!.actorPrincipal = "unknown";
        break;
      case "blocked person":
        deps.turn.getContactStatus = () => "blocked";
        break;
      case "missing person":
        deps.turn.getContactStatus = () => null;
        break;
      case "cycle":
        origin.callerContextId = child.contextId;
        break;
      case "unbound agent":
        delete origin.callerContextId;
        break;
      case "automation":
        origin.principal = { type: "automation", id: "cron:job" };
        child.metadata!.actorPrincipal = "automation:cron:job";
        break;
      case "spoofed CLI child":
        child.kind = "cli-child";
        break;
      case "CLI agent change":
      case "CLI session change": {
        const issued = context("cli", "daughter", { parentContextId: child.contextId });
        issued.kind = "cli-child";
        if (fault === "CLI agent change") issued.agentId = "other-agent";
        else issued.sessionKey = "other-session";
        records.set(issued.contextId, issued);
        deps.turn.runtimeContext.record = issued;
        break;
      }
    }
    expect(resolveAccessActor(deps).kind).toBe("refused");
    expect(unattributedTurnRefusal(deps.turn.env, deps)).not.toBeNull();
    expect(turnActorContactId(deps.turn.env, deps)).toBeNull();
  });
});
