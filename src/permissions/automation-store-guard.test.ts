import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { dbCreateCronJob, dbListCronJobs } from "../cron/cron-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
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

  it("still lets code outside a turn write (daemon, terminal)", () => {
    expect(() => dbCreateTrigger({ name: "operator", topic: "ravi.watch.github.>", message: "ok" })).not.toThrow();
  });
});
