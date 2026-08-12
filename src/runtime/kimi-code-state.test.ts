import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { mergeRuntimeCredentialSessionMetadata } from "./credential-resolver.js";
import {
  KIMI_CODE_STATE_ERROR_CODES,
  KimiCodeStateError,
  cleanupKimiCodeSessionState,
  closeKimiCodePublishIntentCursor,
  classifyKimiCodeStateError,
  commitKimiCodeSessionState,
  createKimiCodeSessionId,
  executeKimiCodeProvisionalExactCleanup,
  executeKimiCodeDeleteStateCleanup,
  executeKimiCodeRetireRevisionCleanup,
  loadKimiCodeSessionState,
  parseKimiCodeCleanupLocator,
  listKimiCodePublishIntents,
  prepareKimiCodeSessionState,
  projectKimiCodeCleanupLocator,
  readKimiCodePublishIntent,
  removeKimiCodePublishIntent,
  serializeKimiCodeCleanupLocator,
} from "./kimi-code-state.js";
import {
  emptySkillVisibilitySnapshot,
  markLoadedFromRaviSkillToolCall,
  markLoadedFromSkillGate,
} from "./skill-visibility.js";
import type { KimiCodeConversationMessage } from "./kimi-code-turn.js";
import type { KimiCodeStateErrorCode } from "./kimi-code-state.js";
import type { RuntimeCredentialAttemptBinding } from "./credential-types.js";
import type { RuntimeSessionState } from "./types.js";

const temporaryRoots = new Set<string>();

if (process.platform === "win32") setDefaultTimeout(20_000);

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

