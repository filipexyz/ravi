import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  extractChangedSpecIds,
  findTriggeredPrefixes,
  isDocsOnlyDiff,
  RUNTIME_PATH_MAP,
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
      "src/omni/inbound-source.ts",
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
    expect(isDocsOnlyDiff(["docs/guide.md", "src/omni/inbound-source.ts"])).toBe(false);
  });
});

describe("findTriggeredPrefixes", () => {
  it("identifies triggered runtime path prefixes", () => {
    const files = ["src/omni/inbound-source.ts", "src/devin/client.ts"];
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

  it("identifies native WhatsApp channel changes", () => {
    const files = ["src/channels/whatsapp/runtime.ts", "src/channels/whatsapp/lib/socket.ts"];

    expect(findTriggeredPrefixes(files)).toEqual(["src/channels/", "src/channels/whatsapp/"]);
  });

  it("excludes test files from triggering", () => {
    const files = ["src/omni/inbound-source.test.ts"];
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
    writeTestFile(cwd, "src/omni/inbound-source.test.ts");

    const result = runCoverageGate(["src/omni/inbound-source.ts"], cwd);

    expect(result.ok).toBe(false);
    expect(result.triggeredPrefixes).toEqual(["src/omni/"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("no focused test in the diff");
  });

  it("passes when test file is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/omni/inbound-source.ts", "src/omni/inbound-source.test.ts"], cwd);

    expect(result.ok).toBe(true);
  });

  it("accepts canonical chat schema coverage for router persistence changes", () => {
    const result = runCoverageGate(["src/router/router-db.ts", "src/router/chat-schema.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/router/"]);
  });

  it("accepts focused route CRUD coverage for router persistence changes", () => {
    const result = runCoverageGate(["src/router/router-db.ts", "src/router/router-db.routes.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/router/"]);
  });

  it("accepts sticky-attach coverage for route agent migration", () => {
    const result = runCoverageGate(["src/router/route-sticky-attach.ts", "src/router/route-sticky-attach.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/router/"]);
  });

  it("accepts announceCompaction coverage for router persistence changes", () => {
    const result = runCoverageGate(["src/router/router-db.ts", "src/router/router-db.announce-compaction.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/router/"]);
  });

  it("accepts daemon restart delivery ledger coverage for router persistence changes", () => {
    const result = runCoverageGate(["src/router/router-db.ts", "src/router/router-db.daemon-restart.test.ts"]);

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

  it("requires a focused WhatsApp test for WhatsApp channel changes", () => {
    const missing = runCoverageGate(["src/channels/whatsapp/runtime.ts"]);
    const unrelatedChannelTest = runCoverageGate(["src/channels/whatsapp/runtime.ts", "src/channels/backend.test.ts"]);
    const runtimeCovered = runCoverageGate([
      "src/channels/whatsapp/runtime.ts",
      "src/channels/whatsapp/__tests__/runtime-inbound.test.ts",
    ]);
    const libCovered = runCoverageGate([
      "src/channels/whatsapp/lib/handlers/messages.ts",
      "src/channels/whatsapp/lib/__tests__/messages-handler.test.ts",
    ]);
    const clientCovered = runCoverageGate(["src/channels/whatsapp/client.ts", "src/channels/whatsapp/client.test.ts"]);

    expect(missing.ok).toBe(false);
    expect(missing.triggeredPrefixes).toEqual(["src/channels/", "src/channels/whatsapp/"]);
    expect(missing.errors.map((error) => error.prefix)).toEqual(["src/channels/", "src/channels/whatsapp/"]);
    expect(unrelatedChannelTest.ok).toBe(false);
    expect(unrelatedChannelTest.errors.map((error) => error.prefix)).toEqual(["src/channels/whatsapp/"]);
    expect(runtimeCovered.ok).toBe(true);
    expect(libCovered.ok).toBe(true);
    expect(clientCovered.ok).toBe(true);
  });

  it("accepts any legacy bridge test for a legacy bridge change", () => {
    const result = runCoverageGate(["src/omni/sender.ts", "src/omni/legacy-bridge.test.ts"]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/omni/"]);
  });

  it("passes when the session stream focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/session-prompts/stream.ts", "src/session-prompts/stream.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/session-prompts/"]);
  });

  it("passes when the presence targets focused test is in the diff", () => {
    const result = runCoverageGate([
      "src/channels/inbound/presence-targets.ts",
      "src/channels/inbound/presence-targets.test.ts",
    ]);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/channels/", "src/channels/inbound/"]);
  });

  it("requires the nats-server test for a nats-server change", () => {
    expect(runCoverageGate(["src/nats-server.ts"]).ok).toBe(false);
    const covered = runCoverageGate(["src/nats-server.ts", "src/nats-server.test.ts"]);
    expect(covered.ok).toBe(true);
    expect(covered.triggeredPrefixes).toEqual(["src/nats-server.ts"]);
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

  it("passes when the Grok provider focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/runtime/grok-provider.ts", "src/runtime/grok-provider.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("passes when the Pi provider focused tests are in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(
      [
        "src/runtime/pi-provider.ts",
        "src/runtime/pi-tool-permissions.ts",
        "src/runtime/pi-provider.test.ts",
        "src/runtime/pi-tool-permissions.test.ts",
      ],
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("passes when the session dispatcher focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(
      ["src/runtime/session-dispatcher.ts", "src/runtime/session-dispatcher.test.ts"],
      cwd,
    );

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("passes when the tool safety focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/hooks/tool-safety.ts", "src/hooks/tool-safety.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/hooks/"]);
  });

  it("passes when the Ravi env file focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/runtime/ravi-env-file.ts", "src/runtime/ravi-env-file.test.ts"], cwd);

    expect(result.ok).toBe(true);
    expect(result.triggeredPrefixes).toEqual(["src/runtime/"]);
  });

  it("passes when the provider device-login focused test is in the diff", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(
      ["src/runtime/provider-device-login.ts", "src/runtime/provider-device-login.test.ts"],
      cwd,
    );

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
    expect(
      runCoverageGate(
        ["src/runtime/runtime-request-builder.ts", "src/runtime/runtime-request-builder.context-key.test.ts"],
        cwd,
      ).ok,
    ).toBe(true);
  });

  it("accepts last-used provider and restart-resume focused tests for runtime changes", () => {
    expect(runCoverageGate(["src/runtime/session-resolver.ts", "src/runtime/session-resolver.test.ts"]).ok).toBe(true);
    expect(runCoverageGate(["src/runtime/runtime-selection.ts", "src/runtime/runtime-selection.test.ts"]).ok).toBe(
      true,
    );
    expect(
      runCoverageGate(["src/runtime/agent-session-runtime-sync.ts", "src/runtime/agent-session-runtime-sync.test.ts"])
        .ok,
    ).toBe(true);
    expect(
      runCoverageGate(["src/runtime/daemon-restart-resume.ts", "src/runtime/daemon-restart-resume.test.ts"]).ok,
    ).toBe(true);
    expect(runCoverageGate(["src/runtime/host-event-loop.ts", "src/runtime/session-trace.test.ts"]).ok).toBe(true);
  });

  it("fails for runtime change without focused test", () => {
    const cwd = makeWorkspace();

    const result = runCoverageGate(["src/omni/inbound-source.ts"], cwd);

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

  it("requires a focused inbound test for neutral inbound channel changes", () => {
    const missing = runCoverageGate(["src/channels/inbound/topics.ts"]);
    const covered = runCoverageGate(["src/channels/inbound/topics.ts", "src/channels/inbound/topics.test.ts"]);

    expect(missing.ok).toBe(false);
    expect(missing.triggeredPrefixes).toEqual(["src/channels/", "src/channels/inbound/"]);
    expect(missing.errors.map((error) => error.prefix)).toEqual(["src/channels/", "src/channels/inbound/"]);
    expect(covered.ok).toBe(true);
  });

  it("requires a focused outbound test for neutral outbound channel changes", () => {
    const missing = runCoverageGate(["src/channels/outbound/router.ts"]);
    const covered = runCoverageGate(["src/channels/outbound/router.ts", "src/channels/outbound/router.test.ts"]);

    expect(missing.ok).toBe(false);
    expect(missing.triggeredPrefixes).toEqual(["src/channels/", "src/channels/outbound/"]);
    expect(missing.errors.map((error) => error.prefix)).toEqual(["src/channels/", "src/channels/outbound/"]);
    expect(covered.ok).toBe(true);
  });

  it("requires the group metadata cache test for group metadata changes", () => {
    const missing = runCoverageGate(["src/channels/group-metadata/cache.ts"]);
    const covered = runCoverageGate([
      "src/channels/group-metadata/cache.ts",
      "src/channels/group-metadata/cache.test.ts",
    ]);

    expect(missing.ok).toBe(false);
    expect(missing.triggeredPrefixes).toEqual(["src/channels/", "src/channels/group-metadata/"]);
    expect(missing.errors.map((error) => error.prefix)).toEqual(["src/channels/", "src/channels/group-metadata/"]);
    expect(covered.ok).toBe(true);
  });

  it("requires the session prompt stream test for session prompt changes", () => {
    const missing = runCoverageGate(["src/session-prompts/stream.ts"]);
    const covered = runCoverageGate(["src/session-prompts/stream.ts", "src/session-prompts/stream.test.ts"]);

    expect(missing.ok).toBe(false);
    expect(missing.triggeredPrefixes).toEqual(["src/session-prompts/"]);
    expect(missing.errors[0]!.message).toContain("src/session-prompts/stream.test.ts");
    expect(covered.ok).toBe(true);
  });

  it("requires the daemon channels test for daemon channel wiring changes", () => {
    const missing = runCoverageGate(["src/daemon-channels.ts"]);
    const covered = runCoverageGate(["src/daemon-channels.ts", "src/daemon-channels.test.ts"]);

    expect(missing.ok).toBe(false);
    expect(missing.triggeredPrefixes).toEqual(["src/daemon-channels.ts"]);
    expect(missing.errors[0]!.message).toContain("src/daemon-channels.test.ts");
    expect(covered.ok).toBe(true);
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

describe("RUNTIME_PATH_MAP", () => {
  // A focused test that was renamed or deleted can never be "in the diff", so a stale
  // entry silently narrows what covers its prefix.
  it("names only prefixes and focused tests that exist", () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    const missing: string[] = [];
    for (const [prefix, tests] of Object.entries(RUNTIME_PATH_MAP)) {
      if (!existsSync(join(repoRoot, prefix))) missing.push(prefix);
      for (const test of tests) {
        if (!existsSync(join(repoRoot, test))) missing.push(`${prefix} -> ${test}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("runQualityGate (combined)", () => {
  it("passes when both gates pass", () => {
    const cwd = makeWorkspace();
    writeSpec(cwd, "quality");
    writeSpec(cwd, "quality/ci-gates");
    writeTestFile(cwd, "src/omni/inbound-source.test.ts");

    const result = runQualityGate(
      [".ravi/specs/quality/ci-gates/SPEC.md", "src/omni/inbound-source.ts", "src/omni/inbound-source.test.ts"],
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

    const result = runQualityGate(["src/omni/inbound-source.ts"], cwd);

    expect(result.ok).toBe(false);
    expect(result.coverage.ok).toBe(false);
  });
});
