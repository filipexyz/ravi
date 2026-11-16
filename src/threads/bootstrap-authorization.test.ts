import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openStateDatabase } from "../db/state-boundary.js";
import type { MaintenanceProcess } from "../runtime-maintenance.js";
import {
  withExitedThreadBootstrapAuthorization,
  withNewIsolatedThreadState,
  type ExitedThreadBootstrapProof,
} from "./bootstrap-authorization.js";
import { prepareThreadFence, readThreadSchemaFence } from "./schema-fence.js";

const roots: string[] = [];
const handles: Database[] = [];
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ravi-bootstrap-proof-"));
  roots.push(path);
  return path;
}
function legacy(path: string): Database {
  const db = openStateDatabase(path);
  handles.push(db);
  db.exec("CREATE TABLE pending_work (id TEXT); INSERT INTO pending_work VALUES ('preserved')");
  return db;
}
function audit(path: string): { reason: string; evidence?: unknown[] } {
  return JSON.parse(readFileSync(`${path}.thread-bootstrap.jsonl`, "utf8").trim().split("\n").at(-1)!);
}
function exited(name: MaintenanceProcess["name"]): MaintenanceProcess {
  // A disposable process prints its own identity and exits; no Ravi runtime,
  // live DB, broker, launcher, or service-management command is invoked.
  const result = spawnSync(process.execPath, ["--no-env-file", "-e", "console.log(process.pid)"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH },
    cwd: tmpdir(),
  });
  expect(result.status).toBe(0);
  return { name, pid: Number(result.stdout.trim()), startedAt: Date.now(), bundleSha256: "a".repeat(64) };
}
function stoppedFixture() {
  const directory = root();
  const databasePath = join(directory, "ravi.db");
  const db = legacy(databasePath);
  const predecessors = [exited("ravi"), exited("ravi-channels")];
  const path = join(directory, "external-completion.json");
  writeFileSync(
    path,
    JSON.stringify({
      databasePath,
      predecessors,
      fixture: "all accepted work persisted, no runtime or launcher in this sandbox",
    }),
  );
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const proof: ExitedThreadBootstrapProof = {
    inventoryComplete: true,
    inventory: [],
    admissionsClosed: true,
    launchersExcluded: true,
    exclusionEvidence: { path, sha256 },
    completion: predecessors.map((process) => ({
      process,
      admissionsClosed: true,
      launcherDisabled: true,
      evidencePath: path,
      evidenceSha256: sha256,
    })),
  };
  return { databasePath, db, predecessors, proof, verify: () => proof };
}

