import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runWithContext } from "../cli/context.js";
import { CRON_RUN_AUTHORITY_ENV } from "../cron/authority.js";
import { getOrCreateSession } from "../router/sessions.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { spawnedAutomationEnv } from "../runtime/turn-origin.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  inRuntimeTurn,
  isUnattributedTurn,
  resolveTurnActor,
  turnActorContactId,
  unattributedTurnRefusal,
} from "./turn-actor.js";

describe("turnActorContactId", () => {
  it("is null outside a runtime turn, without classifying anything", () => {
    expect(turnActorContactId({})).toBeNull();
    expect(turnActorContactId({ RAVI_CONTEXT_KEY: "  " })).toBeNull();
  });

  it("names the contact only when someone other than the operator wrote the turn", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    expect(turnActorContactId(env, { actor: { kind: "contact", contactId: "c_ana" } })).toBe("c_ana");
    expect(turnActorContactId(env, { actor: { kind: "operator" } })).toBeNull();
    expect(
      turnActorContactId(env, { actor: { kind: "refused", message: "unknown speaker", actorPrincipal: "agent:x" } }),
    ).toBeNull();
  });

  it("keeps a relay a contact's turn produced attributed to that contact", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    const refused = { kind: "refused" as const, message: "agent relay", actorPrincipal: "agent:x" };
    const relayed = {
      context: {
        contextId: "ctx_relay",
        contextKey: "rctx_relay",
        kind: "turn-runtime",
        capabilities: [],
        createdAt: 0,
        metadata: { relayCallerContactId: "c_ana" },
      },
    };
    expect(runWithContext(relayed, () => turnActorContactId(env, { actor: refused }))).toBe("c_ana");
    expect(runWithContext(relayed, () => turnActorContactId(env, { actor: { kind: "operator" } }))).toBeNull();
  });

  it("is null when the turn cannot be classified", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    const throwing = {
      readCredentials: () => {
        throw new Error("credentials unreadable");
      },
    };
    expect(turnActorContactId(env, throwing)).toBeNull();
  });
});

describe("isUnattributedTurn", () => {
  const refused = { kind: "refused" as const, message: "unknown speaker", actorPrincipal: "agent:x" };

  it("is true only for a runtime turn Ravi cannot attribute, or cannot classify", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    expect(isUnattributedTurn(env, { actor: refused })).toBe(true);
    expect(isUnattributedTurn(env, { actor: { kind: "operator" } })).toBe(false);
    expect(isUnattributedTurn(env, { actor: { kind: "contact", contactId: "c_ana" } })).toBe(false);
    const throwing = {
      readCredentials: () => {
        throw new Error("credentials unreadable");
      },
    };
    expect(isUnattributedTurn(env, throwing)).toBe(true);
  });

  it("is false outside a runtime turn (the terminal, the daemon's own calls)", () => {
    expect(isUnattributedTurn({})).toBe(false);
    expect(runWithContext({}, () => isUnattributedTurn({}))).toBe(false);
  });
});

describe("unattributedTurnRefusal", () => {
  it("carries the refusal's reason, unknown when the classification gave none or failed", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    const reason = {
      kind: "routine_not_operator_owned" as const,
      routine: "cron" as const,
      jobId: "job_1",
      ownerPrincipal: "contact:c_ana",
    };
    expect(
      unattributedTurnRefusal(env, {
        actor: { kind: "refused", message: "x", actorPrincipal: "automation:cron:job_1", reason },
      }),
    ).toEqual({ reason, actorPrincipal: "automation:cron:job_1" });
    expect(
      unattributedTurnRefusal(env, { actor: { kind: "refused", message: "x", actorPrincipal: "agent:x" } }),
    ).toEqual({ reason: { kind: "unknown" }, actorPrincipal: "agent:x" });
    expect(unattributedTurnRefusal(env, { actor: { kind: "operator" } })).toBeNull();
    const throwing = {
      readCredentials: () => {
        throw new Error("credentials unreadable");
      },
    };
    expect(unattributedTurnRefusal(env, throwing)?.reason).toEqual({ kind: "unknown" });
    expect(unattributedTurnRefusal({})).toBeNull();
  });
});

