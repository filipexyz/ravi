import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readSelfSnapshot } from "./self-read-snapshot.js";

const roots: string[] = [];
const originalStateDir = process.env.RAVI_STATE_DIR;

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe("SELF read-only SQLite snapshot", () => {
  it("does not create a missing state directory or database", () => {
    const root = temporaryRoot();
    const missingState = join(root, "missing-state");
    process.env.RAVI_STATE_DIR = missingState;

    expect(readSelfSnapshot({ sessionCandidates: ["main"], includeParticipants: true, messageLimit: 10 })).toEqual({
      session: null,
      binding: null,
      chat: null,
      boundRoute: null,
      sessionRoutes: [],
      participants: [],
      messages: [],
    });
    expect(existsSync(missingState)).toBe(false);
  });

  it("reads an existing database without changing bytes, schema, journal mode, WAL or SHM", () => {
    const root = temporaryRoot();
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    process.env.RAVI_STATE_DIR = stateDir;
    const dbPath = join(stateDir, "ravi.db");
    const fixture = new Database(dbPath, { create: true });
    fixture.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        name TEXT,
        sdk_session_id TEXT,
        runtime_provider TEXT,
        runtime_provider_override TEXT,
        runtime_session_display_id TEXT,
        agent_id TEXT NOT NULL,
        agent_cwd TEXT NOT NULL,
        chat_type TEXT,
        channel TEXT,
        account_id TEXT,
        group_id TEXT,
        subject TEXT,
        display_name TEXT,
        last_channel TEXT,
        last_to TEXT,
        last_account_id TEXT,
        last_thread_id TEXT,
        last_context TEXT,
        model_override TEXT,
        effort_override TEXT,
        thinking_level TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        compaction_count INTEGER NOT NULL DEFAULT 0,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions (
        session_key, name, agent_id, agent_cwd, created_at, updated_at
      ) VALUES ('agent:main:main', 'main', 'main', '/repo', 1000, 2000);
    `);
    const schemaVersion = (fixture.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
    fixture.close();

    const beforeHash = sha256(dbPath);
    const beforeMtime = statSync(dbPath).mtimeMs;
    const beforeFiles = readdirSync(stateDir).sort();

    const snapshot = readSelfSnapshot({
      sessionCandidates: ["agent:main:main", "main"],
      includeParticipants: true,
      messageLimit: 10,
    });

    expect(snapshot.session).toMatchObject({ sessionKey: "agent:main:main", name: "main", agentId: "main" });
    expect(sha256(dbPath)).toBe(beforeHash);
    expect(statSync(dbPath).mtimeMs).toBe(beforeMtime);
    expect(readdirSync(stateDir).sort()).toEqual(beforeFiles);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const verification = new Database(dbPath, { readonly: true, create: false });
    expect((verification.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version).toBe(
      schemaVersion,
    );
    expect((verification.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    verification.close();
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-self-snapshot-"));
  roots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function removeTemporaryRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      globalThis.Bun.gc(true);
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
