import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { writeCachedActorBinding } from "../../cloud-auth/actor-bindings.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  isPersonPrincipal,
  isTriggerOwnSessionKey,
  parseTriggerSessionKey,
  readTriggerRunAuthority,
  triggerAuthorityLendsOwner,
  triggerIsolatedSessionKey,
  triggerOfSessionKey,
  triggerOwnSessionAdmitsPrompt,
  triggerOwnSessionName,
} from "../authority.js";
import {
  TRIGGER_OWNER_NEUTRAL_SET_KEYS,
  captureTriggerRunAuthority,
  ownerKeptOnEnable,
  resolveTriggerOwnerForCurrentTurn,
  sameTriggerDefinition,
  sessionAdmitsTriggerFire,
  triggerOwnSession,
  triggerOwnerActsAsOperator,
  triggerOwnerLostWarning,
  triggerRunsAs,
  triggerRunsAsWarning,
  triggerRunsInOwnSession,
  triggerSessionTargetError,
} from "../ownership.js";
import type { Trigger } from "../types.js";

const OWNER = { activeUserId: "user_luis", activeOrgId: "org_1", ownerName: "Luis" };

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trigger-ownership-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function bindToConsole(contactId: string, consoleUserId: string) {
  writeCachedActorBinding({
    contactId,
    actorPrincipal: `contact:${contactId}`,
    consoleUserId,
    orgId: "org_1",
    installationId: "inst_1",
  });
}

describe("who a trigger runs as", () => {
  it("is nobody when the trigger has no recorded owner", () => {
    expect(triggerRunsAs({})).toBe("unknown");
    expect(triggerRunsAs({ ownerPrincipal: "  " })).toBe("unknown");
    expect(triggerRunsAs({ ownerPrincipal: "contact:c_ana" })).toBe("contact:c_ana");
  });

  it("acts as the operator only for an owner that does, never by default", () => {
    // A cron job with no owner is the operator; a trigger is not.
    expect(triggerOwnerActsAsOperator(undefined, OWNER)).toBe(false);
    expect(triggerOwnerActsAsOperator(null, OWNER)).toBe(false);
    expect(triggerOwnerActsAsOperator("", OWNER)).toBe(false);
    expect(triggerOwnerActsAsOperator("operator", OWNER)).toBe(true);
    expect(triggerOwnerActsAsOperator("unknown", OWNER)).toBe(false);
    expect(triggerOwnerActsAsOperator("agent:helper", OWNER)).toBe(false);
    expect(triggerOwnerActsAsOperator("automation:trigger:trg_1", OWNER)).toBe(false);
    expect(triggerOwnerActsAsOperator("contact:c_ana", OWNER)).toBe(false);
  });

  it("treats the contact bound to the operator's login as the operator", () => {
    bindToConsole("c_luis", "user_luis");
    bindToConsole("c_ana", "user_ana");
    expect(triggerOwnerActsAsOperator("contact:c_luis", OWNER)).toBe(true);
    expect(triggerOwnerActsAsOperator("contact:c_ana", OWNER)).toBe(false);
    expect(triggerOwnerActsAsOperator("contact:c_luis", { ...OWNER, activeUserId: "user_other" })).toBe(false);
  });

  it("is the operator for a trigger written from the terminal", () => {
    expect(resolveTriggerOwnerForCurrentTurn({ ...OWNER, env: {} })).toBe("operator");
  });

  it("never touches the owner for the keys that only pace the trigger", () => {
    expect([...TRIGGER_OWNER_NEUTRAL_SET_KEYS].sort()).toEqual(["cooldown", "timeout"]);
  });
});

