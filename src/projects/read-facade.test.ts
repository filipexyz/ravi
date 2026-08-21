import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  AmbiguousProjectReferenceError,
  AmbiguousProjectResourceReferenceError,
  ProjectsReadFacade,
  ProjectsReadSchemaError,
  readProjectsSnapshot,
} from "./read-facade.js";

const roots: string[] = [];
const originalStateDir = process.env.RAVI_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-projects-read-"));
  roots.push(root);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  process.env.RAVI_STATE_DIR = state;
  return state;
}

function createFixture(): string {
  const path = join(stateDir(), "ravi.db");
  const database = new Database(path);
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
    CREATE TABLE tag_definitions (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE tag_bindings (
      id TEXT PRIMARY KEY, tag_id TEXT NOT NULL, asset_type TEXT NOT NULL,
      asset_id TEXT NOT NULL, metadata_json TEXT, source TEXT, created_by TEXT,
      updated_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE workflow_specs (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_spec_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE workflow_node_runs (
      id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, spec_node_key TEXT NOT NULL,
      label TEXT NOT NULL, node_kind TEXT NOT NULL, requirement TEXT NOT NULL,
      release_mode TEXT NOT NULL, status TEXT NOT NULL, current_task_id TEXT,
      last_task_transition_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
      priority TEXT NOT NULL, progress INTEGER NOT NULL
    );
    INSERT INTO projects VALUES
      ('project-1', 'alpha', 'Alpha', 'active', 'Summary A', 'Hypothesis A', 'Next A', 200,
       'agent-a', 'session-a', NULL, NULL, NULL, NULL, 100, 200),
      ('project-2', 'beta', 'Beta', 'blocked', 'Summary B', 'Hypothesis B', 'Next B', 100,
       NULL, NULL, NULL, NULL, NULL, NULL, 100, 100);
    INSERT INTO tag_definitions VALUES ('tag-1', 'important');
    INSERT INTO tag_bindings VALUES
      ('binding-1', 'tag-1', 'project', 'alpha', NULL, 'ravi', NULL, NULL, 100, 100);
    INSERT INTO project_links VALUES
      ('link-workflow', 'project-1', 'workflow', 'workflow-1', 'primary', NULL, NULL, NULL, NULL, 100, 200),
      ('resource-1', 'project-1', 'resource', 'repo:a', NULL,
       '{"type":"repo","locator":"https://example.test/a","label":"Code"}', NULL, NULL, NULL, 100, 100),
      ('resource-2', 'project-1', 'resource', 'repo:b', NULL,
       '{"type":"repo","locator":"https://example.test/b","label":"Docs"}', NULL, NULL, NULL, 100, 90);
    INSERT INTO workflow_specs VALUES ('spec-1', 'Release');
    INSERT INTO workflow_runs VALUES ('workflow-1', 'spec-1', 'Release run', 'blocked', 200);
    INSERT INTO workflow_node_runs VALUES
      ('node-1', 'workflow-1', 'ship', 'Ship', 'task', 'required', 'manual', 'blocked', 'task-1', 190, 200);
    INSERT INTO tasks VALUES ('task-1', 'Publish', 'blocked', 'high', 40);
  `);
  database.close();
  return path;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("projects read facade", () => {
  it("does not create a database when the state is absent", () => {
    const state = stateDir();
    rmSync(state, { recursive: true, force: true });

    const snapshot = readProjectsSnapshot();

    expect(snapshot.databaseExists).toBe(false);
    expect(snapshot.projects).toEqual([]);
    expect(existsSync(join(state, "ravi.db"))).toBe(false);
  });

  it("reads projects, tags, workflows and resources without changing durable bytes", () => {
    const path = createFixture();
    const before = sha256(path);

    const facade = new ProjectsReadFacade();
    const list = facade.list({ tagSlug: "important" });
    const details = facade.get("alpha");
    const resource = facade.resource("project-1", "Code");

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "project-1", linkCount: 3 });
    expect(details).toMatchObject({
      project: { id: "project-1", slug: "alpha" },
      workflowAggregate: { total: 1, blocked: 1, overallStatus: "blocked" },
      operational: {
        hottestWorkflowRunId: "workflow-1",
        hottestNodeKey: "ship",
        hottestTaskId: "task-1",
        hottestTaskProgress: 40,
      },
    });
    expect(resource).toMatchObject({ id: "resource-1", resourceType: "repo" });
    expect(sha256(path)).toBe(before);
  });

  it("fails closed when an id collides with another project slug", () => {
    const path = createFixture();
    const database = new Database(path);
    database.run(
      `INSERT INTO projects VALUES
       ('alpha', 'collision', 'Collision', 'active', 'S', 'H', 'N', 1,
        NULL, NULL, NULL, NULL, NULL, NULL, 1, 1)`,
    );
    database.close();

    const facade = new ProjectsReadFacade();
    expect(() => facade.get("alpha")).toThrow(AmbiguousProjectReferenceError);
  });

  it("fails closed when two resources share a human label", () => {
    const path = createFixture();
    const database = new Database(path);
    database.run(
      `UPDATE project_links
       SET metadata_json = '{"type":"repo","locator":"https://example.test/b","label":"Code"}'
       WHERE id = 'resource-2'`,
    );
    database.close();

    const facade = new ProjectsReadFacade();
    expect(() => facade.resource("alpha", "code")).toThrow(AmbiguousProjectResourceReferenceError);
  });

  it("rejects an incompatible projects schema instead of migrating it", () => {
    const path = join(stateDir(), "ravi.db");
    const database = new Database(path);
    database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY)");
    database.close();
    const before = sha256(path);

    expect(() => readProjectsSnapshot()).toThrow(ProjectsReadSchemaError);
    expect(sha256(path)).toBe(before);
  });
});
