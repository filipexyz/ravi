import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createContact } from "../contacts.js";
import { getOrCreateSession } from "../router/sessions.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { startTurnLink } from "./turn-link.js";

describe("startTurnLink", () => {
  it("messages nobody for a cron run acting for its creator", async () => {
    let requested = false;
    const flow = await startTurnLink("c_ana", {
      isRoutineRun: () => true,
      requestLink: (async () => {
        requested = true;
        return { status: "dm_sent" };
      }) as never,
    });
    expect(flow).toBe("routine");
    expect(requested).toBe(false);
  });
});

describe("startTurnLink in a turn a contact's trigger fired", () => {
  let stateDir: string | null = null;
  let previousContextKey: string | undefined;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-turn-link-trigger-");
    previousContextKey = process.env.RAVI_CONTEXT_KEY;
  });

  afterEach(async () => {
    if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
    else process.env.RAVI_CONTEXT_KEY = previousContextKey;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function enterTriggerTurnOf(contactId: string): void {
    // The trigger's own session: the one its runner created and sent the fire to.
    const ownSessionKey = "agent:main:trigger:trg_1:own";
    getOrCreateSession(ownSessionKey, "main", stateDir ?? "/tmp", undefined, { triggerRunner: true });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionKey: ownSessionKey,
      sessionName: "requests-queue",
      metadata: {
        actorResolution: "resolved",
        executorAgentId: "main",
        actorPrincipal: "automation:trigger:trg_1",
        agentIdentityCompartment: "automation:trigger:trg_1",
        turnReplyTarget: { kind: "none" },
        triggerRunAuthority: {
          triggerId: "trg_1",
          ownerPrincipal: `contact:${contactId}`,
          ownerIsOperator: false,
          ownSessionKey,
        },
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
  }

  it("messages nobody when Bases refused the trigger's owner for not being linked", async () => {
    const contact = createContact({ phone: "5511888888888", name: "Ana", status: "allowed", source: "manual" });
    enterTriggerTurnOf(contact.id);
    let requested = false;
    const requestLink = (async () => {
      requested = true;
      return { status: "dm_sent" };
    }) as never;

    // Bases reads the turn with trigger owners: the trigger acts for its owner, so nobody is asking.
    expect(await startTurnLink(contact.id, { actor: { triggerRoutines: true }, requestLink })).toBe("routine");
    expect(requested).toBe(false);
  });

  it("is not a routine for callers that refuse trigger turns", async () => {
    const contact = createContact({ phone: "5511888888888", name: "Ana", status: "allowed", source: "manual" });
    enterTriggerTurnOf(contact.id);
    let requested = false;
    const flow = await startTurnLink(contact.id, {
      context: null,
      requestLink: (async () => {
        requested = true;
        return { status: "unavailable" };
      }) as never,
    });
    expect(flow).not.toBe("routine");
    expect(requested).toBe(true);
  });
});