describe("who a trigger keeps its owner for when it is turned on", () => {
  it("is the owner themself, and the operator arming someone else's trigger", () => {
    // The owner turning their own trigger on.
    expect(ownerKeptOnEnable({ ownerPrincipal: "contact:c_ana" }, "contact:c_ana")).toBe("contact:c_ana");
    expect(ownerKeptOnEnable({ ownerPrincipal: "operator" }, "operator")).toBe("operator");
    // The operator arms a draft someone else created: it keeps that person as its owner.
    expect(ownerKeptOnEnable({ ownerPrincipal: "contact:c_ana" }, "operator")).toBe("contact:c_ana");
    // Nobody else keeps another person's owner: the store compares, and clears.
    expect(ownerKeptOnEnable({ ownerPrincipal: "operator" }, "contact:c_ana")).toBe("contact:c_ana");
    expect(ownerKeptOnEnable({ ownerPrincipal: "operator" }, "agent:helper")).toBe("agent:helper");
    // Nothing to keep on a trigger with no owner.
    expect(ownerKeptOnEnable({}, "operator")).toBeUndefined();
    expect(ownerKeptOnEnable({ ownerPrincipal: "  " }, "operator")).toBeUndefined();
  });
});

describe("the run authority a trigger fires with", () => {
  const OWN_SESSION = "agent:main:trigger:trg_1:own";

  it("snapshots the owner and the session of its own, with no owner for a row that has none", () => {
    expect(
      captureTriggerRunAuthority({ id: "trg_1", ownerPrincipal: "operator" }, { ownSessionKey: OWN_SESSION }, OWNER),
    ).toEqual({ triggerId: "trg_1", ownerPrincipal: "operator", ownerIsOperator: true, ownSessionKey: OWN_SESSION });
    // Fired into a session that is not the trigger's own: the snapshot names none.
    expect(
      captureTriggerRunAuthority({ id: "trg_1", ownerPrincipal: "contact:c_ana" }, { ownSessionKey: null }, OWNER),
    ).toEqual({ triggerId: "trg_1", ownerPrincipal: "contact:c_ana", ownerIsOperator: false, ownSessionKey: null });
    expect(
      captureTriggerRunAuthority({ id: "trg_1", ownerPrincipal: "operator" }, { ownSessionKey: "" }, OWNER),
    ).toEqual({
      triggerId: "trg_1",
      ownerPrincipal: "operator",
      ownerIsOperator: true,
      ownSessionKey: null,
    });
    expect(captureTriggerRunAuthority({ id: "trg_1" }, { ownSessionKey: OWN_SESSION }, OWNER)).toEqual({
      triggerId: "trg_1",
      ownerPrincipal: "unknown",
      ownerIsOperator: false,
      ownSessionKey: OWN_SESSION,
    });
  });

  it("is read back only when complete and for the same trigger", () => {
    const snapshot = {
      triggerId: "trg_1",
      ownerPrincipal: "operator",
      ownerIsOperator: true,
      ownSessionKey: OWN_SESSION,
    };
    expect(readTriggerRunAuthority(snapshot, "trg_1")).toEqual(snapshot);
    expect(readTriggerRunAuthority({ ...snapshot, extra: "ignored" }, "trg_1")).toEqual(snapshot);
    expect(readTriggerRunAuthority({ ...snapshot, ownSessionKey: null }, "trg_1")).toEqual({
      ...snapshot,
      ownSessionKey: null,
    });
    expect(readTriggerRunAuthority(snapshot, "trg_2")).toBeNull();
    expect(readTriggerRunAuthority(undefined, "trg_1")).toBeNull();
    expect(readTriggerRunAuthority(null, "trg_1")).toBeNull();
    expect(readTriggerRunAuthority("operator", "trg_1")).toBeNull();
    expect(readTriggerRunAuthority([snapshot], "trg_1")).toBeNull();
    expect(readTriggerRunAuthority({ ...snapshot, ownerPrincipal: " " }, "trg_1")).toBeNull();
    expect(readTriggerRunAuthority({ ...snapshot, ownerIsOperator: 1 }, "trg_1")).toBeNull();
    // A snapshot that does not say which session the fire was sent to is not one.
    const { ownSessionKey: _unsaid, ...withoutSession } = snapshot;
    expect(readTriggerRunAuthority(withoutSession, "trg_1")).toBeNull();
    expect(readTriggerRunAuthority({ ...snapshot, ownSessionKey: "" }, "trg_1")).toBeNull();
    expect(readTriggerRunAuthority({ ...snapshot, ownSessionKey: true }, "trg_1")).toBeNull();
    expect(readTriggerRunAuthority({ ...snapshot, ownSessionKey: undefined }, "trg_1")).toBeNull();
  });

  it("lends authority only for the operator or a contact, in a session of the trigger's own", () => {
    const of = (ownerPrincipal: string, ownerIsOperator = false, ownSessionKey: string | null = OWN_SESSION) => ({
      triggerId: "trg_1",
      ownerPrincipal,
      ownerIsOperator,
      ownSessionKey,
    });
    expect(triggerAuthorityLendsOwner(of("operator", true))).toBe(true);
    expect(triggerAuthorityLendsOwner(of("contact:c_ana"))).toBe(true);
    // The same owners lend nothing in a session that is not the trigger's own.
    expect(triggerAuthorityLendsOwner(of("operator", true, null))).toBe(false);
    expect(triggerAuthorityLendsOwner(of("contact:c_ana", false, null))).toBe(false);
    expect(triggerAuthorityLendsOwner(of("unknown"))).toBe(false);
    expect(triggerAuthorityLendsOwner(of("agent:helper"))).toBe(false);
    expect(triggerAuthorityLendsOwner(of("automation:cron:job_1"))).toBe(false);
    expect(triggerAuthorityLendsOwner(undefined)).toBe(false);
    expect(triggerAuthorityLendsOwner(null)).toBe(false);
  });

  it("lends nothing, and does not throw, for a snapshot that is not one", () => {
    for (const malformed of [
      "operator",
      42,
      true,
      [],
      [{ ownerPrincipal: "operator", ownerIsOperator: true, ownSessionKey: OWN_SESSION }],
      {},
      { ownSessionKey: OWN_SESSION },
      { ownerPrincipal: 7, ownerIsOperator: true, ownSessionKey: OWN_SESSION },
      { ownerPrincipal: null, ownSessionKey: OWN_SESSION },
      { ownerPrincipal: "operator", ownerIsOperator: "true", ownSessionKey: OWN_SESSION },
      { ownerPrincipal: "contact:c_ana", ownSessionKey: true },
      { ownerPrincipal: "contact:c_ana", ownSessionKey: "" },
      { ownerPrincipal: "operator", ownerIsOperator: true, ownSession: true },
    ]) {
      expect(triggerAuthorityLendsOwner(malformed)).toBe(false);
    }
  });
});