async function allPublishIntents(env: NodeJS.ProcessEnv): Promise<string[]> {
  const paths: string[] = [];
  let cursor: Awaited<ReturnType<typeof listKimiCodePublishIntents>>["nextCursor"];
  try {
    do {
      const page = await listKimiCodePublishIntents(cursor ? { cursor, limit: 32 } : { env, limit: 32 });
      paths.push(...page.intentPaths);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return paths;
  } finally {
    if (cursor) await closeKimiCodePublishIntentCursor(cursor);
  }
}

describe("Kimi Code state failure and cleanup locator contract", () => {
  test("exposes only the closed non-secret state codes and maps filesystem codes without reading messages", () => {
    expect(KIMI_CODE_STATE_ERROR_CODES).toEqual([
      "state_missing",
      "io_transient",
      "state_busy",
      "invalid_locator",
      "schema_mismatch",
      "binding_mismatch",
      "foreign_root",
      "reparse_detected",
      "credential_detected",
      "unknown",
    ]);

    const secret = "must-not-escape";
    const cases: Array<[unknown, KimiCodeStateErrorCode]> = [
      [{ code: "ENOENT", message: secret }, "state_missing"],
      [{ code: "EIO", message: secret }, "io_transient"],
      [{ code: "EBUSY", message: secret }, "state_busy"],
      [{ code: "UNRECOGNIZED", message: secret }, "unknown"],
      [new Error(secret), "unknown"],
    ];
    for (const [cause, expectedCode] of cases) {
      const classified = classifyKimiCodeStateError(cause);
      expect(classified).toBeInstanceOf(KimiCodeStateError);
      expect(classified.code).toBe(expectedCode);
      expect(classified.message).not.toContain(secret);
      expect("cause" in classified).toBe(false);
    }

    for (const code of KIMI_CODE_STATE_ERROR_CODES) {
      const error = new KimiCodeStateError(code);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(secret);
    }
  });

  test("projects canonical Kimi locator bytes while excluding every source-only field", async () => {
    const committed = await firstCommit();
    const source: RuntimeSessionState = {
      ...committed.session,
      params: {
        ...committed.session.params,
        runtimeCredential: { credentialId: "host-only" },
        skillVisibility: { loadedSkills: ["host-only"] },
        arbitrary: { nested: "host-only" },
      },
    };

    const projected = projectKimiCodeCleanupLocator(source, committed.env);
    const serialized = serializeKimiCodeCleanupLocator(source, committed.env);
    expect(serialized).toBe(JSON.stringify(projected));
    expect(Object.keys(projected)).toEqual([
      "schemaVersion",
      "provider",
      "model",
      "sessionId",
      "revision",
      "cwd",
      "workspaceIdentity",
      "sessionFile",
      "lastCommittedTurnId",
    ]);
    expect(serialized).not.toContain("runtimeCredential");
    expect(serialized).not.toContain("skillVisibility");
    expect(serialized).not.toContain("arbitrary");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(parseKimiCodeCleanupLocator(serialized, committed.env)).toEqual(projected);
  });

  test("rejects noncanonical or invalid Kimi cleanup locators with typed semantic codes", async () => {
    const committed = await firstCommit();
    const canonical = JSON.parse(serializeKimiCodeCleanupLocator(committed.session, committed.env)) as Record<
      string,
      unknown
    >;
    const mutations: Array<[Record<string, unknown> | string, KimiCodeStateErrorCode]> = [
      [{ ...canonical, provider: "other" }, "invalid_locator"],
      [{ ...canonical, schemaVersion: 2 }, "schema_mismatch"],
      [{ ...canonical, sessionId: "not-a-uuid" }, "invalid_locator"],
      [{ ...canonical, revision: 0 }, "invalid_locator"],
      [{ ...canonical, sessionFile: join(committed.root, "outside.json") }, "foreign_root"],
      [
        { ...canonical, sessionFile: `${dirname(String(canonical.sessionFile))}${sep}..${sep}escape.json` },
        "foreign_root",
      ],
      [{ ...canonical, lastCommittedTurnId: "" }, "invalid_locator"],
      [{ ...canonical, unknown: true }, "invalid_locator"],
      [`${JSON.stringify(canonical)} `, "invalid_locator"],
    ];

    for (const [value, expectedCode] of mutations) {
      try {
        parseKimiCodeCleanupLocator(typeof value === "string" ? value : JSON.stringify(value), committed.env);
        throw new Error("expected locator rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(KimiCodeStateError);
        expect((error as KimiCodeStateError).code).toBe(expectedCode);
      }
    }
  });
});

describe("Kimi Code prepared state publication", () => {
  test("classifies preparation filesystem failures without exposing private paths", async () => {
    const fixture = temporaryState();
    const privateMarker = "private-path-marker";
    fixture.env.RAVI_STATE_DIR = `${fixture.env.RAVI_STATE_DIR}-${privateMarker}\0`;

    let failure: unknown;
    try {
      await prepareKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-private-failure",
        messages: nativeMessages("private-failure"),
        taskId: "task-private-failure",
        ownerAttemptId: "attempt-private-failure",
        env: fixture.env,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(KimiCodeStateError);
    expect((failure as KimiCodeStateError).code).toBe("unknown");
    expect((failure as Error).message).not.toContain(privateMarker);
    expect("cause" in (failure as object)).toBe(false);
  });

  test("scans intents incrementally past the hard budget and isolates malformed candidates", async () => {
    const first = await firstCommit();
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(sessionDirectory, `bounded-noise-${index.toString().padStart(3, "0")}`), "x");
    }
    writeFileSync(join(sessionDirectory, ".publish-intent-malformed.json"), "not-json", { mode: 0o600 });
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-page-tail",
      messages: nativeMessages("page-tail"),
      previousSnapshot: first.snapshot,
      taskId: "task-page-tail",
      ownerAttemptId: "attempt-page-tail",
      env: first.env,
    });

    const candidates = [];
    let cursor: Awaited<ReturnType<typeof listKimiCodePublishIntents>>["nextCursor"];
    let pages = 0;
    try {
      do {
        const page = await listKimiCodePublishIntents(cursor ? { cursor, limit: 2 } : { env: first.env, limit: 2 });
        candidates.push(...page.candidates);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor);
    } finally {
      if (cursor) await closeKimiCodePublishIntentCursor(cursor);
    }
    expect(pages).toBeGreaterThan(1);
    expect(candidates).toContainEqual({
      kind: "invalid",
      path: join(sessionDirectory, ".publish-intent-malformed.json"),
      code: "schema_mismatch",
    });
    expect(candidates).toContainEqual({ kind: "canonical", path: prepared.intentPath });
    const early = await listKimiCodePublishIntents({ env: first.env, limit: 1 });
    expect(early.nextCursor).toBeDefined();
    await closeKimiCodePublishIntentCursor(early.nextCursor!);
    await expect(listKimiCodePublishIntents({ cursor: early.nextCursor!, limit: 1 })).rejects.toMatchObject({
      code: "invalid_locator",
    });

    const retryableClose = await listKimiCodePublishIntents({ env: first.env, limit: 1 });
    let closeFailed = false;
    await expect(
      closeKimiCodePublishIntentCursor(retryableClose.nextCursor!, {
        closeDirectory: async (kind) => {
          if (kind === "root" && !closeFailed) {
            closeFailed = true;
            throw { code: "EIO" };
          }
        },
      }),
    ).rejects.toMatchObject({ code: "io_transient" });
    await closeKimiCodePublishIntentCursor(retryableClose.nextCursor!);
    await expect(listKimiCodePublishIntents({ cursor: retryableClose.nextCursor!, limit: 1 })).rejects.toMatchObject({
      code: "invalid_locator",
    });
    await expect(listKimiCodePublishIntents({ env: first.env, limit: 0 })).rejects.toMatchObject({
      code: "invalid_locator",
    });
    await expect(listKimiCodePublishIntents({ env: first.env, limit: 33 })).rejects.toMatchObject({
      code: "invalid_locator",
    });
  }, 20_000);

  test.skipIf(process.platform !== "win32")(
    "discovers a staging-only intent after an ambiguous Windows intent move",
    async () => {
      const first = await firstCommit();
      await expect(
        prepareKimiCodeSessionState({
          sessionId: first.snapshot.sessionId,
          model: "k3",
          cwd: first.cwd,
          lastCommittedTurnId: "turn-staging-timeout",
          messages: nativeMessages("staging-timeout"),
          previousSnapshot: first.snapshot,
          taskId: "task-staging-timeout",
          ownerAttemptId: "attempt-staging-timeout",
          env: first.env,
          faultInjection: { intentWindowsMoveTimeoutMs: 1 },
        }),
      ).rejects.toBeInstanceOf(KimiCodeStateError);

      const page = await listKimiCodePublishIntents({ env: first.env, limit: 4 });
      try {
        const staging = page.candidates.find((candidate) => candidate.kind === "staging");
        expect(staging?.path.endsWith(".publish-intent-task-staging-timeout.staging")).toBe(true);
        const intent = await readKimiCodePublishIntent(staging!.path, first.env);
        expect(intent).toMatchObject({
          taskId: "task-staging-timeout",
          ownerAttemptId: "attempt-staging-timeout",
        });
        await executeKimiCodeProvisionalExactCleanup({
          locatorJson: intent.locatorJson,
          taskId: intent.taskId,
          ownerAttemptId: intent.ownerAttemptId,
          env: first.env,
          isLocatorOwned: () => false,
        });
        expect(existsSync(staging!.path)).toBe(false);
      } finally {
        if (page.nextCursor) await closeKimiCodePublishIntentCursor(page.nextCursor);
      }
    },
    20_000,
  );

  test("writes an exact redacted private intent and publishes synchronously exactly once", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-prepared",
      messages: nativeMessages("prepared"),
      previousSnapshot: first.snapshot,
      taskId: "task-prepared-01",
      ownerAttemptId: "attempt-prepared-01",
      env: first.env,
    });
    const finalPath = String(prepared.session.params?.sessionFile);

    expect(existsSync(finalPath)).toBe(false);
    expect(prepared.locatorJson).toBe(serializeKimiCodeCleanupLocator(prepared.session, first.env));
    expect(prepared.taskId).toBe("task-prepared-01");
    expect(prepared.ownerAttemptId).toBe("attempt-prepared-01");
    const intents = await allPublishIntents(first.env);
    expect(intents).toEqual([prepared.intentPath]);
    const intent = await readKimiCodePublishIntent(prepared.intentPath, first.env);
    expect(Object.keys(intent)).toEqual(["schemaVersion", "locatorJson", "taskId", "ownerAttemptId"]);
    expect(intent).toEqual({
      schemaVersion: 1,
      locatorJson: prepared.locatorJson,
      taskId: prepared.taskId,
      ownerAttemptId: prepared.ownerAttemptId,
    });
    const intentBytes = readFileSync(prepared.intentPath, "utf8");
    expect(intentBytes).not.toContain("messages");
    expect(intentBytes).not.toContain("reasoning");
    expect(intentBytes).not.toContain(first.env.KIMI_API_KEY);
    if (process.platform !== "win32") expect(lstatSync(prepared.intentPath).mode & 0o777).toBe(0o600);

    const result = prepared.publish();
    expect(result).toBeUndefined();
    expect((result as unknown as { then?: unknown } | undefined)?.then).toBeUndefined();
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(prepared.intentPath)).toBe(true);
    expect(() => prepared.publish()).toThrow();

    await removeKimiCodePublishIntent(prepared.intentPath, first.env);
    expect(existsSync(prepared.intentPath)).toBe(false);
    expect(existsSync(finalPath)).toBe(true);
  });

  test.skipIf(process.platform !== "win32")(
    "uses fixed write-through Windows moves with a minimal secret-free environment",
    async () => {
      const first = await firstCommit();
      const observed: NodeJS.ProcessEnv[] = [];
      const executables: string[] = [];
      const prepared = await prepareKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-windows-write-through",
        messages: nativeMessages("windows-write-through"),
        previousSnapshot: first.snapshot,
        taskId: "task-windows-write-through",
        ownerAttemptId: "attempt-windows-write-through",
        env: first.env,
        faultInjection: {
          observeWindowsMoveProcessEnv: (env) => observed.push(env),
          observePowerShellExecutable: (path) => executables.push(path),
        },
      });

      expect(observed).toHaveLength(1);
      expect(existsSync(prepared.intentPath)).toBe(true);
      prepared.publish();
      expect(observed).toHaveLength(2);
      for (const env of observed) {
        expect(env.RAVI_KIMI_MOVE_SOURCE).toBeDefined();
        expect(env.RAVI_KIMI_MOVE_DESTINATION).toBeDefined();
        expect(env.KIMI_API_KEY).toBeUndefined();
        expect(env.PATH).toBeUndefined();
        expect(JSON.stringify(env)).not.toContain(first.env.KIMI_API_KEY);
      }
      expect(executables).toHaveLength(2);
      for (const executable of executables) {
        expect(executable).toBe(
          realpathSync(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")),
        );
      }
    },
    20_000,
  );

  test.skipIf(process.platform !== "win32")(
    "rejects a complete fake SystemRoot tree before spawning its PowerShell",
    async () => {
      const fixture = temporaryState();
      const originalSystemRoot = process.env.SystemRoot;
      const originalWindir = process.env.WINDIR;
      const fakeRoot = join(fixture.root, "fake-system-root");
      const fakePowerShell = join(fakeRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      mkdirSync(dirname(fakePowerShell), { recursive: true });
      copyFileSync(process.execPath, fakePowerShell);
      process.env.SystemRoot = fakeRoot;
      process.env.WINDIR = fakeRoot;
      try {
        await expect(
          prepareKimiCodeSessionState({
            sessionId: createKimiCodeSessionId(),
            model: "k3",
            cwd: fixture.cwd,
            lastCommittedTurnId: "turn-fake-system-root",
            messages: nativeMessages("fake-system-root"),
            taskId: "task-fake-system-root",
            ownerAttemptId: "attempt-fake-system-root",
            env: fixture.env,
          }),
        ).rejects.toMatchObject({ code: "foreign_root" });
        expect(readFileSync(fakePowerShell)).toEqual(readFileSync(process.execPath));
      } finally {
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
        if (originalWindir === undefined) delete process.env.WINDIR;
        else process.env.WINDIR = originalWindir;
      }
    },
    20_000,
  );

  test.skipIf(process.platform !== "win32")(
    "Windows publication is no-replace and preserves intent on destination collision",
    async () => {
      const first = await firstCommit();
      const prepared = await prepareKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-windows-no-replace",
        messages: nativeMessages("windows-no-replace"),
        previousSnapshot: first.snapshot,
        taskId: "task-windows-no-replace",
        ownerAttemptId: "attempt-windows-no-replace",
        env: first.env,
      });
      const finalPath = String(prepared.session.params?.sessionFile);
      writeFileSync(finalPath, "pre-existing-destination", { mode: 0o600 });

      let collision: unknown;
      try {
        prepared.publish();
      } catch (error) {
        collision = error;
      }
      expect(collision).toBeInstanceOf(KimiCodeStateError);
      expect((collision as KimiCodeStateError).code).toBe("state_busy");
      expect(() => prepared.publish()).toThrow(KimiCodeStateError);
      expect(readFileSync(finalPath, "utf8")).toBe("pre-existing-destination");
      expect(existsSync(prepared.intentPath)).toBe(true);
      expect(existsSync(prepared.temporaryPath)).toBe(true);
    },
    20_000,
  );

  test.skipIf(process.platform !== "win32")(
    "Windows publication timeout fails closed and retains recovery intent",
    async () => {
      const first = await firstCommit();
      const prepared = await prepareKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-windows-timeout",
        messages: nativeMessages("windows-timeout"),
        previousSnapshot: first.snapshot,
        taskId: "task-windows-timeout",
        ownerAttemptId: "attempt-windows-timeout",
        env: first.env,
        faultInjection: { publishWindowsMoveTimeoutMs: 1 },
      });

      expect(() => prepared.publish()).toThrow(KimiCodeStateError);
      expect(existsSync(prepared.intentPath)).toBe(true);
    },
    20_000,
  );

  test("validates bounded path-safe reservation identifiers before creating state", async () => {
    const fixture = temporaryState();
    const inputs = [
      { taskId: "../escape", ownerAttemptId: "attempt-safe" },
      { taskId: "task-safe", ownerAttemptId: "attempt/escape" },
      { taskId: "x".repeat(129), ownerAttemptId: "attempt-safe" },
      { taskId: "task-safe", ownerAttemptId: "" },
    ];
    for (const identifiers of inputs) {
      await expect(
        prepareKimiCodeSessionState({
          sessionId: createKimiCodeSessionId(),
          model: "k3",
          cwd: fixture.cwd,
          lastCommittedTurnId: "turn-invalid-id",
          messages: nativeMessages("invalid-id"),
          ...identifiers,
          env: fixture.env,
        }),
      ).rejects.toMatchObject({ code: "invalid_locator" });
    }
    expect(existsSync(join(fixture.env.RAVI_STATE_DIR, "runtime", "kimi-code", "sessions"))).toBe(false);
  });

  test("a duplicate preparation cannot remove another invocation's unpublished artifacts", async () => {
    const first = await firstCommit();
    const input = {
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-duplicate-unpublished",
      messages: nativeMessages("duplicate-unpublished"),
      previousSnapshot: first.snapshot,
      taskId: "task-duplicate-unpublished",
      ownerAttemptId: "attempt-duplicate-unpublished",
      env: first.env,
    };
    const owner = await prepareKimiCodeSessionState(input);
    const intentBefore = readFileSync(owner.intentPath);
    const tempBefore = readFileSync(owner.temporaryPath);

    await expect(prepareKimiCodeSessionState(input)).rejects.toMatchObject({ code: "state_busy" });

    expect(readFileSync(owner.intentPath)).toEqual(intentBefore);
    expect(readFileSync(owner.temporaryPath)).toEqual(tempBefore);
    owner.publish();
    expect(existsSync(String(owner.session.params?.sessionFile))).toBe(true);
  });

  test("a duplicate preparation after publication preserves the authoritative intent and final", async () => {
    const first = await firstCommit();
    const input = {
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-duplicate-published",
      messages: nativeMessages("duplicate-published"),
      previousSnapshot: first.snapshot,
      taskId: "task-duplicate-published",
      ownerAttemptId: "attempt-duplicate-published",
      env: first.env,
    };
    const owner = await prepareKimiCodeSessionState(input);
    owner.publish();
    const finalPath = String(owner.session.params?.sessionFile);
    const intentBefore = readFileSync(owner.intentPath);
    const finalBefore = readFileSync(finalPath);

    await expect(prepareKimiCodeSessionState(input)).rejects.toMatchObject({ code: "state_busy" });

    expect(readFileSync(owner.intentPath)).toEqual(intentBefore);
    expect(readFileSync(finalPath)).toEqual(finalBefore);
    expect(existsSync(owner.temporaryPath)).toBe(false);
  });

  test("retains only authoritative recovery evidence at each preparation and publication crash boundary", async () => {
    const first = await firstCommit();
    const base = {
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      messages: nativeMessages("crash-boundary"),
      previousSnapshot: first.snapshot,
      env: first.env,
    };

    await expect(
      prepareKimiCodeSessionState({
        ...base,
        lastCommittedTurnId: "turn-before-intent-sync",
        taskId: "task-before-intent-sync",
        ownerAttemptId: "attempt-before-intent-sync",
        faultInjection: {
          beforeIntentSync: () => {
            throw new Error("before intent sync");
          },
        },
      }),
    ).rejects.toThrow("before intent sync");
    expect((await allPublishIntents(first.env)).map((path) => basename(path))).not.toContain(
      ".publish-intent-task-before-intent-sync.json",
    );

    await expect(
      prepareKimiCodeSessionState({
        ...base,
        lastCommittedTurnId: "turn-after-intent-sync",
        taskId: "task-after-intent-sync",
        ownerAttemptId: "attempt-after-intent-sync",
        faultInjection: {
          afterIntentSync: () => {
            throw new Error("after intent sync");
          },
        },
      }),
    ).rejects.toThrow("after intent sync");
    const afterIntentPath = (await allPublishIntents(first.env)).find((path) =>
      path.endsWith(".publish-intent-task-after-intent-sync.json"),
    );
    expect(afterIntentPath).toBeDefined();
    const afterIntent = await readKimiCodePublishIntent(afterIntentPath!, first.env);
    const afterIntentLocator = parseKimiCodeCleanupLocator(afterIntent.locatorJson, first.env);
    expect(existsSync(afterIntentLocator.sessionFile)).toBe(false);
    expect(readdirSync(dirname(afterIntentPath!)).some((name) => name === ".prepared-task-after-intent-sync.tmp")).toBe(
      true,
    );

    const afterLink = await prepareKimiCodeSessionState({
      ...base,
      lastCommittedTurnId: "turn-after-link",
      taskId: "task-after-link",
      ownerAttemptId: "attempt-after-link",
      faultInjection: {
        beforePublishDirectorySync: () => {
          throw new Error("after link");
        },
      },
    });
    expect(() => afterLink.publish()).toThrow("after link");
    expect(existsSync(String(afterLink.session.params?.sessionFile))).toBe(true);
    expect(existsSync(afterLink.intentPath)).toBe(true);
    expect(existsSync(afterLink.temporaryPath)).toBe(false);
  }, 20_000);

  test("persists discoverable intent before writing any transcript-bearing temporary snapshot", async () => {
    const first = await firstCommit();
    await expect(
      prepareKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-intent-before-temp",
        messages: nativeMessages("intent-before-temp"),
        previousSnapshot: first.snapshot,
        taskId: "task-intent-before-temp",
        ownerAttemptId: "attempt-intent-before-temp",
        env: first.env,
        faultInjection: {
          afterIntentBeforeTemporary: () => {
            throw new Error("synthetic crash before temporary snapshot");
          },
        },
      }),
    ).rejects.toThrow("synthetic crash before temporary snapshot");

    const page = await listKimiCodePublishIntents({ env: first.env, limit: 4 });
    try {
      const candidate = page.candidates.find((item) => item.kind !== "invalid");
      expect(candidate).toBeDefined();
      const intent = await readKimiCodePublishIntent(candidate!.path, first.env);
      expect(intent.taskId).toBe("task-intent-before-temp");
      expect(existsSync(join(dirname(candidate!.path), ".prepared-task-intent-before-temp.tmp"))).toBe(false);
    } finally {
      if (page.nextCursor) await closeKimiCodePublishIntentCursor(page.nextCursor);
    }
  });

  test("discard before publication removes only its own temp and intent", async () => {
    const first = await firstCommit();
    const unrelated = join(dirname(String(first.session.params?.sessionFile)), "unrelated.keep");
    writeFileSync(unrelated, "keep", { mode: 0o600 });
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-discard",
      messages: nativeMessages("discard"),
      previousSnapshot: first.snapshot,
      taskId: "task-discard",
      ownerAttemptId: "attempt-discard",
      env: first.env,
    });

    await prepared.discard();

    expect(existsSync(prepared.temporaryPath)).toBe(false);
    expect(existsSync(prepared.intentPath)).toBe(false);
    expect(existsSync(String(prepared.session.params?.sessionFile))).toBe(false);
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test("discard keeps intent until its temporary payload name is durably absent", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-discard-two-phase",
      messages: nativeMessages("discard-two-phase"),
      previousSnapshot: first.snapshot,
      taskId: "task-discard-two-phase",
      ownerAttemptId: "attempt-discard-two-phase",
      env: first.env,
      faultInjection: {
        afterDiscardPayloadsDurable: () => {
          throw new Error("synthetic discard crash after payload durability");
        },
      },
    });

    await expect(prepared.discard()).rejects.toThrow("synthetic discard crash after payload durability");
    expect(existsSync(prepared.temporaryPath)).toBe(false);
    expect(existsSync(prepared.intentPath)).toBe(true);

    await prepared.discard();
    expect(existsSync(prepared.intentPath)).toBe(false);
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(true);
  });

  test.skipIf(process.platform !== "win32")(
    "discard resumes after its intent was moved to a tombstone",
    async () => {
      const first = await firstCommit();
      let crash = true;
      const prepared = await prepareKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-discard-intent-tombstone",
        messages: nativeMessages("discard-intent-tombstone"),
        previousSnapshot: first.snapshot,
        taskId: "task-discard-intent-tombstone",
        ownerAttemptId: "attempt-discard-intent-tombstone",
        env: first.env,
        faultInjection: {
          afterDiscardWindowsArtifactMove: (kind) => {
            if (kind === "intent" && crash) {
              crash = false;
              throw new Error("synthetic crash after intent tombstone move");
            }
          },
        },
      });
      const tombstone = join(dirname(prepared.intentPath), `.cleanup-${prepared.taskId}-intent.tombstone`);

      await expect(prepared.discard()).rejects.toThrow("synthetic crash after intent tombstone move");
      expect(existsSync(prepared.intentPath)).toBe(false);
      expect(existsSync(tombstone)).toBe(true);
      await prepared.discard();
      expect(existsSync(tombstone)).toBe(false);
    },
    20_000,
  );
});

