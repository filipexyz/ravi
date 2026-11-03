import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

type BrowserResponse = {
  data: unknown;
  requestId: string | null;
  status: number;
};

type EvidenceStep = {
  completedAt: string;
  details: JsonObject;
  name: string;
  startedAt: string;
  status: "passed" | "failed";
};

type EvidencePacket = {
  completedAt: string | null;
  environment: "production";
  failureCode: string | null;
  hostAlias: string;
  mode: "full";
  projectRef: string;
  result: "running" | "passed" | "failed";
  runId: string;
  sourceRevision: string;
  startedAt: string;
  steps: EvidenceStep[];
  version: 1;
};

type InstanceView = {
  backups: Array<{
    backupRef: string;
    contentDigest: string;
    createdAt: string;
    operationId: string;
    sizeBytes: number;
    sourceVmId: string;
  }>;
  connections: Array<{
    id: string;
    kind: string;
    status: string;
  }>;
  instance: {
    desiredState: string;
    displayName: string;
    failureCode: string | null;
    id: string;
    observedState: string;
    provisioningPhase: string | null;
    runtimeProvider: string;
    runtimeVersion: string | null;
  };
  latestOperation: {
    action: string;
    failureCode: string | null;
    id: string;
    phase: string | null;
    progressPercent: number;
    status: string;
  } | null;
};

type SessionView = {
  commands: Array<{
    action: string;
    failureCode: string | null;
    id: string;
    phase: string;
    result: unknown;
    status: string;
  }>;
  latestEventSequence: number;
  session: {
    id: string;
    instanceId: string;
    status: string;
  };
};

type ChatMessage = {
  actorId: string | null;
  actorType: string;
  clientMessageId: string;
  content: JsonObject;
  createdAt: string;
  failureCode: string | null;
  id: string;
  operationId: string | null;
  status: string;
};

type ChatView = {
  binding: {
    id: string;
    status: string;
    targetAgentId: string;
  } | null;
  messages: ChatMessage[];
};

type ChatOperation = {
  failureCode: string | null;
  id: string;
  status: string;
};

type ChatSubmission = {
  duplicate: boolean;
  message: ChatMessage;
  operation: ChatOperation;
};

type VmProjection = {
  controlEndpointDigest: string;
  facts: JsonObject;
  generation: number;
  id: string;
  imageDigest: string;
  instanceRef: string;
  jailIdDigest: string;
  replacedVmId: string | null;
  restoredFromBackupRef: string | null;
  state: string;
};

const TERMINAL_COMMANDS = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_OPERATIONS = new Set(["succeeded", "failed", "cancelled"]);
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SENSITIVE_KEY = /(authorization|cookie|credential|password|prompt|response|secret|token)/i;
const SENSITIVE_VALUE = /(Bearer\s+|(?:dctx|rctx)_[A-Za-z0-9._:-]+|__Host-|OPENAI_API_KEY)/i;
const PRIVATE_ADDRESS = /\b(?:10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)\d{1,3}(?:\.\d{1,3}){2}\b/;
const HOST_PATH = /(?:^|\s)\/(?:etc|home|opt|root|run|tmp|var)\//;