/** The key the runner gives a named session: the trigger's key plus a 24-hex hash of the name. */
const namedKey = (triggerId: string, hash = "0123456789abcdef01234567", agent = "main") =>
  `agent:${agent}:trigger:${triggerId}:key:${hash}`;

describe("the session a trigger's runner created", () => {
  it("is told from the session key, in the three forms the runner writes", () => {
    expect(parseTriggerSessionKey("agent:main:trigger:trg_1")).toEqual({
      agentId: "main",
      triggerId: "trg_1",
      kind: "isolated",
    });
    expect(parseTriggerSessionKey("agent:helper:trigger:trg_2:own")).toEqual({
      agentId: "helper",
      triggerId: "trg_2",
      kind: "own",
    });
    expect(parseTriggerSessionKey(namedKey("trg_1"))).toEqual({ agentId: "main", triggerId: "trg_1", kind: "named" });
    // A named session whose hash happens to end like the trigger's id is still a named one.
    expect(parseTriggerSessionKey(namedKey("0123abcd", "0123456789abcdef0123abcd"))?.kind).toBe("named");

    expect(triggerOfSessionKey("agent:main:trigger:trg_1")).toBe("trg_1");
    expect(triggerOfSessionKey("agent:main:trigger:trg_1:own")).toBe("trg_1");
    expect(triggerOfSessionKey(namedKey("trg_1"))).toBe("trg_1");
  });

  it("is no other session: a chat's, the agent's main one, or a name that only looks like it", () => {
    for (const key of [
      "agent:main:main",
      "agent:main:whatsapp:dm:5511999999999",
      "agent:main:cron:job_1",
      "trigger:trg_1",
      "agent:main:trigger:",
      "xagent:main:trigger:trg_1",
      "agent:main:whatsapp:trigger:trg_1",
      "requests-queue",
      "",
      null,
      undefined,
    ]) {
      expect(parseTriggerSessionKey(key)).toBeNull();
      expect(triggerOfSessionKey(key)).toBeNull();
      expect(isTriggerOwnSessionKey(key)).toBe(false);
    }
  });

  it("is not a session derived from a trigger's session, which has its own participants", () => {
    for (const key of [
      // A thread opened from a trigger's session, and anything else appended to its key.
      "agent:main:trigger:trg_1:thread:1700000000.000100",
      "agent:main:trigger:trg_1:own:thread:1700000000.000100",
      `${namedKey("trg_1")}:thread:1700000000.000100`,
      "agent:main:trigger:trg_1:",
      "agent:main:trigger:trg_1:own:",
      "agent:main:trigger:trg_1:owned",
      "agent:main:trigger:trg_1:OWN",
      "agent:main:trigger:trg_1:key:",
      // Not the hash the runner writes: too short, too long, not hex.
      "agent:main:trigger:trg_1:key:abc",
      namedKey("trg_1", "0123456789abcdef012345678"),
      namedKey("trg_1", "0123456789abcdef0123456z"),
      "agent:main:trigger:trg_1:own\nagent:main:trigger:trg_2:own",
    ]) {
      expect(parseTriggerSessionKey(key)).toBeNull();
      expect(isTriggerOwnSessionKey(key)).toBe(false);
    }
  });

  it("tells a trigger's own session from the plain one-per-trigger session", () => {
    expect(isTriggerOwnSessionKey("agent:main:trigger:trg_1:own")).toBe(true);
    expect(isTriggerOwnSessionKey("agent:main:trigger:trg_1")).toBe(false);
    expect(isTriggerOwnSessionKey(namedKey("trg_1"))).toBe(false);
    expect(triggerIsolatedSessionKey("main", "trg_1", true)).toBe("agent:main:trigger:trg_1:own");
    expect(triggerIsolatedSessionKey("main", "trg_1", false)).toBe("agent:main:trigger:trg_1");
  });
});

