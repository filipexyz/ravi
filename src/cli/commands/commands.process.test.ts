import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  withoutRaviRuntimeContextEnv,
} from "../../test/ravi-state.js";

setDefaultTimeout(90_000);

let stateDir = "";
let agentCwd = "";
let logicalStateBefore = "";

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface SourceFileDigest {
  path: string;
  sha256: string;
}

function runCli(args: string[]): CliResult {
  const childEnv = withoutRaviRuntimeContextEnv();
  delete childEnv.RAVI_SUPPRESS_AUDIT_EVENTS;
  delete childEnv.RAVI_NO_AUDIT;
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...childEnv,
      RAVI_HOME: stateDir,
      RAVI_STATE_DIR: stateDir,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sourceDigest(): SourceFileDigest[] {
  const roots = [join(agentCwd, ".ravi", "commands"), join(stateDir, "commands")];
  const files: SourceFileDigest[] = [];
  const visit = (root: string, directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(root, path);
      } else if (entry.isFile()) {
        files.push({
          path: `${relative(root, path).replaceAll("\\", "/")}:${root === roots[0] ? "agent" : "global"}`,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      }
    }
  };
  for (const root of roots) visit(root, root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function stateFileDigest(): SourceFileDigest[] {
  const files: SourceFileDigest[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        files.push({
          path: relative(stateDir, path).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      }
    }
  };
  visit(stateDir);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function logicalStateDigest(): string {
  const path = join(stateDir, "ravi.db");
  if (!existsSync(path)) return createHash("sha256").update("missing").digest("hex");
  const database = new Database(path, { readonly: true, create: false });
  try {
    const tableNames = (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const snapshot = tableNames.map((table) => {
      const escaped = table.replaceAll('"', '""');
      const rows = (database.prepare(`SELECT * FROM "${escaped}"`).all() as Array<Record<string, unknown>>)
        .map((row) => JSON.stringify(row))
        .sort();
      return { table, rows };
    });
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  } finally {
    database.close();
  }
}

function captureState(): { sources: SourceFileDigest[]; files: SourceFileDigest[]; logical: string } {
  const logical = logicalStateDigest();
  return { sources: sourceDigest(), files: stateFileDigest(), logical };
}

function expectStateUnchanged(before: ReturnType<typeof captureState>): void {
  const after = captureState();
  expect(after.sources).toEqual(before.sources);
  expect(after.logical).toBe(before.logical);
  expect(after.files).toEqual(before.files);
}

function expectReadOnlySuccess(args: string[]): Record<string, unknown> {
  const before = captureState();
  const result = runCli(args);

  expect(result).toMatchObject({ status: 0, stderr: "" });
  expectStateUnchanged(before);

  return JSON.parse(result.stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  stateDir = await createIsolatedRaviState("ravi-commands-process-");
  agentCwd = mkdtempSync(join(tmpdir(), "ravi-commands-agent-"));

  const agentCommandsDir = join(agentCwd, ".ravi", "commands");
  const globalCommandsDir = join(stateDir, "commands");
  mkdirSync(agentCommandsDir, { recursive: true });
  mkdirSync(globalCommandsDir, { recursive: true });
  writeFileSync(
    join(agentCommandsDir, "review.md"),
    "---\ntitle: Review\ndescription: Review a change\n---\nReview $ARGUMENTS",
  );
  writeFileSync(join(globalCommandsDir, "notes.md"), "Summarize notes");

  const { dbUpdateAgent, closeRouterDb } = await import("../../router/router-db.js");
  dbUpdateAgent("main", { cwd: agentCwd });
  closeRouterDb();
  logicalStateBefore = logicalStateDigest();
});

afterAll(async () => {
  try {
    expect(logicalStateDigest()).toBe(logicalStateBefore);
  } finally {
    await cleanupIsolatedRaviState(stateDir);
    rmSync(agentCwd, { recursive: true, force: true });
  }
});

describe("commands process contract", () => {
  it("does not inherit test-only audit suppression into native CLI processes", () => {
    const childEnv = withoutRaviRuntimeContextEnv();
    delete childEnv.RAVI_SUPPRESS_AUDIT_EVENTS;
    delete childEnv.RAVI_NO_AUDIT;

    expect(childEnv.RAVI_SUPPRESS_AUDIT_EVENTS).toBeUndefined();
    expect(childEnv.RAVI_NO_AUDIT).toBeUndefined();
  });

  it("prints group help with exit 0 when no operation is supplied", () => {
    const before = captureState();
    const result = runCli(["commands"]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: ravi commands");
    expect(result.stdout).toContain("list [options]");
    expectStateUnchanged(before);
  });

  it("list is paginated, projected, and leaves command sources unchanged", () => {
    const payload = expectReadOnlySuccess(["commands", "list", "--limit", "1", "--fields", "id", "--json"]);
    expect(payload.items).toEqual([{ id: "notes" }]);
    expect(payload.commands).toEqual(payload.items);
    expect(payload.pagination).toMatchObject({ limit: 1, offset: 0, returned: 1, total: 2, nextOffset: 1 });
  });

  it("show resolves case-insensitively and leaves command sources unchanged", () => {
    const payload = expectReadOnlySuccess(["commands", "show", "#REVIEW", "--json"]);
    expect(payload.command).toMatchObject({ id: "review", scope: "agent", body: "Review $ARGUMENTS" });
  });

  it("validate returns a verdict and leaves command sources unchanged", () => {
    const payload = expectReadOnlySuccess(["commands", "validate", "--json"]);
    expect(payload).toMatchObject({ valid: true, total: 2, effectiveTotal: 2, errors: [], warnings: [] });
  });

  it("run renders a preview and leaves command sources and runtime untouched", () => {
    const payload = expectReadOnlySuccess(["commands", "run", "review", "--json", "--", "change-42"]);
    expect(payload.prompt).toContain("Review change-42");
    expect(payload.metadata).toMatchObject({ id: "review", scope: "agent" });
    expect((payload.metadata as { renderedPromptSha256: string }).renderedPromptSha256).toHaveLength(64);
  });

  for (const testCase of [
    {
      name: "empty name",
      args: ["commands", "show", "", "--json"],
      code: "INVALID_COMMAND_NAME",
    },
    {
      name: "invalid name",
      args: ["commands", "run", "bad_name", "--json"],
      code: "INVALID_COMMAND_NAME",
    },
    {
      name: "invalid pagination",
      args: ["commands", "list", "--limit", "0", "--json"],
      code: "USAGE_ERROR",
    },
    {
      name: "invalid fields",
      args: ["commands", "list", "--fields", "id,unknown", "--json"],
      code: "USAGE_ERROR",
      acceptedFields: true,
    },
  ] as const) {
    it(`returns one typed exit-2 envelope for ${testCase.name}`, () => {
      const before = captureState();
      const result = runCli([...testCase.args]);

      expect(result).toMatchObject({ status: 2, stderr: "" });
      const payload = JSON.parse(result.stdout) as {
        success: boolean;
        op: string;
        error: { code: string; acceptedFields?: string[] };
      };
      expect(payload).toMatchObject({ success: false, error: { code: testCase.code } });
      if (testCase.acceptedFields) expect(payload.error.acceptedFields).toContain("id");
      expectStateUnchanged(before);
    });
  }
});
