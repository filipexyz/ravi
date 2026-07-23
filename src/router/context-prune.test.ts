import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateContext, dbListContexts, dbPruneContexts } from "./router-db.js";

let stateDir: string | null = null;

const DAY = 24 * 60 * 60 * 1000;

function makeContext(id: string, fields: { createdAt: number; expiresAt?: number; revokedAt?: number }) {
  dbCreateContext({
    contextId: id,
    contextKey: `key-${id}`,
    kind: "turn-runtime",
    capabilities: [],
    createdAt: fields.createdAt,
    ...(fields.expiresAt != null ? { expiresAt: fields.expiresAt } : {}),
    ...(fields.revokedAt != null ? { revokedAt: fields.revokedAt } : {}),
  });
}

describe("dbPruneContexts", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-context-prune-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("prunes old inactive contexts and keeps active or recent ones", () => {
    const now = Date.now();
    makeContext("active", { createdAt: now - 30 * DAY, expiresAt: now + DAY }); // active
    makeContext("expired-old", { createdAt: now - 30 * DAY, expiresAt: now - 10 * DAY }); // inactive + old
    makeContext("revoked-old", { createdAt: now - 30 * DAY, revokedAt: now - 10 * DAY }); // inactive + old
    makeContext("expired-recent", { createdAt: now - DAY, expiresAt: now - 1000 }); // inactive but recent

    const planned = dbPruneContexts({ olderThanMs: 7 * DAY });
    expect(planned).toMatchObject({ matched: 2, pruned: 0 });

    const pruned = dbPruneContexts({ apply: true, olderThanMs: 7 * DAY });
    expect(pruned).toMatchObject({ matched: 2, pruned: 2 });

    const remaining = dbListContexts({ includeInactive: true })
      .map((c) => c.contextId)
      .sort();
    expect(remaining).toEqual(["active", "expired-recent"]);
  });

  it("with no retention prunes all inactive contexts but never active ones", () => {
    const now = Date.now();
    makeContext("active", { createdAt: now, expiresAt: now + DAY });
    makeContext("expired", { createdAt: now, expiresAt: now - 1000 });
    makeContext("revoked", { createdAt: now, revokedAt: now - 1000 });

    const pruned = dbPruneContexts({ apply: true });
    expect(pruned).toMatchObject({ matched: 2, pruned: 2 });
    expect(dbListContexts({ includeInactive: true }).map((c) => c.contextId)).toEqual(["active"]);
  });
});
