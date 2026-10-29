import { describe, expect, it } from "bun:test";

import { runWithContext } from "../cli/context.js";
import { spawnedAutomationEnv } from "../runtime/turn-origin.js";
import { inRuntimeTurn, isUnattributedTurn, turnActorContactId, unattributedTurnRefusal } from "./turn-actor.js";

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

  it("refuses a contact-owned shell cron and lets an operator-owned one act as the operator", () => {
    const env = spawnedAutomationEnv("cron", "job_1");
    const contactOwned = unattributedTurnRefusal(env, {
      turn: { ...OWNER, getCronJobOwner: () => ({ found: true, ownerPrincipal: "contact:c_ana" }) },
    });
    expect(contactOwned?.reason).toEqual({
      kind: "routine_not_operator_owned",
      routine: "cron",
      jobId: "job_1",
      ownerPrincipal: "contact:c_ana",
    });
    expect(
      unattributedTurnRefusal(env, {
        turn: { ...OWNER, getCronJobOwner: () => ({ found: true, ownerPrincipal: "operator" }) },
      }),
    ).toBeNull();
    expect(
      turnActorContactId(env, {
        turn: { ...OWNER, getCronJobOwner: () => ({ found: true, ownerPrincipal: "operator" }) },
      }),
    ).toBeNull();
  });
});