describe("Kimi Code provisional exact cleanup", () => {
  test("fails closed when strict POSIX directory fsync is unsupported", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-strict-posix-sync",
      messages: nativeMessages("strict-posix-sync"),
      previousSnapshot: first.snapshot,
      taskId: "task-strict-posix-sync",
      ownerAttemptId: "attempt-strict-posix-sync",
      env: first.env,
    });
    await expect(
      executeKimiCodeProvisionalExactCleanup({
        locatorJson: prepared.locatorJson,
        taskId: prepared.taskId,
        ownerAttemptId: prepared.ownerAttemptId,
        env: first.env,
        isLocatorOwned: () => false,
        faultInjection: {
          platform: "linux",
          strictSyncDirectory: async () => {
            throw { code: "EINVAL" };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "io_transient" });
    expect(existsSync(prepared.intentPath)).toBe(true);
  });

  test("keeps intent until exact payload names are durably absent and then retries", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-exact-two-phase",
      messages: nativeMessages("exact-two-phase"),
      previousSnapshot: first.snapshot,
      taskId: "task-exact-two-phase",
      ownerAttemptId: "attempt-exact-two-phase",
      env: first.env,
    });
    prepared.publish();

    await expect(
      executeKimiCodeProvisionalExactCleanup({
        locatorJson: prepared.locatorJson,
        taskId: prepared.taskId,
        ownerAttemptId: prepared.ownerAttemptId,
        env: first.env,
        isLocatorOwned: () => false,
        faultInjection: {
          afterPayloadsDurable: () => {
            throw new Error("synthetic cleanup crash after payload durability");
          },
        },
      }),
    ).rejects.toThrow();
    expect(existsSync(String(prepared.session.params?.sessionFile))).toBe(false);
    expect(existsSync(prepared.temporaryPath)).toBe(false);
    expect(existsSync(prepared.intentPath)).toBe(true);

    await executeKimiCodeProvisionalExactCleanup({
      locatorJson: prepared.locatorJson,
      taskId: prepared.taskId,
      ownerAttemptId: prepared.ownerAttemptId,
      env: first.env,
      isLocatorOwned: () => false,
    });
    expect(existsSync(prepared.intentPath)).toBe(false);
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(true);
  });

  test.skipIf(process.platform !== "win32")(
    "retries an exact Windows cleanup from its deterministic zero-length tombstone",
    async () => {
      const first = await firstCommit();
      const prepared = await prepareKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-zero-tombstone",
        messages: nativeMessages("zero-tombstone"),
        previousSnapshot: first.snapshot,
        taskId: "task-zero-tombstone",
        ownerAttemptId: "attempt-zero-tombstone",
        env: first.env,
      });
      prepared.publish();
      const tombstone = join(dirname(prepared.intentPath), `.cleanup-${prepared.taskId}-snapshot.tombstone`);

      await expect(
        executeKimiCodeProvisionalExactCleanup({
          locatorJson: prepared.locatorJson,
          taskId: prepared.taskId,
          ownerAttemptId: prepared.ownerAttemptId,
          env: first.env,
          isLocatorOwned: () => false,
          faultInjection: {
            afterWindowsArtifactMove: (kind) => {
              if (kind === "snapshot") throw new Error("synthetic crash after tombstone move");
            },
          },
        }),
      ).rejects.toThrow();
      expect(existsSync(String(prepared.session.params?.sessionFile))).toBe(false);
      expect(lstatSync(tombstone).size).toBeGreaterThan(0);
      expect(existsSync(prepared.intentPath)).toBe(true);

      writeFileSync(tombstone, "", { mode: 0o600 });
      await executeKimiCodeProvisionalExactCleanup({
        locatorJson: prepared.locatorJson,
        taskId: prepared.taskId,
        ownerAttemptId: prepared.ownerAttemptId,
        env: first.env,
        isLocatorOwned: () => false,
      });
      expect(existsSync(tombstone) ? lstatSync(tombstone).size : 0).toBe(0);
      expect(existsSync(prepared.intentPath)).toBe(false);
    },
    20_000,
  );

  test("deletes only the exact provisional revision and matching recovery evidence", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-exact",
      messages: nativeMessages("exact"),
      previousSnapshot: first.snapshot,
      taskId: "task-exact",
      ownerAttemptId: "attempt-exact",
      env: first.env,
    });
    prepared.publish();
    const newer = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-newer-than-exact",
      messages: nativeMessages("newer-than-exact"),
      previousSnapshot: prepared.snapshot,
      env: first.env,
    });
    const exactPath = String(prepared.session.params?.sessionFile);
    let ownershipChecks = 0;

    await executeKimiCodeProvisionalExactCleanup({
      locatorJson: prepared.locatorJson,
      taskId: prepared.taskId,
      ownerAttemptId: prepared.ownerAttemptId,
      env: first.env,
      isLocatorOwned: () => {
        ownershipChecks += 1;
        expect(existsSync(exactPath)).toBe(true);
        return false;
      },
    });

    expect(ownershipChecks).toBe(1);
    expect(existsSync(exactPath)).toBe(false);
    expect(existsSync(prepared.intentPath)).toBe(false);
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(true);
    expect(existsSync(String(newer.session.params?.sessionFile))).toBe(true);
    expect(existsSync(dirname(exactPath))).toBe(true);

    await executeKimiCodeProvisionalExactCleanup({
      locatorJson: prepared.locatorJson,
      taskId: prepared.taskId,
      ownerAttemptId: prepared.ownerAttemptId,
      env: first.env,
      isLocatorOwned: () => {
        throw new Error("must not inspect ownership after exact evidence is already gone");
      },
    });
  });

  test("cleans an unpublished matching temp but requires bound intent when any artifact exists", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-temp-only",
      messages: nativeMessages("temp-only"),
      previousSnapshot: first.snapshot,
      taskId: "task-temp-only",
      ownerAttemptId: "attempt-temp-only",
      env: first.env,
    });
    await executeKimiCodeProvisionalExactCleanup({
      locatorJson: prepared.locatorJson,
      taskId: prepared.taskId,
      ownerAttemptId: prepared.ownerAttemptId,
      env: first.env,
      isLocatorOwned: () => false,
    });
    expect(existsSync(prepared.temporaryPath)).toBe(false);
    expect(existsSync(prepared.intentPath)).toBe(false);

    const missingIntent = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-missing-intent",
      messages: nativeMessages("missing-intent"),
      previousSnapshot: first.snapshot,
      taskId: "task-missing-intent",
      ownerAttemptId: "attempt-missing-intent",
      env: first.env,
    });
    missingIntent.publish();
    unlinkSync(missingIntent.intentPath);
    await expect(
      executeKimiCodeProvisionalExactCleanup({
        locatorJson: missingIntent.locatorJson,
        taskId: missingIntent.taskId,
        ownerAttemptId: missingIntent.ownerAttemptId,
        env: first.env,
        isLocatorOwned: () => false,
      }),
    ).rejects.toMatchObject({ code: "state_missing" });
    expect(existsSync(String(missingIntent.session.params?.sessionFile))).toBe(true);
  });

  test("fails closed before mutation for owned locators and mismatched task or attempt binding", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-owned",
      messages: nativeMessages("owned"),
      previousSnapshot: first.snapshot,
      taskId: "task-owned",
      ownerAttemptId: "attempt-owned",
      env: first.env,
    });
    prepared.publish();
    const exactPath = String(prepared.session.params?.sessionFile);

    for (const mutation of [
      { taskId: "task-other", ownerAttemptId: prepared.ownerAttemptId },
      { taskId: prepared.taskId, ownerAttemptId: "attempt-other" },
    ]) {
      await expect(
        executeKimiCodeProvisionalExactCleanup({
          locatorJson: prepared.locatorJson,
          ...mutation,
          env: first.env,
          isLocatorOwned: () => false,
        }),
      ).rejects.toMatchObject({ code: "binding_mismatch" });
      expect(existsSync(exactPath)).toBe(true);
      expect(existsSync(prepared.intentPath)).toBe(true);
    }

    await expect(
      executeKimiCodeProvisionalExactCleanup({
        locatorJson: prepared.locatorJson,
        taskId: prepared.taskId,
        ownerAttemptId: prepared.ownerAttemptId,
        env: first.env,
        isLocatorOwned: () => true,
      }),
    ).rejects.toMatchObject({ code: "state_busy" });
    expect(existsSync(exactPath)).toBe(true);
    expect(existsSync(prepared.intentPath)).toBe(true);
  });

  test("classifies foreign, binding, and reparse attacks without deleting exact or unrelated state", async () => {
    const first = await firstCommit();
    const prepared = await prepareKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-attacks",
      messages: nativeMessages("attacks"),
      previousSnapshot: first.snapshot,
      taskId: "task-attacks",
      ownerAttemptId: "attempt-attacks",
      env: first.env,
    });
    prepared.publish();
    const exactPath = String(prepared.session.params?.sessionFile);
    const canonical = JSON.parse(prepared.locatorJson) as Record<string, unknown>;
    const foreign = JSON.stringify({ ...canonical, sessionFile: join(first.root, "outside.json") });
    const wrongRevision = JSON.stringify({ ...canonical, revision: Number(canonical.revision) + 1 });
    await expect(
      executeKimiCodeProvisionalExactCleanup({
        locatorJson: foreign,
        taskId: prepared.taskId,
        ownerAttemptId: prepared.ownerAttemptId,
        env: first.env,
        isLocatorOwned: () => false,
      }),
    ).rejects.toMatchObject({ code: "foreign_root" });
    await expect(
      executeKimiCodeProvisionalExactCleanup({
        locatorJson: wrongRevision,
        taskId: prepared.taskId,
        ownerAttemptId: prepared.ownerAttemptId,
        env: first.env,
        isLocatorOwned: () => false,
      }),
    ).rejects.toMatchObject({ code: "binding_mismatch" });

    const outsideIntent = join(first.root, "outside-intent.json");
    writeFileSync(outsideIntent, readFileSync(prepared.intentPath));
    rmSync(prepared.intentPath);
    let linked = false;
    try {
      symlinkSync(outsideIntent, prepared.intentPath, "file");
      linked = true;
    } catch {
      copyFileSync(outsideIntent, prepared.intentPath);
      const sessionDirectory = dirname(exactPath);
      const outsideSessionDirectory = join(first.root, "outside-session-directory");
      mkdirSync(outsideSessionDirectory);
      for (const name of readdirSync(sessionDirectory)) {
        copyFileSync(join(sessionDirectory, name), join(outsideSessionDirectory, name));
      }
      rmSync(sessionDirectory, { recursive: true });
      try {
        symlinkSync(outsideSessionDirectory, sessionDirectory, process.platform === "win32" ? "junction" : "dir");
        linked = true;
      } catch {
        // The remaining foreign/binding assertions still run on hosts that deny every reparse primitive.
      }
    }
    if (linked) {
      await expect(
        executeKimiCodeProvisionalExactCleanup({
          locatorJson: prepared.locatorJson,
          taskId: prepared.taskId,
          ownerAttemptId: prepared.ownerAttemptId,
          env: first.env,
          isLocatorOwned: () => false,
        }),
      ).rejects.toMatchObject({ code: "reparse_detected" });
      expect(existsSync(exactPath)).toBe(true);
    }
  });
});