const origin = process.env.MANAGED_RAVI_CONSOLE_ORIGIN ?? "https://console.ravi.bot";
const projectRef = process.env.MANAGED_RAVI_PROJECT_REF ?? "core";
const hostAlias = process.env.MANAGED_RAVI_HOST ?? "ravi-runtime-ovh-1";
const runId = `mrr_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
const marker = `managed-ravi-readiness-${runId}`;
const basePath = `/api/console/projects/${encodeURIComponent(projectRef)}/managed-runtime/instances`;
const chatBasePath = `/api/console/projects/${encodeURIComponent(projectRef)}/ravi-control/instances`;
const outputPath = resolve(
  process.env.MANAGED_RAVI_EVIDENCE_OUTPUT
    ?? `.ravi/evidence/managed-runtime/${runId}.json`,
);

let instanceId: string | null = null;
let deleted = false;

export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function safeFailureCode(error: unknown): string {
  if (error instanceof ReadinessError) return error.code;
  return "managed_runtime_readiness_unexpected";
}

export function assertEvidenceSafe(value: unknown, path = "evidence"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertEvidenceSafe(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as JsonObject)) {
      if (SENSITIVE_KEY.test(key)) {
        throw new ReadinessError("managed_runtime_evidence_sensitive_key");
      }
      assertEvidenceSafe(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (SENSITIVE_VALUE.test(value) || PRIVATE_ADDRESS.test(value) || HOST_PATH.test(value)) {
    throw new ReadinessError("managed_runtime_evidence_sensitive_value");
  }
}

export function projectVm(raw: unknown): VmProjection {
  const root = objectValue(raw);
  const vm = objectValue(root.vm ?? root.instance ?? root);
  const id = stringValue(vm.id, "managed_runtime_vm_id_missing");
  const instanceRef = stringValue(
    vm.instanceRef,
    "managed_runtime_vm_instance_ref_missing",
  );
  const controlEndpoint = stringValue(
    vm.controlEndpoint,
    "managed_runtime_vm_control_endpoint_missing",
  );
  const jailId = stringValue(vm.jailId, "managed_runtime_vm_jail_id_missing");
  return {
    controlEndpointDigest: digest(controlEndpoint),
    facts: safeFacts(vm.facts),
    generation: numberValue(vm.generation, "managed_runtime_vm_generation_missing"),
    id,
    imageDigest: stringValue(
      vm.imageDigest,
      "managed_runtime_vm_image_digest_missing",
    ),
    instanceRef,
    jailIdDigest: digest(jailId),
    replacedVmId: nullableString(vm.replacedVmId),
    restoredFromBackupRef: nullableString(vm.restoredFromBackupRef),
    state: stringValue(vm.state, "managed_runtime_vm_state_missing"),
  };
}

class ReadinessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReadinessError";
  }
}

class ReadinessRun {
  readonly evidence: EvidencePacket;

  constructor(sourceRevision: string) {
    this.evidence = {
      completedAt: null,
      environment: "production",
      failureCode: null,
      hostAlias,
      mode: "full",
      projectRef,
      result: "running",
      runId,
      sourceRevision,
      startedAt: new Date().toISOString(),
      steps: [],
      version: 1,
    };
  }

  async step<T>(
    name: string,
    action: () => Promise<{ details: JsonObject; value: T }>,
  ): Promise<T> {
    const startedAt = new Date().toISOString();
    process.stdout.write(`[managed-runtime-readiness] ${name}: running\n`);
    try {
      const result = await action();
      assertEvidenceSafe(result.details);
      this.evidence.steps.push({
        completedAt: new Date().toISOString(),
        details: result.details,
        name,
        startedAt,
        status: "passed",
      });
      await this.persist();
      process.stdout.write(`[managed-runtime-readiness] ${name}: passed\n`);
      return result.value;
    } catch (error) {
      const failureCode = safeFailureCode(error);
      this.evidence.steps.push({
        completedAt: new Date().toISOString(),
        details: { failureCode },
        name,
        startedAt,
        status: "failed",
      });
      await this.persist();
      throw error;
    }
  }

  async finish(result: "passed" | "failed", failureCode: string | null) {
    this.evidence.completedAt = new Date().toISOString();
    this.evidence.failureCode = failureCode;
    this.evidence.result = result;
    await this.persist();
  }

  private async persist() {
    assertEvidenceSafe(this.evidence);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(this.evidence, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

async function main() {
  validateConfiguration();
  const sourceRevision = await localCommand(["git", "rev-parse", "HEAD"]);
  const run = new ReadinessRun(sourceRevision.trim());

  try {
    await openAuthenticatedTab();

    await run.step("authenticated_console_boundary", async () => {
      const response = await api("GET", "/api/console/features");
      expectStatus(response, 200, "managed_runtime_console_auth_failed");
      return {
        details: { status: response.status, requestId: response.requestId },
        value: null,
      };
    });

    const baseline = await run.step("host_baseline", async () => {
      const [services, capacity, list] = await Promise.all([
        hostServices(),
        hostJson(deckCommand("capacity --json")),
        hostJson(deckCommand("list --json --limit 1")),
      ]);
      const total = numberAt(list, ["total"], "managed_runtime_host_list_invalid");
      const safeCapacity = capacityProjection(capacity);
      return {
        details: { services, capacity: safeCapacity, managedVmCount: total },
        value: { capacity: safeCapacity, managedVmCount: total },
      };
    });

    const created = await run.step("one_click_create", async () => {
      const response = await api("POST", basePath, {
        displayName: `Managed Ravi readiness ${runId}`,
        idempotencyKey: `${runId}:create`,
        placementClass: "shared-small",
        provider: "codex",
        sizePreset: "small",
      });
      expectStatus(response, 202, "managed_runtime_create_failed");
      const view = instanceView(response.data);
      instanceId = view.instance.id;
      const replay = await api("POST", basePath, {
        displayName: `Managed Ravi readiness ${runId}`,
        idempotencyKey: `${runId}:create`,
        placementClass: "shared-small",
        provider: "codex",
        sizePreset: "small",
      });
      expectStatus(replay, 202, "managed_runtime_create_replay_failed");
      const replayView = instanceView(replay.data);
      if (replayView.instance.id !== instanceId) {
        throw new ReadinessError("managed_runtime_create_replay_duplicated");
      }
      return {
        details: {
          instanceId,
          operationId: view.latestOperation?.id ?? null,
          replayInstanceMatched: true,
          requestId: response.requestId,
        },
        value: view,
      };
    });
    const createOperationId = requiredOperationId(created);

    const ready = await run.step("provision_to_sdk_ready", async () => {
      const started = Date.now();
      const view = await waitForOperation(createOperationId, 12 * 60_000);
      assertReady(view);
      const vm = await hostVm(view.instance.id);
      return {
        details: {
          instanceId: view.instance.id,
          operationId: createOperationId,
          durationMs: Date.now() - started,
          observedState: view.instance.observedState,
          connectionOnline: connectionOnline(view),
          runtimeProvider: view.instance.runtimeProvider,
          runtimeVersion: view.instance.runtimeVersion,
          vm,
        },
        value: { view, vm },
      };
    });

    const firstChat = await run.step("canonical_chat_and_idempotency", async () => {
      const answerMarker = `MRR-${randomUUID()}`;
      const prompt = `Reply with exactly this marker and nothing else: ${answerMarker}`;
      const commandKey = `${runId}:chat:1`;
      const clientMessageId = `${runId}:message:1`;
      const sent = await sendChatMessage(clientMessageId, commandKey, prompt);
      const replay = await sendChatMessage(clientMessageId, commandKey, prompt);
      if (
        sent.operation.id !== replay.operation.id
        || sent.message.id !== replay.message.id
        || !replay.duplicate
      ) {
        throw new ReadinessError("ravi_control_message_replay_duplicated");
      }
      const terminal = await waitForCommand(sent.operation.id, 8 * 60_000);
      if (terminal.status !== "succeeded") {
        throw new ReadinessError(terminal.failureCode ?? "ravi_control_chat_failed");
      }
      const chat = await waitForChatMessage(
        (message) =>
          message.actorType === "agent"
          && message.status === "canonical"
          && contentText(message.content) === answerMarker,
        90_000,
      );
      const agentMessage = chat.messages.find(
        (message) =>
          message.actorType === "agent"
          && message.status === "canonical"
          && contentText(message.content) === answerMarker,
      );
      if (!agentMessage) throw new ReadinessError("ravi_control_codex_marker_missing");
      const session = await getCurrentSession();
      const events = await getSessionEvents(session.session.id, 0);
      const markerSeen = containsText(terminal.result, answerMarker)
        || containsText(agentMessage.content, answerMarker)
        || containsText(events.data, answerMarker);
      if (!markerSeen) throw new ReadinessError("ravi_control_codex_marker_missing");
      const eventTypes = uniqueEventTypes(events.data);
      return {
        details: {
          sessionId: session.session.id,
          commandId: sent.operation.id,
          bindingId: chat.binding?.id ?? null,
          messageId: sent.message.id,
          agentMessageId: agentMessage.id,
          promptDigest: digest(prompt),
          answerMarkerDigest: digest(answerMarker),
          replayCommandMatched: true,
          replayMessageMatched: true,
          markerSeen,
          eventCount: eventCount(events.data),
          eventTypes,
        },
        value: {
          bindingId: requiredBindingId(chat),
          agentMessageId: agentMessage.id,
          clientMessageId,
          commandId: sent.operation.id,
          messageId: sent.message.id,
          sessionId: session.session.id,
        },
      };
    });

    await run.step("canonical_history_reload", async () => {
      const first = await getChat();
      const second = await getChat();
      const messageInFirst = first.messages.some(
        (item) => item.clientMessageId === firstChat.clientMessageId,
      );
      const messageInSecond = second.messages.some(
        (item) => item.clientMessageId === firstChat.clientMessageId,
      );
      if (
        !messageInFirst
        || !messageInSecond
        || requiredBindingId(first) !== firstChat.bindingId
        || requiredBindingId(second) !== firstChat.bindingId
      ) {
        throw new ReadinessError("ravi_control_history_reload_failed");
      }
      return {
        details: {
          bindingId: firstChat.bindingId,
          messageCount: first.messages.length,
          historyStable: true,
        },
        value: null,
      };
    });

    await run.step("unauthenticated_chat_denied", async () => {
      const boundary = await unauthenticatedBoundary(
        `${chatBasePath}/${requiredInstanceId()}/chat`,
      );
      if (!boundary.denied) {
        throw new ReadinessError("ravi_control_unauthenticated_chat_not_denied");
      }
      return {
        details: {
          status: boundary.status,
          authRedirect: boundary.authRedirect,
          denied: true,
        },
        value: null,
      };
    });

    await run.step("turn_interrupt", async () => {
      const prompt = "Run the shell command sleep 45, then reply with the single word completed.";
      const longTurn = await sendChatMessage(
        `${runId}:message:interrupt`,
        `${runId}:chat:interrupt`,
        prompt,
      );
      await waitForCommandActive(longTurn.operation.id, 60_000);
      const interrupted = await interruptChat(
        `${runId}:interrupt:1`,
        longTurn.operation.id,
      );
      const interruptTerminal = await waitForCommand(
        interrupted.id,
        90_000,
      );
      if (interruptTerminal.status !== "succeeded") {
        throw new ReadinessError(
          interruptTerminal.failureCode ?? "ravi_control_interrupt_failed",
        );
      }
      const interruptedSession = await getCurrentSession();
      const interruptionObserved = interruptedSession.session.status === "interrupted";
      const longTerminal = await waitForCommand(longTurn.operation.id, 90_000);
      if (!TERMINAL_COMMANDS.has(longTerminal.status)) {
        throw new ReadinessError("managed_runtime_long_turn_not_terminal");
      }
      return {
        details: {
          longTurnCommandId: longTurn.operation.id,
          interruptCommandId: interrupted.id,
          promptDigest: digest(prompt),
          interruptStatus: interruptTerminal.status,
          interruptionObserved,
          longTurnTerminalStatus: longTerminal.status,
        },
        value: null,
      };
    });

    await lifecycleOperation(run, "stop_start_continuity_stop", "stop", "stopped");
    await lifecycleOperation(run, "stop_start_continuity_start", "start", "ready");

    await run.step("session_continuity_after_start", async () => {
      const [session, chat] = await Promise.all([getCurrentSession(), getChat()]);
      const preserved = session.session.id === firstChat.sessionId
        && session.commands.some((item) => item.id === firstChat.commandId)
        && requiredBindingId(chat) === firstChat.bindingId
        && chat.messages.some((item) => item.id === firstChat.agentMessageId)
        && chat.messages.some(
          (item) => item.clientMessageId === firstChat.clientMessageId,
        );
      if (!preserved) throw new ReadinessError("managed_runtime_session_continuity_failed");
      return {
        details: {
          sessionId: session.session.id,
          commandCount: session.commands.length,
          preserved,
        },
        value: null,
      };
    });

    await run.step("runtime_control_restart_reconciliation", async () => {
      await restartHostService("ravi-managed-runtime-control");
      await waitForHostService("ravi-managed-runtime-control", 60_000);
      const view = await waitForInstance(
        (candidate) => candidate.instance.observedState === "ready",
        90_000,
      );
      const sync = await syncChat(`${runId}:sync:runtime-control`);
      const terminal = await waitForCommand(sync.id, 90_000);
      if (terminal.status !== "succeeded") {
        throw new ReadinessError("managed_runtime_sync_after_control_restart_failed");
      }
      return {
        details: {
          instanceId: view.instance.id,
          observedState: view.instance.observedState,
          commandId: sync.id,
          serviceActive: true,
        },
        value: null,
      };
    });

    await run.step("deck_restart_reconciliation", async () => {
      await restartHostService("ravi-deck-managed");
      await waitForHostService("ravi-deck-managed", 60_000);
      const list = await hostJson(
        deckCommand("list --json --limit 1"),
      );
      const count = numberAt(list, ["total"], "managed_runtime_host_list_invalid");
      if (count !== baseline.managedVmCount + 1) {
        throw new ReadinessError("managed_runtime_deck_restart_vm_count_invalid");
      }
      const vm = await hostVm(requiredInstanceId());
      if (vm.id !== ready.vm.id || vm.generation !== ready.vm.generation) {
        throw new ReadinessError("managed_runtime_deck_restart_duplicated_vm");
      }
      const sync = await syncChat(`${runId}:sync:deck`);
      const terminal = await waitForCommand(sync.id, 90_000);
      if (terminal.status !== "succeeded") {
        throw new ReadinessError("managed_runtime_sync_after_deck_restart_failed");
      }
      return {
        details: { managedVmCount: count, vm, commandId: sync.id },
        value: null,
      };
    });

    const readyBackup = await run.step("backup_ready_instance", async () => {
      const before = await getInstance();
      const response = await enqueueOperation("backup", `${runId}:backup:ready`);
      const operationId = requiredOperationId(response);
      const view = await waitForOperation(operationId, 8 * 60_000);
      if (view.instance.observedState !== "ready") {
        throw new ReadinessError("managed_runtime_ready_backup_did_not_resume");
      }
      const backup = view.backups.find((item) => item.operationId === operationId);
      if (!backup) throw new ReadinessError("managed_runtime_ready_backup_missing");
      return {
        details: {
          operationId,
          backupRef: backup.backupRef,
          contentDigest: backup.contentDigest,
          sizeBytes: backup.sizeBytes,
          sourceVmId: backup.sourceVmId,
          createdAt: backup.createdAt,
          stateBefore: before.instance.observedState,
          stateAfter: view.instance.observedState,
        },
        value: backup,
      };
    });

    await lifecycleOperation(run, "stop_for_stopped_backup", "stop", "stopped");

    await run.step("backup_stopped_instance", async () => {
      const response = await enqueueOperation("backup", `${runId}:backup:stopped`);
      const operationId = requiredOperationId(response);
      const view = await waitForOperation(operationId, 8 * 60_000);
      if (view.instance.observedState !== "stopped") {
        throw new ReadinessError("managed_runtime_stopped_backup_changed_state");
      }
      const backup = view.backups.find((item) => item.operationId === operationId);
      if (!backup) throw new ReadinessError("managed_runtime_stopped_backup_missing");
      return {
        details: {
          operationId,
          backupRef: backup.backupRef,
          contentDigest: backup.contentDigest,
          sizeBytes: backup.sizeBytes,
          sourceVmId: backup.sourceVmId,
          createdAt: backup.createdAt,
          stateAfter: view.instance.observedState,
        },
        value: backup,
      };
    });

    await run.step("unknown_backup_rejected", async () => {
      const backupRef = `mbk_${"f".repeat(32)}`;
      const response = await api("POST", `${basePath}/${requiredInstanceId()}/operations`, {
        action: "restore",
        backupRef,
        idempotencyKey: `${runId}:restore:unknown`,
      });
      expectStatus(response, 404, "managed_runtime_unknown_backup_not_rejected");
      const error = objectValue(response.data).error;
      if (error !== "managed_runtime_backup_not_found") {
        throw new ReadinessError("managed_runtime_unknown_backup_error_invalid");
      }
      return {
        details: { status: response.status, safeError: error, requestId: response.requestId },
        value: null,
      };
    });

    const restored = await run.step("restore_replacement_vm", async () => {
      const before = await hostVm(requiredInstanceId());
      const response = await enqueueOperation(
        "restore",
        `${runId}:restore:ready-backup`,
        readyBackup.backupRef,
      );
      const operationId = requiredOperationId(response);
      const view = await waitForOperation(operationId, 12 * 60_000);
      if (view.instance.observedState !== "stopped") {
        throw new ReadinessError("managed_runtime_restore_not_stopped");
      }
      const after = await hostVm(requiredInstanceId());
      const replaced = after.id !== before.id
        && after.generation > before.generation
        && after.replacedVmId === before.id
        && after.restoredFromBackupRef === readyBackup.backupRef
        && after.controlEndpointDigest !== before.controlEndpointDigest
        && after.jailIdDigest !== before.jailIdDigest;
      if (!replaced) throw new ReadinessError("managed_runtime_restore_replacement_invalid");
      return {
        details: {
          operationId,
          observedState: view.instance.observedState,
          backupRef: readyBackup.backupRef,
          before,
          after,
          replacementVerified: true,
        },
        value: after,
      };
    });

    await lifecycleOperation(run, "start_restored_instance", "start", "ready");

    await run.step("restored_session_continuity", async () => {
      const [session, chat] = await Promise.all([getCurrentSession(), getChat()]);
      const preserved = session.session.id === firstChat.sessionId
        && session.commands.some((item) => item.id === firstChat.commandId)
        && requiredBindingId(chat) === firstChat.bindingId
        && chat.messages.some((item) => item.id === firstChat.agentMessageId)
        && chat.messages.some(
          (item) => item.clientMessageId === firstChat.clientMessageId,
        );
      if (!preserved) throw new ReadinessError("managed_runtime_restored_history_missing");
      const sync = await syncChat(`${runId}:sync:restored`);
      const terminal = await waitForCommand(sync.id, 90_000);
      if (terminal.status !== "succeeded") {
        throw new ReadinessError("managed_runtime_restored_sdk_failed");
      }
      return {
        details: {
          sessionId: session.session.id,
          commandCount: session.commands.length,
          historyPreserved: true,
          replacementVmId: restored.id,
          syncCommandId: sync.id,
        },
        value: null,
      };
    });

    await lifecycleOperation(
      run,
      "controller_credential_rotation",
      "rotate_controller",
      "ready",
    );

    await run.step("delete_and_cleanup", async () => {
      const response = await enqueueOperation("delete", `${runId}:delete`);
      const operationId = requiredOperationId(response);
      const view = await waitForOperation(operationId, 10 * 60_000);
      if (view.instance.observedState !== "deleted") {
        throw new ReadinessError("managed_runtime_delete_not_terminal");
      }
      deleted = true;
      const [list, capacity] = await Promise.all([
        hostJson(deckCommand("list --json --limit 1")),
        hostJson(deckCommand("capacity --json")),
      ]);
      const count = numberAt(list, ["total"], "managed_runtime_host_list_invalid");
      const afterCapacity = capacityProjection(capacity);
      if (
        count !== baseline.managedVmCount
        || JSON.stringify(afterCapacity.reserved)
          !== JSON.stringify(baseline.capacity.reserved)
      ) {
        throw new ReadinessError("managed_runtime_delete_cleanup_failed");
      }
      const chatResponse = await api(
        "GET",
        `${chatBasePath}/${requiredInstanceId()}/chat`,
      );
      if (chatResponse.status < 400) {
        throw new ReadinessError("ravi_control_deleted_chat_still_available");
      }
      return {
        details: {
          instanceId: view.instance.id,
          operationId,
          observedState: view.instance.observedState,
          managedVmCount: count,
          capacityReleased: true,
          deletedChatStatus: chatResponse.status,
        },
        value: null,
      };
    });

    await run.finish("passed", null);
    process.stdout.write(`[managed-runtime-readiness] passed: ${outputPath}\n`);
  } catch (error) {
    const failureCode = safeFailureCode(error);
    await run.finish("failed", failureCode);
    process.stderr.write(`[managed-runtime-readiness] failed: ${failureCode}\n`);
    await cleanupFailedRun();
    process.exitCode = 1;
  } finally {
    await closeAuthenticatedTab();
  }
}

async function lifecycleOperation(
  run: ReadinessRun,
  name: string,
  action: "start" | "stop" | "restart" | "rotate_controller",
  expectedState: string,
) {
  return run.step(name, async () => {
    const response = await enqueueOperation(action, `${runId}:${action}:${name}`);
    const operationId = requiredOperationId(response);
    const started = Date.now();
    const view = await waitForOperation(operationId, 8 * 60_000);
    if (view.instance.observedState !== expectedState) {
      throw new ReadinessError(`managed_runtime_${action}_state_invalid`);
    }
    return {
      details: {
        action,
        operationId,
        durationMs: Date.now() - started,
        observedState: view.instance.observedState,
        desiredState: view.instance.desiredState,
      },
      value: view,
    };
  });
}

async function cleanupFailedRun() {
  if (!instanceId || deleted) return;
  try {
    const current = await getInstance();
    if (current.instance.observedState === "deleted") return;
    if (current.latestOperation && !TERMINAL_OPERATIONS.has(current.latestOperation.status)) {
      await Bun.sleep(5_000);
    }
    const response = await enqueueOperation("delete", `${runId}:cleanup:delete`);
    const operationId = requiredOperationId(response);
    await waitForOperation(operationId, 10 * 60_000);
    deleted = true;
  } catch {
    process.stderr.write("[managed-runtime-readiness] cleanup requires operator follow-up\n");
  }
}

async function openAuthenticatedTab() {
  const url = `${origin}/api/console/features#${marker}`;
  await appleScript(
    [
      "on run argv",
      "set targetUrl to item 1 of argv",
      "tell application \"Google Chrome\"",
      "if (count of windows) is 0 then make new window",
      "tell front window to make new tab at end of tabs with properties {URL:targetUrl}",
      "end tell",
      "return \"opened\"",
      "end run",
    ].join("\n"),
    [url],
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await browserScript(`JSON.stringify({url:location.href,ready:document.readyState})`);
    const parsed = JSON.parse(state) as { ready?: string; url?: string };
    if (parsed.ready === "complete") {
      if (!parsed.url?.startsWith(origin)) {
        throw new ReadinessError("managed_runtime_browser_auth_redirected");
      }
      return;
    }
    await Bun.sleep(250);
  }
  throw new ReadinessError("managed_runtime_browser_auth_timeout");
}

