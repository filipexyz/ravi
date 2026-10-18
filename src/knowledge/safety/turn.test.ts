import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { dbCreateCronJob } from "../../cron/cron-db.js";
import type { ConnectorTurnDeps } from "../../link/connector-turn.js";
import type { ContextRecord } from "../../router/router-db.js";
import { getOrCreateSession } from "../../router/sessions.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { buildSessionRelayTurnOrigin } from "../../runtime/turn-origin.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { classifyKnowledgeTurn, isKnowledgeOperatorTurn } from "./turn.js";

// Fixtures follow src/link/connector-turn.test.ts.
const OWNER = { activeUserId: "user_luis", activeOrgId: "org_1", ownerName: "Luis" } satisfies ConnectorTurnDeps;
const OWNER_DM_SESSION = { sessionKey: "agent:main:whatsapp:wa-main:dm:5511999999999", sessionName: "luis-dm" };

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-turn-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function turnContext(
  metadata: Record<string, unknown>,
  extra: { sessionName?: string; sessionKey?: string } = {},
): ContextRecord {
  if (extra.sessionKey) getOrCreateSession(extra.sessionKey, "main", stateDir ?? "/tmp");
  return createRuntimeContext({
    kind: "turn-runtime",
    agentId: "main",
    ...(extra.sessionKey ? { sessionKey: extra.sessionKey } : {}),
    sessionName: extra.sessionName ?? "main-session",
    metadata: { actorResolution: "resolved", executorAgentId: "main", ...metadata },
  });
}

function classify(context: ContextRecord, deps: ConnectorTurnDeps = {}) {
  return classifyKnowledgeTurn({
    readCredentials: () => null,
    turn: { ...OWNER, env: { RAVI_CONTEXT_KEY: context.contextKey }, ...deps },
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("classifyKnowledgeTurn", () => {
  it("lets the terminal in with the terminal exec context and no turn key", () => {
    const verdict = classifyKnowledgeTurn({ readCredentials: () => null, turn: { ...OWNER, env: {} } });

    expect(verdict).toEqual({
      ok: true,
      turn: {
        audience: "operator",
        turnKey: null,
        sessionKey: null,
        sessionName: null,
        agentId: null,
        execContext: { v: 1, speaker: { kind: "terminal" }, conversation: "terminal" },
      },
    });
  });

  it("lets the owner's own direct chat in, without the Console user id in the exec context", () => {
    const context = turnContext(
      {
        actorPrincipal: "contact:c_luis",
        consoleUserId: "user_luis",
        consoleOrgId: "org_1",
        agentIdentityCompartment: "dm:5511999999999@s.whatsapp.net",
      },
      OWNER_DM_SESSION,
    );

    const verdict = classify(context);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.turn.turnKey).toBe(sha256(context.contextId));
    expect(verdict.turn.sessionName).toBe("luis-dm");
    expect(verdict.turn.sessionKey).toBe(OWNER_DM_SESSION.sessionKey);
    expect(verdict.turn.agentId).toBe("main");
    expect(verdict.turn.execContext.speaker).toEqual({ kind: "owner", contactId: "c_luis" });
    expect(verdict.turn.execContext.conversation).toBe("dm");
  });

  const RELAY = {
    actorPrincipal: "automation:operator:local",
    agentIdentityCompartment: "workspace:default",
    turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
    turnReplyTarget: { kind: "none" },
  };

  it("lets the operator's relay in, in a session made from the terminal", () => {
    const context = turnContext(RELAY, { sessionKey: "relay-notes", sessionName: "relay-notes" });

    const verdict = classify(context);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.turn.sessionKey).toBe("relay-notes");
  });

  it("refuses the operator's relay into a shared session with reason shared_session", () => {
    for (const sessionKey of ["agent:main:main", "agent:main:whatsapp:wa-main:group:120363012345678901"]) {
      const context = turnContext(RELAY, { sessionKey, sessionName: `s-${sessionKey.length}` });
      expect(classify(context)).toMatchObject({ ok: false, reason: "shared_session" });
    }
    // A session with no known key is not private either.
    expect(classify(turnContext(RELAY))).toMatchObject({ ok: false, reason: "shared_session" });
  });

  it("lets an operator-owned cron in, in its isolated session", () => {
    const job = dbCreateCronJob({
      name: "knowledge-turn-cron",
      schedule: { type: "every", every: 60_000 },
      message: "summarize",
      ownerPrincipal: "operator",
    });
    const cron = { actorPrincipal: `automation:cron:${job.id}`, agentIdentityCompartment: `automation:cron:${job.id}` };
    const context = turnContext(cron, { sessionKey: `agent:main:cron:${job.id}`, sessionName: "main-cron" });

    const verdict = classify(context);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.turn.execContext.routine).toEqual({ kind: "cron", id: job.id });

    // The same cron publishing into the agent's main session is refused.
    const shared = turnContext(cron, { sessionKey: "agent:main:main", sessionName: "main-main" });
    expect(classify(shared)).toMatchObject({ ok: false, reason: "shared_session" });
  });

  it("refuses the owner in a group with reason group", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_luis",
      consoleUserId: "user_luis",
      consoleOrgId: "org_1",
      agentIdentityCompartment: "chat:120363012345678901@g.us",
    });

    expect(classify(context)).toEqual({
      ok: false,
      code: "KNOWLEDGE_TURN_NOT_OPERATOR",
      reason: "group",
      actorPrincipal: "contact:c_luis",
    });
  });

  it("refuses the heartbeat with reason routine", () => {
    const context = turnContext({
      actorPrincipal: "automation:heartbeat",
      agentIdentityCompartment: "automation:heartbeat",
    });

    expect(classify(context)).toMatchObject({ ok: false, reason: "routine" });
  });

  it("refuses a contact with reason contact", () => {
    const context = turnContext({
      actorPrincipal: "contact:c_new",
      agentIdentityCompartment: "dm:5511777777777@s.whatsapp.net",
    });

    expect(classify(context)).toMatchObject({ ok: false, reason: "contact", actorPrincipal: "contact:c_new" });
  });

  it("refuses a relay from another agent with reason agent", () => {
    const context = turnContext({ actorPrincipal: "agent:other", agentIdentityCompartment: "workspace:default" });

    expect(classify(context)).toMatchObject({ ok: false, reason: "agent" });
  });

  it("fails closed with reason unknown when classification throws", () => {
    const thrown = classifyKnowledgeTurn({
      readCredentials: () => null,
      turn: {
        ...OWNER,
        getContextById: () => {
          throw new Error("context store unreadable");
        },
        runtimeContext: {
          present: true,
          record: turnContext({ parentContextId: "ctx_parent" }),
        },
      },
    });

    expect(thrown).toEqual({
      ok: false,
      code: "KNOWLEDGE_TURN_NOT_OPERATOR",
      reason: "unknown",
      actorPrincipal: "unknown",
    });
  });

  it("honours the operatorOwnTurn override", () => {
    expect(isKnowledgeOperatorTurn({ operatorOwnTurn: true })).toBe(true);
    expect(classifyKnowledgeTurn({ operatorOwnTurn: false })).toMatchObject({ ok: false, reason: "unknown" });
  });
});
