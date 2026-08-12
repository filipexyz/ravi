import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { mergeRuntimeCredentialSessionMetadata } from "./credential-resolver.js";
import {
  cleanupKimiCodeSessionState,
  commitKimiCodeSessionState,
  createKimiCodeSessionId,
  loadKimiCodeSessionState,
} from "./kimi-code-state.js";
import {
  emptySkillVisibilitySnapshot,
  markLoadedFromRaviSkillToolCall,
  markLoadedFromSkillGate,
} from "./skill-visibility.js";
import type { KimiCodeConversationMessage } from "./kimi-code-turn.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type { RuntimeSessionState } from "./types.js";

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryState() {
  const root = mkdtempSync(join(tmpdir(), "ravi-kimi-state-"));
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  temporaryRoots.add(root);
  return { root, cwd, env: { RAVI_STATE_DIR: join(root, "state"), KIMI_API_KEY: "never-persist-this-key" } };
}

function detectWorkspaceRetargetCapability(): { available: true } | { available: false; reason: string } {
  const root = mkdtempSync(join(tmpdir(), "ravi-kimi-retarget-capability-"));
  const target = join(root, "target");
  const alias = join(root, "alias");
  mkdirSync(target);
  try {
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    return { available: true };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
    return { available: false, reason: `${process.platform} symlink/junction unavailable (${code})` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const workspaceRetargetCapability = detectWorkspaceRetargetCapability();

function nativeMessages(label = "one"): KimiCodeConversationMessage[] {
  return [
    { role: "user", content: `question-${label}` },
    {
      role: "assistant",
      content: "",
      reasoning_content: `private-reasoning-${label}`,
      tool_calls: [
        {
          id: `call-${label}`,
          type: "function",
          function: { name: "lookup", arguments: `{"label":"${label}"}` },
        },
      ],
    },
    { role: "tool", tool_call_id: `call-${label}`, content: `result-${label}` },
    { role: "assistant", content: `answer-${label}`, reasoning_content: `final-reasoning-${label}`, tool_calls: [] },
  ];
}

async function firstCommit() {
  const fixture = temporaryState();
  const committed = await commitKimiCodeSessionState({
    sessionId: createKimiCodeSessionId(),
    model: "k3",
    cwd: fixture.cwd,
    lastCommittedTurnId: "turn-1",
    messages: nativeMessages(),
    env: fixture.env,
  });
  return { ...fixture, ...committed };
}

function cloneSession(session: RuntimeSessionState): RuntimeSessionState {
  return { ...session, params: { ...session.params } };
}

describe("Kimi Code immutable session state", () => {
  test("creates random UUID sessions with the exact private locator fields", async () => {
    const first = await firstCommit();
    const second = await firstCommit();
    const params = first.session.params as Record<string, unknown>;

    expect(first.snapshot.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.snapshot.sessionId).not.toBe(first.snapshot.sessionId);
    expect(Object.keys(params).sort()).toEqual([
      "cwd",
      "lastCommittedTurnId",
      "model",
      "provider",
      "revision",
      "schemaVersion",
      "sessionFile",
      "sessionId",
      "workspaceIdentity",
    ]);
    expect(params).toMatchObject({
      schemaVersion: 1,
      provider: "kimi-code",
      model: "k3",
      sessionId: first.snapshot.sessionId,
      revision: 1,
      cwd: first.cwd,
      lastCommittedTurnId: "turn-1",
      workspaceIdentity: {
        realpath: realpathSync(first.cwd),
        device: expect.stringMatching(/^\d+$/),
        inode: expect.stringMatching(/^[1-9]\d*$/),
      },
    });
    expect(String(params.sessionFile)).toContain(join("runtime", "kimi-code", "sessions", first.snapshot.sessionId));
    expect(JSON.stringify(first.session)).not.toContain("private-reasoning");
    expect(JSON.stringify(first.session)).not.toContain("never-persist-this-key");
  });

  test("commits monotonic immutable revisions atomically with private permissions", async () => {
    const first = await firstCommit();
    const firstFile = String(first.session.params?.sessionFile);
    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-2",
      messages: nativeMessages("two"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });
    const secondFile = String(second.session.params?.sessionFile);

    const sibling = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-collision",
      messages: nativeMessages("collision"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });

    expect(second.snapshot.sessionId).toBe(first.snapshot.sessionId);
    expect(second.snapshot.revision).toBe(2);
    expect(secondFile).not.toBe(firstFile);
    expect(sibling.snapshot.revision).toBe(2);
    expect(String(sibling.session.params?.sessionFile)).not.toBe(secondFile);
    expect(existsSync(firstFile)).toBe(true);
    expect(existsSync(secondFile)).toBe(true);
    expect(readFileSync(String(sibling.session.params?.sessionFile), "utf8")).toContain("answer-collision");
    await expect(
      loadKimiCodeSessionState({ session: first.session, model: "k3", cwd: first.cwd, env: first.env }),
    ).resolves.toEqual(first.snapshot);
    await expect(
      loadKimiCodeSessionState({ session: second.session, model: "k3", cwd: first.cwd, env: first.env }),
    ).resolves.toEqual(second.snapshot);
    await expect(
      loadKimiCodeSessionState({ session: sibling.session, model: "k3", cwd: first.cwd, env: first.env }),
    ).resolves.toEqual(sibling.snapshot);
    expect(readdirSync(dirname(secondFile)).filter((name) => name.includes(".tmp"))).toEqual([]);
    if (process.platform !== "win32") {
      expect(lstatSync(secondFile).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(secondFile)).mode & 0o777).toBe(0o700);
    }
  });

  test("retains only the published revision and clears unpublished temporary artifacts", async () => {
    const first = await firstCommit();
    const firstFile = String(first.session.params?.sessionFile);
    const sessionDirectory = dirname(firstFile);
    const staleTemporary = join(
      sessionDirectory,
      ".revision-00000099-123e4567-e89b-42d3-a456-426614174000.json.223e4567-e89b-42d3-a456-426614174000.tmp",
    );
    writeFileSync(staleTemporary, "unpublished", { encoding: "utf8", mode: 0o600 });
    utimesSync(staleTemporary, new Date(0), new Date(0));

    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-pruned",
      messages: nativeMessages("pruned"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });
    const liveFile = String(second.session.params?.sessionFile);

    expect(existsSync(firstFile)).toBe(true);
    expect(existsSync(staleTemporary)).toBe(false);
    expect(existsSync(liveFile)).toBe(true);
    expect(readdirSync(sessionDirectory).sort()).toEqual([basename(firstFile), basename(liveFile)].sort());
  });

  test("cleans only a validated Kimi session directory and is idempotent", async () => {
    const committed = await firstCommit();
    const sessionFile = String(committed.session.params?.sessionFile);
    const sessionDirectory = dirname(sessionFile);
    const foreign = join(committed.root, "foreign-state");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.txt"), "keep");
    const invalid = cloneSession(committed.session);
    Object.assign(invalid.params ?? {}, { sessionFile: join(foreign, "keep.txt") });

    await expect(cleanupKimiCodeSessionState(invalid, committed.env)).rejects.toThrow("session path is invalid");
    expect(existsSync(join(foreign, "keep.txt"))).toBe(true);

    const fabricated = cloneSession(committed.session);
    Object.assign(fabricated.params ?? {}, { lastCommittedTurnId: "fabricated-turn" });
    await expect(cleanupKimiCodeSessionState(fabricated, committed.env)).rejects.toThrow("snapshot binding mismatch");
    expect(existsSync(sessionFile)).toBe(true);

    await cleanupKimiCodeSessionState(committed.session, committed.env);
    await cleanupKimiCodeSessionState(committed.session, committed.env);
    expect(existsSync(sessionFile)).toBe(false);
    expect(existsSync(sessionDirectory)).toBe(false);
  });

  test("retains a previously returned locator after a newer revision is published", async () => {
    const first = await firstCommit();
    await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-orphan",
      messages: nativeMessages("orphan"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });

    await expect(
      loadKimiCodeSessionState({ session: first.session, model: "k3", cwd: first.cwd, env: first.env }),
    ).resolves.toEqual(first.snapshot);
  });

  test("cleans an unpublished temporary revision and permits retry after a pre-publication crash", async () => {
    const first = await firstCommit();
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));
    await expect(
      commitKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-crash",
        messages: nativeMessages("crash"),
        previousSnapshot: first.snapshot,
        env: first.env,
        faultInjection: {
          beforePublish: () => {
            throw new Error("synthetic crash");
          },
        },
      }),
    ).rejects.toThrow("synthetic crash");

    expect(readdirSync(sessionDirectory).filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(readdirSync(sessionDirectory).filter((name) => name.endsWith(".json"))).toEqual([
      basename(String(first.session.params?.sessionFile)),
    ]);
    const retry = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-retry",
      messages: nativeMessages("retry"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });
    expect(retry.snapshot.revision).toBe(2);
  });

  test("commits after an orphaned next-revision snapshot without overwriting the orphan", async () => {
    const first = await firstCommit();
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));

    await expect(
      commitKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-orphaned",
        messages: nativeMessages("orphaned"),
        previousSnapshot: first.snapshot,
        env: first.env,
        faultInjection: {
          beforePromote: () => {
            throw new Error("synthetic promotion abort");
          },
        },
      }),
    ).rejects.toThrow("synthetic promotion abort");

    const orphan = readdirSync(sessionDirectory)
      .filter((name) => name.endsWith(".json") && name !== basename(String(first.session.params?.sessionFile)))
      .map((name) => join(sessionDirectory, name));
    expect(orphan).toHaveLength(1);
    const orphanBytes = readFileSync(orphan[0]!, "utf8");

    const retry = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-retry-after-orphan",
      messages: nativeMessages("retry-after-orphan"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });

    expect(retry.snapshot.revision).toBe(2);
    expect(String(retry.session.params?.sessionFile)).not.toBe(orphan[0]);
    expect(readFileSync(orphan[0]!, "utf8")).toBe(orphanBytes);
    expect(readFileSync(String(retry.session.params?.sessionFile), "utf8")).toContain("answer-retry-after-orphan");
  });

  test("keeps the previous locator authoritative when promotion aborts", async () => {
    const first = await firstCommit();
    const locatorBefore = JSON.stringify(first.session);

    await expect(
      commitKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-not-promoted",
        messages: nativeMessages("not-promoted"),
        previousSnapshot: first.snapshot,
        env: first.env,
        faultInjection: {
          beforePromote: () => {
            throw new Error("synthetic promotion abort");
          },
        },
      }),
    ).rejects.toThrow("synthetic promotion abort");

    expect(JSON.stringify(first.session)).toBe(locatorBefore);
    await expect(
      loadKimiCodeSessionState({ session: first.session, model: "k3", cwd: first.cwd, env: first.env }),
    ).resolves.toEqual(first.snapshot);
  });

  if (workspaceRetargetCapability.available) {
    test("rejects resume after the same cwd pathname is retargeted", async () => {
      const fixture = temporaryState();
      const firstWorkspace = join(fixture.root, "workspace-one");
      const secondWorkspace = join(fixture.root, "workspace-two");
      const linkedWorkspace = join(fixture.root, "workspace-link");
      mkdirSync(firstWorkspace);
      mkdirSync(secondWorkspace);
      symlinkSync(firstWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
      const committed = await commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: linkedWorkspace,
        lastCommittedTurnId: "turn-before-retarget",
        messages: nativeMessages("before-retarget"),
        env: fixture.env,
      });

      unlinkSync(linkedWorkspace);
      symlinkSync(secondWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");

      await expect(
        loadKimiCodeSessionState({ session: committed.session, model: "k3", cwd: linkedWorkspace, env: fixture.env }),
      ).rejects.toThrow("workspace identity mismatch");
    });

    test("does not alias public workspace identity into the retained snapshot", async () => {
      const fixture = temporaryState();
      const firstWorkspace = join(fixture.root, "alias-workspace-one");
      const secondWorkspace = join(fixture.root, "alias-workspace-two");
      const linkedWorkspace = join(fixture.root, "alias-workspace-link");
      mkdirSync(firstWorkspace);
      mkdirSync(secondWorkspace);
      symlinkSync(firstWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
      const committed = await commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: linkedWorkspace,
        lastCommittedTurnId: "turn-before-public-mutation",
        messages: nativeMessages("before-public-mutation"),
        env: fixture.env,
      });
      const publicIdentity = committed.session.params?.workspaceIdentity as Record<string, unknown>;

      unlinkSync(linkedWorkspace);
      symlinkSync(secondWorkspace, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
      const canonical = realpathSync(linkedWorkspace);
      const info = statSync(canonical, { bigint: true });
      Object.assign(publicIdentity, { realpath: canonical, device: String(info.dev), inode: String(info.ino) });

      await expect(
        commitKimiCodeSessionState({
          sessionId: committed.snapshot.sessionId,
          model: "k3",
          cwd: linkedWorkspace,
          lastCommittedTurnId: "turn-after-public-mutation",
          messages: nativeMessages("after-public-mutation"),
          previousSnapshot: committed.snapshot,
          env: fixture.env,
        }),
      ).rejects.toThrow("previous snapshot is invalid");
      expect(publicIdentity).not.toBe(committed.snapshot.workspaceIdentity);
    });
  } else {
    test.skip(`rejects resume after the same cwd pathname is retargeted [${workspaceRetargetCapability.reason}]`, () => {});
    test.skip(`does not alias public workspace identity into the retained snapshot [${workspaceRetargetCapability.reason}]`, () => {});
  }

  test("fails closed when canonical workspace identity cannot be established", async () => {
    const fixture = temporaryState();
    const missingWorkspace = join(fixture.root, "missing-workspace");

    await expect(
      commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: missingWorkspace,
        lastCommittedTurnId: "turn-missing-workspace",
        messages: nativeMessages("missing-workspace"),
        env: fixture.env,
      }),
    ).rejects.toThrow("workspace identity is unavailable");
  });

  test("round-trips complete reasoning and tool pairings without persisting the API key", async () => {
    const committed = await firstCommit();
    const loaded = await loadKimiCodeSessionState({
      session: committed.session,
      model: "k3",
      cwd: committed.cwd,
      env: committed.env,
    });
    const bytes = readFileSync(String(committed.session.params?.sessionFile), "utf8");

    expect(loaded.messages).toEqual(nativeMessages());
    expect(bytes).toContain("private-reasoning-one");
    expect(bytes).not.toContain("never-persist-this-key");
  });

  test("binds private continuity to a non-secret credential profile fingerprint", async () => {
    const committed = await firstCommit();
    const bytes = readFileSync(String(committed.session.params?.sessionFile), "utf8");
    const fingerprint = (committed.snapshot as unknown as Record<string, unknown>).credentialProfileFingerprint;

    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bytes).toContain(String(fingerprint));
    expect(bytes).not.toContain(committed.env.KIMI_API_KEY);
    await expect(
      loadKimiCodeSessionState({
        session: committed.session,
        model: "k3",
        cwd: committed.cwd,
        env: { ...committed.env, KIMI_API_KEY: "rotated-membership-key" },
      }),
    ).rejects.toThrow("credential profile mismatch");
  });

  test("resumes through host-managed credential and skill metadata without accepting arbitrary fields or secrets", async () => {
    const committed = await firstCommit();
    const binding: RuntimeCredentialAttemptBinding = {
      credentialId: "rcred-kimi-managed",
      label: "Managed Kimi membership",
      fingerprint: "sha256:credential-profile",
      runtimeProvider: "kimi-code",
      resolvedEnv: { KIMI_API_KEY: committed.env.KIMI_API_KEY },
      sensitiveEnvKeys: ["KIMI_API_KEY"],
      remoteForwardEnvKeys: [],
      bindings: [],
    };
    const params = mergeRuntimeCredentialSessionMetadata(committed.session.params ?? undefined, binding);
    const skillVisibility = markLoadedFromSkillGate(
      markLoadedFromRaviSkillToolCall(emptySkillVisibilitySnapshot(100), {
        provider: "kimi-code",
        toolName: "ravi_skills_show",
        toolInput: { name: "release-check" },
        output: { name: "release-check" },
        now: 200,
      }),
      {
        provider: "kimi-code",
        skill: "gated-check",
        source: "synthetic",
        path: "C:/synthetic/SKILL.md",
        toolName: "ravi_tasks_add",
        now: 300,
      },
    );
    Object.assign(params ?? {}, { skillVisibility });
    const resumed: RuntimeSessionState = { ...committed.session, params };

    expect(JSON.stringify(resumed)).not.toContain(committed.env.KIMI_API_KEY);
    await expect(
      loadKimiCodeSessionState({ session: resumed, model: "k3", cwd: committed.cwd, env: committed.env }),
    ).resolves.toEqual(committed.snapshot);

    const arbitraryLocator = cloneSession(resumed);
    Object.assign(arbitraryLocator.params ?? {}, { arbitrary: "metadata" });
    await expect(
      loadKimiCodeSessionState({ session: arbitraryLocator, model: "k3", cwd: committed.cwd, env: committed.env }),
    ).rejects.toThrow("locator is invalid");

    const credentialWithSecret = cloneSession(resumed);
    Object.assign(credentialWithSecret.params?.runtimeCredential as Record<string, unknown>, {
      KIMI_API_KEY: committed.env.KIMI_API_KEY,
    });
    await expect(
      loadKimiCodeSessionState({ session: credentialWithSecret, model: "k3", cwd: committed.cwd, env: committed.env }),
    ).rejects.toThrow("locator is invalid");

    const secretInAllowedMetadata = cloneSession(resumed);
    Object.assign(secretInAllowedMetadata.params?.runtimeCredential as Record<string, unknown>, {
      fingerprint: committed.env.KIMI_API_KEY,
    });
    await expect(
      loadKimiCodeSessionState({
        session: secretInAllowedMetadata,
        model: "k3",
        cwd: committed.cwd,
        env: committed.env,
      }),
    ).rejects.toThrow("locator is invalid");

    const malformedSkillVisibility = cloneSession(resumed);
    Object.assign(malformedSkillVisibility.params ?? {}, {
      skillVisibility: { skills: [{ id: "release-check" }], loadedSkills: [], updatedAt: 200 },
    });
    await expect(
      loadKimiCodeSessionState({
        session: malformedSkillVisibility,
        model: "k3",
        cwd: committed.cwd,
        env: committed.env,
      }),
    ).rejects.toThrow("locator is invalid");

    const skillVisibilityWithSecret = cloneSession(resumed);
    const secretSkills = (
      (skillVisibilityWithSecret.params?.skillVisibility as Record<string, unknown>).skills as Array<
        Record<string, unknown>
      >
    ).map((skill) => ({ ...skill, source: committed.env.KIMI_API_KEY }));
    Object.assign(skillVisibilityWithSecret.params ?? {}, {
      skillVisibility: { ...skillVisibility, skills: secretSkills },
    });
    await expect(
      loadKimiCodeSessionState({
        session: skillVisibilityWithSecret,
        model: "k3",
        cwd: committed.cwd,
        env: committed.env,
      }),
    ).rejects.toThrow("locator is invalid");
  });

  test("does not inherit the managed Kimi key into the Windows ACL child environment", async () => {
    const fixture = temporaryState();
    const observed: NodeJS.ProcessEnv[] = [];

    await commitKimiCodeSessionState({
      sessionId: createKimiCodeSessionId(),
      model: "k3",
      cwd: fixture.cwd,
      lastCommittedTurnId: "turn-acl-env",
      messages: nativeMessages(),
      env: fixture.env,
      faultInjection: { observeAclProcessEnv: (env) => observed.push(env) },
    });

    if (process.platform === "win32") expect(observed).toHaveLength(2);
    for (const env of observed) {
      expect(env.KIMI_API_KEY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(fixture.env.KIMI_API_KEY);
    }
  });

  test("rejects a commit when native state contains the configured API key", async () => {
    const fixture = temporaryState();
    await expect(
      commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-key",
        messages: [
          { role: "user", content: "lookup" },
          { role: "tool", tool_call_id: "call-key", content: fixture.env.KIMI_API_KEY },
        ],
        env: fixture.env,
      }),
    ).rejects.toThrow("Kimi Code session state contains configured credential");
    expect(existsSync(join(fixture.env.RAVI_STATE_DIR, "runtime", "kimi-code", "sessions"))).toBe(false);
  });

  test("rejects escaped credential values and credential-bearing public locator paths", async () => {
    const fixture = temporaryState();
    const escapedKey = 'key-with-"quote\\slash\nand-control';
    await expect(
      commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-escaped-key",
        messages: [{ role: "user", content: escapedKey }],
        env: { ...fixture.env, KIMI_API_KEY: escapedKey },
      }),
    ).rejects.toThrow("Kimi Code session state contains configured credential");

    const keyInPath = "key-in-public-locator";
    await expect(
      commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-key-path",
        messages: nativeMessages(),
        env: {
          ...fixture.env,
          KIMI_API_KEY: keyInPath,
          RAVI_STATE_DIR: join(fixture.root, keyInPath, "state"),
        },
      }),
    ).rejects.toThrow("Kimi Code session state contains configured credential");
  });

  test("does not let a stale reservation artifact block the next immutable revision", async () => {
    const first = await firstCommit();
    const firstFile = String(first.session.params?.sessionFile);
    const staleReservation = join(dirname(firstFile), "revision-00000002.json.lock");
    writeFileSync(staleReservation, "stale", { encoding: "utf8", mode: 0o600 });

    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-after-crash",
      messages: nativeMessages("after-crash"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });

    expect(second.snapshot.revision).toBe(2);
    expect(readFileSync(String(second.session.params?.sessionFile), "utf8")).toContain("answer-after-crash");
  });

  test("rejects oversized state deterministically without lossy compaction", async () => {
    const fixture = temporaryState();
    await expect(
      commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-large",
        messages: [
          { role: "user", content: "oversized" },
          { role: "assistant", content: "x".repeat(1024 * 1024), reasoning_content: "", tool_calls: [] },
        ],
        env: fixture.env,
      }),
    ).rejects.toThrow("Kimi Code session state exceeds maximum size");
    expect(existsSync(join(fixture.env.RAVI_STATE_DIR, "runtime", "kimi-code", "sessions"))).toBe(false);
  });

  test("rejects locator and snapshot binding mismatches", async () => {
    const committed = await firstCommit();
    const mutations: Array<[string, (snapshot: RuntimeSessionState) => void, string, string]> = [
      ["model", (state) => Object.assign(state.params ?? {}, { model: "k2.5" }), "k3", committed.cwd],
      ["provider", (state) => Object.assign(state.params ?? {}, { provider: "other" }), "k3", committed.cwd],
      ["schema", (state) => Object.assign(state.params ?? {}, { schemaVersion: 2 }), "k3", committed.cwd],
      ["cwd", (state) => Object.assign(state.params ?? {}, { cwd: join(committed.cwd, "other") }), "k3", committed.cwd],
      [
        "session",
        (state) => Object.assign(state.params ?? {}, { sessionId: "00000000-0000-4000-8000-000000000000" }),
        "k3",
        committed.cwd,
      ],
      ["revision", (state) => Object.assign(state.params ?? {}, { revision: 9 }), "k3", committed.cwd],
    ];

    for (const [name, mutate, model, cwd] of mutations) {
      const session = cloneSession(committed.session);
      mutate(session);
      await expect(loadKimiCodeSessionState({ session, model, cwd, env: committed.env }), name).rejects.toThrow();
    }
    await expect(
      loadKimiCodeSessionState({ session: committed.session, model: "k2.5", cwd: committed.cwd, env: committed.env }),
    ).rejects.toThrow();
    await expect(
      loadKimiCodeSessionState({
        session: committed.session,
        model: "k3",
        cwd: join(committed.cwd, "different"),
        env: committed.env,
      }),
    ).rejects.toThrow();
  });

  test("rejects corrupt native tool pairing and message ordering", async () => {
    const fixture = temporaryState();
    const invalidMessages: KimiCodeConversationMessage[][] = [
      [{ role: "tool", tool_call_id: "orphan", content: "result" }],
      [
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "private",
          tool_calls: [{ id: "", type: "function", function: { name: "lookup", arguments: "{}" } }],
        },
      ],
      [
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "private",
          tool_calls: [
            { id: "duplicate", type: "function", function: { name: "lookup", arguments: "{}" } },
            { id: "duplicate", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "duplicate", content: "one" },
        { role: "tool", tool_call_id: "duplicate", content: "two" },
        { role: "assistant", content: "answer", reasoning_content: "private", tool_calls: [] },
      ],
    ];

    for (const messages of invalidMessages) {
      await expect(
        commitKimiCodeSessionState({
          sessionId: createKimiCodeSessionId(),
          model: "k3",
          cwd: fixture.cwd,
          lastCommittedTurnId: "turn-corrupt-pairing",
          messages,
          env: fixture.env,
        }),
      ).rejects.toThrow("native messages are invalid");
    }
  });

  test("allows a provider tool-call id to be reused in a later completed turn", async () => {
    const fixture = temporaryState();
    const repeated = nativeMessages("reused");
    await expect(
      commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-reused-id",
        messages: [...repeated, ...repeated],
        env: fixture.env,
      }),
    ).resolves.toMatchObject({ snapshot: { revision: 1 } });
  });

  test("keeps conventional Windows cwd matching separate from exact locator matching", async () => {
    if (process.platform !== "win32") return;
    const committed = await firstCommit();
    const changedCaseCwd = committed.cwd.replace(/[a-z]/, (character) => character.toUpperCase());
    if (changedCaseCwd === committed.cwd) return;

    await expect(
      loadKimiCodeSessionState({
        session: committed.session,
        model: "k3",
        cwd: changedCaseCwd,
        env: committed.env,
      }),
    ).resolves.toEqual(committed.snapshot);
  });

  test("rejects missing, corrupt, traversal, and absolute-escape state files", async () => {
    const committed = await firstCommit();
    const originalFile = String(committed.session.params?.sessionFile);
    const outside = join(committed.root, "outside.json");
    writeFileSync(outside, "{}", "utf8");

    const lexicalTraversal = `${dirname(originalFile)}${sep}..${sep}${committed.snapshot.sessionId}${sep}${basename(originalFile)}`;
    for (const candidate of [lexicalTraversal, join(committed.env.RAVI_STATE_DIR, "..", "outside.json"), outside]) {
      const escaped = cloneSession(committed.session);
      Object.assign(escaped.params ?? {}, { sessionFile: candidate });
      await expect(
        loadKimiCodeSessionState({ session: escaped, model: "k3", cwd: committed.cwd, env: committed.env }),
      ).rejects.toThrow();
    }

    rmSync(originalFile);
    await expect(
      loadKimiCodeSessionState({
        session: committed.session,
        model: "k3",
        cwd: committed.cwd,
        env: committed.env,
      }),
    ).rejects.toThrow();
    writeFileSync(originalFile, "{broken", { encoding: "utf8", mode: 0o600 });
    await expect(
      loadKimiCodeSessionState({
        session: committed.session,
        model: "k3",
        cwd: committed.cwd,
        env: committed.env,
      }),
    ).rejects.toThrow();
  });

  test("requires the generated session locator path to match exact normalized casing", async () => {
    const committed = await firstCommit();
    const altered = cloneSession(committed.session);
    const original = String(altered.params?.sessionFile);
    const changedCase = original.replace(/[a-z]/, (character) => character.toUpperCase());
    if (changedCase === original) return;
    Object.assign(altered.params ?? {}, { sessionFile: changedCase });

    await expect(
      loadKimiCodeSessionState({ session: altered, model: "k3", cwd: committed.cwd, env: committed.env }),
    ).rejects.toThrow("session path is invalid");
  });

  test("rejects a symlink or reparse-point escape where the platform permits creating one", async () => {
    const committed = await firstCommit();
    const sessionFile = String(committed.session.params?.sessionFile);
    const outsideFile = join(committed.root, "outside-snapshot.json");
    copyFileSync(sessionFile, outsideFile);
    rmSync(sessionFile);
    try {
      symlinkSync(outsideFile, sessionFile, "file");
    } catch {
      copyFileSync(outsideFile, sessionFile);
      chmodSync(sessionFile, 0o600);
      return;
    }

    expect(relative(committed.env.RAVI_STATE_DIR, sessionFile).startsWith("..")).toBe(false);
    await expect(
      loadKimiCodeSessionState({
        session: committed.session,
        model: "k3",
        cwd: committed.cwd,
        env: committed.env,
      }),
    ).rejects.toThrow();
  });

  test("rejects an ancestor symlink or junction before creating directories through it", async () => {
    const fixture = temporaryState();
    const outsideState = join(fixture.root, "outside-state");
    const linkedState = join(fixture.root, "linked-state");
    mkdirSync(outsideState);
    try {
      symlinkSync(outsideState, linkedState, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    await expect(
      commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-ancestor-link",
        messages: nativeMessages(),
        env: { ...fixture.env, RAVI_STATE_DIR: linkedState },
      }),
    ).rejects.toThrow();
    expect(existsSync(join(outsideState, "runtime"))).toBe(false);
  });

  test.skipIf(process.platform !== "win32")(
    "does not transiently open a snapshot under a permissive inherited Windows ACL",
    async () => {
      const fixture = temporaryState();
      mkdirSync(fixture.env.RAVI_STATE_DIR);
      execFileSync("icacls", [fixture.env.RAVI_STATE_DIR, "/grant", "*S-1-1-0:(OI)(CI)R", "/Q"]);
      const allowed = new Set([currentWindowsSid(), "S-1-5-18", "S-1-5-32-544"]);
      let inspectedOpenSnapshot = false;

      await commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-transient-acl",
        messages: nativeMessages("transient-acl"),
        env: fixture.env,
        faultInjection: {
          observeAclProcessEnv: (env) => {
            const targets = JSON.parse(env.RAVI_KIMI_ACL_TARGETS ?? "[]") as Array<{
              path: string;
              directory: boolean;
            }>;
            const snapshot = targets.find((target) => !target.directory);
            if (!snapshot) return;
            inspectedOpenSnapshot = true;
            expect(new Set(windowsAclSids(dirname(snapshot.path)))).toEqual(allowed);
            expect(new Set(windowsAclSids(snapshot.path))).toEqual(allowed);
          },
        },
      });

      expect(inspectedOpenSnapshot).toBe(true);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "creates the Windows provider root with its protected ACL atomically on first use",
    async () => {
      const fixture = temporaryState();
      mkdirSync(fixture.env.RAVI_STATE_DIR);
      execFileSync("icacls", [fixture.env.RAVI_STATE_DIR, "/grant", "*S-1-1-0:(OI)(CI)R", "/Q"]);
      const providerRoot = join(fixture.env.RAVI_STATE_DIR, "runtime", "kimi-code");
      const allowed = new Set([currentWindowsSid(), "S-1-5-18", "S-1-5-32-544"]);

      const pending = commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-atomic-provider-root",
        messages: nativeMessages("atomic-provider-root"),
        env: fixture.env,
      });
      while (!existsSync(providerRoot)) await new Promise((resolve) => setTimeout(resolve, 1));
      const firstVisibleAcl = new Set(windowsAclSids(providerRoot));
      await pending;

      expect(firstVisibleAcl).toEqual(allowed);
    },
  );

  test("fails closed when an existing Windows session directory no longer has the exact private ACL", async () => {
    if (process.platform !== "win32") return;
    const committed = await firstCommit();
    const sessionFile = String(committed.session.params?.sessionFile);
    const sessionDirectory = dirname(sessionFile);
    execFileSync("icacls", [sessionDirectory, "/grant", "*S-1-1-0:(OI)(CI)R", "/Q"]);

    await expect(
      commitKimiCodeSessionState({
        sessionId: committed.snapshot.sessionId,
        model: "k3",
        cwd: committed.cwd,
        lastCommittedTurnId: "turn-acl",
        messages: nativeMessages("acl"),
        previousSnapshot: committed.snapshot,
        env: committed.env,
      }),
    ).rejects.toThrow();
    expect(existsSync(String(committed.session.params?.sessionFile))).toBe(true);
  });
});

function currentWindowsSid(): string {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8" },
  ).trim();
}

function windowsAclSids(path: string): string[] {
  const script = [
    "$acl = Get-Acl -LiteralPath $env:RAVI_TEST_ACL_PATH",
    "$acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }",
  ].join("; ");
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, RAVI_TEST_ACL_PATH: path },
  })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