async function closeAuthenticatedTab() {
  try {
    await appleScript(
      [
        "on run argv",
        "set markerValue to item 1 of argv",
        "tell application \"Google Chrome\"",
        "repeat with browserWindow in windows",
        "repeat with browserTab in tabs of browserWindow",
        "if (URL of browserTab contains markerValue) then",
        "close browserTab",
        "return \"closed\"",
        "end if",
        "end repeat",
        "end repeat",
        "end tell",
        "return \"missing\"",
        "end run",
      ].join("\n"),
      [marker],
    );
  } catch {
    // The readiness result must not be replaced by best-effort tab cleanup.
  }
}

async function api(method: string, path: string, body?: unknown): Promise<BrowserResponse> {
  const code = `(() => {
    try {
      const request = new XMLHttpRequest();
      request.open(${JSON.stringify(method)}, ${JSON.stringify(path)}, false);
      request.setRequestHeader("Accept", "application/json");
      ${body === undefined ? "" : "request.setRequestHeader(\"Content-Type\", \"application/json\");"}
      request.send(${body === undefined ? "null" : JSON.stringify(JSON.stringify(body))});
      let data = null;
      try { data = request.responseText ? JSON.parse(request.responseText) : null; }
      catch { data = { error: "non_json_response" }; }
      return JSON.stringify({
        status: request.status,
        requestId: request.getResponseHeader("x-request-id"),
        data,
      });
    } catch {
      return JSON.stringify({ status: 0, requestId: null, data: { error: "browser_request_failed" } });
    }
  })()`;
  const raw = await browserScript(code);
  const parsed = JSON.parse(raw) as BrowserResponse;
  if (!Number.isInteger(parsed.status)) {
    throw new ReadinessError("managed_runtime_browser_response_invalid");
  }
  return parsed;
}

