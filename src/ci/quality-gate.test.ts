import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  extractChangedSpecIds,
  findTriggeredPrefixes,
  isDocsOnlyDiff,
  runCoverageGate,
  runQualityGate,
  runSpecGate,
} from "./quality-gate.js";

const tempRoots: string[] = [];
let isolatedStateDir: string | null = null;
let previousStateDir: string | undefined;

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-ci-gate-"));
  tempRoots.push(root);
  return root;
}

function writeSpec(cwd: string, id: string, overrides: Record<string, string> = {}): void {
  const parts = id.split("/");
  const depth = parts.length;
  const expectedKind = depth === 1 ? "domain" : depth === 2 ? "capability" : "feature";

  const kind = overrides.kind ?? expectedKind;
  const title = overrides.title ?? id.replace(/\//g, " ");
  const domain = parts[0]!;

  const dir = join(cwd, ".ravi", "specs", ...parts);
  mkdirSync(dir, { recursive: true });

  const frontmatter = [
    "---",
    `id: ${id}`,
    `title: "${title}"`,
    `kind: ${kind}`,
    `domain: ${domain}`,
    ...(parts[1] ? [`capability: ${parts[1]}`] : []),
    ...(parts[2] ? [`feature: ${parts[2]}`] : []),
    "tags: []",
    "applies_to: []",
    "owners:",
    "  - ravi-dev",
    `status: ${overrides.status ?? "active"}`,
    "normative: true",
    "---",
    "",
    `# ${title}`,
    "",
    "## Intent",
    "",
    "Test spec.",
    "",
  ].join("\n");

  writeFileSync(join(dir, "SPEC.md"), frontmatter, "utf8");

  if (overrides.withCompanions !== "false") {
    writeFileSync(join(dir, "WHY.md"), `# ${title} / WHY\n\n## Rationale\n\nTest rationale.\n`, "utf8");
    writeFileSync(join(dir, "RUNBOOK.md"), `# ${title} / RUNBOOK\n\n## Debug Flow\n\nTest runbook.\n`, "utf8");
    writeFileSync(join(dir, "CHECKS.md"), `# ${title} / CHECKS\n\n## Checks\n\n- Spec MUST be valid.\n`, "utf8");
  }
}

function writeTestFile(cwd: string, relativePath: string): void {
  const fullPath = join(cwd, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, `// test placeholder\n`, "utf8");
}

beforeEach(async () => {
  previousStateDir = process.env.RAVI_STATE_DIR;
  isolatedStateDir = await createIsolatedRaviState("ravi-ci-gate-state-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(isolatedStateDir);
  isolatedStateDir = null;
  if (previousStateDir) {
    process.env.RAVI_STATE_DIR = previousStateDir;
  }
  previousStateDir = undefined;

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("extractChangedSpecIds", () => {
  it("extracts spec ids from changed file paths", () => {
    const files = [
      ".ravi/specs/quality/ci-gates/SPEC.md",
      ".ravi/specs/quality/ci-gates/WHY.md",
      ".ravi/specs/channels/chats/reactions/SPEC.md",
      "src/omni/consumer.ts",
      "README.md",
    ];
    expect(extractChangedSpecIds(files)).toEqual(["channels/chats/reactions", "quality/ci-gates"]);
  });

  it("returns empty array for non-spec changes", () => {
    expect(extractChangedSpecIds(["src/router/sessions.ts"])).toEqual([]);
  });

  it("deduplicates ids from multiple files in the same spec dir", () => {
    const files = [
      ".ravi/specs/quality/ci-gates/SPEC.md",
      ".ravi/specs/quality/ci-gates/CHECKS.md",
      ".ravi/specs/quality/ci-gates/WHY.md",
    ];
    expect(extractChangedSpecIds(files)).toEqual(["quality/ci-gates"]);
  });

  it("handles domain-level specs", () => {
    const files = [".ravi/specs/quality/SPEC.md"];
    expect(extractChangedSpecIds(files)).toEqual(["quality"]);
  });
});

describe("isDocsOnlyDiff", () => {
  it("returns true for docs-only changes", () => {
    expect(isDocsOnlyDiff(["docs/guide.md", ".ravi/specs/quality/SPEC.md"])).toBe(true);
  });

  it("returns false when runtime source is present", () => {
    expect(isDocsOnlyDiff(["docs/guide.md", "src/omni/consumer.ts"])).toBe(false);
  });
});

describe("findTriggeredPrefixes", () => {
  it("identifies triggered runtime path prefixes", () => {
    const files = ["src/omni/consumer.ts", "src/devin/client.ts"];
    expect(findTriggeredPrefixes(files)).toEqual(["src/devin/", "src/omni/"]);
  });

  it("identifies native channel runner and adapter changes", () => {
    const files = ["src/channels/runner.ts", "src/channels/slack/socket-mode.ts"];

    expect(findTriggeredPrefixes(files)).toEqual([
      "src/channels/",
      "src/channels/runner.ts",
      "src/channels/slack/socket-mode.ts",
    ]);
  });

  it("excludes test files from triggering", () => {
    const files = ["src/omni/consumer-context.test.ts"];
    expect(findTriggeredPrefixes(files)).toEqual([]);
  });

  it("returns empty for non-runtime paths", () => {
    expect(findTriggeredPrefixes(["src/cli/commands/specs.ts"])).toEqual([]);
  });
});

describe("runSpecGate", () => {
  it("passes for a valid changed spec", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "quality");
    writeSpec(cwd, "quality/ci-gates");

    const result = runSpecGate([".ravi/specs/quality/ci-gates/SPEC.md"], cwd);

    expect(result.ok).toBe(true);
    expect(result.changedSpecIds).toEqual(["quality/ci-gates"]);
    expect(result.syncResult).toBeTruthy();
    expect(result.errors).toHaveLength(0);
  });

  it("fails for a nested spec with wrong kind (incident class)", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "channels");
    writeSpec(cwd, "channels/chats");
    // Three-level spec declaring kind: capability instead of kind: feature
    writeSpec(cwd, "channels/chats/reactions", { kind: "capability" });

    const result = runSpecGate([".ravi/specs/channels/chats/reactions/SPEC.md"], cwd);

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const kindError = result.errors.find((e) => e.specId === "channels/chats/reactions" || e.specId === "*");
    expect(kindError).toBeTruthy();
    expect(kindError!.error).toContain("kind");
  });

  it("fails for a spec missing required companions", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "quality");
    writeSpec(cwd, "quality/ci-gates", { withCompanions: "false" });

    const result = runSpecGate([".ravi/specs/quality/ci-gates/SPEC.md"], cwd);

    expect(result.ok).toBe(false);
    const companionErrors = result.errors.filter((e) => e.error.includes("missing required companion"));
    expect(companionErrors.length).toBe(3);
  });

  it("fails for a spec with empty CHECKS.md", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "quality");
    writeSpec(cwd, "quality/ci-gates");
    // Overwrite CHECKS.md with empty content
    writeFileSync(join(cwd, ".ravi/specs/quality/ci-gates/CHECKS.md"), "", "utf8");

    const result = runSpecGate([".ravi/specs/quality/ci-gates/SPEC.md"], cwd);

    expect(result.ok).toBe(false);
    const checksError = result.errors.find((e) => e.error.includes("CHECKS.md is empty"));
    expect(checksError).toBeTruthy();
  });

  it("fails for a spec with CHECKS.md lacking verifiable criteria", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "quality");
    writeSpec(cwd, "quality/ci-gates");
    // Overwrite CHECKS.md with content that has no list items
    writeFileSync(
      join(cwd, ".ravi/specs/quality/ci-gates/CHECKS.md"),
      "# Checks\n\nSome notes about quality.\n",
      "utf8",
    );

    const result = runSpecGate([".ravi/specs/quality/ci-gates/SPEC.md"], cwd);

    expect(result.ok).toBe(false);
    const checksError = result.errors.find((e) => e.error.includes("no verifiable criteria"));
    expect(checksError).toBeTruthy();
  });

  it("fails for a spec with CHECKS.md list items but no verifiable language", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "quality");
    writeSpec(cwd, "quality/ci-gates");
    // List items without MUST/SHOULD/fails/passes etc.
    writeFileSync(
      join(cwd, ".ravi/specs/quality/ci-gates/CHECKS.md"),
      "# Checks\n\n- Something about the spec\n- Another note\n",
      "utf8",
    );

    const result = runSpecGate([".ravi/specs/quality/ci-gates/SPEC.md"], cwd);

    expect(result.ok).toBe(false);
    const checksError = result.errors.find((e) => e.error.includes("none appear verifiable"));
    expect(checksError).toBeTruthy();
  });

  it("returns ok with no changed spec ids", () => {
    const result = runSpecGate(["src/router/sessions.ts"]);
    expect(result.ok).toBe(true);
    expect(result.changedSpecIds).toEqual([]);
  });
});

