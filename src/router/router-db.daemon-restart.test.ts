import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  dbGetDaemonRestartResumeDelivery,
  dbHasDaemonRestartResumeDelivery,
  dbMarkDaemonRestartResumeDelivered,
  dbUpsertDaemonRestartEpoch,
} from "./router-db.js";

describe("daemon restart delivery ledger", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("daemon-restart-delivery-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("records whether a restart delivered a resume or only a notice", () => {
    dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-kind", reason: "version update", createdAt: 1 });

    expect(
      dbMarkDaemonRestartResumeDelivered({
        restartEpoch: "epoch-kind",
        sessionKey: "agent:main:main",
        sessionName: "main",
        deliveryKind: "notice",
        decisionReason: "unsafe_snapshot",
        deliveredAt: 10,
      }),
    ).toBe(true);
    expect(
      dbMarkDaemonRestartResumeDelivered({
        restartEpoch: "epoch-kind",
        sessionKey: "agent:dev:dev",
        sessionName: "dev",
        deliveryKind: "resume",
        decisionReason: "continue",
        deliveredAt: 11,
      }),
    ).toBe(true);

    expect(dbGetDaemonRestartResumeDelivery("epoch-kind", "agent:main:main")).toEqual({
      restartEpoch: "epoch-kind",
      sessionKey: "agent:main:main",
      sessionName: "main",
      deliveryKind: "notice",
      decisionReason: "unsafe_snapshot",
      deliveredAt: 10,
    });
    expect(dbGetDaemonRestartResumeDelivery("epoch-kind", "agent:dev:dev")).toMatchObject({
      deliveryKind: "resume",
      decisionReason: "continue",
    });
  });

  it("keeps the first delivery record for an epoch and session", () => {
    dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-idempotent", reason: "test", createdAt: 1 });
    const base = { restartEpoch: "epoch-idempotent", sessionKey: "agent:main:main", sessionName: "main" };

    expect(dbMarkDaemonRestartResumeDelivered({ ...base, deliveryKind: "notice", deliveredAt: 5 })).toBe(true);
    expect(dbMarkDaemonRestartResumeDelivered({ ...base, deliveryKind: "resume", deliveredAt: 6 })).toBe(false);

    expect(dbGetDaemonRestartResumeDelivery("epoch-idempotent", "agent:main:main")).toMatchObject({
      deliveryKind: "notice",
      deliveredAt: 5,
    });
  });

  it("returns nothing for a session that was never delivered", () => {
    dbUpsertDaemonRestartEpoch({ restartEpoch: "epoch-empty", reason: "test", createdAt: 1 });

    expect(dbHasDaemonRestartResumeDelivery("epoch-empty", "agent:main:main")).toBe(false);
    expect(dbGetDaemonRestartResumeDelivery("epoch-empty", "agent:main:main")).toBeNull();
  });

  it("migrates a legacy delivery table and reads its rows as resume deliveries", () => {
    if (!stateDir) throw new Error("missing isolated state dir");
    const legacy = new Database(join(stateDir, "ravi.db"));
    legacy.exec(`
      CREATE TABLE daemon_restart_epochs (
        restart_epoch TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        caller_session_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE daemon_restart_resume_deliveries (
        restart_epoch TEXT NOT NULL,
        session_key TEXT NOT NULL,
        session_name TEXT,
        delivered_at INTEGER NOT NULL,
        PRIMARY KEY (restart_epoch, session_key),
        FOREIGN KEY(restart_epoch) REFERENCES daemon_restart_epochs(restart_epoch) ON DELETE CASCADE
      );
      INSERT INTO daemon_restart_epochs VALUES ('epoch-legacy', 'legacy', NULL, 1, 1);
      INSERT INTO daemon_restart_resume_deliveries VALUES ('epoch-legacy', 'agent:main:main', 'main', 5);
    `);
    legacy.close();

    expect(dbGetDaemonRestartResumeDelivery("epoch-legacy", "agent:main:main")).toEqual({
      restartEpoch: "epoch-legacy",
      sessionKey: "agent:main:main",
      sessionName: "main",
      deliveryKind: "resume",
      decisionReason: undefined,
      deliveredAt: 5,
    });
    expect(
      dbMarkDaemonRestartResumeDelivered({
        restartEpoch: "epoch-legacy",
        sessionKey: "agent:dev:dev",
        deliveryKind: "notice",
        decisionReason: "missing_snapshot",
      }),
    ).toBe(true);
    expect(dbGetDaemonRestartResumeDelivery("epoch-legacy", "agent:dev:dev")).toMatchObject({
      deliveryKind: "notice",
      decisionReason: "missing_snapshot",
    });
  });
});