async function unauthenticatedBoundary(path: string): Promise<{
  authRedirect: boolean;
  denied: boolean;
  status: number;
}> {
  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: "application/json" },
    redirect: "manual",
  });
  const location = response.headers.get("location");
  let authRedirect = false;
  if (response.status >= 300 && response.status < 400 && location) {
    try {
      const target = new URL(location, origin);
      authRedirect = target.protocol === "https:"
        && (
          target.pathname.includes("/authorize")
          || target.pathname === "/login"
          || target.pathname === "/sign-in"
        );
    } catch {
      authRedirect = false;
    }
  }
  return {
    authRedirect,
    denied: response.status === 401 || response.status === 403 || authRedirect,
    status: response.status,
  };
}

async function browserScript(code: string): Promise<string> {
  return appleScript(
    [
      "on run argv",
      "set markerValue to item 1 of argv",
      "set sourceCode to item 2 of argv",
      "tell application \"Google Chrome\"",
      "repeat with browserWindow in windows",
      "repeat with browserTab in tabs of browserWindow",
      "if (URL of browserTab contains markerValue) then",
      "return execute browserTab javascript sourceCode",
      "end if",
      "end repeat",
      "end repeat",
      "end tell",
      "error \"managed readiness tab not found\"",
      "end run",
    ].join("\n"),
    [marker, code],
  );
}

