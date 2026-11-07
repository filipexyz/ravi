import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schemaOwnerPath = new URL("./schema-owner.ts", import.meta.url).href;
const schemaLockPath = new URL("./schema-lock.ts", import.meta.url).href;

const stores = [
  { name: "chat", path: "../db.ts", open: "store.getDb()", table: "messages", foreignKeys: 0 },
  { name: "router", path: "../router/router-db.ts", open: "store.getDb()", table: "agents", foreignKeys: 1 },
  {
    name: "devin",
    path: "../devin/store.ts",
    open: "store.ensureDevinSchema()",
    table: "devin_sessions",
    foreignKeys: 1,
  },
] as const;

describe("database setup retry after journal lock contention", () => {
  for (const store of stores) {
    for (const closeThrows of [false, true]) {
      it(`${store.name} discards the failed handle and configures a fresh handle on retry${closeThrows ? " even when close throws" : ""}`, () => {
        const stateDir = mkdtempSync(join(tmpdir(), `ravi-journal-retry-${store.name}-`));
        const storePath = new URL(store.path, import.meta.url).href;
        const script = `
        import { mock } from "bun:test";
        import assert from "node:assert/strict";
        const actualSchema = await import(${JSON.stringify(schemaOwnerPath)});
        const configure = actualSchema.configureStateJournalMode;
        const { SchemaLockBusyError } = await import(${JSON.stringify(schemaLockPath)});
        const contention = new SchemaLockBusyError();
        const handles = [];
        mock.module(${JSON.stringify(schemaOwnerPath)}, () => ({
          ...actualSchema,
          configureStateJournalMode(db) {
            handles.push(db);
            if (handles.length === 1) {
              if (${closeThrows}) {
                const close = db.close.bind(db);
                db.close = () => {
                  close();
                  throw new Error("close failed after releasing the handle");
                };
              }
              throw contention;
            }
            configure(db);
          },
        }));
        const store = await import(${JSON.stringify(storePath)});
        assert.throws(() => { ${store.open}; }, error => error === contention);
        assert.equal(handles.length, 1);
        assert.throws(() => handles[0].query("SELECT 1").get(), "failed setup must close its handle");
        ${store.open};
        assert.equal(handles.length, 2, "retry must run journal setup again");
        assert.notEqual(handles[0], handles[1], "retry must open a fresh handle");
        const db = handles[1];
        assert.equal(db.query("PRAGMA journal_mode").get().journal_mode, "wal");
        assert.equal(db.query("PRAGMA busy_timeout").get().timeout, 5000);
        assert.equal(db.query("PRAGMA foreign_keys").get().foreign_keys, ${store.foreignKeys});
        assert.ok(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(${JSON.stringify(store.table)}));
        assert.equal(db.query("SELECT version FROM state_schema_versions WHERE component=?").get(${JSON.stringify(store.name)}).version, actualSchema.STATE_SCHEMA_VERSION);
        ${store.open};
        assert.equal(handles.length, 2, "successful setup should remain cached");
        console.log("JOURNAL_RETRY_OK");
      `;
        try {
          const result = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
            cwd: stateDir,
            env: {
              RAVI_STATE_DIR: stateDir,
              RAVI_SUPPRESS_AUDIT_EVENTS: "1",
              NATS_URL: "nats://127.0.0.1:1",
              NODE_ENV: "test",
              TZ: "UTC",
            },
            encoding: "utf8",
            timeout: 10_000,
          });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain("JOURNAL_RETRY_OK");
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      });
    }
  }
});
