import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

setDefaultTimeout(90_000);

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTemporaryRoot(root);
});

describe("SELF native process boundary", () => {
  it("runs with no context touch, SQLite mutation, WAL/SHM creation or secret output", () => {
    const root = temporaryRoot();
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const dbPath = join(stateDir, "ravi.db");
    const contextKey = "rctx_process_secret_value";
    const db = new Database(dbPath, { create: true });
    db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE contexts (
        context_id TEXT PRIMARY KEY,
        context_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        agent_id TEXT,
        session_key TEXT,
        session_name TEXT,
        source_json TEXT,
        capabilities_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO contexts (
        context_id, context_key, kind, agent_id, session_key, session_name,
        source_json, capabilities_json, metadata_json, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ctx_process_self",
      contextKey,
      "agent-runtime",
      "main",
      "agent:main:main",
      "main",
      JSON.stringify({ channel: "test", accountId: "main", chatId: "chat_process" }),
      JSON.stringify([{ permission: "read", objectType: "self", objectId: "*" }]),
      JSON.stringify({ authorization: "Bearer process-secret" }),
      1000,
      1234,
    );
    db.close();

    const beforeHash = sha256(dbPath);
    const beforeFiles = readdirSync(stateDir).sort();
    const result = runCli(root, ["self", "whoami", "--json"], {
      RAVI_STATE_DIR: stateDir,
      RAVI_CONTEXT_KEY: contextKey,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { identity: { contextId: string; lastUsedAt: number } };
    expect(payload.identity).toMatchObject({ contextId: "ctx_process_self", lastUsedAt: 1234 });
    expect(result.stdout).not.toContain(contextKey);
    expect(result.stdout).not.toContain("process-secret");
    expect(sha256(dbPath)).toBe(beforeHash);
    expect(readdirSync(stateDir).sort()).toEqual(beforeFiles);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const verify = new Database(dbPath, { readonly: true, create: false });
    const row = verify.query("SELECT last_used_at FROM contexts WHERE context_id = 'ctx_process_self'").get() as {
      last_used_at: number;
    };
    expect(row.last_used_at).toBe(1234);
    verify.close();
  });

  it("prints root help without any ambient RAVI value", () => {
    const root = temporaryRoot();
    const stateDir = join(root, "missing-state");
    const sentinels = {
      RAVI_AGENT_ID: "ENV_AGENT_SENTINEL",
      RAVI_SESSION_NAME: "ENV_SESSION_SENTINEL",
      RAVI_CHANNEL: "ENV_CHANNEL_SENTINEL",
      RAVI_CHAT_ID: "ENV_CHAT_SENTINEL",
      RAVI_ACCOUNT_ID: "ENV_ACCOUNT_SENTINEL",
      RAVI_ACTOR_TYPE: "ENV_ACTOR_SENTINEL",
      RAVI_CONTACT_ID: "ENV_CONTACT_SENTINEL",
    };
    const result = runCli(root, ["--help"], { RAVI_STATE_DIR: stateDir, ...sentinels });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ravi Operational Context");
    expect(result.stdout).toContain("capabilities: unavailable");
    for (const value of Object.values(sentinels)) expect(result.stdout).not.toContain(value);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("never substitutes a default credential for an invalid tool context key", () => {
    const root = temporaryRoot();
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    const dbPath = join(stateDir, "ravi.db");
    const defaultKey = "rctx_default_must_not_replace_explicit";
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE contexts (
        context_id TEXT PRIMARY KEY,
        context_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        agent_id TEXT,
        session_key TEXT,
        session_name TEXT,
        source_json TEXT,
        capabilities_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
    `);
    db.prepare(
      `INSERT INTO contexts (
        context_id, context_key, kind, agent_id, session_key, session_name,
        capabilities_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ctx_default_tool",
      defaultKey,
      "agent-runtime",
      "default-agent",
      "agent:default-agent:main",
      "main",
      JSON.stringify([{ permission: "read", objectType: "self", objectId: "*" }]),
      Date.now(),
    );
    db.close();

    const credentialsPath = join(root, "credentials.json");
    writeFileSync(
      credentialsPath,
      `${JSON.stringify({
        version: 1,
        default: defaultKey,
        contexts: {
          [defaultKey]: {
            context_id: "ctx_default_tool",
            agent_id: "default-agent",
            label: "default",
            kind: "agent-runtime",
            issued_at: Date.now(),
            expires_at: null,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(credentialsPath, 0o600);

    const script = `
      import { SelfCommands } from "./src/cli/commands/self.ts";
      import { extractTools } from "./src/cli/tools-export.ts";
      const tool = extractTools([SelfCommands]).find((candidate) => candidate.name === "self_whoami");
      const result = await tool.handler({});
      process.stdout.write(JSON.stringify(result));
    `;
    const result = runBunScript(script, {
      RAVI_STATE_DIR: stateDir,
      RAVI_CONTEXT_KEY: "rctx_forged_explicit",
      RAVI_CREDENTIALS_PATH: credentialsPath,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      isError: boolean;
      outcome: string;
      exitCode: number;
      content: Array<{ text: string }>;
    };
    expect(payload).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    expect(JSON.parse(payload.content[0]?.text ?? "{}")).toMatchObject({
      success: false,
      error: { code: "TOOL_CONTEXT_REQUIRED" },
    });
    expect(result.stdout).not.toContain("default-agent");
    expect(result.stdout).not.toContain(defaultKey);
  });
});

function runCli(root: string, args: string[], raviEnv: NodeJS.ProcessEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RAVI_")));
  const result = spawnSync(process.execPath, ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...env,
      ...raviEnv,
      RAVI_CREDENTIALS_PATH: join(root, "missing-credentials.json"),
    },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runBunScript(script: string, raviEnv: NodeJS.ProcessEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RAVI_")));
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...env, ...raviEnv },
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-self-process-"));
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