async function appleScript(source: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["osascript", "-e", source, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    void stderr;
    throw new ReadinessError("managed_runtime_browser_automation_failed");
  }
  return stdout.trim();
}

async function hostJson(command: string): Promise<unknown> {
  const raw = await remoteCommand(command);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReadinessError("managed_runtime_host_json_invalid");
  }
}

async function hostVm(id: string): Promise<VmProjection> {
  if (!UUID.test(id)) throw new ReadinessError("managed_runtime_instance_id_invalid");
  const ref = `managed-${id}`;
  return projectVm(
    await hostJson(
      deckCommand(`show ${shellQuote(ref)} --json`),
    ),
  );
}

async function hostServices(): Promise<JsonObject> {
  const raw = await remoteCommand(
    "systemctl is-active ravi-deck-managed ravi-managed-provider-firewall ravi-managed-provider-broker ravi-managed-runtime-control",
  );
  const states = raw.split(/\s+/).filter(Boolean);
  if (states.length !== 4 || states.some((state) => state !== "active")) {
    throw new ReadinessError("managed_runtime_host_service_inactive");
  }
  return {
    deck: states[0],
    providerFirewall: states[1],
    providerBroker: states[2],
    runtimeControl: states[3],
  };
}

async function restartHostService(service: string) {
  if (!new Set(["ravi-managed-runtime-control", "ravi-deck-managed"]).has(service)) {
    throw new ReadinessError("managed_runtime_host_service_invalid");
  }
  await remoteCommand(`sudo systemctl restart ${service}`);
}

