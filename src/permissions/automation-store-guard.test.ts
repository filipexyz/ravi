import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { dbCreateCronJob, dbListCronJobs, dbUpdateCronJob } from "../cron/cron-db.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { getRaviStateDir } from "../utils/paths.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbUpsertObserverRule } from "../runtime/observation-plane.js";
import { dbCreateTrigger, dbListTriggers } from "../triggers/triggers-db.js";

let stateDir: string | null = null;

function personTurnHeldBelowBreakGlass(): ToolContext {
  return {
    contextId: "ctx_person",
    agentId: "full-agent",
    context: {
      contextId: "ctx_person",
      contextKey: "rctx_person",
      kind: "turn-runtime",
      agentId: "full-agent",
      capabilities: [],
      metadata: {
        actorAuthorizationMode: "invoke-only",
        actorBreakGlassWithheld: ["admin:system:*", "execute:executable:*"],
      },
      createdAt: 0,
    },
  };
}

describe("automation store guard on the real stores", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-automation-store-guard-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("refuses a writer that reaches the trigger store directly (watch trigger, page or bug follow, or the next one)", () => {
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () =>
        dbCreateTrigger({ name: "from a person", topic: "ravi.watch.github.>", message: "do anything" }),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(dbListTriggers()).toHaveLength(0);
  });

  it("lets the operator's own relay (a thread they asked for) leave a trigger and a cron job behind", () => {
    const operatorRelay = (): ToolContext => {
      const context = personTurnHeldBelowBreakGlass();
      return {
        ...context,
        context: {
          ...context.context!,
          capabilities: [],
          metadata: { actorAuthorizationMode: "invoke-only", relayNarrowing: true, relayCallerUnrestricted: true },
        },
      };
    };
    runWithContext(operatorRelay(), () => {
      dbCreateTrigger({ name: "gh-follow:o/r#7", topic: "ravi.watch.github.>", message: "ok" });
      dbCreateCronJob({
        name: "from the operator's thread",
        schedule: { type: "every", everyMs: 60_000 },
        message: "ok",
      } as unknown as Parameters<typeof dbCreateCronJob>[0]);
    });
    expect(dbListTriggers().map((trigger) => trigger.name)).toEqual(["gh-follow:o/r#7"]);
    expect(dbListCronJobs()).toHaveLength(1);
  });

  it("still refuses the same writes from a relay of a person held below the agent", () => {
    const heldRelay: ToolContext = {
      ...personTurnHeldBelowBreakGlass(),
      context: {
        ...personTurnHeldBelowBreakGlass().context!,
        capabilities: [],
        metadata: { actorAuthorizationMode: "invoke-only", relayNarrowing: true },
      },
    };
    expect(() =>
      runWithContext(heldRelay, () => dbCreateTrigger({ name: "gh-follow:o/r#7", topic: "x.y", message: "ok" })),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(dbListTriggers()).toHaveLength(0);
  });

  it("refuses a cron job written directly from that turn", () => {
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () =>
        dbCreateCronJob({
          name: "from a person",
          schedule: { type: "every", everyMs: 60_000 },
          message: "do anything",
        } as unknown as Parameters<typeof dbCreateCronJob>[0]),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(dbListCronJobs()).toHaveLength(0);
  });

  it("refuses an observer rule written from that turn (the observer would take turns as the whole agent)", () => {
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () =>
        dbUpsertObserverRule({
          id: "from-person",
          scopeType: "session",
          scopeValue: "s",
          observerAgentId: "full-agent",
        } as unknown as Parameters<typeof dbUpsertObserverRule>[0]),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("refuses moving an agent's workspace or creating an agent from that turn", () => {
    dbCreateAgent({ id: "full-agent", cwd: "/tmp/full-agent" });
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () => dbUpdateAgent("full-agent", { cwd: getRaviStateDir() })),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () => dbCreateAgent({ id: "new-agent", cwd: "/tmp/new" })),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("holds a derived context that inherited only the deny_* capabilities (no metadata)", () => {
    const derived: ToolContext = {
      contextId: "ctx_child",
      agentId: "full-agent",
      context: {
        contextId: "ctx_child",
        contextKey: "rctx_child",
        kind: "app-runtime",
        agentId: "full-agent",
        capabilities: [
          { permission: "admin", objectType: "system", objectId: "*" },
          { permission: "deny_execute", objectType: "executable", objectId: "*" },
        ],
        metadata: {},
        createdAt: 0,
      },
    };
    expect(() =>
      runWithContext(derived, () =>
        dbCreateTrigger({ name: "from a child", topic: "ravi.watch.github.>", message: "do anything" }),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("does not treat an explicit creatorChat: undefined as disable-only on a cron job", () => {
    const job = dbCreateCronJob({
      name: "operator job",
      schedule: { type: "every", everyMs: 60_000 },
      message: "ok",
    } as unknown as Parameters<typeof dbCreateCronJob>[0]);
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () =>
        dbUpdateCronJob(job.id, { creatorChat: undefined } as Parameters<typeof dbUpdateCronJob>[1]),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () => dbUpdateCronJob(job.id, { enabled: false })),
    ).not.toThrow();
  });

  it("lets a limited turn disable an existing observer rule but not create or retarget one with enabled: false", () => {
    dbCreateAgent({ id: "full-agent", cwd: "/tmp/full-agent" });
    dbCreateAgent({ id: "other-agent", cwd: "/tmp/other-agent" });
    const base = { id: "operator-rule", scopeType: "session", scopeValue: "s", observerAgentId: "full-agent" };
    dbUpsertObserverRule(base as unknown as Parameters<typeof dbUpsertObserverRule>[0]);
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () =>
        dbUpsertObserverRule({ id: "operator-rule", observerAgentId: "full-agent", enabled: false } as Parameters<
          typeof dbUpsertObserverRule
        >[0]),
      ),
    ).not.toThrow();
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () =>
        dbUpsertObserverRule({ id: "new-rule", observerAgentId: "full-agent", enabled: false } as Parameters<
          typeof dbUpsertObserverRule
        >[0]),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() =>
      runWithContext(personTurnHeldBelowBreakGlass(), () =>
        dbUpsertObserverRule({ id: "operator-rule", observerAgentId: "other-agent", enabled: false } as Parameters<
          typeof dbUpsertObserverRule
        >[0]),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("still lets code outside a turn write (daemon, terminal)", () => {
    expect(() => dbCreateTrigger({ name: "operator", topic: "ravi.watch.github.>", message: "ok" })).not.toThrow();
  });
});