describe("the session an isolated trigger runs in", () => {
  it("is the trigger's own session only while a person owns the trigger", () => {
    for (const ownerPrincipal of ["operator", "contact:c_ana"]) {
      expect(triggerOwnSession("main", { id: "trg_1", ownerPrincipal })).toEqual({
        sessionKey: "agent:main:trigger:trg_1:own",
        own: true,
      });
    }
    // Nobody owns it (it never had an owner, or lost it), or something that is
    // not a person does: the plain session, which never held an owner's turns.
    for (const ownerPrincipal of [
      undefined,
      "",
      "  ",
      "unknown",
      "agent:helper",
      "automation:cron:job_1",
      "contact:",
    ]) {
      expect(triggerOwnSession("main", { id: "trg_1", ownerPrincipal })).toEqual({
        sessionKey: "agent:main:trigger:trg_1",
        own: false,
      });
    }
  });

  it("counts only the operator and a contact as a person", () => {
    expect(isPersonPrincipal("operator")).toBe(true);
    expect(isPersonPrincipal("contact:c_ana")).toBe(true);
    expect(isPersonPrincipal(" operator ")).toBe(true);
    for (const principal of [undefined, null, "", "unknown", "contact:", "agent:helper", "automation:trigger:trg_1"]) {
      expect(isPersonPrincipal(principal)).toBe(false);
    }
  });

  it("is what Bases asks of a trigger: only `isolated` is a session of its own", () => {
    expect(triggerRunsInOwnSession({ session: "isolated" })).toBe(true);
    for (const session of ["main", "requests-queue", "bases-{{data.payload.rowId}}", "agent:main:trigger:trg_1:own"]) {
      expect(triggerRunsInOwnSession({ session })).toBe(false);
    }
  });
});