describe("inRuntimeTurn", () => {
  it("covers commands the daemon gateway runs for a turn, whose process has no RAVI_CONTEXT_KEY", () => {
    expect(inRuntimeTurn({})).toBe(false);
    expect(inRuntimeTurn({ RAVI_CONTEXT_KEY: "ctx_1" })).toBe(true);
    expect(runWithContext({ transport: "gateway" }, () => inRuntimeTurn({}))).toBe(true);
    expect(runWithContext({ transport: "tool" }, () => inRuntimeTurn({}))).toBe(true);
    expect(runWithContext({}, () => inRuntimeTurn({}))).toBe(false);
  });

  it("covers a shell cron the daemon spawned, but not shell triggers or jobs", () => {
    expect(inRuntimeTurn(spawnedAutomationEnv("cron", "job_1"))).toBe(true);
    expect(inRuntimeTurn(spawnedAutomationEnv("trigger", "trg_1"))).toBe(false);
    expect(inRuntimeTurn(spawnedAutomationEnv("job", "job_1"))).toBe(false);
    expect(inRuntimeTurn({ RAVI_AUTOMATION_PRINCIPAL: "automation:cron:" })).toBe(false);
  });
});

describe("shell crons and Bases", () => {
  const OWNER = { activeUserId: "user_luis", activeOrgId: "org_1", ownerName: "Luis" };

  it("acts for the contact who owns a shell cron, refuses an ownerless one and lets an operator-owned one act as the operator", () => {
    const envFor = (ownerPrincipal: string) => ({
      ...spawnedAutomationEnv("cron", "job_1"),
      [CRON_RUN_AUTHORITY_ENV]: JSON.stringify({
        jobId: "job_1",
        ownerPrincipal,
        ownerIsOperator: ownerPrincipal === "operator",
      }),
    });
    const deps = { turn: { ...OWNER, getContactStatus: () => "allowed" } };
    expect(unattributedTurnRefusal(envFor("contact:c_ana"), deps)).toBeNull();
    expect(turnActorContactId(envFor("contact:c_ana"), deps)).toBe("c_ana");
    expect(unattributedTurnRefusal(envFor("unknown"), deps)?.reason).toEqual({
      kind: "routine_not_operator_owned",
      routine: "cron",
      jobId: "job_1",
      ownerPrincipal: "unknown",
    });
    expect(unattributedTurnRefusal(envFor("operator"), deps)).toBeNull();
    expect(turnActorContactId(envFor("operator"), deps)).toBeNull();
    expect(unattributedTurnRefusal(spawnedAutomationEnv("cron", "job_1"), deps)).not.toBeNull();
  });
});