async function waitForHostService(service: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await remoteCommand(`systemctl is-active ${service}`);
      if (state.trim() === "active") return;
    } catch {
      // Retry while systemd converges.
    }
    await Bun.sleep(1_000);
  }
  throw new ReadinessError("managed_runtime_host_service_restart_timeout");
}

async function remoteCommand(command: string): Promise<string> {
  const process = Bun.spawn(["ssh", hostAlias, command], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    void stderr;
    throw new ReadinessError("managed_runtime_host_command_failed");
  }
  return stdout.trim();
}

async function localCommand(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new ReadinessError("managed_runtime_local_command_failed");
  return stdout.trim();
}

async function getInstance(): Promise<InstanceView> {
  const response = await api("GET", `${basePath}/${requiredInstanceId()}`);
  expectStatus(response, 200, "managed_runtime_instance_read_failed");
  return instanceView(response.data);
}

async function waitForInstance(
  predicate: (view: InstanceView) => boolean,
  timeoutMs: number,
): Promise<InstanceView> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    const view = await getInstance();
    lastState = `${view.instance.observedState}:${view.latestOperation?.status ?? "none"}`;
    if (predicate(view)) return view;
    await Bun.sleep(2_000);
  }
  void lastState;
  throw new ReadinessError("managed_runtime_instance_wait_timeout");
}

async function waitForOperation(operationId: string, timeoutMs: number): Promise<InstanceView> {
  return waitForInstance((view) => {
    const operation = view.latestOperation;
    if (!operation || operation.id !== operationId) return false;
    if (!TERMINAL_OPERATIONS.has(operation.status)) return false;
    if (operation.status !== "succeeded") {
      throw new ReadinessError(operation.failureCode ?? "managed_runtime_operation_failed");
    }
    return true;
  }, timeoutMs);
}

async function enqueueOperation(
  action: string,
  idempotencyKey: string,
  backupRef?: string,
): Promise<InstanceView> {
  const response = await api("POST", `${basePath}/${requiredInstanceId()}/operations`, {
    action,
    ...(backupRef ? { backupRef } : {}),
    idempotencyKey,
  });
  expectStatus(response, 202, `managed_runtime_${action}_enqueue_failed`);
  return instanceView(response.data);
}

async function getCurrentSession(): Promise<SessionView> {
  const response = await api(
    "GET",
    `${basePath}/${requiredInstanceId()}/sessions/current`,
  );
  expectStatus(response, 200, "managed_runtime_session_read_failed");
  return sessionView(response.data);
}

async function getChat(): Promise<ChatView> {
  const response = await api(
    "GET",
    `${chatBasePath}/${requiredInstanceId()}/chat`,
  );
  expectStatus(response, 200, "ravi_control_chat_read_failed");
  return chatView(response.data);
}

async function sendChatMessage(
  clientMessageId: string,
  idempotencyKey: string,
  text: string,
): Promise<ChatSubmission> {
  const response = await api(
    "POST",
    `${chatBasePath}/${requiredInstanceId()}/chat/messages`,
    { clientMessageId, idempotencyKey, text },
  );
  expectStatus(response, 202, "ravi_control_chat_message_enqueue_failed");
  return chatSubmission(response.data);
}

