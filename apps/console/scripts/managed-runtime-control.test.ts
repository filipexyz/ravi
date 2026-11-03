import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createBoundedRaviSdkFetch,
  ManagedRuntimeControl,
  type ManagedCommand,
  loadManagedRuntimeControlConfig,
  type ManagedRaviClientFactory,
  type ManagedRuntimeControlConfig,
  type RuntimeControlConsoleApi,
  type RuntimeControlDeckApi,
} from "./managed-runtime-control";

const INSTANCE_ID = "10000000-0000-4000-8000-000000000001";
const OPERATION_ID = "20000000-0000-4000-8000-000000000001";
const HOST_ID = "30000000-0000-4000-8000-000000000001";
const IMAGE_ID = "40000000-0000-4000-8000-000000000001";
const SESSION_ID = "50000000-0000-4000-8000-000000000001";
const VM_ID = "mvm_test0000000000000000000000000001";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("managed runtime control", () => {
  test("provisions with generated client boundaries and reports only opaque connection evidence", async () => {
    const fixture = await createFixture("create");
    const result = await fixture.control.runOnce();

    expect(result).toEqual({ action: "create", claimed: true, operationId: OPERATION_ID });
    expect(fixture.deckCalls).toEqual(["image", "inspect", "create", "prepare", "start", "inspect", "inspect"]);
    expect(fixture.deckCreateInputs).toEqual([
      expect.objectContaining({
        name: "managed-ravi-test-10000000000040008000000000000001",
      }),
    ]);
    expect(fixture.raviCalls).toEqual(["self.whoami"]);
    expect(fixture.claimAuthorizations).toEqual(["Bearer ravi_mcc_test_claim_token_abcdefghijklmnopqrstuvwxyz"]);
    expect(fixture.imageRegistrations).toEqual([
      expect.objectContaining({
        digest: IMAGE_DIGEST,
        version: "p0b-test+aaaaaaaaaaaa",
      }),
    ]);

    const terminal = fixture.reports.at(-1);
    expect(terminal).toMatchObject({
      connection: {
        kind: "private_ravi_sdk",
        protocolVersion: "0.test",
        status: "online",
      },
      observedState: "ready",
      phase: "ready",
      status: "succeeded",
    });
    const serialized = JSON.stringify(fixture.reports);
    expect(serialized).not.toContain("rctx_test_controller_key");
    expect(serialized).not.toContain("ravi_mcc_test_claim_token");
    expect(serialized).not.toContain("172.30.0.2");
    expect(serialized).toContain("cred_");
    expect(serialized).toContain("endpoint_");

    const credentialPath = path.join(fixture.config.credentialRoot, INSTANCE_ID, "controller.json");
    expect((await stat(fixture.config.stateRoot)).mode & 0o777).toBe(0o750);
    expect((await stat(fixture.config.credentialRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(credentialPath, "utf8")).toContain("rctx_test_controller_key");
    await expect(readFile(path.join(fixture.config.credentialRoot, INSTANCE_ID, "pending-claim.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("creates after generated Deck inspect returns nested not-found code", async () => {
    const fixture = await createFixture("create", {
      inspectFailure: {
        body: { error: "BadRequest", message: "managed_vm_not_found" },
        status: 400,
      },
    });

    await fixture.control.runOnce();

    expect(fixture.deckCalls).toEqual([
      "image",
      "inspect",
      "create",
      "prepare",
      "start",
      "inspect",
      "inspect",
    ]);
    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "ready",
      status: "succeeded",
    });
  });

  test("renews the operation lease without regressing progress while Deck waits", async () => {
    const fixture = await createFixture("create", {
      operationHeartbeatMs: 5,
      startDelayMs: 35,
    });

    await fixture.control.runOnce();

    const startingReports = fixture.reports.filter((report) =>
      report.status === "running" && report.phase === "starting"
    );
    expect(startingReports.length).toBeGreaterThanOrEqual(2);
    expect(startingReports.every((report) => report.progressPercent === 55)).toBe(true);
    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "ready",
      progressPercent: 100,
      status: "succeeded",
    });
  });

  test("preserves the safe appliance check when Deck readiness times out", async () => {
    const fixture = await createFixture("create", {
      readinessBody: {
        code: "readiness_pending",
        currentCheck: "dns_resolution",
        failedChecks: [],
        ok: false,
        ready: false,
      },
      startFailure: { code: "managed_appliance_ready_timeout" },
    });

    await fixture.control.runOnce();

    expect(fixture.reports.at(-1)).toMatchObject({
      failureCode: "managed_appliance_readiness_timeout_dns_resolution",
      observedState: "failed",
      status: "failed",
    });
    expect(fixture.controllerRequests).toContainEqual({
      authorization: "",
      pathname: "/health",
    });
  });

  test("preserves the safe appliance check when generated Deck returns a failed VM", async () => {
    const fixture = await createFixture("create", {
      readinessBody: {
        code: "readiness_failed",
        failedChecks: ["codex_authenticated"],
        ok: false,
        ready: false,
      },
      startState: "quarantined",
    });

    await fixture.control.runOnce();

    expect(fixture.reports.at(-1)).toMatchObject({
      failureCode: "managed_appliance_readiness_failed_codex_authenticated",
      observedState: "failed",
      status: "failed",
    });
    expect(fixture.controllerRequests).toContainEqual({
      authorization: "",
      pathname: "/health",
    });
  });

  test("reuses a persisted one-time claim after a controller restart", async () => {
    const fixture = await createFixture("create", { pendingClaim: true, vmState: "prepared" });
    await fixture.control.runOnce();

    expect(fixture.bootstrapIssues).toBe(0);
    expect(fixture.deckCalls).toEqual(["image", "inspect", "prepare", "start", "inspect", "inspect"]);
    expect(fixture.reports.at(-1)).toMatchObject({ observedState: "ready", status: "succeeded" });
  });

  test("stops and deletes through verified Deck state transitions", async () => {
    const stop = await createFixture("stop", { credential: true, vmState: "running" });
    await stop.control.runOnce();
    expect(stop.reports.at(-1)).toMatchObject({
      connection: { status: "offline" },
      observedState: "stopped",
      status: "succeeded",
    });

    const destroy = await createFixture("delete", { credential: true, vmState: "running" });
    await destroy.control.runOnce();
    expect(destroy.reports.at(-1)).toMatchObject({
      connection: { status: "revoked" },
      observedState: "deleted",
      safeResult: { cleanupVerified: true },
      status: "succeeded",
    });
    await expect(stat(path.join(destroy.config.credentialRoot, INSTANCE_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("treats an absent Deck VM as an idempotent verified delete", async () => {
    const fixture = await createFixture("delete", {
      credential: true,
      destroyFailure: {
        body: { error: "BadRequest", message: "managed_vm_not_found" },
        status: 400,
      },
      vmState: "missing",
    });

    await fixture.control.runOnce();

    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "deleted",
      safeResult: { cleanupVerified: true, deckState: "absent" },
      status: "succeeded",
    });
    await expect(stat(path.join(fixture.config.credentialRoot, INSTANCE_ID)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rotates the private controller credential and erases the one-time grant", async () => {
    const fixture = await createFixture("rotate_controller", {
      credential: true,
      vmState: "running",
    });

    await fixture.control.runOnce();

    expect(fixture.rotationIssues).toBe(1);
    expect(fixture.controllerRequests.map((item) => item.pathname)).toEqual([
      "/controller/rotation/prepare",
      "/controller/rotation/claim",
      "/controller/rotation/ack",
    ]);
    expect(fixture.controllerRequests.map((item) => item.authorization)).toEqual([
      "",
      `Bearer ${fixture.rotationClaimToken}`,
      `Bearer ${fixture.rotationClaimToken}`,
    ]);
    const credentialPath = path.join(
      fixture.config.credentialRoot,
      INSTANCE_ID,
      "controller.json",
    );
    expect(JSON.parse(await readFile(credentialPath, "utf8"))).toMatchObject({
      contextId: "ctx_controller_02",
      contextKey: "rctx_test_controller_key_next",
    });
    await expect(
      stat(
        path.join(
          fixture.config.credentialRoot,
          INSTANCE_ID,
          "pending-controller-rotation.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fixture.reports.at(-1)).toMatchObject({
      connection: { status: "online" },
      observedState: "ready",
      status: "succeeded",
    });
    expect(JSON.stringify(fixture.reports)).not.toContain(fixture.rotationClaimToken);
    expect(JSON.stringify(fixture.reports)).not.toContain("rctx_test_controller_key_next");
    expect(fixture.raviContextKeys).toContain("rctx_test_controller_key_next");
  });

  test("recovers the exact restored backup credential before controller rotation", async () => {
    const fixture = await createFixture("rotate_controller", {
      restoredCredentialRecovery: true,
      vmState: "running",
    });

    await fixture.control.runOnce();

    expect(fixture.rotationContextIds).toEqual(["ctx_controller_01"]);
    expect(fixture.raviContextKeys).toEqual(
      expect.arrayContaining([
        "rctx_test_controller_key_stale",
        "rctx_test_controller_key",
        "rctx_test_controller_key_next",
      ]),
    );
    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "ready",
      status: "succeeded",
    });
    expect(JSON.parse(await readFile(
      path.join(fixture.config.credentialRoot, INSTANCE_ID, "controller.json"),
      "utf8",
    ))).toMatchObject({ contextId: "ctx_controller_02" });
  });

  test("discards an expired unclaimed grant from a prior rotation operation", async () => {
    const fixture = await createFixture("rotate_controller", {
      credential: true,
      expiredForeignRotation: true,
      vmState: "running",
    });

    await fixture.control.runOnce();

    expect(fixture.rotationIssues).toBe(1);
    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "ready",
      status: "succeeded",
    });
  });

  test("backs up a running VM through stop, snapshot, resume, and SDK validation", async () => {
    const fixture = await createFixture("backup", {
      credential: true,
      vmState: "running",
    });

    await fixture.control.runOnce();

    expect(fixture.deckCalls).toEqual(
      expect.arrayContaining(["inspect", "stop", "backup", "start"]),
    );
    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "ready",
      safeResult: {
        backup: {
          backupRef: `mbk_${OPERATION_ID.replaceAll("-", "")}`,
          contentDigest: `sha256:${"d".repeat(64)}`,
        },
      },
      status: "succeeded",
    });
    const backupCredential = path.join(
      fixture.config.credentialRoot,
      "backups",
      INSTANCE_ID,
      `mbk_${OPERATION_ID.replaceAll("-", "")}`,
      "controller.json",
    );
    expect(JSON.parse(await readFile(backupCredential, "utf8"))).toMatchObject({
      contextId: "ctx_controller_01",
    });
    expect(JSON.stringify(fixture.reports)).not.toContain("rctx_test_controller_key");
  });

  test("restores into a replacement VM, rotates authority, and finishes stopped", async () => {
    const fixture = await createFixture("restore", {
      backupCredential: true,
      vmState: "stopped",
    });

    await fixture.control.runOnce();

    expect(fixture.deckCalls).toEqual(
      expect.arrayContaining(["restore", "start", "stop"]),
    );
    expect(fixture.rotationIssues).toBe(1);
    expect(fixture.reports.at(-1)).toMatchObject({
      connection: { status: "offline" },
      observedState: "stopped",
      safeResult: {
        backupRef: `mbk_${"b".repeat(32)}`,
        generation: 2,
        replacedVmId: VM_ID,
      },
      status: "succeeded",
    });
    const credentialPath = path.join(
      fixture.config.credentialRoot,
      INSTANCE_ID,
      "controller.json",
    );
    expect(JSON.parse(await readFile(credentialPath, "utf8"))).toMatchObject({
      contextId: "ctx_controller_02",
      contextKey: "rctx_test_controller_key_next",
    });
    expect(fixture.raviContextKeys).toEqual(
      expect.arrayContaining([
        "rctx_test_controller_key",
        "rctx_test_controller_key_next",
      ]),
    );
    const restoreProgress = fixture.reports.map((report) =>
      Number(report.progressPercent),
    );
    expect(restoreProgress).toEqual(
      [...restoreProgress].sort((left, right) => left - right),
    );
    expect(fixture.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "rotating_controller",
          progressPercent: 75,
          provisioningPhase: "restoring",
        }),
      ]),
    );
    expect(JSON.stringify(fixture.reports)).not.toContain("rctx_test_controller_key");
  });

  test("retries a partially applied restore without replacing the VM twice", async () => {
    const fixture = await createFixture("retry", {
      backupCredential: true,
      credential: true,
      retryRestore: true,
      vmState: "running",
    });

    await fixture.control.runOnce();

    expect(fixture.deckCalls).not.toContain("restore");
    expect(fixture.rotationIssues).toBe(1);
    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "stopped",
      safeResult: {
        backupRef: `mbk_${"b".repeat(32)}`,
        generation: 2,
        replacedVmId: VM_ID,
      },
      status: "succeeded",
    });
  });

  test("resumes after an ack outage without issuing another controller grant", async () => {
    const fixture = await createFixture("rotate_controller", {
      credential: true,
      rotationAckFailureOnce: true,
      vmState: "running",
    });

    await fixture.control.runOnce();
    expect(fixture.reports.at(-1)).toMatchObject({
      failureCode: "managed_rotation_ack_unavailable",
      status: "failed",
    });
    const pendingPath = path.join(
      fixture.config.credentialRoot,
      INSTANCE_ID,
      "pending-controller-rotation.json",
    );
    expect(JSON.parse(await readFile(pendingPath, "utf8"))).toMatchObject({
      replacement: { contextId: "ctx_controller_02" },
      stage: "credential_persisted",
    });

    fixture.reclaim();
    await fixture.control.runOnce();

    expect(fixture.rotationIssues).toBe(1);
    expect(fixture.controllerRequests.map((item) => item.pathname)).toEqual([
      "/controller/rotation/prepare",
      "/controller/rotation/claim",
      "/controller/rotation/ack",
      "/controller/rotation/ack",
    ]);
    expect(fixture.reports.at(-1)).toMatchObject({
      observedState: "ready",
      status: "succeeded",
    });
    await expect(stat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports bounded safe errors and never echoes provider text", async () => {
    const fixture = await createFixture("create", { deckFailure: { message: "secret=rctx_should_not_escape" } });
    await fixture.control.runOnce();
    expect(fixture.reports.at(-1)).toEqual(expect.objectContaining({
      failureCode: "managed_runtime_control_failed",
      observedState: "failed",
      status: "failed",
    }));
    expect(JSON.stringify(fixture.reports)).not.toContain("rctx_should_not_escape");
  });

  test("fails legacy prompt commands without falling back to sessions.send", async () => {
    const fixture = await createFixture("create", {
      command: managedCommand("prompt_send", {
        prompt: "legacy prompt must not execute",
        sessionKey: "managed-ravi",
      }),
      credential: true,
      vmState: "running",
    });

    await fixture.control.runOnce();
    await fixture.control.waitForActiveCommands();

    expect(fixture.raviCalls).toEqual([]);
    expect(fixture.commandReports.at(-1)).toMatchObject({
      failureCode: "managed_runtime_legacy_prompt_unsupported",
      phase: "failed",
      status: "failed",
    });
  });

  test("executes canonical chat and interrupt commands through scoped Ravi SDK contexts", async () => {
    const prompt = await createFixture("create", {
      command: managedCommand(
        "chat_message_create",
        canonicalCommandInput({
          clientMessageId: "client-message-0001",
          text: "Responda apenas OK.",
        }),
      ),
      credential: true,
      history: {
        messages: [
          {
            actorType: "contact",
            content: { text: "Responda apenas OK." },
            createdAt: 1,
            id: "message-control-1",
            sortKey: "0001",
          },
          {
            actorType: "agent",
            agentId: "managed-ravi",
            content: { text: "OK" },
            createdAt: 2,
            id: "message-control-2",
            sortKey: "0002",
          },
        ],
      },
      streamEvents: [
        {
          data: {
            data: { text: "OK" },
            sessionName: "managed-ravi",
            timestamp: new Date().toISOString(),
            topic: "ravi.session.managed-ravi.response",
            type: "session.event",
          },
          event: "session",
          id: "evt_0001",
        },
        {
          data: {
            data: { type: "turn.complete" },
            sessionName: "managed-ravi",
            timestamp: new Date().toISOString(),
            topic: "ravi.session.managed-ravi.runtime",
            type: "session.event",
          },
          event: "session",
          id: "evt_0002",
        },
      ],
      vmState: "running",
    });
    const claimed = await prompt.control.runOnce();
    expect(claimed).toEqual({
      action: null,
      claimed: true,
      commandId: "70000000-0000-4000-8000-000000000001",
      operationId: null,
    });
    await prompt.control.waitForActiveCommands();
    expect(prompt.streamedSessionNames).toEqual([
      "managed-ravi-control-session",
    ]);
    expect(prompt.raviCalls).toEqual([
      "context.remote-control.issue:chat-ensure",
      "chats.ensure",
      "context.remote-control.issue:chat-turn",
      "chats.messages.create",
      "context.remote-control.issue:chat-turn",
      "chats.read",
    ]);
    expect(prompt.commandReports.at(-1)).toMatchObject({
      phase: "completed",
      result: {
        accepted: {
          dispatchStatus: "accepted",
          duplicate: false,
          messageId: "message-control-1",
        },
        binding: {
          chatId: "chat-control-1",
          sessionKey: "managed-ravi",
        },
        history: {
          messages: [
            {
              actorType: "contact",
              content: { text: "Responda apenas OK." },
              id: "message-control-1",
            },
            {
              actorType: "agent",
              content: { text: "OK" },
              id: "message-control-2",
            },
          ],
        },
      },
      status: "succeeded",
    });
    expect(prompt.commandReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          events: [
            expect.objectContaining({
              eventType: "ravi.session.managed-ravi.response",
              sourceEventId:
                "70000000-0000-4000-8000-000000000001:evt_0001",
            }),
          ],
          phase: "streaming",
        }),
      ]),
    );
    expect(JSON.stringify(prompt.commandReports)).not.toContain(
      "rctx_test_controller_key",
    );

    const interrupt = await createFixture("create", {
      command: managedCommand(
        "turn_interrupt",
        canonicalCommandInput({
          chatId: "chat-control-1",
          localActorId: "actor:console-user-1",
          localPlatformIdentityId: "identity:console-user-1",
          sessionKey: "managed-ravi",
          targetCommandId: "70000000-0000-4000-8000-000000000099",
        }),
      ),
      credential: true,
      vmState: "running",
    });
    await interrupt.control.runOnce();
    await interrupt.control.waitForActiveCommands();
    expect(interrupt.raviCalls).toEqual([
      "context.remote-control.issue:chat-ensure",
      "chats.ensure",
      "context.remote-control.issue:turn-interrupt",
      "sessions.runtime.interrupt",
      "chats.read",
    ]);
    expect(interrupt.commandReports.at(-1)).toMatchObject({
      phase: "completed",
      status: "succeeded",
    });
  });

  test("aborts the exact canonical turn bound to a successful interrupt", async () => {
    const promptCommandId = "70000000-0000-4000-8000-000000000010";
    const interruptCommandId = "70000000-0000-4000-8000-000000000011";
    const fixture = await createFixture("create", {
      commands: [
        managedCommand(
          "chat_message_create",
          canonicalCommandInput({
            clientMessageId: "client-message-0010",
            text: "Analise o documento em profundidade.",
          }),
          promptCommandId,
        ),
        managedCommand(
          "turn_interrupt",
          canonicalCommandInput({
            chatId: "chat-control-1",
            localActorId: "actor:console-user-1",
            localPlatformIdentityId: "identity:console-user-1",
            sessionKey: "managed-ravi",
            targetCommandId: promptCommandId,
          }),
          interruptCommandId,
        ),
      ],
      credential: true,
      streamUntilAbort: true,
      vmState: "running",
    });

    await fixture.control.runOnce();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fixture.raviCalls.includes("chats.messages.create")) break;
      await Bun.sleep(2);
    }
    expect(fixture.raviCalls).toContain("chats.messages.create");

    await fixture.control.runOnce();
    await fixture.control.waitForActiveCommands();

    expect(
      fixture.commandReports.filter(
        (report) => report.commandId === promptCommandId,
      ).at(-1),
    ).toMatchObject({
      failureCode: null,
      phase: "interrupted",
      status: "cancelled",
    });
    expect(
      fixture.commandReports.filter(
        (report) => report.commandId === interruptCommandId,
      ).at(-1),
    ).toMatchObject({
      phase: "completed",
      status: "succeeded",
    });
  });

  test("terminalizes an interrupted canonical chat turn from the session stream", async () => {
    const fixture = await createFixture("create", {
      command: managedCommand(
        "chat_message_create",
        canonicalCommandInput({
          clientMessageId: "client-message-0020",
          text: "Prepare uma análise detalhada.",
        }),
      ),
      credential: true,
      history: {
        messages: [
          {
            actorType: "contact",
            content: { text: "Prepare uma análise detalhada." },
            createdAt: 1,
            id: "message-control-1",
            sortKey: "0001",
          },
          {
            actorType: "agent",
            content: { text: "Análise parcial" },
            createdAt: 2,
            id: "message-control-2",
            sortKey: "0002",
          },
        ],
      },
      streamEvents: [
        {
          data: {
            data: { reason: "explicit_abort", type: "turn.interrupted" },
            sessionName: "managed-ravi",
            timestamp: new Date().toISOString(),
            topic: "ravi.session.managed-ravi.runtime",
            type: "session.event",
          },
          event: "session",
          id: "evt_interrupt_0001",
        },
      ],
      vmState: "running",
    });

    await fixture.control.runOnce();
    await fixture.control.waitForActiveCommands();

    expect(fixture.commandReports.at(-1)).toMatchObject({
      phase: "interrupted",
      result: {
        history: {
          messages: [
            {
              actorType: "contact",
              content: { text: "Prepare uma análise detalhada." },
            },
            {
              actorType: "agent",
              content: { text: "Análise parcial" },
            },
          ],
        },
      },
      status: "cancelled",
    });
  });

  test("terminalizes a history sync when the SDK read exceeds its deadline", async () => {
    const fixture = await createFixture("create", {
      command: managedCommand("session_sync", {
        sessionKey: "managed-ravi",
      }),
      credential: true,
      historyReadDelayMs: 40,
      historyReadTimeoutMs: 5,
      vmState: "running",
    });

    await fixture.control.runOnce();
    await fixture.control.waitForActiveCommands();

    expect(fixture.commandReports.at(-1)).toMatchObject({
      failureCode: "managed_runtime_history_read_timeout",
      phase: "failed",
      status: "failed",
    });
  });

  test("bounds the complete Ravi SDK response body and request duration", async () => {
    const oversized = createBoundedRaviSdkFetch({
      fetchImpl: (async () =>
        new Response("response-body-too-large", {
          headers: { "content-length": "23" },
        })) as unknown as typeof fetch,
      maxResponseBytes: 8,
      timeoutMs: 100,
    });
    await expect(oversized("https://ravi.test/api/v1/sessions/read")).rejects
      .toThrow("managed_runtime_sdk_response_too_large");

    const stalled = createBoundedRaviSdkFetch({
      fetchImpl: (async (
        _input: string | URL | Request,
        init?: RequestInit,
      ) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        })) as unknown as typeof fetch,
      maxResponseBytes: 1024,
      timeoutMs: 5,
    });
    await expect(stalled("https://ravi.test/api/v1/sessions/read")).rejects
      .toThrow("managed_runtime_sdk_request_timeout");
  });

  test("requires secrets from environment and absolute private paths", () => {
    expect(() => loadManagedRuntimeControlConfig({ NODE_ENV: "test" })).toThrow("managed_runtime_control_config_missing");
    expect(() => loadManagedRuntimeControlConfig({
      NODE_ENV: "test",
      RAVI_DECK_CONTEXT_KEY: "dctx_test",
      RAVI_DECK_GATEWAY_URL: "http://127.0.0.1:7417",
      RAVI_MANAGED_STATE_ROOT: "relative",
      RAVI_RUNTIME_CONSOLE_URL: "https://console.ravi.bot",
      RAVI_RUNTIME_CONTROL_TOKEN: "control_test",
    })).toThrow("managed_runtime_control_path_invalid");
  });
});