describe("Kimi Code durable ordinary cleanup executors", () => {
  test("delete_state advances past an unrelated full scan page instead of rescanning it forever", async () => {
    const first = await firstCommit();
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));
    for (let index = 0; index < 80; index += 1) {
      writeFileSync(join(sessionDirectory, `unrelated-${index.toString().padStart(3, "0")}.txt`), "unrelated", {
        mode: 0o600,
      });
    }
    const input = {
      locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
      taskId: "task-delete-unrelated-prefix",
      env: first.env,
      faultInjection: { platform: "linux" as const, strictSyncDirectory: async () => undefined },
    };
    const results = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      results.push(await executeKimiCodeDeleteStateCleanup(input));
      if (results.at(-1)?.complete) break;
    }

    expect(results.some((result) => !result.complete && result.processed === 0)).toBe(true);
    expect(results.at(-1)).toEqual({ complete: true, processed: 0 });
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(false);
  });

  test("delete_state processes a bounded batch and signals incomplete until an empty final pass", async () => {
    const first = await firstCommit();
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));
    const fixtureSnapshot = JSON.parse(readFileSync(String(first.session.params?.sessionFile), "utf8")) as Record<
      string,
      unknown
    >;
    let ownedSession = first.session;
    for (let revision = 2; revision <= 40; revision += 1) {
      const sessionFile = join(
        sessionDirectory,
        `revision-${revision.toString().padStart(8, "0")}-${randomUUID()}.json`,
      );
      const lastCommittedTurnId = `turn-bounded-${revision}`;
      writeFileSync(sessionFile, JSON.stringify({ ...fixtureSnapshot, revision, lastCommittedTurnId }), {
        mode: 0o600,
      });
      if (revision === 40) {
        ownedSession = {
          params: { ...first.session.params, revision, sessionFile, lastCommittedTurnId },
        };
      }
    }
    const input = {
      locatorJson: serializeKimiCodeCleanupLocator(ownedSession, first.env),
      taskId: "task-delete-bounded",
      env: first.env,
      faultInjection: { platform: "linux" as const, strictSyncDirectory: async () => undefined },
    };
    const results = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      results.push(await executeKimiCodeDeleteStateCleanup(input));
      if (results.at(-1)?.complete) break;
    }

    expect(results.length).toBeGreaterThan(2);
    expect(results.slice(0, -1).every((result) => !result.complete && result.processed <= 16)).toBe(true);
    expect(results.at(-1)).toEqual({ complete: true, processed: 0 });
    expect(readdirSync(sessionDirectory).filter((name) => name.startsWith("revision-"))).toEqual([]);
  });

  test("delete_state stops before the next artifact mutation after execution cancellation", async () => {
    const first = await firstCommit();
    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-delete-cancelled-second",
      messages: nativeMessages("delete-cancelled-second"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });
    const controller = new AbortController();

    await expect(
      executeKimiCodeDeleteStateCleanup({
        locatorJson: serializeKimiCodeCleanupLocator(second.session, first.env),
        taskId: "task-delete-cancelled",
        env: first.env,
        signal: controller.signal,
        faultInjection: {
          platform: "linux",
          strictSyncDirectory: async () => undefined,
          afterArtifactDurable: () => controller.abort(),
        },
      }),
    ).rejects.toMatchObject({ code: "state_busy" });

    const remainingRevisions = readdirSync(dirname(String(first.session.params?.sessionFile))).filter((name) =>
      name.startsWith("revision-"),
    );
    expect(remainingRevisions).toHaveLength(1);
  });

  test("delete_state reopens the directory for an empty confirmation after an EOF pass did work", async () => {
    const first = await firstCommit();
    const sessionFile = String(first.session.params?.sessionFile);
    const snapshotBytes = readFileSync(sessionFile);
    const input = {
      locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
      taskId: "task-delete-eof-confirmation",
      env: first.env,
      faultInjection: { platform: "linux" as const, strictSyncDirectory: async () => undefined },
    };

    expect(await executeKimiCodeDeleteStateCleanup(input)).toEqual({ complete: false, processed: 1 });
    writeFileSync(sessionFile, snapshotBytes, { mode: 0o600 });
    expect(await executeKimiCodeDeleteStateCleanup(input)).toEqual({ complete: false, processed: 1 });
    expect(existsSync(sessionFile)).toBe(false);
    expect(await executeKimiCodeDeleteStateCleanup(input)).toEqual({ complete: true, processed: 0 });
  });

  test("delete_state reserves scanner slots atomically under simultaneous starts", async () => {
    const scannerLimit = 64;
    const fixtures = await Promise.all(Array.from({ length: scannerLimit + 1 }, () => firstCommit()));
    let entered = 0;
    let busy = 0;
    let releaseScanners!: () => void;
    let resolveAllArrived!: () => void;
    let rejectAllArrived!: (error: unknown) => void;
    const allArrived = new Promise<void>((resolve, reject) => {
      resolveAllArrived = resolve;
      rejectAllArrived = reject;
    });
    const scannerBarrier = new Promise<void>((resolve) => {
      releaseScanners = resolve;
    });
    const markArrival = () => {
      if (entered + busy === fixtures.length) resolveAllArrived();
    };
    const runs = fixtures.map((fixture, index) =>
      executeKimiCodeDeleteStateCleanup({
        locatorJson: serializeKimiCodeCleanupLocator(fixture.session, fixture.env),
        taskId: `task-delete-active-scanner-${index}`,
        env: fixture.env,
        faultInjection: {
          platform: "linux",
          strictSyncDirectory: async () => {
            entered += 1;
            markArrival();
            await scannerBarrier;
          },
        },
      }).catch((error) => {
        if (error instanceof KimiCodeStateError && error.code === "state_busy") {
          busy += 1;
          markArrival();
        } else {
          rejectAllArrived(error);
        }
        throw error;
      }),
    );
    const settledRuns = Promise.allSettled(runs);

    try {
      await allArrived;
    } finally {
      releaseScanners();
    }
    const settled = await settledRuns;
    expect(entered).toBe(scannerLimit);
    expect(busy).toBe(1);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(scannerLimit);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
  }, 20_000);

  test("delete_state excludes a simultaneous call for the same task id", async () => {
    const first = await firstCommit();
    let releaseScanner!: () => void;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const scannerBarrier = new Promise<void>((resolve) => {
      releaseScanner = resolve;
    });
    const input = {
      locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
      taskId: "task-delete-same-task-concurrent",
      env: first.env,
      faultInjection: {
        platform: "linux" as const,
        strictSyncDirectory: async () => {
          resolveEntered();
          await scannerBarrier;
        },
      },
    };
    const activeRun = executeKimiCodeDeleteStateCleanup(input);

    await entered;
    try {
      await expect(executeKimiCodeDeleteStateCleanup(input)).rejects.toMatchObject({ code: "state_busy" });
    } finally {
      releaseScanner();
    }
    expect(await activeRun).toEqual({ complete: false, processed: 1 });
  });

  test("delete_state blocks an old task id while atomically replacing its stale scanner", async () => {
    const first = await firstCommit();
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));
    rmSync(String(first.session.params?.sessionFile));
    for (let index = 0; index < 80; index += 1) {
      writeFileSync(join(sessionDirectory, `stale-noise-${index.toString().padStart(3, "0")}`), "noise");
    }
    let now = 0;
    const oldInput = {
      locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
      taskId: "task-delete-stale-old",
      env: first.env,
      faultInjection: { platform: "linux" as const, maxDeleteScanners: 1, now: () => now },
    };
    expect(await executeKimiCodeDeleteStateCleanup(oldInput)).toEqual({ complete: false, processed: 0 });

    now = 5 * 60_000;
    let releaseClose!: () => void;
    let resolveCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      resolveCloseStarted = resolve;
    });
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const newInput = {
      ...oldInput,
      taskId: "task-delete-stale-new",
      faultInjection: {
        ...oldInput.faultInjection,
        closeDirectory: async () => {
          resolveCloseStarted();
          await closeBarrier;
        },
      },
    };
    const replacement = executeKimiCodeDeleteStateCleanup(newInput);

    await closeStarted;
    try {
      await expect(executeKimiCodeDeleteStateCleanup(oldInput)).rejects.toMatchObject({ code: "state_busy" });
    } finally {
      releaseClose();
    }
    expect(await replacement).toEqual({ complete: false, processed: 0 });
    for (const name of readdirSync(sessionDirectory)) unlinkSync(join(sessionDirectory, name));
    expect(
      await executeKimiCodeDeleteStateCleanup({ ...newInput, faultInjection: oldInput.faultInjection }),
    ).toEqual({ complete: true, processed: 0 });
  });

  test("delete_state restores a stale scanner when eviction close fails", async () => {
    const first = await firstCommit();
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));
    rmSync(String(first.session.params?.sessionFile));
    for (let index = 0; index < 80; index += 1) {
      writeFileSync(join(sessionDirectory, `rollback-noise-${index.toString().padStart(3, "0")}`), "noise");
    }
    let now = 0;
    const oldInput = {
      locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
      taskId: "task-delete-rollback-old",
      env: first.env,
      faultInjection: { platform: "linux" as const, maxDeleteScanners: 1, now: () => now },
    };
    expect(await executeKimiCodeDeleteStateCleanup(oldInput)).toEqual({ complete: false, processed: 0 });

    now = 5 * 60_000;
    await expect(
      executeKimiCodeDeleteStateCleanup({
        ...oldInput,
        taskId: "task-delete-rollback-new",
        faultInjection: {
          ...oldInput.faultInjection,
          closeDirectory: async () => {
            throw new Error("synthetic scanner close failure");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "unknown" });

    for (const name of readdirSync(sessionDirectory)) unlinkSync(join(sessionDirectory, name));
    expect(await executeKimiCodeDeleteStateCleanup(oldInput)).toEqual({ complete: true, processed: 0 });
  });

  test.skipIf(process.platform !== "win32")(
    "delete_state retries a moved revision tombstone",
    async () => {
      const first = await firstCommit();
      let crash = true;
      const input = {
        locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
        taskId: "task-delete-tombstone",
        env: first.env,
        faultInjection: {
          afterWindowsArtifactMove: () => {
            if (crash) {
              crash = false;
              throw new Error("synthetic delete tombstone crash");
            }
          },
        },
      };

      await expect(executeKimiCodeDeleteStateCleanup(input)).rejects.toThrow();
      await executeKimiCodeDeleteStateCleanup(input);
      expect(
        readdirSync(dirname(String(first.session.params?.sessionFile))).filter((name) =>
          name.includes("task-delete-tombstone"),
        ),
      ).toEqual([]);
    },
    20_000,
  );

  test("delete_state durably removes only owned revisions and retries a partial crash", async () => {
    const first = await firstCommit();
    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-delete-owned-second",
      messages: nativeMessages("delete-owned-second"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });
    const newer = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-delete-owned-newer",
      messages: nativeMessages("delete-owned-newer"),
      previousSnapshot: second.snapshot,
      env: first.env,
    });
    let crash = true;
    const input = {
      locatorJson: serializeKimiCodeCleanupLocator(second.session, first.env),
      taskId: "task-delete-owned",
      env: first.env,
      faultInjection: {
        afterArtifactDurable: () => {
          if (crash) {
            crash = false;
            throw new Error("synthetic delete crash");
          }
        },
      },
    };

    await expect(executeKimiCodeDeleteStateCleanup(input)).rejects.toThrow();
    await executeKimiCodeDeleteStateCleanup(input);
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(false);
    expect(existsSync(String(second.session.params?.sessionFile))).toBe(false);
    expect(existsSync(String(newer.session.params?.sessionFile))).toBe(true);
  }, 20_000);

  test("retire_revision durably removes only the exact predecessor and preserves successor", async () => {
    const first = await firstCommit();
    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-retire-successor",
      messages: nativeMessages("retire-successor"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });

    await executeKimiCodeRetireRevisionCleanup({
      locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
      successorLocatorJson: serializeKimiCodeCleanupLocator(second.session, first.env),
      taskId: "task-retire-exact",
      env: first.env,
    });
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(false);
    expect(existsSync(String(second.session.params?.sessionFile))).toBe(true);
    await executeKimiCodeRetireRevisionCleanup({
      locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
      successorLocatorJson: serializeKimiCodeCleanupLocator(second.session, first.env),
      taskId: "task-retire-exact",
      env: first.env,
    });
  });

  test.skipIf(process.platform !== "win32")(
    "retire_revision retries from its task-bound zero-length tombstone",
    async () => {
      const first = await firstCommit();
      const second = await commitKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-retire-tombstone-successor",
        messages: nativeMessages("retire-tombstone-successor"),
        previousSnapshot: first.snapshot,
        env: first.env,
      });
      let crash = true;
      const input = {
        locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
        successorLocatorJson: serializeKimiCodeCleanupLocator(second.session, first.env),
        taskId: "task-retire-tombstone",
        env: first.env,
        faultInjection: {
          afterWindowsArtifactMove: () => {
            if (crash) {
              crash = false;
              throw new Error("synthetic retire tombstone crash");
            }
          },
        },
      };
      const sessionDirectory = dirname(String(first.session.params?.sessionFile));

      await expect(executeKimiCodeRetireRevisionCleanup(input)).rejects.toThrow();
      const tombstone = join(
        sessionDirectory,
        readdirSync(sessionDirectory).find((name) => name.startsWith(".cleanup-retire-task-retire-tombstone-"))!,
      );
      expect(basename(tombstone)).toMatch(/-[a-f0-9]{24}\.tombstone$/);
      expect(existsSync(tombstone)).toBe(true);
      writeFileSync(tombstone, "", { mode: 0o600 });
      await executeKimiCodeRetireRevisionCleanup(input);
      expect(existsSync(tombstone)).toBe(false);
      expect(existsSync(String(second.session.params?.sessionFile))).toBe(true);
    },
    20_000,
  );

  test.skipIf(process.platform !== "win32")(
    "rejects forged delete and retire tombstones without truncating them",
    async () => {
      const first = await firstCommit();
      const second = await commitKimiCodeSessionState({
        sessionId: first.snapshot.sessionId,
        model: "k3",
        cwd: first.cwd,
        lastCommittedTurnId: "turn-forged-successor",
        messages: nativeMessages("forged-successor"),
        previousSnapshot: first.snapshot,
        env: first.env,
      });
      const sessionDirectory = dirname(String(first.session.params?.sessionFile));
      let retireCrash = true;
      const retireInput = {
        locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
        successorLocatorJson: serializeKimiCodeCleanupLocator(second.session, first.env),
        taskId: "task-forged-retire",
        env: first.env,
        faultInjection: {
          afterWindowsArtifactMove: () => {
            if (retireCrash) {
              retireCrash = false;
              throw new Error("capture retire tombstone");
            }
          },
        },
      };
      await expect(executeKimiCodeRetireRevisionCleanup(retireInput)).rejects.toThrow();
      const retireTombstone = readdirSync(sessionDirectory).find((name) => name.includes("task-forged-retire"))!;
      const newerBytes = readFileSync(String(second.session.params?.sessionFile));
      writeFileSync(join(sessionDirectory, retireTombstone), newerBytes);
      await expect(executeKimiCodeRetireRevisionCleanup(retireInput)).rejects.toMatchObject({
        code: "binding_mismatch",
      });
      expect(readFileSync(join(sessionDirectory, retireTombstone))).toEqual(newerBytes);

      const forgedDelete = join(
        sessionDirectory,
        `.cleanup-delete-task-forged-delete-${basename(String(second.session.params?.sessionFile))}-${"0".repeat(24)}.tombstone`,
      );
      writeFileSync(forgedDelete, "", { mode: 0o600 });
      await expect(
        executeKimiCodeDeleteStateCleanup({
          locatorJson: serializeKimiCodeCleanupLocator(second.session, first.env),
          taskId: "task-forged-delete",
          env: first.env,
        }),
      ).rejects.toMatchObject({ code: "binding_mismatch" });
      expect(existsSync(forgedDelete)).toBe(true);
    },
    20_000,
  );

  test("binds cleanup tombstones to the exact full task id when ids contain hyphens", async () => {
    const first = await firstCommit();
    const sourceFilename = basename(String(first.session.params?.sessionFile));
    const sessionDirectory = dirname(String(first.session.params?.sessionFile));
    rmSync(String(first.session.params?.sessionFile));
    const tombstoneFor = (taskId: string) => {
      const digest = createHash("sha256")
        .update(`delete\u0000${taskId}\u0000${sourceFilename}`)
        .digest("hex")
        .slice(0, 24);
      return join(sessionDirectory, `.cleanup-delete-${taskId}-${sourceFilename}-${digest}.tombstone`);
    };
    const fooTombstone = tombstoneFor("foo");
    const fooBarTombstone = tombstoneFor("foo-bar");
    writeFileSync(fooTombstone, "", { mode: 0o600 });
    writeFileSync(fooBarTombstone, "", { mode: 0o600 });
    const execute = (taskId: string) =>
      executeKimiCodeDeleteStateCleanup({
        locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
        taskId,
        env: first.env,
        faultInjection: { platform: "win32" },
      });

    await execute("foo");
    expect(existsSync(fooTombstone)).toBe(false);
    expect(existsSync(fooBarTombstone)).toBe(true);
    await execute("foo-bar");
    expect(existsSync(fooBarTombstone)).toBe(false);
  });

  test.skipIf(process.platform !== "win32")(
    "classifies configured credentials in recovered delete tombstones",
    async () => {
      const first = await firstCommit();
      const sessionDirectory = dirname(String(first.session.params?.sessionFile));
      const bytes = JSON.parse(readFileSync(String(first.session.params?.sessionFile), "utf8")) as Record<
        string,
        unknown
      >;
      const sourceFilename = basename(String(first.session.params?.sessionFile));
      const digest = createHash("sha256")
        .update(`delete\u0000task-credential-delete\u0000${sourceFilename}`)
        .digest("hex")
        .slice(0, 24);
      const tombstone = join(
        sessionDirectory,
        `.cleanup-delete-task-credential-delete-${sourceFilename}-${digest}.tombstone`,
      );
      writeFileSync(tombstone, JSON.stringify({ ...bytes, messages: nativeMessages(first.env.KIMI_API_KEY!) }), {
        mode: 0o600,
      });

      await expect(
        executeKimiCodeDeleteStateCleanup({
          locatorJson: serializeKimiCodeCleanupLocator(first.session, first.env),
          taskId: "task-credential-delete",
          env: first.env,
        }),
      ).rejects.toMatchObject({ code: "credential_detected" });
      expect(existsSync(tombstone)).toBe(true);
    },
    20_000,
  );
});

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

  test("cleans an old locator without deleting a newer published locator", async () => {
    const first = await firstCommit();
    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-newer",
      messages: nativeMessages("newer"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });

    await cleanupKimiCodeSessionState(first.session, first.env);

    await expect(
      loadKimiCodeSessionState({ session: second.session, model: "k3", cwd: first.cwd, env: first.env }),
    ).resolves.toEqual(second.snapshot);
    expect(existsSync(String(first.session.params?.sessionFile))).toBe(false);
  });

  test("cleanup current removes all validated older revisions but preserves a newer concurrent locator", async () => {
    const first = await firstCommit();
    const second = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-current",
      messages: nativeMessages("current"),
      previousSnapshot: first.snapshot,
      env: first.env,
    });
    const newer = await commitKimiCodeSessionState({
      sessionId: first.snapshot.sessionId,
      model: "k3",
      cwd: first.cwd,
      lastCommittedTurnId: "turn-concurrent-newer",
      messages: nativeMessages("concurrent-newer"),
      previousSnapshot: second.snapshot,
      env: first.env,
    });

    await cleanupKimiCodeSessionState(second.session, first.env);

    expect(existsSync(String(first.session.params?.sessionFile))).toBe(false);
    expect(existsSync(String(second.session.params?.sessionFile))).toBe(false);
    await expect(
      loadKimiCodeSessionState({ session: newer.session, model: "k3", cwd: first.cwd, env: first.env }),
    ).resolves.toEqual(newer.snapshot);
  }, 20_000);

  test("accepts a negative nonzero device identity but rejects signed-zero and plus-prefixed locators", async () => {
    const committed = await firstCommit();
    const sessionFile = String(committed.session.params?.sessionFile);
    const snapshot = JSON.parse(readFileSync(sessionFile, "utf8")) as { workspaceIdentity: { device: string } };
    snapshot.workspaceIdentity.device = "-42";
    writeFileSync(sessionFile, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    const negative = cloneSession(committed.session);
    Object.assign((negative.params?.workspaceIdentity as Record<string, unknown>) ?? {}, { device: "-42" });

    await cleanupKimiCodeSessionState(negative, committed.env);
    expect(existsSync(sessionFile)).toBe(false);

    for (const device of ["-0", "+1", "00"]) {
      const invalid = cloneSession(committed.session);
      Object.assign((invalid.params?.workspaceIdentity as Record<string, unknown>) ?? {}, { device });
      await expect(cleanupKimiCodeSessionState(invalid, committed.env)).rejects.toThrow("locator is invalid");
    }
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

  test("rejects oversized state before reaching the publication boundary", async () => {
    const fixture = temporaryState();
    let reachedPublicationBoundary = false;
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
        faultInjection: {
          beforePublish: () => {
            reachedPublicationBoundary = true;
          },
        },
      }),
    ).rejects.toThrow("Kimi Code session state exceeds maximum size");
    expect(reachedPublicationBoundary).toBe(false);
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

  test.skipIf(process.platform !== "darwin")(
    "accepts a macOS workspace and state directory beneath the canonical /var system alias",
    async () => {
      const fixture = temporaryState();
      if (!fixture.root.startsWith(`${sep}var${sep}`)) return;

      const committed = await commitKimiCodeSessionState({
        sessionId: createKimiCodeSessionId(),
        model: "k3",
        cwd: fixture.cwd,
        lastCommittedTurnId: "turn-macos-var-alias",
        messages: nativeMessages("macos-var-alias"),
        env: fixture.env,
      });

      await expect(
        loadKimiCodeSessionState({ session: committed.session, model: "k3", cwd: fixture.cwd, env: fixture.env }),
      ).resolves.toEqual(committed.snapshot);
    },
  );

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