describe("trigger turns and Bases", () => {
  const OWNER = {
    activeUserId: "user_luis",
    activeOrgId: "org_1",
    ownerName: "Luis",
    getContactStatus: () => "allowed",
  };
  /** What Bases passes; every other caller passes nothing. */
  const BASES = { triggerRoutines: true, turn: OWNER, readCredentials: () => null };
  const OTHERS = { turn: OWNER, readCredentials: () => null };
  const NOWHERE = { kind: "none" };
  const INTO_GROUP = { kind: "chat", channel: "whatsapp", chatId: "120363000000000000@g.us" };

  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-turn-actor-trigger-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  /** The session the trigger's runner created for it, where its fires run. */
  const OWN_SESSION = "agent:main:trigger:trg_1:own";
  const CHAT_SESSION = "agent:main:whatsapp:wa-main:dm:5511888888888";

  function triggerTurnEnv(
    ownerPrincipal?: string,
    ownerIsOperator = false,
    turnReplyTarget: Record<string, unknown> = NOWHERE,
    session: { runsIn?: string; sentTo?: string | null } = {},
  ): NodeJS.ProcessEnv {
    const sessionKey = session.runsIn ?? OWN_SESSION;
    const ownSessionKey = session.sentTo === undefined ? OWN_SESSION : session.sentTo;
    // A turn runs in a session that exists; the trigger's own was created by its runner.
    getOrCreateSession(sessionKey, "main", stateDir ?? "/tmp", undefined, { triggerRunner: true });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionKey,
      sessionName: "requests-queue",
      metadata: {
        actorResolution: "resolved",
        executorAgentId: "main",
        actorPrincipal: "automation:trigger:trg_1",
        agentIdentityCompartment: "automation:trigger:trg_1",
        turnReplyTarget,
        ...(ownerPrincipal
          ? { triggerRunAuthority: { triggerId: "trg_1", ownerPrincipal, ownerIsOperator, ownSessionKey } }
          : {}),
      },
    });
    return { RAVI_CONTEXT_KEY: context.contextKey };
  }

  it("lets an operator-owned trigger act as the operator in Bases, sending no contact", () => {
    const env = triggerTurnEnv("operator", true);
    expect(unattributedTurnRefusal(env, BASES)).toBeNull();
    expect(turnActorContactId(env, BASES)).toBeNull();
    expect(resolveTurnActor(env, BASES)).toEqual({ refusal: null, contactId: null });
  });

  it("acts for the contact who owns the trigger in Bases", () => {
    const env = triggerTurnEnv("contact:c_ana");
    expect(unattributedTurnRefusal(env, BASES)).toBeNull();
    expect(turnActorContactId(env, BASES)).toBe("c_ana");
    expect(resolveTurnActor(env, BASES)).toEqual({ refusal: null, contactId: "c_ana" });
  });

  it("refuses a trigger no person owns in Bases, naming the trigger", () => {
    expect(unattributedTurnRefusal(triggerTurnEnv("unknown"), BASES)).toEqual({
      actorPrincipal: "automation:trigger:trg_1",
      reason: { kind: "routine_not_operator_owned", routine: "trigger", jobId: "trg_1", ownerPrincipal: "unknown" },
    });
    expect(unattributedTurnRefusal(triggerTurnEnv("agent:helper"), BASES)?.reason).toMatchObject({
      kind: "routine_not_operator_owned",
      ownerPrincipal: "agent:helper",
    });
    expect(unattributedTurnRefusal(triggerTurnEnv(), BASES)?.reason).toEqual({ kind: "unknown" });
    expect(turnActorContactId(triggerTurnEnv("unknown"), BASES)).toBeNull();
  });

  it("refuses an owned trigger whose answer goes to a chat that is not its owner's", () => {
    for (const env of [
      triggerTurnEnv("operator", true, INTO_GROUP),
      triggerTurnEnv("contact:c_ana", false, INTO_GROUP),
    ]) {
      const turn = resolveTurnActor(env, BASES);
      expect(turn.refusal?.reason).toEqual({ kind: "routine_answers_elsewhere", routine: "trigger", jobId: "trg_1" });
      // A refused turn names nobody: nothing may go out for it.
      expect(turn.contactId).toBeNull();
    }
  });

  it("refuses an owned trigger that does not run in a session of its own", () => {
    for (const env of [
      // The runner sent the fire to the agent's main session, or to a chat's.
      triggerTurnEnv("operator", true, NOWHERE, { runsIn: "agent:main:main", sentTo: null }),
      triggerTurnEnv("contact:c_ana", false, NOWHERE, { runsIn: CHAT_SESSION, sentTo: null }),
      // Sent to the trigger's own session, but the turn runs in another one.
      triggerTurnEnv("operator", true, NOWHERE, { runsIn: CHAT_SESSION }),
    ]) {
      const turn = resolveTurnActor(env, BASES);
      expect(turn.refusal?.reason).toEqual({ kind: "routine_shared_session", routine: "trigger", jobId: "trg_1" });
      expect(turn.contactId).toBeNull();
      expect(turnActorContactId(env, BASES)).toBeNull();
    }
  });

  it("keeps refusing every trigger turn for callers other than Bases, and names no contact for them", () => {
    for (const env of [triggerTurnEnv("operator", true), triggerTurnEnv("contact:c_ana"), triggerTurnEnv()]) {
      expect(unattributedTurnRefusal(env, OTHERS)?.reason).toEqual({ kind: "unknown" });
      expect(turnActorContactId(env, OTHERS)).toBeNull();
      expect(resolveTurnActor(env, OTHERS).refusal?.reason).toEqual({ kind: "unknown" });
    }
  });
});

describe("resolveTurnActor", () => {
  it("is the operator outside a runtime turn, without classifying anything", () => {
    expect(resolveTurnActor({})).toEqual({ refusal: null, contactId: null });
  });

  it("gives the refusal and the actor from one decision", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    expect(resolveTurnActor(env, { actor: { kind: "contact", contactId: "c_ana" } })).toEqual({
      refusal: null,
      contactId: "c_ana",
    });
    expect(resolveTurnActor(env, { actor: { kind: "operator" } })).toEqual({ refusal: null, contactId: null });
    expect(resolveTurnActor(env, { actor: { kind: "refused", message: "x", actorPrincipal: "agent:x" } })).toEqual({
      refusal: { reason: { kind: "unknown" }, actorPrincipal: "agent:x" },
      contactId: null,
    });
  });

  it("refuses when the turn cannot be classified", () => {
    const throwing = {
      readCredentials: () => {
        throw new Error("credentials unreadable");
      },
    };
    expect(resolveTurnActor({ RAVI_CONTEXT_KEY: "ctx_1" }, throwing)).toEqual({
      refusal: { reason: { kind: "unknown" }, actorPrincipal: "unknown" },
      contactId: null,
    });
  });
});
