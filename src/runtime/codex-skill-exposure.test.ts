import { describe, expect, test } from "bun:test";
import * as Bun from "bun";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillPolicySnapshot } from "./skill-policy.js";
import type { RuntimeStartRequest } from "./types.js";

function snapshot(id = "fixture-snapshot", ids: string[] = []): SkillPolicySnapshot {
  return {
    contractVersion: 1,
    id,
    status: ids.length ? "ready" : "empty",
    scope: { agentId: "fixture-agent", executionId: "fixture-execution", contextKey: "fixture-context" },
    revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" },
    skills: ids.map((skillId) => ({ id: skillId, name: skillId, aliases: [], resource: { path: "SKILL.md" } })),
    provenance: {},
    diagnostics: [],
  };
}

function request(policy: SkillPolicySnapshot, cwd: string): RuntimeStartRequest {
  return {
    cwd,
    model: "gpt-5",
    systemPromptAppend: "",
    abortController: new AbortController(),
    prompt: (async function* () {})(),
    skillPolicy: policy,
    skillExposure: { snapshotId: policy.id, mode: "textual", preparedIds: policy.skills.map((skill) => skill.id) },
    verifySkillPolicy: async () => {},
    verifySkillPolicyAtDispatch: () => {},
    onSkillPolicyInvalidated: () => {},
  };
}