async function createFixture(
  action:
    | "backup"
    | "create"
    | "delete"
    | "restart"
    | "restore"
    | "retry"
    | "rotate_controller"
    | "start"
    | "stop",
  options: {
    backupCredential?: boolean;
    command?: ManagedCommand;
    commands?: ManagedCommand[];
    credential?: boolean;
    deckFailure?: unknown;
    destroyFailure?: unknown;
    inspectFailure?: unknown;
    pendingClaim?: boolean;
    expiredForeignRotation?: boolean;
    operationHeartbeatMs?: number;
    restoredCredentialRecovery?: boolean;
    rotationAckFailureOnce?: boolean;
    readinessBody?: Record<string, unknown>;
    retryRestore?: boolean;
    startFailure?: unknown;
    startState?: string;
    startDelayMs?: number;
    history?: {
      messages: Array<{
        actorType: string;
        agentId?: string;
        content?: Record<string, unknown>;
        createdAt: number;
        id: string;
        messageType?: string;
        platformIdentityId?: string;
        sortKey: string;
      }>;
    };
    historyReadDelayMs?: number;
    historyReadTimeoutMs?: number;
    streamEvents?: Array<{
      data: unknown;
      event: string;
      id?: string;
    }>;
    streamUntilAbort?: boolean;
    vmState?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed-runtime-control-"));
  roots.push(root);
  const config: ManagedRuntimeControlConfig = {
    claimOwner: "ovh-managed-01",
    claimTtlSeconds: 60,
    consoleControlToken: "control_test",
    consoleUrl: "https://console.test",
    credentialRoot: path.join(root, "credentials"),
    deckContextKey: "dctx_test",
    deckGatewayUrl: "http://127.0.0.1:7417",
    deckSdkPath: "/runtime/deck-sdk",
    environment: "production",
    hostName: "ovh-managed-01",
    hostProvider: "ovh",
    imageName: "ravi-codex-p0b",
    pollIntervalMs: 1_000,
    providerBrokerRegistryPath: path.join(root, "provider-broker/instances.json"),
    raviSdkPath: "/runtime/ravi-sdk",
    region: "bhs",
    stateRoot: root,
    vercelBypassSecret: null,
    waitReadySeconds: 90,
  };
  const reports: Record<string, unknown>[] = [];
  const commandReports: Record<string, unknown>[] = [];
  const deckCalls: string[] = [];
  const deckCreateInputs: Parameters<RuntimeControlDeckApi["create"]>[0][] = [];
  const raviCalls: string[] = [];
  const streamedSessionNames: string[] = [];
  const claimAuthorizations: string[] = [];
  const controllerRequests: Array<{ authorization: string; pathname: string }> = [];
  const raviContextKeys: string[] = [];
  const imageRegistrations: Record<string, unknown>[] = [];
  let bootstrapIssues = 0;
  let rotationIssues = 0;
  const rotationContextIds: string[] = [];
  let rotationAckFailuresRemaining = options.rotationAckFailureOnce ? 1 : 0;
  let claimed = false;
  let commandIndex = 0;
  const commands = options.commands ?? (options.command ? [options.command] : []);
  let state = options.vmState ?? "missing";

  const operation = {
    action,
    attemptCount: 1,
    claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    id: OPERATION_ID,
    instance: {
      desiredState: action === "delete"
        ? "deleted" as const
        : action === "stop" || action === "restore" || options.retryRestore
          ? "stopped" as const
          : "running" as const,
      displayName: "Managed Ravi Test",
      hostId: HOST_ID,
      imageId: IMAGE_ID,
      observedState: options.vmState ?? "provisioning",
      placementClass: "shared-small",
      runtimeModel: null,
      runtimeProvider: "codex",
    },
    instanceId: INSTANCE_ID,
    organizationId: "50000000-0000-4000-8000-000000000001",
    projectId: "60000000-0000-4000-8000-000000000001",
    safeInput: {
      sizePreset: "small",
      ...(action === "restore" ? { backupRef: `mbk_${"b".repeat(32)}` } : {}),
      ...(options.retryRestore
        ? {
            backupRef: `mbk_${"b".repeat(32)}`,
            retryAction: "restore",
            retryOperationId: "20000000-0000-4000-8000-000000000099",
          }
        : {}),
    },
  };

  const consoleApi: RuntimeControlConsoleApi = {
    async claimCommand() {
      const command = commands[commandIndex] ?? null;
      if (command) commandIndex += 1;
      return command;
    },
    async claimOperation() {
      if (commands.length > 0) return null;
      if (claimed) return null;
      claimed = true;
      return operation;
    },
    async heartbeatHost() {},
    async issueBootstrap() {
      bootstrapIssues += 1;
      return {
        bootstrap: {
          credentialClaimToken: "ravi_mcc_test_claim_token_abcdefghijklmnopqrstuvwxyz",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          payloadBase64: Buffer.from("{\"bootstrap\":true}").toString("base64"),
          signatureBase64: Buffer.from("signature").toString("base64"),
        },
      };
    },
    async issueControllerRotation(input) {
      rotationIssues += 1;
      rotationContextIds.push(input.currentContextId);
      return {
        rotation: {
          credentialClaimToken:
            "ravi_mcc_test_rotation_claim_token_abcdefghijklmnopqrstuvwxyz",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          grantId: "d7d49753-0557-41c6-85d3-01f6375f5aa8",
          payloadBase64: Buffer.from("{\"rotation\":true}").toString("base64"),
          signatureBase64: Buffer.from("managed-rotation-signature").toString(
            "base64",
          ),
        },
      };
    },
    async registerHost() {
      return { id: HOST_ID };
    },
    async registerImage(input) {
      imageRegistrations.push(input);
      return { id: IMAGE_ID };
    },
    async reportCommand(input) {
      commandReports.push(input);
    },
    async reportOperation(input) {
      reports.push(input);
    },
  };
  const restoredReplacement = options.restoredCredentialRecovery || options.retryRestore;
  let currentVmId = restoredReplacement
    ? `mvm_${"e".repeat(32)}`
    : VM_ID;
  let generation = restoredReplacement ? 2 : 1;
  let replacedVmId: string | null = restoredReplacement
    ? VM_ID
    : null;
  let restoredFromBackupRef: string | null = restoredReplacement
    ? `mbk_${"b".repeat(32)}`
    : null;
  let vmOperationRef = options.retryRestore
    ? "20000000-0000-4000-8000-000000000099"
    : OPERATION_ID;
  const vm = (): {
    controlEndpoint: string;
    facts: { gatewayHealthy: boolean };
    failureCode: null;
    generation: number;
    id: string;
    instanceRef: string;
    operationRef: string;
    quarantinedReason: null;
    replacedVmId: string | null;
    restoredFromBackupRef: string | null;
    state: string;
  } => ({
    controlEndpoint: "http://172.30.0.2:4211",
    facts: { gatewayHealthy: state === "running" },
    failureCode: null,
    generation,
    id: currentVmId,
    instanceRef: `managed-${INSTANCE_ID}`,
    operationRef: vmOperationRef,
    quarantinedReason: null,
    replacedVmId,
    restoredFromBackupRef,
    state,
  });
  const deck: RuntimeControlDeckApi = {
    async backup(_ref, backupRef) {
      deckCalls.push("backup");
      return {
        backup: {
          backupRef,
          contentDigest: `sha256:${"d".repeat(64)}`,
          createdAt: "2026-07-15T12:00:00.000Z",
          imageDigest: IMAGE_DIGEST,
          instanceRef: `managed-${INSTANCE_ID}`,
          sizeBytes: 8_224 * 1024 * 1024,
          sourceVmId: currentVmId,
          stateDiskMib: 8_192,
        },
        vm: vm(),
      };
    },
    async create(input) {
      deckCalls.push("create");
      deckCreateInputs.push(input);
      if (options.deckFailure) throw options.deckFailure;
      state = "created";
      return vm();
    },
    async destroy() {
      deckCalls.push("destroy");
      if (options.destroyFailure) throw options.destroyFailure;
      state = "destroyed";
      return vm();
    },
    async image() {
      deckCalls.push("image");
      return {
        id: "img_ravi-codex-p0b",
        metadata: {
          imageDigest: IMAGE_DIGEST,
          kernelSha256: "b".repeat(64),
          rootfsSha256: "c".repeat(64),
        },
        name: "ravi-codex-p0b",
        os: "ubuntu-24.04",
        raviVersion: "p0b-test",
        status: "ready",
      };
    },
    async inspect() {
      deckCalls.push("inspect");
      if (state === "missing") {
        throw options.inspectFailure ?? { code: "managed_vm_not_found" };
      }
      return vm();
    },
    async prepare() {
      deckCalls.push("prepare");
      state = "prepared";
      return vm();
    },
    async restart() {
      deckCalls.push("restart");
      state = "running";
      return vm();
    },
    async restore(_ref, backupRef) {
      deckCalls.push("restore");
      replacedVmId = currentVmId;
      currentVmId = `mvm_${"e".repeat(32)}`;
      generation = 2;
      restoredFromBackupRef = backupRef;
      vmOperationRef = OPERATION_ID;
      state = "stopped";
      return vm();
    },
    async start() {
      deckCalls.push("start");
      if (options.startDelayMs) await Bun.sleep(options.startDelayMs);
      if (options.startFailure) throw options.startFailure;
      state = options.startState ?? "running";
      return vm();
    },
    async stop() {
      deckCalls.push("stop");
      state = "stopped";
      return vm();
    },
  };
  const ravi: ManagedRaviClientFactory = {
    create(_baseUrl, contextKey) {
      raviContextKeys.push(contextKey);
      return {
        chats: {
          async ensure(installationId, actorId, agentId) {
            raviCalls.push("chats.ensure");
            return {
              actor: {
                id: `actor:${actorId}`,
                platformIdentityId: `identity:${actorId}`,
              },
              binding: {
                agentId,
                chatId: "chat-control-1",
                sessionKey: "managed-ravi",
              },
              chat: { id: "chat-control-1" },
              session: {
                agentId,
                sessionKey: "managed-ravi",
                sessionName: "managed-ravi-control-session",
              },
              installationId,
            };
          },
          messages: {
            async create() {
              raviCalls.push("chats.messages.create");
              return {
                dispatch: { status: "accepted" },
                duplicate: false,
                message: { id: "message-control-1" },
                session: { sessionKey: "managed-ravi" },
              };
            },
          },
          async read() {
            raviCalls.push("chats.read");
            if (options.historyReadDelayMs) {
              await Bun.sleep(options.historyReadDelayMs);
            }
            return options.history ?? { messages: [] };
          },
        },
        context: {
          remoteControl: {
            async issue(profile) {
              raviCalls.push(`context.remote-control.issue:${profile}`);
              return {
                contextId: `ctx_${profile}`,
                contextKey: `rctx_${profile}`,
                expiresAt: Date.now() + 120_000,
              };
            },
          },
        },
        self: {
          async whoami() {
            raviCalls.push("self.whoami");
            if (
              options.restoredCredentialRecovery
              && contextKey === "rctx_test_controller_key_stale"
            ) {
              throw new Error("PermissionDenied");
            }
            return { agent: "managed-ravi" };
          },
        },
        sessions: {
          async list() {
            raviCalls.push("sessions.list");
            return { items: [], total: 0 };
          },
          async read() {
            raviCalls.push("sessions.read");
            if (options.historyReadDelayMs) {
              await Bun.sleep(options.historyReadDelayMs);
            }
            return options.history ?? { messages: [] };
          },
          runtime: {
            async interrupt() {
              raviCalls.push("sessions.runtime.interrupt");
              return { ok: true, operation: "interrupt" };
            },
          },
        },
      };
    },
    createStream() {
      return {
        chat(_chatId, streamOptions) {
          return (async function* () {
            const signal = streamOptions?.signal;
            if (!signal || signal.aborted) return;
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })();
        },
        session(sessionName, streamOptions) {
          streamedSessionNames.push(sessionName);
          return (async function* () {
            if (options.streamUntilAbort) {
              await new Promise<void>((resolve) => {
                const signal = streamOptions?.signal;
                if (!signal || signal.aborted) {
                  resolve();
                  return;
                }
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
              return;
            }
            for (const event of options.streamEvents ?? []) yield event;
          })();
        },
      };
    },
    protocolVersion: "0.test",
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    claimAuthorizations.push(authorization);
    controllerRequests.push({ authorization, pathname: requestUrl.pathname });
    if (requestUrl.pathname === "/health" && options.readinessBody) {
      return Response.json(options.readinessBody, { status: 503 });
    }
    if (requestUrl.pathname === "/controller/rotation/prepare") {
      return Response.json({
        grantId: "d7d49753-0557-41c6-85d3-01f6375f5aa8",
        ok: true,
        phase: "claimable",
      });
    }
    if (requestUrl.pathname === "/controller/rotation/claim") {
      return Response.json({
        credential: {
          contextId: "ctx_controller_02",
          contextKey: "rctx_test_controller_key_next",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          instanceId: INSTANCE_ID,
          schemaVersion: "ravi.managed-appliance.controller-credential/v1",
        },
        ok: true,
      });
    }
    if (requestUrl.pathname === "/controller/rotation/ack") {
      if (rotationAckFailuresRemaining > 0) {
        rotationAckFailuresRemaining -= 1;
        return Response.json(
          { code: "managed_rotation_ack_unavailable", ok: false },
          { status: 503 },
        );
      }
      return Response.json({
        acknowledged: true,
        contextId: "ctx_controller_02",
        grantId: "d7d49753-0557-41c6-85d3-01f6375f5aa8",
        ok: true,
      });
    }
    return Response.json({
      credential: {
        contextId: "ctx_controller_01",
        contextKey: "rctx_test_controller_key",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        instanceId: INSTANCE_ID,
        schemaVersion: "ravi.managed-appliance.controller-credential/v1",
      },
      ok: true,
    });
  }) as typeof fetch;

  if (options.pendingClaim) {
    const claimDir = path.join(config.credentialRoot, INSTANCE_ID);
    await Bun.write(path.join(claimDir, "pending-claim.json"), "");
    await rm(path.join(claimDir, "pending-claim.json"), { force: true });
    await Bun.write(path.join(config.stateRoot, "bootstrap", VM_ID, "payload.json"), "{\"bootstrap\":true}");
    await Bun.write(path.join(config.stateRoot, "bootstrap", VM_ID, "payload.sig"), "signature");
    await Bun.write(path.join(claimDir, "pending-claim.json"), JSON.stringify({
      bootstrapExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      claimToken: "ravi_mcc_test_claim_token_abcdefghijklmnopqrstuvwxyz",
      instanceId: INSTANCE_ID,
      operationId: OPERATION_ID,
      schemaVersion: "ravi.managed-runtime.pending-controller-claim/v1",
      vmId: VM_ID,
    }));
  }
  if (options.credential) {
    await Bun.write(path.join(config.credentialRoot, INSTANCE_ID, "controller.json"), JSON.stringify({
      contextId: "ctx_controller_01",
      contextKey: "rctx_test_controller_key",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      instanceId: INSTANCE_ID,
      schemaVersion: "ravi.managed-appliance.controller-credential/v1",
    }));
  }
  if (options.restoredCredentialRecovery) {
    await Bun.write(
      path.join(config.credentialRoot, INSTANCE_ID, "controller.json"),
      JSON.stringify({
        contextId: "ctx_controller_stale",
        contextKey: "rctx_test_controller_key_stale",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        instanceId: INSTANCE_ID,
        schemaVersion: "ravi.managed-appliance.controller-credential/v1",
      }),
    );
  }
  if (options.backupCredential) {
    await Bun.write(
      path.join(
        config.credentialRoot,
        "backups",
        INSTANCE_ID,
        `mbk_${"b".repeat(32)}`,
        "controller.json",
      ),
      JSON.stringify({
        contextId: "ctx_controller_01",
        contextKey: "rctx_test_controller_key",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        instanceId: INSTANCE_ID,
        schemaVersion: "ravi.managed-appliance.controller-credential/v1",
      }),
    );
  }
  if (options.restoredCredentialRecovery) {
    await Bun.write(
      path.join(
        config.credentialRoot,
        "backups",
        INSTANCE_ID,
        `mbk_${"b".repeat(32)}`,
        "controller.json",
      ),
      JSON.stringify({
        contextId: "ctx_controller_01",
        contextKey: "rctx_test_controller_key",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        instanceId: INSTANCE_ID,
        schemaVersion: "ravi.managed-appliance.controller-credential/v1",
      }),
    );
  }
  if (options.expiredForeignRotation) {
    await Bun.write(
      path.join(
        config.credentialRoot,
        INSTANCE_ID,
        "pending-controller-rotation.json",
      ),
      JSON.stringify({
        deckInstanceRef: `managed-${INSTANCE_ID}`,
        grant: {
          credentialClaimToken:
            "ravi_mcc_test_expired_rotation_claim_abcdefghijklmnopqrstuvwxyz",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          grantId: "d7d49753-0557-41c6-85d3-01f6375f5aa7",
          payloadBase64: Buffer.from("{\"rotation\":true}").toString("base64"),
          signatureBase64: Buffer.from("managed-rotation-signature").toString("base64"),
        },
        instanceId: INSTANCE_ID,
        operationId: "20000000-0000-4000-8000-000000000099",
        previousContextId: "ctx_controller_01",
        replacement: null,
        replacementContextId: null,
        schemaVersion: "ravi.managed-runtime.pending-controller-rotation/v1",
        stage: "grant_issued",
        vmId: VM_ID,
      }),
    );
  }

  const control = new ManagedRuntimeControl(config, {
    console: consoleApi,
    deck,
    fetchImpl,
    historyReadTimeoutMs: options.historyReadTimeoutMs,
    operationHeartbeatMs: options.operationHeartbeatMs,
    ravi,
  });
  await control.initialize();
  return {
    get bootstrapIssues() { return bootstrapIssues; },
    claimAuthorizations,
    commandReports,
    config,
    control,
    controllerRequests,
    deckCalls,
    deckCreateInputs,
    imageRegistrations,
    raviContextKeys,
    raviCalls,
    streamedSessionNames,
    reclaim() { claimed = false; },
    reports,
    rotationContextIds,
    get rotationClaimToken() {
      return "ravi_mcc_test_rotation_claim_token_abcdefghijklmnopqrstuvwxyz";
    },
    get rotationIssues() { return rotationIssues; },
  };
}

function managedCommand(
  action: ManagedCommand["action"],
  input: Record<string, unknown>,
  id = "70000000-0000-4000-8000-000000000001",
): ManagedCommand {
  return {
    action,
    attemptCount: 1,
    claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    id,
    input,
    instanceId: INSTANCE_ID,
    organizationId: "80000000-0000-4000-8000-000000000001",
    projectId: "90000000-0000-4000-8000-000000000001",
    sessionId: SESSION_ID,
    sessionKey: "managed-ravi",
    status: "claimed",
  };
}

function canonicalCommandInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "ravi.control.command/v1",
    bindingId: "a0000000-0000-4000-8000-000000000001",
    organizationId: "80000000-0000-4000-8000-000000000001",
    installationId: INSTANCE_ID,
    actorId: "console-user-1",
    actorName: "Console User",
    agentId: "managed-ravi",
    chatId: null,
    sessionKey: null,
    ...overrides,
  };
}
