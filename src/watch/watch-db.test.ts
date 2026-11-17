import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRouterDb } from "../router/router-db.js";
import { readLocalWatchSnapshot, writeLocalWatchSnapshot } from "./local-state.js";
import { deleteWatch, getWatch, listWatches, markWatchEventDelivered, upsertWatch } from "./watch-db.js";

/**
 * O id do watch local é determinístico: provider + resourceRef + eventTypes.
 * Apagar e recriar o mesmo watch reencontra a linha soft-deleted, e o upsert
 * precisa revivê-la. Antes ele filtrava `deleted_at IS NULL`, caía no INSERT e
 * morria com `UNIQUE constraint failed: watches.id` — o watch local de CI nunca
 * nascia e o follow ficava mudo. Estes testes fixam o ciclo create → delete →
 * create.
 */
const DETERMINISTIC_ID = "watch_a0e7071635cd7c40fbbf2fe7";

function localWatch(overrides: Partial<Parameters<typeof upsertWatch>[0]> = {}) {
  return {
    id: DETERMINISTIC_ID,
    name: "github:filipexyz/ravi",
    provider: "github",
    placement: "local" as const,
    status: "active" as const,
    resourceRef: "filipexyz/ravi",
    eventTypes: ["pull_request.opened", "workflow_run.failed"],
    filters: { managedBy: "gh-follow" },
    delivery: null,
    eventSubjects: ["ravi.watch.github.pull_request.opened", "ravi.watch.github.workflow_run.failed"],
    ...overrides,
  };
}

describe("watch db upsert over soft-deleted rows", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.RAVI_STATE_DIR;
    stateDir = mkdtempSync(join(tmpdir(), "ravi-watch-db-"));
    process.env.RAVI_STATE_DIR = stateDir;
    closeRouterDb();
  });

  afterEach(() => {
    closeRouterDb();
    if (previousStateDir === undefined) {
      delete process.env.RAVI_STATE_DIR;
    } else {
      process.env.RAVI_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("revives the same deterministic id instead of failing on the primary key", () => {
    const created = upsertWatch(localWatch());
    expect(created.status).toBe("active");

    expect(deleteWatch(DETERMINISTIC_ID)).toBe(true);
    expect(getWatch(DETERMINISTIC_ID)).toBeNull();
    expect(listWatches({}).total).toBe(0);

    // Não pode lançar `UNIQUE constraint failed: watches.id`.
    const revived = upsertWatch(localWatch({ eventTypes: ["workflow_run.failed"] }));

    expect(revived.id).toBe(DETERMINISTIC_ID);
    expect(revived.status).toBe("active");
    expect(revived.deletedAt).toBeNull();
    expect(revived.eventTypes).toEqual(["workflow_run.failed"]);
    expect(revived.filters).toEqual({ managedBy: "gh-follow" });
    expect(getWatch(DETERMINISTIC_ID)?.id).toBe(DETERMINISTIC_ID);
    expect(listWatches({}).total).toBe(1);
  });

  it("does not inherit the `deleted` status in the revived row", () => {
    upsertWatch(localWatch());
    deleteWatch(DETERMINISTIC_ID);

    // Sem status explícito o upsert herdaria `deleted` da linha antiga.
    const revived = upsertWatch(localWatch());
    expect(revived.status).toBe("active");
    expect(revived.disabledAt).toBeNull();
  });

  it("honors an explicit disabled status when reviving", () => {
    upsertWatch(localWatch());
    deleteWatch(DETERMINISTIC_ID);

    const revived = upsertWatch(localWatch({ status: "disabled" }));
    expect(revived.status).toBe("disabled");
    expect(revived.disabledAt).not.toBeNull();
  });

  it("starts a fresh lifecycle: stale metrics and local snapshot are dropped", () => {
    upsertWatch(localWatch());
    markWatchEventDelivered(DETERMINISTIC_ID);
    writeLocalWatchSnapshot(DETERMINISTIC_ID, { version: 1, pullRequests: {}, workflowRuns: {} }, stateDir);
    expect(readLocalWatchSnapshot(DETERMINISTIC_ID, stateDir)).not.toBeNull();
    deleteWatch(DETERMINISTIC_ID);

    const revived = upsertWatch(localWatch());
    expect(revived.lastEventAt).toBeNull();
    expect(readLocalWatchSnapshot(DETERMINISTIC_ID, stateDir)).toBeNull();
  });

  it("keeps normal updates untouched when the row is not deleted", () => {
    upsertWatch(localWatch());
    markWatchEventDelivered(DETERMINISTIC_ID);
    const createdAt = getWatch(DETERMINISTIC_ID)!.createdAt;

    const updated = upsertWatch(localWatch({ name: "renamed" }));
    expect(updated.name).toBe("renamed");
    expect(updated.createdAt).toBe(createdAt);
    expect(updated.lastEventAt).not.toBeNull();
    expect(updated.deletedAt).toBeNull();
  });
});