if (process.env.RAVI_CODEX_EXPOSURE_TEST_CHILD !== "1") {
  test("Codex exposure contract runs in a hermetic child with isolated legacy side effects", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-codex-exposure-child-"));
    const env: Record<string, string> = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: join(root, ".codex"),
      TMP: root,
      TEMP: root,
      RAVI_CODEX_EXPOSURE_TEST_CHILD: "1",
      RAVI_CODEX_EXPOSURE_FIXTURE_ROOT: root,
    });
    const rtk = Bun.which("rtk");
    if (!rtk) throw new Error("RTK is required for the isolated test child.");
    const child = Bun.spawnSync([rtk, "proxy", process.execPath, "--no-env-file", "test", import.meta.path], {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
  }, 15000);
} else {
  const fixtureRoot = process.env.RAVI_CODEX_EXPOSURE_FIXTURE_ROOT;
  if (
    !fixtureRoot ||
    resolve(homedir()) !== resolve(fixtureRoot) ||
    process.env.HOME !== fixtureRoot ||
    process.cwd() !== fixtureRoot
  ) {
    throw new Error("Refusing to import the Codex provider outside the isolated test home.");
  }
  const { createCodexRuntimeProvider } = await import("./codex-provider.js");
  const { buildSkillPolicySessionBinding } = await import("./skill-policy-lifecycle.js");

  describe("Codex immutable skill exposure", () => {
    test("declares textual exposure with native discovery disabled and canonical shell capability", () => {
      const capabilities = createCodexRuntimeProvider().getCapabilities();
      expect(capabilities.skillExposure).toEqual({
        contractVersion: 1,
        modes: ["textual"],
        nativeDiscovery: { user: "disabled", project: "disabled", plugins: "disabled" },
        modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
        contextUpdate: "rebuild",
      });
      expect(capabilities.tools?.availableCapabilities).toContain("exec.shell");
      expect(capabilities.tools?.availableCapabilities).not.toContain("Bash");
    });

    test("prepares the exact immutable set without global skill synchronization", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-policy-"));
      let syncCalls = 0;
      const provider = createCodexRuntimeProvider({
        syncSkills() {
          syncCalls++;
          return ["legacy-denied"];
        },
      });
      const policy = snapshot("fixture-a", ["fixture:allowed"]);
      const prepared = await provider.prepareSession?.({
        agentId: "fixture-agent",
        cwd,
        skillPolicy: policy,
        skillExposureMode: "textual",
        plugins: [],
      });
      expect(prepared?.skillExposure).toEqual({
        snapshotId: policy.id,
        mode: "textual",
        preparedIds: ["fixture:allowed"],
      });
      expect(syncCalls).toBe(0);
      const handle = provider.startSession(request(policy, cwd));
      expect(handle.skillVisibility?.skills.map((skill) => skill.id)).toEqual(["fixture:allowed"]);
      await handle.close?.();
    });

    test("does not recover another agent's catalog from a shared cwd", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ravi-codex-shared-cwd-"));
      const provider = createCodexRuntimeProvider({ syncSkills: () => ["legacy-denied"] });
      const first = snapshot("fixture-first", ["fixture:first"]);
      const second = snapshot("fixture-empty");
      await provider.prepareSession?.({
        agentId: "fixture-agent",
        cwd,
        skillPolicy: first,
        skillExposureMode: "textual",
      });
      await provider.prepareSession?.({
        agentId: "fixture-agent",
        cwd,
        skillPolicy: second,
        skillExposureMode: "textual",
      });
      const handle = provider.startSession(request(first, cwd));
      const empty = provider.startSession(request(second, cwd));
      expect(handle.skillVisibility?.skills.map((skill) => skill.id)).toEqual(["fixture:first"]);
      expect(empty.skillVisibility?.skills).toEqual([]);
      await handle.close?.();
      await empty.close?.();
    });

    test("rejects unproven injected transports before any turn", () => {
      let dispatched = 0;
      const provider = createCodexRuntimeProvider({
        transport: {
          startTurn() {
            dispatched++;
            throw new Error("should not dispatch");
          },
        },
      });
      expect(() => provider.startSession(request(snapshot(), "fixture-cwd"))).toThrow("protected");
      expect(dispatched).toBe(0);
    });

    test("refuses an unproven native command before spawning a protected turn", async () => {
      const provider = createCodexRuntimeProvider({ command: "fixture-unproven-command" });
      const handle = provider.startSession({
        ...request(snapshot(), fixtureRoot),
        prompt: (async function* () {
          yield {
            type: "user",
            message: { role: "user", content: "Fixture only." },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      });
      const failures: string[] = [];
      try {
        for await (const event of handle.events) if (event.type === "turn.failed") failures.push(event.error);
      } finally {
        await handle.close?.();
      }
      expect(failures).toEqual(["Protected Codex preflight failed (unsupported-native-command)."]);
    });

    test("reports a missing scoped authorization hook without installing one", async () => {
      const provider = createCodexRuntimeProvider();
      const handle = provider.startSession({
        ...request(snapshot(), fixtureRoot),
        env: { CODEX_HOME: join(fixtureRoot, "fixture-missing-hook") },
        prompt: (async function* () {
          yield {
            type: "user",
            message: { role: "user", content: "Fixture only." },
            session_id: "",
            parent_tool_use_id: null,
          };
        })(),
      });
      const failures: string[] = [];
      try {
        for await (const event of handle.events) if (event.type === "turn.failed") failures.push(event.error);
      } finally {
        await handle.close?.();
      }
      expect(failures).toEqual(["Protected Codex preflight failed (authorization-hook-unavailable)."]);
      expect(await Bun.file(join(fixtureRoot, "fixture-missing-hook", "hooks.json")).exists()).toBe(false);
    });

    test("rejects missing verifier or mismatched preparation before any model request", () => {
      const provider = createCodexRuntimeProvider();
      const input = request(snapshot(), "fixture-cwd");
      expect(() => provider.startSession({ ...input, verifySkillPolicy: undefined })).toThrow("verifier");
      expect(() => provider.startSession({ ...input, verifySkillPolicyAtDispatch: undefined })).toThrow(
        "dispatch verifier",
      );
      expect(() => provider.startSession({ ...input, onSkillPolicyInvalidated: undefined })).toThrow(
        "invalidation callback",
      );
      expect(() =>
        provider.startSession({ ...input, skillExposure: { snapshotId: "other", mode: "textual", preparedIds: [] } }),
      ).toThrow("snapshot");
    });

    test("refuses unproved native exposure mode at preparation", () => {
      const provider = createCodexRuntimeProvider();
      expect(() =>
        provider.prepareSession?.({
          agentId: "fixture",
          cwd: "fixture-cwd",
          skillPolicy: snapshot(),
          skillExposureMode: "native-restricted",
        }),
      ).toThrow("textual");
    });

    test("rejects resuming history that does not carry the same policy snapshot", () => {
      const provider = createCodexRuntimeProvider();
      const input = request(snapshot(), "fixture-cwd");
      expect(() => provider.startSession({ ...input, resume: "old-native-thread" })).toThrow("snapshot");
      expect(() =>
        provider.startSession({
          ...input,
          resumeSession: { params: { sessionId: "old", skillPolicySnapshotId: "other" } },
        }),
      ).toThrow("snapshot");
    });

    test("accepts an authorized core rebind across execution IDs but rejects a mismatched semantic binding", async () => {
      const policy = snapshot("fixture-next-execution");
      const input = request(policy, "fixture-cwd");
      const provider = createCodexRuntimeProvider();
      const binding = buildSkillPolicySessionBinding(policy, policy.scope.contextKey);
      const handle = provider.startSession({
        ...input,
        resumeSession: {
          params: {
            sessionId: "fixture-thread",
            skillPolicySnapshotId: "fixture-old-execution",
            skillPolicySession: binding,
          },
        },
      });
      await handle.close?.();
      expect(() =>
        provider.startSession({
          ...input,
          resumeSession: {
            params: {
              sessionId: "fixture-thread",
              skillPolicySession: { ...binding, contextFingerprint: "fixture-wrong-authority" },
            },
          },
        }),
      ).toThrow("snapshot");
    });
  });
}