describe("the prompts a trigger's own session runs", () => {
  const OWN = "agent:main:trigger:trg_1:own";
  const fire = (triggerId: string) => ({ _trigger: true, _triggerId: triggerId });
  /** A prompt as producers publish it: text plus whatever envelope fields they set. */
  const relay: Record<string, unknown> = { prompt: "[System] Inform: hello" };

  it("are that trigger's fires, and the runtime's restart notice for that session", () => {
    expect(triggerOwnSessionAdmitsPrompt(OWN, fire("trg_1"))).toBe(true);
    expect(triggerOwnSessionAdmitsPrompt(OWN, { _daemonRestartResume: { restartEpoch: "e", sessionKey: OWN } })).toBe(
      true,
    );
  });

  it("are nothing else: no relay, no other routine, nothing that only looks like its fire", () => {
    for (const prompt of [
      {},
      relay,
      fire("trg_2"),
      { _trigger: true },
      { _triggerId: "trg_1" },
      { _trigger: "true", _triggerId: "trg_1" },
      { _cron: true, _jobId: "trg_1" },
      { _hook: true },
      // A failed shell command's notice about itself is not a fire, even when it names this trigger.
      { ...fire("trg_1"), _triggerOnError: true },
      { _daemonRestartResume: true },
      { _daemonRestartResume: [] },
      // A restart notice written for another session, or for none.
      { _daemonRestartResume: { restartEpoch: "e", sessionKey: "agent:main:main" } },
      { _daemonRestartResume: { restartEpoch: "e" } },
    ]) {
      expect(triggerOwnSessionAdmitsPrompt(OWN, prompt)).toBe(false);
    }
  });

  it("leave every other session open to any prompt", () => {
    for (const sessionKey of [
      "agent:main:main",
      "agent:main:whatsapp:dm:5511999999999",
      "agent:main:trigger:trg_1",
      namedKey("trg_1"),
      `${OWN}:thread:1700000000.000100`,
      "requests-queue",
      null,
      undefined,
    ]) {
      expect(triggerOwnSessionAdmitsPrompt(sessionKey, relay)).toBe(true);
    }
  });
});

describe("a fire that reaches a session by a name, a key or a reply session", () => {
  it("never enters a trigger's own session, and enters every other session as before", () => {
    expect(sessionAdmitsTriggerFire({ sessionKey: "agent:main:trigger:trg_1:own" })).toBe(false);
    for (const sessionKey of [
      "agent:main:main",
      "agent:main:whatsapp:dm:5511999999999",
      // The plain session of a trigger nobody owns, and a named session a trigger created.
      "agent:main:trigger:trg_1",
      namedKey("trg_1"),
      "requests-queue",
    ]) {
      expect(sessionAdmitsTriggerFire({ sessionKey })).toBe(true);
    }
    // A name no session answers to yet: the runner creates it.
    expect(sessionAdmitsTriggerFire(null)).toBe(true);
    expect(sessionAdmitsTriggerFire(undefined)).toBe(true);
  });

  it("is refused when the trigger is written, naming the trigger the session belongs to", () => {
    const sessions: Record<string, string> = {
      "agent:main:trigger:trg_1:own": "agent:main:trigger:trg_1:own",
      "requests-queue": namedKey("trg_1"),
      "luis-dm": "agent:main:whatsapp:dm:5511999999999",
    };
    const deps = {
      resolveSession: (ref: string) => {
        const byKey = Object.values(sessions).find((key) => key === ref);
        return ref in sessions ? { sessionKey: sessions[ref]! } : byKey ? { sessionKey: byKey } : null;
      },
    };

    // By its name, which is its key.
    for (const ref of ["agent:main:trigger:trg_1:own", "  agent:main:trigger:trg_1:own "]) {
      const error = triggerSessionTargetError(ref, deps);
      expect(error).toContain(`Session ${ref.trim()} is the own session of trigger trg_1`);
      expect(error).toContain("Choose another session");
    }
    // Before that session exists too: the name alone says whose it will be.
    expect(triggerSessionTargetError("agent:main:trigger:trg_9:own", deps)).toContain(
      "is the own session of trigger trg_9",
    );
    expect(triggerSessionTargetError("agent:acme~2E~support:trigger:trg_9:own", deps)).toContain(
      "is the own session of trigger trg_9",
    );
    // Any other session, a name nothing answers to yet, and the values resolved elsewhere.
    for (const ref of [
      "requests-queue",
      "luis-dm",
      "brand-new",
      "main",
      "isolated",
      "bases-{{data.payload.rowId}}",
      " ",
    ]) {
      expect(triggerSessionTargetError(ref, deps)).toBeNull();
    }
  });
});