describe("thread bootstrap authorization", () => {
  it("legacy process alive without external proof blocks before schema mutation", () => {
    const f = stoppedFixture();
    const before = f.db.query("SELECT type, name, sql FROM sqlite_master").all();
    f.predecessors[0]!.pid = process.pid;
    let verified = false;
    expect(() =>
      withExitedThreadBootstrapAuthorization(
        {
          ...f,
          verify: () => {
            verified = true;
            return f.proof;
          },
        },
        () => prepareThreadFence(f.db),
      ),
    ).toThrow("present or its physical exit is unknown");
    expect(verified).toBe(false);
    expect(f.db.query("SELECT type, name, sql FROM sqlite_master").all()).toEqual(before);
  });

  it("no legacy process in exclusively created isolated state permits legacy schema upgrade and logs why", () => {
    withNewIsolatedThreadState(root(), (directory) => {
      const path = join(directory, "ravi.db");
      const db = legacy(path);
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
      prepareThreadFence(db);
      expect(readThreadSchemaFence(db).phase).toBe("legacy_ready");
      expect(db.query("SELECT * FROM pending_work").all()).toEqual([{ id: "preserved" }]);
      expect(audit(path).reason).toBe("exclusively-created-isolated-state");
    });
  });

  it("legacy processes proven exited with completion and launcher exclusion permit bootstrap with evidence logged", () => {
    const f = stoppedFixture();
    withExitedThreadBootstrapAuthorization(f, () => prepareThreadFence(f.db));
    expect(readThreadSchemaFence(f.db).phase).toBe("legacy_ready");
    expect(f.db.query("SELECT * FROM pending_work").all()).toEqual([{ id: "preserved" }]);
    expect(audit(f.databasePath)).toMatchObject({ reason: "verified-predecessor-exits" });
    expect(audit(f.databasePath).evidence).toHaveLength(3);
  });

  it("dead predecessors without completion, exclusion or a complete inventory still block", () => {
    const f = stoppedFixture();
    for (const override of [{ completion: [] }, { launchersExcluded: false }, { inventoryComplete: false }]) {
      expect(() =>
        withExitedThreadBootstrapAuthorization(
          { ...f, verify: () => ({ ...f.proof, ...override }) as ExitedThreadBootstrapProof },
          () => prepareThreadFence(f.db),
        ),
      ).toThrow("unproven");
    }
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
  });

  it("replacement process and changed evidence block even after predecessor exit", () => {
    const f = stoppedFixture();
    f.proof.inventory = [{ ...f.predecessors[0]!, pid: process.pid }];
    expect(() => withExitedThreadBootstrapAuthorization(f, () => prepareThreadFence(f.db))).toThrow(
      "unaccounted process",
    );
    f.proof.inventory = [];
    writeFileSync(f.proof.exclusionEvidence.path, "changed proof");
    expect(() => withExitedThreadBootstrapAuthorization(f, () => prepareThreadFence(f.db))).toThrow(
      "external evidence changed",
    );
  });

  it("a path label or populated isolated database without an ownership scope is not proof", () => {
    const db = legacy(join(root(), "ravi.db"));
    expect(() => prepareThreadFence(db)).toThrow("BOOTSTRAP_BLOCKED");
  });

  it("authorization is bound to the database inode and cannot authorize another database", () => {
    const other = legacy(join(root(), "ravi.db"));
    withNewIsolatedThreadState(root(), () => {
      expect(() => prepareThreadFence(other)).toThrow("different database identity");
    });
    withNewIsolatedThreadState(root(), (directory) => {
      const path = join(directory, "ravi.db");
      renameSync(path, `${path}.original`);
      const replacement = legacy(path);
      expect(() => prepareThreadFence(replacement)).toThrow("different database identity");
    });
  });

  it("detached callbacks cannot inherit authorization after the synchronous owner returns", async () => {
    let late!: Promise<void>;
    withNewIsolatedThreadState(root(), (directory) => {
      const db = legacy(join(directory, "ravi.db"));
      late = Promise.resolve().then(() => {
        expect(() => prepareThreadFence(db)).toThrow("BOOTSTRAP_BLOCKED");
      });
    });
    await late;
  });

  it("a cached SQLite handle to a replaced file cannot borrow authorization for the replacement", () => {
    const f = stoppedFixture();
    renameSync(f.databasePath, `${f.databasePath}.old`);
    const replacement = legacy(f.databasePath);
    expect(() => withExitedThreadBootstrapAuthorization(f, () => prepareThreadFence(f.db))).toThrow(
      "opened SQLite connection does not match",
    );
    expect(replacement.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
    // SQLite itself refuses queries on a moved open file. Reopen the original
    // by its new name to prove neither file received a fence or lost its work.
    f.db.close();
    handles.splice(handles.indexOf(f.db), 1);
    const original = openStateDatabase(`${f.databasePath}.old`, { readonly: true, create: false });
    handles.push(original);
    expect(original.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
    expect(original.query("SELECT * FROM pending_work").all()).toEqual([{ id: "preserved" }]);
  });

  it("a verifier cannot open a transaction that delays commit beyond its exclusion scope", () => {
    const f = stoppedFixture();
    expect(() =>
      withExitedThreadBootstrapAuthorization(
        {
          ...f,
          verify: () => {
            f.db.exec("BEGIN");
            return f.proof;
          },
        },
        () => prepareThreadFence(f.db),
      ),
    ).toThrow("verifier opened an outer transaction");
    f.db.exec("ROLLBACK");
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
  });

  it("async external verifier is refused before any fence SQL", () => {
    const f = stoppedFixture();
    const verify = (async () => f.proof) as unknown as typeof f.verify;
    expect(() => withExitedThreadBootstrapAuthorization({ ...f, verify }, () => prepareThreadFence(f.db))).toThrow(
      "synchronous",
    );
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
  });

  it("bootstrap cannot defer its commit beyond the authorization scope", () => {
    withNewIsolatedThreadState(root(), (directory) => {
      const db = legacy(join(directory, "ravi.db"));
      db.exec("BEGIN");
      expect(() => prepareThreadFence(db)).toThrow("own its committed transaction");
      db.exec("ROLLBACK");
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
    });
  });
});
