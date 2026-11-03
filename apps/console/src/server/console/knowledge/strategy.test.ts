import { describe, expect, test } from "bun:test";

import { ensureKnowledgeStrategy } from "./strategy";

// The create-then-reuse behaviour runs against Postgres in e2e.db.test.ts.
describe("ensureKnowledgeStrategy", () => {
  test("reuses an existing lexical-v1 strategy without writing", async () => {
    const writes: string[] = [];
    const fake = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ strategyId: "strategy-1", indexId: "index-1" }] }) }),
      }),
      insert: () => {
        writes.push("insert");
        throw new Error("unexpected write");
      },
      update: () => {
        writes.push("update");
        throw new Error("unexpected write");
      },
    };
    const result = await ensureKnowledgeStrategy("org-1", fake as never);
    expect(result).toEqual({ indexId: "index-1", strategyId: "strategy-1", createdNow: false });
    expect(writes).toEqual([]);
  });
});
