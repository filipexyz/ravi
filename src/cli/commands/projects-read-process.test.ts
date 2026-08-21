import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withoutRaviRuntimeContextEnv } from "../../test/ravi-state.js";
import { projectsNextReturnSchema } from "./operational-return-schemas.js";

setDefaultTimeout(90_000);

let stateDir = "";

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const env = withoutRaviRuntimeContextEnv();
  delete env.RAVI_NO_AUDIT;
  delete env.RAVI_SUPPRESS_AUDIT_EVENTS;
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...env, RAVI_HOME: stateDir, RAVI_STATE_DIR: stateDir },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function durableDigest(): Array<{ name: string; sha256: string }> {
  return readdirSync(stateDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith("-shm"))
    .map((entry) => ({
      name: entry.name,
      sha256: createHash("sha256")
        .update(readFileSync(join(stateDir, entry.name)))
        .digest("hex"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function expectReadOnly(args: string[], expectedStatus = 0): CliResult {
  const before = durableDigest();
  const result = runCli(args);
  expect(result.status).toBe(expectedStatus);
  expect(durableDigest()).toEqual(before);
  return result;
}

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-projects-process-"));
  const database = new Database(join(stateDir, "ravi.db"));
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      status TEXT NOT NULL, summary TEXT NOT NULL, hypothesis TEXT NOT NULL,
      next_step TEXT NOT NULL, last_signal_at INTEGER NOT NULL,
      owner_agent_id TEXT, operator_session_name TEXT, created_by TEXT,
      created_by_agent_id TEXT, created_by_session_name TEXT, archived_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE project_links (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, asset_type TEXT NOT NULL,
      asset_id TEXT NOT NULL, role TEXT, metadata_json TEXT, created_by TEXT,
      created_by_agent_id TEXT, created_by_session_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const insert = database.prepare(
    `INSERT INTO projects (
       id, slug, title, status, summary, hypothesis, next_step, last_signal_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    for (let index = 0; index < 30; index += 1) {
      const id = `project-${String(index).padStart(2, "0")}`;
      const slug = `project-${String(index).padStart(2, "0")}`;
      insert.run(id, slug, `Project ${index}`, index === 0 ? "blocked" : "active", "S", "H", "N", 100 - index, 1, 1);
    }
  } finally {
    insert.finalize();
    database.close();
  }
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe("projects read process contract", () => {
  it("keeps audit transport disabled and bounds the next-work payload", () => {
    const result = expectReadOnly(["projects", "next", "--json"]);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      total: number;
      items: unknown[];
      projects: unknown[];
      pagination: { limit: number; returned: number; hasMore: boolean; nextCommand: string };
    };
    expect(payload.total).toBe(30);
    expect(payload.items).toHaveLength(20);
    expect(payload.projects).toEqual(payload.items);
    expect(payload.pagination).toMatchObject({ limit: 20, returned: 20, hasMore: true });
    expect(payload.pagination.nextCommand).toContain("--offset 20");
    expect(projectsNextReturnSchema.safeParse(payload).success).toBe(true);
  });

  it("builds not-found suggestions through the read-only facade", () => {
    const result = expectReadOnly(["projects", "show", "project-99", "--json"], 1);
    const payload = JSON.parse(result.stdout) as { error: { code: string; suggestions: string[] } };
    expect(payload.error.code).toBe("PROJECT_NOT_FOUND");
    expect(payload.error.suggestions.length).toBeGreaterThan(0);
  });

  it("returns a typed status validation error without opening the mutable service", () => {
    const result = expectReadOnly(["projects", "list", "--status", "bogus", "--json"], 1);
    const payload = JSON.parse(result.stdout) as { error: { code: string; validValues: string[] } };
    expect(payload.error.code).toBe("INVALID_PROJECT_STATUS");
    expect(payload.error.validValues).toEqual(["active", "paused", "blocked", "done", "archived"]);
  });
});
