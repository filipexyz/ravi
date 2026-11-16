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
    expect(accessActorFromTurn(otherAgent, noAgentName)).toMatchObject({
      kind: "refused",
      reason: { kind: "agent_relay" },
    });
    expect(decision.reason).toEqual({ kind: "unknown" });

    const ended: ConnectorTurnResult = { ok: false, error: blockedError, actorPrincipal: "unknown", ended: true };
    expect(accessActorFromTurn(ended, noAgentName)).toMatchObject({ kind: "refused", reason: { kind: "ended" } });
  });

  it("acts for the contact who owns the cron job this turn runs", () => {
    const routine: ConnectorTurnResult = {
      ok: false,
      error: blockedError,
      actorPrincipal: "automation:cron:job_1",
      routineOwner: { kind: "cron", id: "job_1", ownerPrincipal: "contact:c_ana" },
    };
    const decision = accessActorFromTurn(routine, noAgentName);
    expect(decision).toEqual({ kind: "contact", contactId: "c_ana", routine: { kind: "cron", id: "job_1" } });
    if (decision.kind === "refused") return;
    expect(accessActorBody(decision)).toEqual({ actor: { contactId: "c_ana" } });
  });

  it("refuses a run of a cron job no person owns, with the job and its owner", () => {
    const routine: ConnectorTurnResult = {
      ok: false,
      error: blockedError,
      actorPrincipal: "automation:cron:job_1",
      routineOwner: { kind: "cron", id: "job_1", ownerPrincipal: "unknown" },
    };
    const decision = accessActorFromTurn(routine, noAgentName);
    expect(decision).toMatchObject({
      kind: "refused",
      actorPrincipal: "automation:cron:job_1",
      reason: { kind: "routine_not_operator_owned", routine: "cron", jobId: "job_1", ownerPrincipal: "unknown" },
    });
    if (decision.kind !== "refused") return;
    expect(decision.message).toContain("cron job job_1");
    expect(decision.message).not.toContain("the person can ask");
    // Text output of access commands prints only the message, so it carries the next step.
    expect(decision.message).toContain("Next: do not retry from this run");
  });

  it("sends no actor for the operator", () => {
    expect(accessActorBody({ kind: "operator" })).toEqual({});
  });

  describe("a turn a trigger fired", () => {
    type TriggerOwner = NonNullable<Extract<ConnectorTurnResult, { ok: false }>["triggerOwner"]>;
    const triggerTurn = (triggerOwner?: TriggerOwner): ConnectorTurnResult => ({
      ok: false,
      error: blockedError,
      actorPrincipal: "automation:trigger:trg_1",
      ...(triggerOwner ? { triggerOwner } : {}),
    });
    const owned = (
      ownerPrincipal: string,
      actsAsOperator: boolean,
      answersToOwner = true,
      ownSession = true,
    ): TriggerOwner => ({
      id: "trg_1",
      ownerPrincipal,
      actsAsOperator,
      ownSession,
      answersToOwner,
    });
    const bases = { ...noAgentName, triggerRoutines: true };

    it("is refused for every caller that does not ask for trigger owners, whoever owns it", () => {
      for (const owner of [owned("operator", true), owned("contact:c_ana", false)]) {
        expect(accessActorFromTurn(triggerTurn(owner), noAgentName)).toMatchObject({
          kind: "refused",
          actorPrincipal: "automation:trigger:trg_1",
          reason: { kind: "unknown" },
        });
      }
    });

    it("acts as the operator for Bases when the trigger's owner does", () => {
      expect(accessActorFromTurn(triggerTurn(owned("operator", true)), bases)).toEqual({ kind: "operator" });
    });

    it("acts for the contact who owns the trigger, as a routine", () => {
      const decision = accessActorFromTurn(triggerTurn(owned("contact:c_ana", false)), bases);
      expect(decision).toEqual({ kind: "contact", contactId: "c_ana", routine: { kind: "trigger", id: "trg_1" } });
      if (decision.kind === "refused") return;
      expect(accessActorBody(decision)).toEqual({ actor: { contactId: "c_ana" } });
    });

    it("refuses a trigger no person owns, with the trigger and its owner", () => {
      for (const ownerPrincipal of ["unknown", "agent:helper", "automation:cron:job_1"]) {
        const decision = accessActorFromTurn(triggerTurn(owned(ownerPrincipal, false)), bases);
        expect(decision).toMatchObject({
          kind: "refused",
          actorPrincipal: "automation:trigger:trg_1",
          reason: { kind: "routine_not_operator_owned", routine: "trigger", jobId: "trg_1", ownerPrincipal },
        });
        if (decision.kind !== "refused") return;
        expect(decision.message).toContain("trigger trg_1");
        expect(decision.message).not.toContain("cron job");
      }
    });

    it("never promotes an owner the snapshot did not admit as the operator", () => {
      // `operator` in the name alone is not enough: the classifier decides.
      const decision = accessActorFromTurn(triggerTurn(owned("operator", false)), bases);
      expect(decision).toMatchObject({ kind: "refused", reason: { kind: "routine_not_operator_owned" } });
    });

    it("refuses an owned trigger whose answer does not stay with its owner", () => {
      for (const owner of [owned("operator", true, false), owned("contact:c_ana", false, false)]) {
        const decision = accessActorFromTurn(triggerTurn(owner), bases);
        expect(decision).toMatchObject({
          kind: "refused",
          actorPrincipal: "automation:trigger:trg_1",
          reason: { kind: "routine_answers_elsewhere", routine: "trigger", jobId: "trg_1" },
        });
        if (decision.kind !== "refused") return;
        expect(decision.message).toContain("its answer is posted into a chat");
        expect(decision.message).toContain("Next: do not retry from this turn");
      }
    });

    it("refuses an owned trigger in a session that is not the trigger's own", () => {
      for (const owner of [owned("operator", true, true, false), owned("contact:c_ana", false, true, false)]) {
        const decision = accessActorFromTurn(triggerTurn(owner), bases);
        expect(decision).toMatchObject({
          kind: "refused",
          actorPrincipal: "automation:trigger:trg_1",
          reason: { kind: "routine_shared_session", routine: "trigger", jobId: "trg_1" },
        });
        if (decision.kind !== "refused") return;
        expect(decision.message).toContain("trigger trg_1");
        expect(decision.message).toContain("Next: do not retry from this turn");
      }
    });

    it("says nobody owns it before the session, and the session before where it answers", () => {
      expect(accessActorFromTurn(triggerTurn(owned("unknown", false, false, false)), bases)).toMatchObject({
        kind: "refused",
        reason: { kind: "routine_not_operator_owned" },
      });
      expect(accessActorFromTurn(triggerTurn(owned("operator", true, false, false)), bases)).toMatchObject({
        kind: "refused",
        reason: { kind: "routine_shared_session" },
      });
    });

    it("is refused without an admitted owner even for Bases", () => {
      expect(accessActorFromTurn(triggerTurn(), bases)).toMatchObject({
        kind: "refused",
        reason: { kind: "unknown" },
      });
    });
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
    // A trigger's own session exists because its runner created it.
    if (sessionKey) getOrCreateSession(sessionKey, "main", stateDir ?? "/tmp", undefined, { triggerRunner: true });
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

  describe("a turn a trigger fired", () => {
    const NOWHERE = { turnReplyTarget: { kind: "none" } };
    /** The session the trigger's runner created for it. */
    const OWN_SESSION = "agent:main:trigger:trg_1:own";
    const triggerTurn = (
      authority?: Record<string, unknown>,
      metadata: Record<string, unknown> = NOWHERE,
      sessionKey = OWN_SESSION,
    ) =>
      turnContext(
        {
          actorPrincipal: "automation:trigger:trg_1",
          agentIdentityCompartment: "automation:trigger:trg_1",
          ...metadata,
          ...(authority ? { triggerRunAuthority: authority } : {}),
        },
        sessionKey,
      );
    const authority = (
      ownerPrincipal: string,
      ownerIsOperator: boolean,
      ownSessionKey: string | null = OWN_SESSION,
    ) => ({
      triggerId: "trg_1",
      ownerPrincipal,
      ownerIsOperator,
      ownSessionKey,
    });
    const resolveFor = (context: ContextRecord, deps: Record<string, unknown> = {}) =>
      resolveAccessActor({
        ...noAgentName,
        readCredentials: () => null,
        ...deps,
        turn: { ...OWNER, getContactStatus: () => "allowed", env: { RAVI_CONTEXT_KEY: context.contextKey } },
      });
    const bases = { triggerRoutines: true };

    it("stays refused for access calls, with or without an owner", () => {
      expect(resolveFor(triggerTurn(authority("operator", true))).kind).toBe("refused");
      expect(resolveFor(triggerTurn(authority("contact:c_ana", false))).kind).toBe("refused");
      expect(resolveFor(triggerTurn()).kind).toBe("refused");
    });

    it("acts as the trigger's owner for Bases in its own session when the answer goes nowhere", () => {
      expect(resolveFor(triggerTurn(authority("operator", true)), bases)).toEqual({ kind: "operator" });
      expect(resolveFor(triggerTurn(authority("contact:c_ana", false)), bases)).toEqual({
        kind: "contact",
        contactId: "c_ana",
        routine: { kind: "trigger", id: "trg_1" },
      });
    });

    it("refuses an owned trigger outside a session of its own", () => {
      const shared = {
        kind: "refused",
        reason: { kind: "routine_shared_session", routine: "trigger", jobId: "trg_1" },
      };
      const chatSession = "agent:main:whatsapp:wa-main:dm:5511888888888";
      for (const [owner, isOperator] of [
        ["operator", true],
        ["contact:c_ana", false],
      ] as const) {
        // The runner sent the fire to the agent's main session, or to a chat's.
        expect(
          resolveFor(triggerTurn(authority(owner, isOperator, null), NOWHERE, "agent:main:main"), bases),
        ).toMatchObject(shared);
        expect(resolveFor(triggerTurn(authority(owner, isOperator, null), NOWHERE, chatSession), bases)).toMatchObject(
          shared,
        );
        // The fire was sent to the trigger's own session, but the turn runs in another one.
        expect(resolveFor(triggerTurn(authority(owner, isOperator), NOWHERE, chatSession), bases)).toMatchObject(
          shared,
        );
        // A snapshot naming a session no trigger's runner created lends nothing there either.
        expect(
          resolveFor(triggerTurn(authority(owner, isOperator, chatSession), NOWHERE, chatSession), bases),
        ).toMatchObject(shared);
      }
    });

    it("refuses an owned trigger that answers into a chat that is not its owner's, or nowhere Ravi can tell", () => {
      const intoGroup = { turnReplyTarget: { kind: "chat", channel: "whatsapp", chatId: "120363000000000000@g.us" } };
      for (const snapshot of [authority("operator", true), authority("contact:c_ana", false)]) {
        expect(resolveFor(triggerTurn(snapshot, intoGroup), bases)).toMatchObject({
          kind: "refused",
          reason: { kind: "routine_answers_elsewhere", routine: "trigger", jobId: "trg_1" },
        });
        // No recorded reply target at all: unknown is not "nowhere".
        expect(resolveFor(triggerTurn(snapshot, {}), bases)).toMatchObject({
          kind: "refused",
          reason: { kind: "routine_answers_elsewhere" },
        });
      }
    });

    it("refuses a trigger with no owner, an agent owner, or a snapshot for another trigger", () => {
      expect(resolveFor(triggerTurn(authority("unknown", false)), bases)).toMatchObject({
        kind: "refused",
        reason: { kind: "routine_not_operator_owned", routine: "trigger", jobId: "trg_1", ownerPrincipal: "unknown" },
      });
      expect(resolveFor(triggerTurn(authority("agent:helper", false)), bases)).toMatchObject({
        kind: "refused",
        reason: { kind: "routine_not_operator_owned", ownerPrincipal: "agent:helper" },
      });
      expect(resolveFor(triggerTurn(), bases)).toMatchObject({ kind: "refused", reason: { kind: "unknown" } });
      expect(
        resolveFor(
          triggerTurn({
            triggerId: "trg_other",
            ownerPrincipal: "operator",
            ownerIsOperator: true,
            ownSessionKey: OWN_SESSION,
          }),
          bases,
        ),
      ).toMatchObject({ kind: "refused", reason: { kind: "unknown" } });
      // A snapshot that does not say which session the fire was sent to is not one.
      expect(
        resolveFor(triggerTurn({ triggerId: "trg_1", ownerPrincipal: "operator", ownerIsOperator: true }), bases),
      ).toMatchObject({ kind: "refused", reason: { kind: "unknown" } });
    });

    it("refuses a trigger whose contact owner was removed or blocked", () => {
      const context = triggerTurn(authority("contact:c_ana", false));
      for (const status of ["blocked", null]) {
        expect(
          resolveAccessActor({
            ...noAgentName,
            ...bases,
            readCredentials: () => null,
            turn: { ...OWNER, getContactStatus: () => status, env: { RAVI_CONTEXT_KEY: context.contextKey } },
          }),
        ).toMatchObject({ kind: "refused", reason: { kind: "unknown" } });
      }
    });

    it("does not take the operator's word from the snapshot when the owner is a contact who is not the operator", () => {
      // A forged or stale `ownerIsOperator` on a contact owner still resolves to that contact.
      const context = triggerTurn(authority("contact:c_ana", true));
      expect(resolveFor(context, bases)).toEqual({
        kind: "contact",
        contactId: "c_ana",
        routine: { kind: "trigger", id: "trg_1" },
      });
    });
  });
});