async function syncChat(idempotencyKey: string): Promise<ChatOperation> {
  const response = await api(
    "POST",
    `${chatBasePath}/${requiredInstanceId()}/chat/sync`,
    { idempotencyKey },
  );
  expectStatus(response, 202, "ravi_control_chat_sync_enqueue_failed");
  return chatOperation(objectValue(response.data).operation);
}

async function interruptChat(
  idempotencyKey: string,
  targetCommandId: string,
): Promise<ChatOperation> {
  const response = await api(
    "POST",
    `${chatBasePath}/${requiredInstanceId()}/chat/interrupt`,
    { idempotencyKey, targetCommandId },
  );
  expectStatus(response, 202, "ravi_control_chat_interrupt_enqueue_failed");
  return chatOperation(objectValue(response.data).operation);
}

async function waitForChatMessage(
  predicate: (message: ChatMessage) => boolean,
  timeoutMs: number,
): Promise<ChatView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chat = await getChat();
    if (chat.messages.some(predicate)) return chat;
    await Bun.sleep(1_500);
  }
  throw new ReadinessError("ravi_control_chat_message_wait_timeout");
}

async function waitForCommand(commandId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await getCurrentSession();
    const command = session.commands.find((candidate) => candidate.id === commandId);
    if (command && TERMINAL_COMMANDS.has(command.status)) return command;
    await Bun.sleep(1_500);
  }
  throw new ReadinessError("managed_runtime_command_wait_timeout");
}

async function waitForCommandActive(commandId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = await getCurrentSession();
    const command = session.commands.find((candidate) => candidate.id === commandId);
    if (command && new Set(["claimed", "running"]).has(command.status)) return;
    if (command && TERMINAL_COMMANDS.has(command.status)) {
      throw new ReadinessError("managed_runtime_long_turn_finished_before_interrupt");
    }
    await Bun.sleep(500);
  }
  throw new ReadinessError("managed_runtime_command_active_timeout");
}

async function getSessionEvents(sessionId: string, after: number) {
  if (!UUID.test(sessionId)) throw new ReadinessError("managed_runtime_session_id_invalid");
  const response = await api(
    "GET",
    `${basePath}/${requiredInstanceId()}/sessions/${sessionId}/events?after=${after}&limit=100`,
  );
  expectStatus(response, 200, "managed_runtime_session_events_failed");
  return response;
}

function instanceView(value: unknown): InstanceView {
  const root = objectValue(value);
  const instance = objectValue(root.instance);
  const latest = root.latestOperation === null ? null : objectValue(root.latestOperation);
  const backups = Array.isArray(root.backups) ? root.backups.map((item) => {
    const backup = objectValue(item);
    return {
      backupRef: stringValue(backup.backupRef, "managed_runtime_backup_ref_missing"),
      contentDigest: stringValue(backup.contentDigest, "managed_runtime_backup_digest_missing"),
      createdAt: stringValue(backup.createdAt, "managed_runtime_backup_created_at_missing"),
      operationId: stringValue(backup.operationId, "managed_runtime_backup_operation_missing"),
      sizeBytes: numberValue(backup.sizeBytes, "managed_runtime_backup_size_missing"),
      sourceVmId: stringValue(backup.sourceVmId, "managed_runtime_backup_vm_missing"),
    };
  }) : [];
  const connections = Array.isArray(root.connections) ? root.connections.map((item) => {
    const connection = objectValue(item);
    return {
      id: stringValue(connection.id, "managed_runtime_connection_id_missing"),
      kind: stringValue(connection.kind, "managed_runtime_connection_kind_missing"),
      status: stringValue(connection.status, "managed_runtime_connection_status_missing"),
    };
  }) : [];
  return {
    backups,
    connections,
    instance: {
      desiredState: stringValue(instance.desiredState, "managed_runtime_desired_state_missing"),
      displayName: stringValue(instance.displayName, "managed_runtime_display_name_missing"),
      failureCode: nullableString(instance.failureCode),
      id: stringValue(instance.id, "managed_runtime_instance_id_missing"),
      observedState: stringValue(instance.observedState, "managed_runtime_observed_state_missing"),
      provisioningPhase: nullableString(instance.provisioningPhase),
      runtimeProvider: stringValue(instance.runtimeProvider, "managed_runtime_provider_missing"),
      runtimeVersion: nullableString(instance.runtimeVersion),
    },
    latestOperation: latest ? {
      action: stringValue(latest.action, "managed_runtime_operation_action_missing"),
      failureCode: nullableString(latest.failureCode),
      id: stringValue(latest.id, "managed_runtime_operation_id_missing"),
      phase: nullableString(latest.phase),
      progressPercent: numberValue(latest.progressPercent, "managed_runtime_operation_progress_missing"),
      status: stringValue(latest.status, "managed_runtime_operation_status_missing"),
    } : null,
  };
}

function sessionView(value: unknown): SessionView {
  const root = objectValue(value);
  const session = objectValue(root.session);
  const commands = Array.isArray(root.commands) ? root.commands.map((item) => {
    const command = objectValue(item);
    return {
      action: stringValue(command.action, "managed_runtime_command_action_missing"),
      failureCode: nullableString(command.failureCode),
      id: stringValue(command.id, "managed_runtime_command_id_missing"),
      phase: stringValue(command.phase, "managed_runtime_command_phase_missing"),
      result: command.result ?? null,
      status: stringValue(command.status, "managed_runtime_command_status_missing"),
    };
  }) : [];
  return {
    commands,
    latestEventSequence: numberValue(
      root.latestEventSequence,
      "managed_runtime_latest_event_sequence_missing",
    ),
    session: {
      id: stringValue(session.id, "managed_runtime_session_id_missing"),
      instanceId: stringValue(session.instanceId, "managed_runtime_session_instance_missing"),
      status: stringValue(session.status, "managed_runtime_session_status_missing"),
    },
  };
}

