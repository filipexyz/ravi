import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

let stateDir: string | null = null;

setDefaultTimeout(90_000);

function runCli(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
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

describe("project fixtures smoke", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-project-fixtures-smoke-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("seeds canonical project fixtures and surfaces project -> workflow -> task across the CLI", () => {
    const seeded = JSON.parse(runCli(["projects", "fixtures", "seed", "--json"]).stdout) as {
      total: number;
      fixtures: Array<{
        projectSlug: string;
        workflowRunId: string;
        workflowStatus: string | null;
        tasks: Array<{ taskId: string; status: string }>;
      }>;
    };

    expect(seeded.total).toBe(3);

    const opsCadence = seeded.fixtures.find((fixture) => fixture.projectSlug === "demo-ops-cadence");
    const launchCopy = seeded.fixtures.find((fixture) => fixture.projectSlug === "demo-launch-copy-refresh");
    const founderIntake = seeded.fixtures.find((fixture) => fixture.projectSlug === "demo-founder-intake-automation");

    expect(opsCadence).toBeDefined();
    expect(launchCopy).toBeDefined();
    expect(founderIntake).toBeDefined();
    expect(opsCadence?.workflowStatus).toBe("running");
    expect(launchCopy?.workflowStatus).toBe("blocked");
    expect(founderIntake?.workflowStatus).toBe("done");

    const projectStatus = runCli(["projects", "status", "demo-ops-cadence"]).stdout;
    expect(projectStatus).toContain("Project:   active");
    expect(projectStatus).toContain("Runtime:   running");
    expect(projectStatus).toContain(`Primary:   ${opsCadence?.workflowRunId}`);

    const blockedProject = JSON.parse(runCli(["projects", "show", "demo-launch-copy-refresh", "--json"]).stdout) as {
      links: Array<{ assetType: string }>;
      workflowAggregate: { overallStatus: string | null } | null;
    };
    expect(blockedProject.workflowAggregate?.overallStatus).toBe("blocked");
    expect(blockedProject.links.map((link) => link.assetType).sort()).toEqual([
      "agent",
      "resource",
      "session",
      "workflow",
    ]);

    const taskShow = runCli(["tasks", "show", opsCadence!.tasks[0]!.taskId]).stdout;
    expect(taskShow).toContain("Project:");
    expect(taskShow).toContain("Slug:       demo-ops-cadence");
    expect(taskShow).toContain(`Workflow:   ${opsCadence!.workflowRunId}`);

    const taskList = JSON.parse(runCli(["tasks", "list", "--json"]).stdout) as {
      tasks: Array<{ id: string; project?: { projectSlug?: string; workflowRunId?: string } | null }>;
    };
    expect(taskList.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: opsCadence!.tasks[0]!.taskId,
          project: expect.objectContaining({
            projectSlug: "demo-ops-cadence",
            workflowRunId: opsCadence!.workflowRunId,
          }),
        }),
      ]),
    );

    const workflowShow = runCli(["workflows", "runs", "show", opsCadence!.workflowRunId]).stdout;
    expect(workflowShow).toContain(`Workflow run ${opsCadence!.workflowRunId}`);
    expect(workflowShow).toContain(opsCadence!.tasks[0]!.taskId);
  });
});
