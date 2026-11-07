import { afterEach, describe, expect, it } from "bun:test";
import { sleep, spawn } from "bun";
import { Database } from "bun:sqlite";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonSchemaPhase } from "./daemon-schema-owner.js";
import { acquireSchemaFileLock, withSchemaMigrationLock } from "./schema-lock.js";

const fixture = join(import.meta.dir, "fixtures/schema-lock-worker.ts");
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
const grandchildren: number[] = [];

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-schema-lock-test-")));
  roots.push(root);
  return root;
}

function worker(root: string, mode: string, name: string, resource?: string) {
  const startedAt = Date.now();
  const child = spawn([process.execPath, "--no-env-file", fixture, mode, root, name, ...(resource ? [resource] : [])], {
    cwd: root,
    env: { RAVI_STATE_DIR: root, TZ: "UTC" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return { child, pid: child.pid, startedAt };
}

async function waitFor(check: () => boolean, description: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(5);
  }
}

async function marker(root: string, name: string, stage: string): Promise<void> {
  await waitFor(() => existsSync(join(root, `${name}.${stage}`)), `${name}.${stage}`);
}

function release(root: string, name: string, stage = "release"): void {
  writeFileSync(join(root, `${name}.${stage}`), "go");
}

async function finished(child: ReturnType<typeof worker>): Promise<void> {
  await waitFor(() => child.child.exitCode !== null, `worker ${child.pid} exit`);
  const error = await new Response(child.child.stderr).text();
  expect(error).toBe("");
  expect(await child.child.exited).toBe(0);
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schema locks with independent processes", () => {
  it("serializes two real migrations including their inspection and own BEGIN/COMMIT", async () => {
    const root = temporaryRoot();
    const path = join(root, "shared.db");
    const first = worker(root, "migrate", "first", path);
    await marker(root, "first", "entered");
    const second = worker(root, "migrate-contender", "second", path);
    await marker(root, "second", "blocked");
    expect(existsSync(join(root, "second.entered"))).toBe(false);
    release(root, "first");
    await Promise.all([finished(first), finished(second)]);
    expect(readFileSync(join(root, "events.log"), "utf8")).toBe("enter:first\nexit:first\nenter:second\nexit:second\n");
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query("SELECT name FROM migrations ORDER BY name").all()).toEqual([
        { name: "first" },
        { name: "second" },
      ]);
    } finally {
      db.close();
    }
  });

  it("does not steal a stopped owner's lock, and SIGKILL releases the same persistent inode", async () => {
    const root = temporaryRoot();
    const path = join(root, "owner.lock");
    const owner = worker(root, "hold", "owner", path);
    await marker(root, "owner", "acquired");
    const inode = statSync(path).ino;
    owner.child.kill("SIGSTOP");
    const blocked = worker(root, "try", "blocked", path);
    await marker(root, "blocked", "busy");
    await finished(blocked);
    expect(existsSync(join(root, "blocked.acquired"))).toBe(false);
    owner.child.kill("SIGKILL");
    await owner.child.exited;
    const successor = worker(root, "try", "successor", path);
    await finished(successor);
    expect(existsSync(join(root, "successor.acquired"))).toBe(true);
    expect(statSync(path).ino).toBe(inode);
  });

  it("converges symlinked directories and symlinked database files on one migration lock", async () => {
    const root = temporaryRoot();
    const path = join(root, "canonical.db");
    const db = new Database(path);
    db.close();
    const aliasRoot = join(root, "alias-directory");
    symlinkSync(root, aliasRoot);
    const aliasFile = join(root, "alias.db");
    symlinkSync(path, aliasFile);
    const owner = worker(root, "hold", "owner", `${path}.schema.lock`);
    await marker(root, "owner", "acquired");
    const aliasProbe = worker(root, "try", "alias-probe", join(aliasRoot, "canonical.db.schema.lock"));
    await marker(root, "alias-probe", "busy");
    await finished(aliasProbe);
    const contender = worker(root, "migrate", "alias-migration", aliasFile);
    await marker(root, "alias-migration", "started");
    // A second process proves the owner still excludes a lock claimant before release.
    const secondProbe = worker(root, "try", "second-probe", `${path}.schema.lock`);
    await marker(root, "second-probe", "busy");
    await finished(secondProbe);
    expect(existsSync(join(root, "alias-migration.entered"))).toBe(false);
    release(root, "owner");
    await marker(root, "alias-migration", "entered");
    release(root, "alias-migration");
    await Promise.all([finished(owner), finished(contender)]);
    expect(existsSync(`${aliasFile}.schema.lock`)).toBe(false);
  });

  it("refuses hardlinked databases before invoking the migration", () => {
    const root = temporaryRoot();
    const path = join(root, "original.db");
    const db = new Database(path);
    linkSync(path, join(root, "alias.db"));
    let invoked = false;
    try {
      expect(() =>
        withSchemaMigrationLock(db, () => {
          invoked = true;
        }),
      ).toThrow("hardlinked");
      expect(invoked).toBe(false);
      expect(existsSync(`${path}.schema.lock`)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("releases a failed migration for a different process without deleting the lock", async () => {
    const root = temporaryRoot();
    const path = join(root, "failed.db");
    const db = new Database(path);
    try {
      expect(() =>
        withSchemaMigrationLock(db, () => {
          throw new Error("migration failed");
        }),
      ).toThrow("migration failed");
    } finally {
      db.close();
    }
    const inode = statSync(`${path}.schema.lock`).ino;
    const successor = worker(root, "try", "successor", `${path}.schema.lock`);
    await finished(successor);
    expect(existsSync(join(root, "successor.acquired"))).toBe(true);
    expect(statSync(`${path}.schema.lock`).ino).toBe(inode);
  });

  it("preserves cascading children when two processes race a foreign-key table rebuild", async () => {
    const root = temporaryRoot();
    const path = join(root, "credentials.db");
    const db = new Database(path);
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE connections (id TEXT PRIMARY KEY, backend TEXT CHECK (backend IN ('keychain')));
      CREATE TABLE scopes (connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE, scope TEXT);
      INSERT INTO connections VALUES ('connection', 'keychain');
      INSERT INTO scopes VALUES ('connection', 'read');
    `);
    db.close();
    const first = worker(root, "foreign-keys", "first", path);
    await marker(root, "first", "inspected");
    const second = worker(root, "foreign-keys", "second", path);
    await marker(root, "second", "started");
    const blocked = worker(root, "try", "blocked", `${path}.schema.lock`);
    await marker(root, "blocked", "busy");
    await finished(blocked);
    expect(existsSync(join(root, "second.inspected"))).toBe(false);
    release(root, "first");
    await Promise.all([finished(first), finished(second)]);
    const checked = new Database(path, { readonly: true });
    try {
      expect(checked.query("SELECT * FROM scopes").all()).toEqual([{ connection_id: "connection", scope: "read" }]);
      expect(checked.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(existsSync(join(root, "second.inspected"))).toBe(false);
    } finally {
      checked.close();
    }
  });

  it("does not let an exec'd child prolong its exited parent's lock", async () => {
    const root = temporaryRoot();
    const path = join(root, "parent.lock");
    const owner = worker(root, "inherit", "owner", path);
    await marker(root, "owner", "child");
    const childPid = Number(readFileSync(join(root, "owner.child"), "utf8"));
    grandchildren.push(childPid);
    await finished(owner);
    expect(() => process.kill(childPid, 0)).not.toThrow();
    const successor = worker(root, "try", "successor", path);
    await finished(successor);
    expect(existsSync(join(root, "successor.acquired"))).toBe(true);
    release(root, "grandchild");
  });

  it("keeps a daemon successor out of SQLite until the owner exits and distinguishes owned from ready", async () => {
    const root = temporaryRoot();
    const owner = worker(root, "daemon", "owner");
    await marker(root, "owner", "owned");
    expect(readDaemonSchemaPhase(owner, root)).toBe("owned");
    release(root, "owner", "ready-go");
    await marker(root, "owner", "ready");
    expect(readDaemonSchemaPhase(owner, root)).toBe("ready");
    const successor = worker(root, "daemon", "successor");
    await waitFor(() => readDaemonSchemaPhase(successor, root) === "waiting", "successor waiting receipt");
    expect(existsSync(join(root, "successor.db"))).toBe(false);
    expect(existsSync(join(root, "successor.owned"))).toBe(false);
    release(root, "owner");
    await finished(owner);
    await marker(root, "successor", "owned");
    expect(readDaemonSchemaPhase(successor, root)).toBe("owned");
    expect(existsSync(join(root, "successor.ready"))).toBe(false);
    release(root, "successor", "ready-go");
    await marker(root, "successor", "ready");
    expect(readDaemonSchemaPhase(successor, root)).toBe("ready");
    release(root, "successor");
    await finished(successor);
  });

  it("rejects stale PID receipts and missing process start identity", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "runtime-processes"));
    writeFileSync(
      join(root, "runtime-processes/schema-owner-123.json"),
      JSON.stringify({
        protocol: 1,
        pid: 123,
        phase: "ready",
        observedAt: 1_000,
      }),
    );
    expect(readDaemonSchemaPhase({ pid: 123, startedAt: 1_001 }, root)).toBe(null);
    expect(readDaemonSchemaPhase({ pid: 123 }, root)).toBe(null);
    expect(readDaemonSchemaPhase({ pid: 123, startedAt: 999 }, root)).toBe("ready");
  });

  it("retains a reentrant lock until the final release", async () => {
    const root = temporaryRoot();
    const path = join(root, "reentrant.lock");
    const outer = acquireSchemaFileLock(path);
    const inner = acquireSchemaFileLock(path);
    try {
      outer.release();
      const blocked = worker(root, "try", "blocked", path);
      await marker(root, "blocked", "busy");
      await finished(blocked);
    } finally {
      outer.release();
      inner.release();
    }
    const next = worker(root, "try", "next", path);
    await finished(next);
    expect(existsSync(join(root, "next.acquired"))).toBe(true);
  });
});