function chatView(value: unknown): ChatView {
  const root = objectValue(value);
  const binding = root.binding === null ? null : objectValue(root.binding);
  const messages = Array.isArray(root.messages)
    ? root.messages.map(chatMessage)
    : [];
  return {
    binding: binding
      ? {
          id: stringValue(binding.id, "ravi_control_binding_id_missing"),
          status: stringValue(
            binding.status,
            "ravi_control_binding_status_missing",
          ),
          targetAgentId: stringValue(
            binding.targetAgentId,
            "ravi_control_binding_agent_missing",
          ),
        }
      : null,
    messages,
  };
}

function chatMessage(value: unknown): ChatMessage {
  const message = objectValue(value);
  return {
    actorId: nullableString(message.actorId),
    actorType: stringValue(message.actorType, "ravi_control_message_actor_missing"),
    clientMessageId: stringValue(
      message.clientMessageId,
      "ravi_control_message_client_id_missing",
    ),
    content: objectValue(message.content),
    createdAt: stringValue(
      message.createdAt,
      "ravi_control_message_created_at_missing",
    ),
    failureCode: nullableString(message.failureCode),
    id: stringValue(message.id, "ravi_control_message_id_missing"),
    operationId: nullableString(message.operationId),
    status: stringValue(message.status, "ravi_control_message_status_missing"),
  };
}

function chatOperation(value: unknown): ChatOperation {
  const operation = objectValue(value);
  return {
    failureCode: nullableString(operation.failureCode),
    id: stringValue(operation.id, "ravi_control_operation_id_missing"),
    status: stringValue(operation.status, "ravi_control_operation_status_missing"),
  };
}

function chatSubmission(value: unknown): ChatSubmission {
  const root = objectValue(value);
  if (typeof root.duplicate !== "boolean") {
    throw new ReadinessError("ravi_control_duplicate_flag_missing");
  }
  return {
    duplicate: root.duplicate,
    message: chatMessage(root.message),
    operation: chatOperation(root.operation),
  };
}

function requiredBindingId(chat: ChatView): string {
  const id = chat.binding?.id;
  if (!id || !UUID.test(id)) {
    throw new ReadinessError("ravi_control_binding_id_missing");
  }
  return id;
}

function contentText(content: JsonObject): string | null {
  return typeof content.text === "string" ? content.text : null;
}

function requiredOperationId(view: InstanceView): string {
  const id = view.latestOperation?.id;
  if (!id) throw new ReadinessError("managed_runtime_operation_id_missing");
  return id;
}

function requiredInstanceId(): string {
  if (!instanceId || !UUID.test(instanceId)) {
    throw new ReadinessError("managed_runtime_instance_id_missing");
  }
  return instanceId;
}

function assertReady(view: InstanceView) {
  if (view.instance.observedState !== "ready" || !connectionOnline(view)) {
    throw new ReadinessError("managed_runtime_sdk_not_ready");
  }
}

function connectionOnline(view: InstanceView): boolean {
  return view.connections.some(
    (connection) => connection.kind === "private_ravi_sdk" && connection.status === "online",
  );
}

function expectStatus(response: BrowserResponse, status: number, code: string) {
  if (response.status === status) return;
  const body = objectValue(response.data);
  const error = typeof body.error === "string" && /^[a-z0-9._-]+$/.test(body.error)
    ? body.error
    : code;
  throw new ReadinessError(error);
}

function containsText(value: unknown, expected: string): boolean {
  try {
    return JSON.stringify(value).includes(expected);
  } catch {
    return false;
  }
}

function eventCount(value: unknown): number {
  const items = objectValue(value).items;
  return Array.isArray(items) ? items.length : 0;
}

function uniqueEventTypes(value: unknown): string[] {
  const items = objectValue(value).items;
  if (!Array.isArray(items)) return [];
  return [...new Set(items.flatMap((item) => {
    const eventType = objectValue(item).eventType;
    return typeof eventType === "string" && /^[A-Za-z0-9._:-]+$/.test(eventType)
      ? [eventType]
      : [];
  }))].sort();
}

function safeFacts(value: unknown): JsonObject {
  const facts = objectValue(value);
  return Object.fromEntries(
    Object.entries(facts).filter(([, item]) => typeof item === "boolean" || item === null),
  );
}

function capacityProjection(value: unknown) {
  const envelope = objectValue(value);
  const root = objectValue(envelope.capacity ?? envelope);
  return {
    configured: Boolean(root.configured),
    total: resourceProjection(root.total),
    reserved: resourceProjection(root.reserved),
    available: resourceProjection(root.available),
    quarantined: resourceProjection(root.quarantined),
  };
}

function resourceProjection(value: unknown) {
  const resource = objectValue(value);
  return {
    vcpu: numberValue(resource.vcpu, "managed_runtime_capacity_vcpu_missing"),
    memoryMib: numberValue(resource.memoryMib, "managed_runtime_capacity_memory_missing"),
    diskMib: numberValue(resource.diskMib, "managed_runtime_capacity_disk_missing"),
  };
}

function numberAt(value: unknown, path: string[], code: string): number {
  let current: unknown = value;
  for (const segment of path) current = objectValue(current)[segment];
  return numberValue(current, code);
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ReadinessError(code);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ReadinessError(code);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function deckCommand(command: string): string {
  const script = [
    "set -a",
    ". /etc/ravi-deck-managed/deck.env",
    "set +a",
    `exec /usr/local/bin/ravi-deck-managed managed ${command}`,
  ].join("; ");
  return `sudo bash -lc ${shellQuote(script)}`;
}

function validateConfiguration() {
  if (!origin.startsWith("https://") || !SAFE_REF.test(projectRef) || !SAFE_REF.test(hostAlias)) {
    throw new ReadinessError("managed_runtime_readiness_configuration_invalid");
  }
}

if (import.meta.main) await main();
