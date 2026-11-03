import { describe, expect, test } from "bun:test";

import {
  ManagedExecutionHarnessCompileError,
  compileManagedExecutionHarness,
} from "./managed-runtime-harness";

describe("managed execution harness compiler", () => {
  test("composes multiple Ravi Apps into a deterministic provider-neutral harness", () => {
    const input = {
      baseAgentId: "ravi-console-dev",
      baseProfileId: "console-dev-runtime-bridge",
      displayName: "Console Dev Harness",
      runtimePolicy: {
        provider: "anthropic-managed-agents",
        retention: { traces: "30d" },
      },
      safeMetadata: { domain: "runtime" },
      slug: "console-dev-harness",
      apps: [
        {
          manifest: jiraManifest,
          manifestPath: "src/apps/jira/ravi.app.json",
          manifestSource: "repo",
          selectedOperations: ["jira.issues.list", "jira.issues.create"],
        },
        {
          manifest: khalTasksManifest,
          manifestPath: "src/apps/khal-tasks/ravi.app.json",
          manifestSource: "repo",
          selectedOperations: ["khal.tasks.list"],
        },
      ],
    };

    const first = compileManagedExecutionHarness(input);
    const second = compileManagedExecutionHarness(input);

    expect(first.harness.harnessHash).toBe(second.harness.harnessHash);
    expect(first.harness.compiledBundleJson.schema).toBe("ravi.managed-harness/v1");
    expect(first.apps.map((app) => app.appId)).toEqual(["jira", "khal-tasks"]);
    expect(first.apps[0]?.selectedOperationsJson).toEqual(["jira.issues.create", "jira.issues.list"]);
    expect(first.apps[0]?.selectedSkillsJson).toEqual(["ravi-system-jira"]);
    expect(first.toolProjections).toHaveLength(3);
    expect(first.toolProjections.map((tool) => tool.toolName)).toEqual([
      "app__jira__jira_issues_create",
      "app__jira__jira_issues_list",
      "app__khal_tasks__khal_tasks_list",
    ]);
    expect(first.toolProjections[0]?.permissionRequirementJson).toMatchObject({
      appId: "jira",
      mutating: true,
      operationId: "jira.issues.create",
      permissions: ["jira.issues.write"],
    });
    expect(first.toolProjections[1]?.permissionRequirementJson).toMatchObject({
      mutating: false,
      permissions: [],
    });
    expect(first.harness.compiledBundleJson.permissions).toMatchObject({
      mutating: ["jira.issues.write", "khal.tasks.write"],
      operationPermissions: ["jira.issues.write"],
      required: ["jira.issues.read", "khal.tasks.read"],
    });
  });

  test("rejects duplicate app ids in one harness", () => {
    expect(() =>
      compileManagedExecutionHarness({
        apps: [
          { manifest: jiraManifest },
          { manifest: { ...jiraManifest, version: "2.0.0" } },
        ],
        displayName: "Duplicate Harness",
        slug: "duplicate-harness",
      }),
    ).toThrow(ManagedExecutionHarnessCompileError);
  });

  test("rejects selected operations not declared by the app", () => {
    expect(() =>
      compileManagedExecutionHarness({
        apps: [
          {
            manifest: jiraManifest,
            selectedOperations: ["jira.issues.delete"],
          },
        ],
        displayName: "Bad Operation Harness",
        slug: "bad-operation-harness",
      }),
    ).toThrow(/selected operation "jira\.issues\.delete" is not declared/);
  });

  test("rejects mutating operations without permission metadata", () => {
    expect(() =>
      compileManagedExecutionHarness({
        apps: [
          {
            manifest: {
              ...jiraManifest,
              operations: {
                "jira.issues.create": {
                  command: "ravi jira issues create --json",
                  interface: "cli",
                  mutating: true,
                },
              },
            },
          },
        ],
        displayName: "Unsafe Harness",
        slug: "unsafe-harness",
      }),
    ).toThrow(/mutating and must declare permission or permissions/);
  });
});

const jiraManifest = {
  schema: "ravi.app/v1" as const,
  id: "jira",
  name: "Jira",
  version: "1.2.0",
  description: "Operates Jira issues through governed Ravi App operations.",
  interfaces: {
    cli: {
      command: "ravi jira --json",
      json: true,
    },
  },
  operations: {
    "jira.issues.create": {
      command: "ravi jira issues create --json",
      inputSchema: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: { type: "string" },
        },
      },
      interface: "cli" as const,
      mutating: true,
      permission: "jira.issues.write",
    },
    "jira.issues.list": {
      command: "ravi jira issues list --json",
      interface: "cli" as const,
      mutating: false,
      outputSchema: {
        type: "object",
        properties: {
          issues: { type: "array" },
        },
      },
    },
  },
  permissions: {
    required: ["jira.issues.read"],
    optional: ["jira.projects.read"],
    mutating: ["jira.issues.write"],
  },
  skills: ["ravi-system-jira"],
  health: {
    checks: [{ type: "cli", command: "ravi jira check --json" }],
  },
};

const khalTasksManifest = {
  schema: "ravi.app/v1" as const,
  id: "khal-tasks",
  name: "KHAL Tasks",
  version: "0.8.0",
  description: "Operates task state for KHAL.",
  interfaces: {
    cli: {
      command: "ravi khal-tasks --json",
      json: true,
    },
  },
  operations: {
    "khal.tasks.create": {
      command: "ravi khal-tasks create --json",
      interface: "cli" as const,
      mutating: true,
      permissions: ["khal.tasks.write"],
    },
    "khal.tasks.list": {
      command: "ravi khal-tasks list --json",
      interface: "cli" as const,
      mutating: false,
    },
  },
  permissions: {
    required: ["khal.tasks.read"],
    mutating: ["khal.tasks.write"],
  },
  skills: ["ravi-system-khal-tasks"],
  health: {
    checks: [{ type: "cli", command: "ravi khal-tasks check --json" }],
  },
};
