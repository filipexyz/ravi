import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRuntimeProvider } from "./claude-provider.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";

function makeAgentWorkspace(skillNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-local-skills-"));
  for (const name of skillNames) {
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n`);
  }
  return root;
}

const emptyPolicy: SkillPolicySnapshot = {
  contractVersion: 1,
  id: "empty-local-policy",
  status: "empty",
  scope: { agentId: "restricted", executionId: "execution", contextKey: "context" },
  revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" },
  skills: [],
  provenance: {},
  diagnostics: [],
};

describe("Claude local skill policy", () => {
  test("preserves personal files without admitting them to an empty preparation", () => {
    const cwd = makeAgentWorkspace(["swarm-orchestrator"]);
    const file = join(cwd, ".claude", "skills", "swarm-orchestrator", "SKILL.md");
    const personalContent = readFileSync(file, "utf8");
    const prepared = createClaudeRuntimeProvider().prepareSession?.({
      agentId: "restricted",
      cwd,
      skillPolicy: emptyPolicy,
      skillNativeNames: {},
      skillExposureMode: "native-restricted",
    });
    expect(prepared).toMatchObject({
      skillExposure: { snapshotId: "empty-local-policy", mode: "native-restricted", preparedIds: [] },
    });
    expect(readFileSync(file, "utf8")).toBe(personalContent);
  });

  test("refuses native names not authorized by the supplied snapshot", () => {
    const cwd = makeAgentWorkspace([]);
    expect(() =>
      createClaudeRuntimeProvider().prepareSession?.({
        agentId: "restricted",
        cwd,
        skillPolicy: emptyPolicy,
        skillNativeNames: { extra: "personal:extra" },
        skillExposureMode: "native-restricted",
      }),
    ).toThrow("native skill");
  });

  test("refuses a strategy this adapter cannot enforce", () => {
    const cwd = makeAgentWorkspace([]);
    expect(() =>
      createClaudeRuntimeProvider().prepareSession?.({
        agentId: "restricted",
        cwd,
        skillPolicy: emptyPolicy,
        skillNativeNames: {},
        skillExposureMode: "textual",
      }),
    ).toThrow("native-restricted");
  });

  test.each(["context: fork", 'context: "fork"', "context: >-\n  fork"])(
    "refuses a forked skill whose child discovery cannot be restricted: %s",
    (declaration) => {
      const cwd = makeAgentWorkspace([]);
      const policy: SkillPolicySnapshot = {
        ...emptyPolicy,
        status: "ready",
        skills: [
          {
            id: "fixture:forked",
            name: "forked",
            aliases: [],
            requirements: { kind: "none" },
            resource: {
              path: "/fixture/SKILL.md",
              files: [
                {
                  path: "SKILL.md",
                  content: `---\nname: forked\n${declaration}\n---\nFixture.`,
                },
              ],
            },
          },
        ],
      };
      expect(() =>
        createClaudeRuntimeProvider().prepareSession?.({
          agentId: "restricted",
          cwd,
          skillPolicy: policy,
          skillNativeNames: { "fixture:forked": "fixture:forked" },
          skillExposureMode: "native-restricted",
        }),
      ).toThrow("forked skill");
    },
  );
});
