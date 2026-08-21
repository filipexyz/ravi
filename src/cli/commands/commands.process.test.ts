import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...withoutRaviRuntimeContextEnv(),
      RAVI_HOME: stateDir,
      RAVI_STATE_DIR: stateDir,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
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

async function logicalStateDigest(): Promise<string> {
  const { dbGetAgent, dbListRoutes, closeRouterDb } = await import("../../router/router-db.js");
  const { listSessions, closeSessionStore } = await import("../../router/sessions.js");
  const value = JSON.stringify({
    agent: dbGetAgent("main"),
    routes: dbListRoutes(),
    sessions: listSessions(),
  });
  closeSessionStore();
  closeRouterDb();
  return createHash("sha256").update(value).digest("hex");
}

function expectReadOnlySuccess(args: string[]): Record<string, unknown> {
  const before = sourceDigest();
  const result = runCli(args);

  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(sourceDigest()).toEqual(before);

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
  logicalStateBefore = await logicalStateDigest();
});

afterAll(async () => {
  try {
    expect(await logicalStateDigest()).toBe(logicalStateBefore);
  } finally {
    await cleanupIsolatedRaviState(stateDir);
    rmSync(agentCwd, { recursive: true, force: true });
  }
});

describe("commands process contract", () => {
  it("prints group help with exit 0 when no operation is supplied", () => {
    const before = sourceDigest();
    const result = runCli(["commands"]);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: ravi commands");
    expect(result.stdout).toContain("list [options]");
    expect(sourceDigest()).toEqual(before);
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
      const before = sourceDigest();
      const result = runCli([...testCase.args]);

      expect(result).toMatchObject({ status: 2, stderr: "" });
      const payload = JSON.parse(result.stdout) as {
        success: boolean;
        op: string;
        error: { code: string; acceptedFields?: string[] };
      };
      expect(payload).toMatchObject({ success: false, error: { code: testCase.code } });
      if (testCase.acceptedFields) expect(payload.error.acceptedFields).toContain("id");
      expect(sourceDigest()).toEqual(before);
    });
  }
});
