import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CloudAuthError } from "../cloud-auth/errors.js";
import type { ConnectorTurnResult } from "../link/connector-turn.js";
import type { ContextRecord } from "../router/router-db.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { getOrCreateSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { accessActorBody, accessActorFromTurn, resolveAccessActor } from "./actor.js";

const OWNER = { activeUserId: "user_luis", activeOrgId: "org_1", ownerName: "Luis" };
const blockedError = new CloudAuthError("CONNECTOR_SPEAKER_NOT_OWNER", "blocked", { exitCode: 3 });
const noAgentName = { getAgentName: () => null };

describe("accessActorFromTurn", () => {
  it("lets the operator act on the terminal, the owner's own chat and owner routines", () => {
    const terminal: ConnectorTurnResult = {
      ok: true,
      turn: { speaker: { kind: "terminal" }, conversation: "terminal", actorPrincipal: "terminal" },
    };
    expect(accessActorFromTurn(terminal, noAgentName)).toEqual({ kind: "operator" });

    const ownerDm: ConnectorTurnResult = {
      ok: true,
      turn: {
        speaker: { kind: "owner", contactId: "c_luis" },
        conversation: "dm",
        actorPrincipal: "contact:c_luis",
        agentId: "main",
      },
    };
    expect(accessActorFromTurn(ownerDm, { getAgentName: () => "Main" })).toEqual({
      kind: "operator",
      agent: { id: "main", name: "Main" },
    });

    const routine: ConnectorTurnResult = {
      ok: true,
      turn: {
        speaker: { kind: "automation" },
        conversation: "automation",
        routine: { kind: "cron", id: "job_1" },
        actorPrincipal: "automation:cron:job_1",
        agentId: "main",
      },
    };
    expect(accessActorFromTurn(routine, noAgentName)).toEqual({ kind: "operator", agent: { id: "main" } });
  });

  it("keeps the owner as the operator when only where they asked is refused", () => {
    const group: ConnectorTurnResult = {
      ok: false,
      error: blockedError,
      actorPrincipal: "contact:c_luis",
      speakerIsOwner: true,
    };
    expect(accessActorFromTurn(group, noAgentName)).toEqual({ kind: "operator" });

    const relay: ConnectorTurnResult = {
      ok: false,
      error: blockedError,
      actorPrincipal: "automation:operator:local",
      speakerIsOwner: true,
      relay: { speaker: { kind: "owner" }, conversation: "group", actorPrincipal: "automation:operator:local" },
    };
    expect(accessActorFromTurn(relay, noAgentName)).toEqual({ kind: "operator" });
  });

  it("acts for a resolved contact, in a direct chat or a group", () => {
    const contact: ConnectorTurnResult = {
      ok: false,
      error: blockedError,
      actorPrincipal: "contact:c_ana",
      candidate: {
        speaker: { kind: "contact", contactId: "c_ana" },
        conversation: "group",
        actorPrincipal: "contact:c_ana",
        agentId: "main",
      },
    };
    const decision = accessActorFromTurn(contact, { getAgentName: () => "Main" });
    expect(decision).toEqual({ kind: "contact", contactId: "c_ana", agent: { id: "main", name: "Main" } });
    if (decision.kind === "refused") throw new Error("expected an actor");
    expect(accessActorBody(decision)).toEqual({ actor: { contactId: "c_ana" } });
  });

  it("refuses a turn it cannot attribute, and never sends an actor for it", () => {
    const unknown: ConnectorTurnResult = { ok: false, error: blockedError, actorPrincipal: "unknown" };
    const decision = accessActorFromTurn(unknown, noAgentName);
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") return;
    expect(decision.message).toContain("could not tell who is asking");

    const otherAgent: ConnectorTurnResult = { ok: false, error: blockedError, actorPrincipal: "agent:helper" };
    expect(accessActorFromTurn(otherAgent, noAgentName).kind).toBe("refused");
  });

  it("sends no actor for the operator", () => {
    expect(accessActorBody({ kind: "operator" })).toEqual({});
  });
});

describe("resolveAccessActor with real turn contexts", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-access-actor-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function turnContext(metadata: Record<string, unknown>, sessionKey?: string): ContextRecord {
    if (sessionKey) getOrCreateSession(sessionKey, "main", stateDir ?? "/tmp");
    return createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      ...(sessionKey ? { sessionKey } : {}),
      sessionName: "main-session",
      metadata: { actorResolution: "resolved", executorAgentId: "main", ...metadata },
    });
  }

  function resolve(context: ContextRecord | null) {
    return resolveAccessActor({
      ...noAgentName,
      turn: { ...OWNER, ...(context ? { env: { RAVI_CONTEXT_KEY: context.contextKey } } : { env: {} }) },
    });
  }

  it("treats a call outside any runtime as the operator", () => {
    expect(resolve(null)).toEqual({ kind: "operator" });
  });

  it("acts for another person writing in their direct chat", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_ana",
      consoleUserId: "user_ana",
      consoleOrgId: "org_1",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    });
    expect(resolve(context)).toEqual({ kind: "contact", contactId: "c_ana", agent: { id: "main" } });
  });

  it("acts for an unlinked contact too, so Console can answer ACTOR_NOT_LINKED", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_new",
      agentIdentityCompartment: "chat:120363000000000000@g.us",
    });
    expect(resolve(context)).toEqual({ kind: "contact", contactId: "c_new", agent: { id: "main" } });
  });

  it("keeps the owner in their own chat as the operator", () => {
    const context = turnContext(
      {
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        consoleOrgId: "org_1",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      },
      "agent:main:whatsapp:wa-main:dm:5511999999999",
    );
    expect(resolve(context)).toMatchObject({ kind: "operator" });
  });

  it("refuses an unresolved sender and an unresolvable context", () => {
    const unresolved = turnContext({
      actorPrincipal: "contact:c_x",
      actorResolution: "missing_contact",
      agentIdentityCompartment: "dm:5511777777777@s.whatsapp.net",
    });
    expect(resolve(unresolved).kind).toBe("refused");
    expect(
      resolveAccessActor({ turn: { ...OWNER, env: {}, runtimeContext: { present: true, record: null } } }).kind,
    ).toBe("refused");
  });

  it("refuses a request relayed by another agent", () => {
    const context = turnContext({ actorPrincipal: "agent:helper" });
    expect(resolve(context).kind).toBe("refused");
  });
});