describe("runCoverageGate", () => {
  it("fails when test file exists on disk but not in the diff", () => {
    const cwd = makeWorkspace();
    writeTestFile(cwd, "src/omni/consumer-context.test.ts");

    const result = runCoverageGate(["src/omni/consumer.ts"], cwd);

    expect(result.ok).toBe(false);
    expect(result.triggeredPrefixes).toEqual(["src/omni/"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("no focused test in the diff");
  });

  it("passes when test file is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/omni/consumer.ts", "src/omni/consumer-context.test.ts"], cwd);

    expect(result.ok).toBe(true);
  });

  it("accepts canonical chat schema coverage for router persistence changes", () => {
    const result = runCoverageGate(["src/router/router-db.ts", "src/router/chat-schema.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/router/"]);
  });

  it("accepts crash recovery store coverage across router persistence and runtime changes", () => {
    const result = runCoverageGate([
      "src/router/router-db.ts",
      "src/runtime/crash-recovery-store.ts",
      "src/runtime/crash-recovery-store.test.ts",
    ]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/router/", "src/runtime/"]);
  });

  it("accepts channel backend coverage across channel, router, and runtime changes", () => {
    const result = runCoverageGate([
      "src/channels/backend.ts",
      "src/router/router-db.ts",
      "src/runtime/message-types.ts",
      "src/channels/backend.test.ts",
    ]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/channels/", "src/router/", "src/runtime/"]);
  });

  it("accepts channel runtime event coverage across channel and router persistence changes", () => {
    const result = runCoverageGate([
      "src/channels/runtime-events.ts",
      "src/router/router-db.ts",
      "src/channels/runtime-events.test.ts",
    ]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/channels/", "src/router/"]);
  });

  it("accepts channel runtime event coverage for host projection policy changes", () => {
    const result = runCoverageGate(["src/runtime/host-event-loop.ts", "src/channels/runtime-events.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("accepts the focused outbound consumer regression for channel delivery changes", () => {
    const result = runCoverageGate(["src/channels/outbound-consumer.ts", "src/channels/outbound-consumer.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/channels/"]);
  });

  it("requires a focused native channel test in the diff", () => {
    const missing = runCoverageGate(["src/channels/slack/socket-mode.ts"]);
    const covered = runCoverageGate(["src/channels/slack/socket-mode.ts", "src/channels/slack/socket-mode.test.ts"]);
    const healthCovered = runCoverageGate(["src/channels/health.ts", "src/channels/health.test.ts"]);
    const mediaCovered = runCoverageGate(["src/channels/slack/media.ts", "src/channels/slack/media.test.ts"]);
    const sessionPromptCovered = runCoverageGate([
      "src/channels/session-prompt.ts",
      "src/channels/session-prompt.test.ts",
    ]);

    expect(missing.ok).toBe(false);
    expect(missing.triggeredPrefixes).toEqual(["src/channels/", "src/channels/slack/socket-mode.ts"]);
    expect(missing.errors[0]?.message).toContain("src/channels/");
    expect(covered.ok).toBe(true);
    expect(covered.triggeredPrefixes).toEqual(["src/channels/", "src/channels/slack/socket-mode.ts"]);
    expect(healthCovered.ok).toBe(true);
    expect(mediaCovered.ok).toBe(true);
    expect(mediaCovered.triggeredPrefixes).toEqual(["src/channels/"]);
    expect(sessionPromptCovered.ok).toBe(true);
    expect(sessionPromptCovered.triggeredPrefixes).toEqual(["src/channels/"]);
  });

  it("passes when the session stream focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/omni/session-stream.ts", "src/omni/session-stream.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/omni/"]);
  });

  it("passes when runtime transport focused tests are in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(
      [
        "src/runtime/codex-transport.ts",
        "src/runtime/codex-transport.test.ts",
        "src/runtime/prompt-subscription.ts",
        "src/runtime/prompt-subscription.test.ts",
      ],
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("passes when the Claude provider focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/runtime/claude-provider.ts", "src/runtime/claude-provider.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("passes when the Codex provider focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/runtime/codex-provider.ts", "src/runtime/codex-provider.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("accepts approval service focused tests for approval service changes", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/approval/service.ts", "src/approval/service.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/approval/"]);
  });

  it("passes when the observation plane focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/runtime/observation-plane.ts", "src/runtime/observation-plane.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("passes when the runtime request context focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(
      ["src/runtime/runtime-request-context.ts", "src/runtime/runtime-request-context.test.ts"],
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("fails for runtime change without focused test", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/omni/consumer.ts"], cwd);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("src/omni/");
    expect(result.errors[0]!.message).toContain("no focused test in the diff");
  });

  it("skips coverage gate for docs-only diff", () => {
    const result = runCoverageGate(["docs/guide.md", ".ravi/specs/quality/SPEC.md"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual([]);
  });

  it("fails for runtime change with existing test on disk but not in diff", () => {
    const cwd = makeWorkspace();
    writeTestFile(cwd, "src/devin/client.test.ts");

    const result = runCoverageGate(["src/devin/client.ts"], cwd);

    expect(result.ok).toBe(false);
    expect(result.triggeredPrefixes).toEqual(["src/devin/"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("no focused test in the diff");
  });

  it("passes when test file is in the diff alongside source", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/devin/client.ts", "src/devin/client.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/devin/"]);
  });

  it("requires the Apps router contract test for Apps runtime changes", () => {
    const uncovered = runCoverageGate(["src/apps/router.ts"]);
    const covered = runCoverageGate(["src/apps/router.ts", "src/apps/router.test.ts"]);

    expect(uncovered.ok).toBe(false);
    expect(uncovered.triggeredPrefixes).toEqual(["src/apps/"]);
    expect(uncovered.errors[0]!.message).toContain("src/apps/router.test.ts");
    expect(covered.ok).toBe(true);
  });
});

describe("runQualityGate (combined)", () => {
  it("passes when both gates pass", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "quality");
    writeSpec(cwd, "quality/ci-gates");
    writeTestFile(cwd, "src/omni/consumer-context.test.ts");

    const result = runQualityGate(
      [".ravi/specs/quality/ci-gates/SPEC.md", "src/omni/consumer.ts", "src/omni/consumer-context.test.ts"],
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(result.spec.ok).toBe(true);
    expect(result.coverage.ok).toBe(true);
  });

  it("fails when spec gate fails", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "channels");
    writeSpec(cwd, "channels/chats");
    writeSpec(cwd, "channels/chats/reactions", { kind: "capability" });

    const result = runQualityGate([".ravi/specs/channels/chats/reactions/SPEC.md"], cwd);

    expect(result.ok).toBe(false);
    expect(result.spec.ok).toBe(false);
  });

  it("fails when coverage gate fails", () => {
    const cwd = makeWorkspace();

    const result = runQualityGate(["src/omni/consumer.ts"], cwd);

    expect(result.ok).toBe(false);
    expect(result.coverage.ok).toBe(false);
  });
});
