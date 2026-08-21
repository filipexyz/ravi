import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState, withoutRaviRuntimeContextEnv } from "../test/ravi-state.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let stateDir: string | null = null;

setDefaultTimeout(20_000);

function runCli(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...withoutRaviRuntimeContextEnv(),
      ...(stateDir ? { RAVI_STATE_DIR: stateDir } : {}),
      NO_COLOR: "1",
    },
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: bun src/cli/index.ts ${args.join(" ")}`,
        `status=${result.status}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

describe("project init smoke", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-project-init-smoke-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("initializes a project through the CLI with a canonical workflow template", () => {
    const resourcePath = resolve(PROJECT_ROOT);
    const result = JSON.parse(
      runCli([
        "projects",
        "init",
        "Ops Cadence",
        "--slug",
        "ops-cadence",
        "--owner-agent",
        "main",
        "--session",
        "ops-room",
        "--resource",
        `worktree:${resourcePath}`,
        "--workflow-template",
        "technical-change",
        "--json",
      ]).stdout,
    ) as {
      details: {
        project: {
          slug: string;
          ownerAgentId?: string;
          operatorSessionName?: string;
        };
        links: Array<{ assetType: string; assetId: string; role?: string; metadata?: Record<string, unknown> }>;
        workflowAggregate: { overallStatus: string | null; primaryWorkflowRunId: string | null } | null;
      };
      workflows: Array<{ source: string; templateId?: string; workflowRunId: string; workflowStatus: string | null }>;
    };

    expect(result.details.project).toMatchObject({
      slug: "ops-cadence",
      ownerAgentId: "main",
      operatorSessionName: "ops-room",
    });
    expect(
      result.details.links.some(
        (link) => link.assetType === "agent" && link.assetId === "main" && link.role === "owner",
      ),
    ).toBe(true);
    expect(
      result.details.links.some(
        (link) => link.assetType === "session" && link.assetId === "ops-room" && link.role === "operator",
      ),
    ).toBe(true);
    const resourceLink = result.details.links.find((link) => link.assetType === "resource");
    expect(resourceLink).toMatchObject({
      assetId: resourcePath,
      role: "substrate",
      metadata: {
        type: "worktree",
        locator: resourcePath,
        label: `${basename(resourcePath)} worktree`,
      },
    });
    expect(result.details.links.some((link) => link.assetType === "workflow" && link.role === "primary")).toBe(true);
    expect(result.details.workflowAggregate).toMatchObject({
      overallStatus: "ready",
    });
    expect(result.workflows).toEqual([
      expect.objectContaining({
        source: "template",
        templateId: "technical-change",
        workflowStatus: "ready",
      }),
    ]);
  });
});
