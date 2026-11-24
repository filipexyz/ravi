import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { dbCreateCronJob, dbListCronJobs } from "../cron/cron-db.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { getRaviStateDir } from "../utils/paths.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbUpsertObserverRule } from "../runtime/observation-plane.js";
import { dbCreateTrigger, dbListTriggers } from "../triggers/triggers-db.js";
import { runCanonicalFollowWrite } from "./user-overlay-automation.js";

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

  it("still lets code outside a turn write (daemon, terminal)", () => {
    expect(() => dbCreateTrigger({ name: "operator", topic: "ravi.watch.github.>", message: "ok" })).not.toThrow();
  });
});

describe("the canonical-follow scope of the automation store guard", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-automation-store-guard-follow-");
  });
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const canonical = { name: "gh-follow:o/r#7", topic: "ravi.watch.github.*", message: "fixed", enabled: true };

  it("lets a turn held below the agent write exactly the follow the scope names, and nothing else", () => {
    runWithContext(personTurnHeldBelowBreakGlass(), () => {
      runCanonicalFollowWrite({ fields: canonical }, () => dbCreateTrigger({ ...canonical }));
      // Same scope, different instruction / extra field: still the plain refusal.
      expect(() =>
        runCanonicalFollowWrite({ fields: canonical }, () => dbCreateTrigger({ ...canonical, message: "other" })),
      ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
      expect(() =>
        runCanonicalFollowWrite({ fields: canonical }, () =>
          dbCreateTrigger({ ...canonical, executionType: "shell", shellCommand: "id" } as never),
        ),
      ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    });
    expect(dbListTriggers().map((trigger) => trigger.name)).toEqual(["gh-follow:o/r#7"]);
  });

  it("does not outlive the write: the next write in the same turn is refused again", () => {
    runWithContext(personTurnHeldBelowBreakGlass(), () => {
      runCanonicalFollowWrite({ fields: canonical }, () => dbCreateTrigger({ ...canonical }));
      expect(() => dbCreateTrigger({ ...canonical, name: "gh-follow:o/r#8" })).toThrow(
        expect.objectContaining({ code: "PERMISSION_DENIED" }),
      );
    });
  });

  it("takes a synchronous body only, so a continuation can never run inside the scope", () => {
    expect(() => runCanonicalFollowWrite({ fields: canonical }, (async () => undefined) as never)).toThrow(
      /synchronous/,
    );
    expect(() => runCanonicalFollowWrite({ fields: canonical }, (() => Promise.resolve()) as never)).toThrow(/promise/);
  });
});