describe("the name a trigger's own session goes by", () => {
  it("is its key", () => {
    for (const key of ["agent:main:trigger:ab12cd34:own", "agent:support-team_2:trigger:ab12cd34:own"]) {
      expect(triggerOwnSessionName(key)).toBe(key);
    }
  });

  it("writes out what a session name cannot hold, so it stays one subject token", () => {
    expect(triggerOwnSessionName("agent:acme.support:trigger:ab12cd34:own")).toBe(
      "agent:acme~2E~support:trigger:ab12cd34:own",
    );
    expect(triggerOwnSessionName("agent:acme support:trigger:ab12cd34:own")).toBe(
      "agent:acme~20~support:trigger:ab12cd34:own",
    );
    expect(triggerOwnSessionName("agent:a*b>c:trigger:ab12cd34:own")).toBe("agent:a~2A~b~3E~c:trigger:ab12cd34:own");
    for (const key of [
      "agent:acme.support:trigger:ab12cd34:own",
      "agent:acme support:trigger:ab12cd34:own",
      "agent:a\tb\u00a0c\u2003d:trigger:ab12cd34:own",
      "agent:a*b>c:trigger:ab12cd34:own",
    ]) {
      expect(triggerOwnSessionName(key)).not.toMatch(/[.\s*>]/);
      // Still spelled like an own session's key, which is what reserves it.
      expect(isTriggerOwnSessionKey(triggerOwnSessionName(key))).toBe(true);
      expect(triggerOfSessionKey(triggerOwnSessionName(key))).toBe("ab12cd34");
    }
  });

  it("is a different name for a different key", () => {
    const keys = [
      "agent:acme.support:trigger:ab12cd34:own",
      "agent:acme-support:trigger:ab12cd34:own",
      "agent:acme support:trigger:ab12cd34:own",
      "agent:acme~2E~support:trigger:ab12cd34:own",
      "agent:acme~support:trigger:ab12cd34:own",
      "agent:acme\u2003support:trigger:ab12cd34:own",
      "agent:acme~2003~support:trigger:ab12cd34:own",
    ];
    expect(new Set(keys.map(triggerOwnSessionName)).size).toBe(keys.length);
  });
});

describe("whether a stored trigger is still the one the runner subscribed", () => {
  const base: Trigger = {
    id: "trg_1",
    name: "requests",
    topic: "ravi.console.inbox.item",
    message: "drain the queue",
    session: "requests-queue",
    enabled: true,
    cooldownMs: 5000,
    fireCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ownerPrincipal: "operator",
  };

  it("ignores state and pacing, which do not change what a fire runs", () => {
    expect(sameTriggerDefinition(base, { ...base })).toBe(true);
    expect(sameTriggerDefinition(base, { ...base, fireCount: 9, lastFiredAt: 5, updatedAt: 9, cooldownMs: 1 })).toBe(
      true,
    );
    // Defaults read the same whether stored or absent.
    expect(
      sameTriggerDefinition(base, { ...base, executionType: "agent", messageSource: "manual", debounceMs: 0 }),
    ).toBe(true);
  });

  it("differs when anything a fire runs, sees or answers into changed", () => {
    const changes: Array<Partial<Trigger>> = [
      { name: "renamed" },
      { topic: "ravi.other" },
      { message: "something else" },
      { messageSource: "catalog" },
      { messageTemplateId: "tpl" },
      { filter: 'data.kind == "x"' },
      { agentId: "other" },
      { accountId: "acc" },
      { session: "elsewhere" },
      { replySession: "chat" },
      { replySource: { channel: "whatsapp", accountId: "acc", chatId: "chat" } },
      { executionType: "shell" },
      { debounceMs: 2000 },
      { enabled: false },
    ];
    for (const change of changes) {
      expect(sameTriggerDefinition(base, { ...base, ...change })).toBe(false);
    }
  });
});

describe("the runs-as warning", () => {
  it("says nothing for a trigger that acts as the operator, agent or shell", () => {
    expect(triggerRunsAsWarning({ id: "trg_1", ownerPrincipal: "operator", executionType: "agent" })).toBeNull();
    expect(triggerRunsAsWarning({ id: "trg_1", ownerPrincipal: "operator", executionType: "shell" })).toBeNull();
  });

  it("says a shell trigger that does not act as the operator will not run", () => {
    for (const ownerPrincipal of [undefined, "contact:c_ana"]) {
      const warning = triggerRunsAsWarning({ id: "trg_1", ownerPrincipal, executionType: "shell" });
      expect(warning).toContain("TRIGGER_SHELL_NOT_OPERATOR");
      expect(warning).toContain("without running the command");
    }
  });

  it("says a contact's trigger acts as that person and needs their link", () => {
    const warning = triggerRunsAsWarning({ id: "trg_1", ownerPrincipal: "contact:c_ana" });
    expect(warning).toContain("Trigger trg_1 runs as contact:c_ana, not the operator");
    expect(warning).toContain("ACTOR_NOT_LINKED");
    expect(warning).not.toMatch(/^Warning:/);
  });

  it("says a trigger nobody owns is refused, and that only creating it gives it an owner", () => {
    for (const ownerPrincipal of [undefined, "agent:helper"]) {
      const warning = triggerRunsAsWarning({ id: "trg_1", ownerPrincipal });
      expect(warning).toContain("ACTOR_UNKNOWN");
      expect(warning).toContain("Only the turn that creates a trigger owns it");
      expect(warning).not.toContain("triggers set");
    }
  });
});

describe("the warning for an edit that took the owner away", () => {
  it("is said only when the trigger had an owner and now has none", () => {
    const before = { id: "trg_1", ownerPrincipal: "operator", executionType: "agent" as const };
    const lost = triggerOwnerLostWarning(before, {});
    expect(lost).toContain("Trigger trg_1 no longer runs as operator");
    expect(lost).toContain("ACTOR_UNKNOWN");
    expect(lost).toContain("create it again");

    expect(triggerOwnerLostWarning(before, { ownerPrincipal: "operator" })).toBeNull();
    expect(triggerOwnerLostWarning({ id: "trg_1" }, {})).toBeNull();
  });

  it("does not talk about Bases for a shell trigger", () => {
    const lost = triggerOwnerLostWarning({ id: "trg_1", ownerPrincipal: "operator", executionType: "shell" }, {});
    expect(lost).toContain("now has no owner");
    expect(lost).toContain("TRIGGER_SHELL_NOT_OPERATOR");
    expect(lost).not.toContain("ACTOR_UNKNOWN");
  });
});
