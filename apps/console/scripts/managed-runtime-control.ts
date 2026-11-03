import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;

type ProviderBrokerRegistryEntry = {
  guestIp: string;
  instanceId: string;
  status: "active" | "revoked";
  updatedAt: string;
  vmId: string;
};

type ProviderBrokerRegistry = {
  entries: ProviderBrokerRegistryEntry[];
  schemaVersion: "ravi.managed-provider-broker.registry/v1";
  updatedAt: string;
};

type ManagedAction =
  | "backup"
  | "create"
  | "delete"
  | "restart"
  | "restore"
  | "retry"
  | "rotate_controller"
  | "start"
  | "stop";

type ManagedOperation = {
  action: ManagedAction;
  attemptCount: number;
  claimExpiresAt: string | null;
  id: string;
  instance: {
    desiredState: "deleted" | "running" | "stopped";
    displayName: string;
    hostId: string | null;
    imageId: string | null;
    observedState: string;
    placementClass: string;
    runtimeModel: string | null;
    runtimeProvider: string;
  };
  instanceId: string;
  organizationId: string;
  projectId: string | null;
  safeInput: JsonRecord;
};

type ManagedCommandAction =
  | "chat_message_create"
  | "chat_sync"
  | "prompt_send"
  | "session_sync"
  | "turn_interrupt";

export type ManagedCommand = {
  action: ManagedCommandAction;
  attemptCount: number;
  claimExpiresAt: string | null;
  id: string;
  input: JsonRecord;
  instanceId: string;
  organizationId: string;
  projectId: string | null;
  sessionId: string;
  sessionKey: string;
  status: string;
};

type ManagedRaviSseEvent = {
  data: unknown;
  event: string;
  id?: string;
};

type ManagedSessionTerminal =
  | { kind: "completed" }
  | { kind: "failed" }
  | { kind: "interrupted" }
  | { kind: "stream_ended" }
  | { kind: "stream_failed" };

type ManagedVm = {
  controlEndpoint: string;
  facts: {
    gatewayHealthy: boolean;
  } & JsonRecord;
  failureCode: string | null;
  generation: number;
  id: string;
  instanceRef: string;
  operationRef: string;
  quarantinedReason: string | null;
  replacedVmId: string | null;
  restoredFromBackupRef: string | null;
  state: string;
};

type ManagedBackup = {
  backupRef: string;
  contentDigest: string;
  createdAt: string;
  imageDigest: string;
  instanceRef: string;
  sizeBytes: number;
  sourceVmId: string;
  stateDiskMib: number;
};

type ControllerCredential = {
  contextId: string;
  contextKey: string;
  expiresAt: string | null;
  instanceId: string;
  schemaVersion: "ravi.managed-appliance.controller-credential/v1";
};

type PendingControllerClaim = {
  bootstrapExpiresAt: string;
  claimToken: string;
  instanceId: string;
  operationId: string;
  schemaVersion: "ravi.managed-runtime.pending-controller-claim/v1";
  vmId: string;
};

type ControllerRotationGrant = {
  credentialClaimToken: string;
  expiresAt: string;
  grantId: string;
  payloadBase64: string;
  signatureBase64: string;
};

type PendingControllerRotation = {
  deckInstanceRef: string;
  grant: ControllerRotationGrant | null;
  instanceId: string;
  operationId: string;
  previousContextId: string | null;
  replacement: ControllerCredential | null;
  replacementContextId: string | null;
  schemaVersion: "ravi.managed-runtime.pending-controller-rotation/v1";
  stage:
    | "credential_claimed"
    | "credential_persisted"
    | "grant_issued"
    | "guest_acknowledged"
    | "guest_prepared";
  vmId: string;
};

type RuntimeImage = {
  id: string;
  metadata: JsonRecord;
  name: string;
  os: string;
  raviVersion: string;
  status: string;
};

export type ManagedRuntimeControlConfig = {
  claimOwner: string;
  claimTtlSeconds: number;
  consoleControlToken: string;
  consoleUrl: string;
  credentialRoot: string;
  deckContextKey: string;
  deckGatewayUrl: string;
  deckSdkPath: string;
  environment: "development" | "preview" | "production";
  hostName: string;
  hostProvider: string;
  imageName: string;
  pollIntervalMs: number;
  providerBrokerRegistryPath: string;
  raviSdkPath: string;
  region: string | null;
  stateRoot: string;
  vercelBypassSecret: string | null;
  waitReadySeconds: number;
};

export type RuntimeControlConsoleApi = {
  claimCommand(input: {
    claimOwner: string;
    claimTtlSeconds: number;
    hostId: string;
  }): Promise<ManagedCommand | null>;
  claimOperation(input: {
    claimOwner: string;
    claimTtlSeconds: number;
    hostId: string;
    imageId: string;
  }): Promise<ManagedOperation | null>;
  heartbeatHost(input: JsonRecord): Promise<void>;
  issueBootstrap(input: {
    claimOwner: string;
    deckInstanceRef: string;
    operationId: string;
    providerBrokerBaseUrl: string;
    vmId: string;
  }): Promise<{
    bootstrap: {
      credentialClaimToken: string;
      expiresAt: string;
      payloadBase64: string;
      signatureBase64: string;
    };
  }>;
  issueControllerRotation(input: {
    claimOwner: string;
    currentContextId: string;
    deckInstanceRef: string;
    operationId: string;
    vmId: string;
  }): Promise<{ rotation: ControllerRotationGrant }>;
  registerHost(input: JsonRecord): Promise<{ id: string }>;
  registerImage(input: JsonRecord): Promise<{ id: string }>;
  reportCommand(input: JsonRecord): Promise<void>;
  reportOperation(input: JsonRecord): Promise<void>;
};

export type RuntimeControlDeckApi = {
  backup(
    ref: string,
    backupRef: string,
    operationRef: string,
  ): Promise<{ backup: ManagedBackup; vm: ManagedVm }>;
  create(input: {
    image: string;
    instanceRef: string;
    memoryMib: string;
    name: string;
    networkPolicy: string;
    operationRef: string;
    stateDiskMib: string;
    vcpu: string;
  }): Promise<ManagedVm>;
  destroy(ref: string, operationRef: string): Promise<ManagedVm>;
  image(ref: string): Promise<RuntimeImage>;
  inspect(ref: string): Promise<ManagedVm>;
  prepare(input: {
    bootstrapPayload: string;
    bootstrapSignature: string;
    operationRef: string;
    ref: string;
  }): Promise<ManagedVm>;
  restart(ref: string, operationRef: string, waitReadySeconds: number): Promise<ManagedVm>;
  restore(ref: string, backupRef: string, operationRef: string): Promise<ManagedVm>;
  start(ref: string, operationRef: string, waitReadySeconds: number): Promise<ManagedVm>;
  stop(ref: string, operationRef: string): Promise<ManagedVm>;
};

export type ManagedRaviClient = {
  chats: {
    ensure(
      installationId: string,
      actorId: string,
      agentId: string,
      options?: { actorName?: string; title?: string },
    ): Promise<CanonicalChatEnsure>;
    messages: {
      create(
        chatId: string,
        actorId: string,
        clientMessageId: string,
        text: string,
        options?: { replyToMessageId?: string },
      ): Promise<CanonicalMessageAccepted>;
    };
    read(
      chatId: string,
      options?: { limit?: string; offset?: string; order?: string },
    ): Promise<CanonicalChatHistory>;
  };
  context: {
    remoteControl: {
      issue(
        profile: "chat-ensure" | "chat-turn" | "turn-interrupt",
        organizationId: string,
        installationId: string,
        actorId: string,
        agentId: string,
        operationId: string,
        options?: {
          chatId?: string;
          sessionKey?: string;
          sessionName?: string;
          ttlSeconds?: string;
        },
      ): Promise<{ contextId: string; contextKey: string; expiresAt: number | null }>;
    };
  };
  self: {
    whoami(): Promise<JsonRecord>;
  };
  sessions: {
    list(options?: { limit?: string; live?: boolean }): Promise<{
      items?: unknown[];
      total?: number;
    }>;
    read(
      nameOrKey?: string,
      options?: { count?: string; messageId?: string; workspace?: boolean },
    ): Promise<JsonRecord>;
    runtime: {
      interrupt(
        session: string,
        options?: { thread?: string; turn?: string },
      ): Promise<JsonRecord>;
    };
  };
};

export type ManagedRaviStreamClient = {
  chat(
    chatId: string,
    options?: { cursor?: string; signal?: AbortSignal; timeout?: number },
  ): AsyncIterable<ManagedRaviSseEvent>;
  session(
    name: string,
    options?: { signal?: AbortSignal; timeout?: number },
  ): AsyncIterable<ManagedRaviSseEvent>;
};

type CanonicalChatEnsure = {
  actor: {
    id: string;
    platformIdentityId: string;
  };
  binding: {
    agentId: string;
    chatId: string;
    sessionKey: string;
  };
  chat: { id: string };
  session: {
    agentId: string;
    sessionKey: string;
    sessionName: string;
  };
};

type CanonicalMessageAccepted = {
  dispatch: { status: string };
  duplicate: boolean;
  message: { id: string };
  session: { sessionKey: string };
};

type CanonicalChatHistory = {
  messages: Array<{
    actorType: string;
    agentId?: string;
    content?: JsonRecord;
    createdAt: number;
    id: string;
    messageType?: string;
    platformIdentityId?: string;
    sortKey: string;
  }>;
};

type CanonicalCommandPrincipal = {
  actorId: string;
  agentId: string;
  chatId: string;
  installationId: string;
  localActorId: string;
  localPlatformIdentityId: string;
  operationId: string;
  organizationId: string;
  sessionKey: string;
  sessionName: string;
};

export type ManagedRaviClientFactory = {
  create(baseUrl: string, contextKey: string): ManagedRaviClient;
  createStream(baseUrl: string, contextKey: string): ManagedRaviStreamClient;
  protocolVersion: string;
};

type RuntimeControlDependencies = {
  console: RuntimeControlConsoleApi;
  deck: RuntimeControlDeckApi;
  fetchImpl?: typeof fetch;
  historyReadTimeoutMs?: number;
  now?: () => Date;
  operationHeartbeatMs?: number;
  ravi: ManagedRaviClientFactory;
  sleep?: (milliseconds: number) => Promise<void>;
};

type RuntimePlacement = {
  hostId: string;
  imageId: string;
  image: RuntimeImage;
};

const ACTIONS: ManagedAction[] = [
  "create",
  "start",
  "stop",
  "restart",
  "retry",
  "delete",
  "backup",
  "restore",
  "rotate_controller",
];
const SAFE_CODE = /^[a-z][a-z0-9._-]{1,119}$/;
const UUID_FRAGMENT = /[^a-zA-Z0-9_-]/g;
const RAVI_SDK_REQUEST_TIMEOUT_MS = 20_000;
const RAVI_SDK_MAX_RESPONSE_BYTES = 512 * 1024;
const MANAGED_HISTORY_READ_COUNT = "25";
const MANAGED_HISTORY_READ_TIMEOUT_MS = RAVI_SDK_REQUEST_TIMEOUT_MS + 2_000;
const INTERRUPT_ABORT_REASON = Symbol("managed_runtime_prompt_interrupted");

export class ManagedRuntimeControl {
  private readonly activeCommands = new Map<
    string,
    { abort: AbortController; command: ManagedCommand; promise: Promise<void> }
  >();
  private placement: RuntimePlacement | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly historyReadTimeoutMs: number;
  private readonly now: () => Date;
  private readonly operationHeartbeatMs: number;
  private readonly operationReportQueues = new Map<string, Promise<void>>();
  private readonly runningOperationReports = new Map<string, JsonRecord>();
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly config: ManagedRuntimeControlConfig,
    private readonly dependencies: RuntimeControlDependencies,
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.historyReadTimeoutMs = Math.max(
      1,
      dependencies.historyReadTimeoutMs ?? MANAGED_HISTORY_READ_TIMEOUT_MS,
    );
    this.now = dependencies.now ?? (() => new Date());
    const heartbeatCeiling = Math.max(
      1_000,
      Math.floor(this.config.claimTtlSeconds * 1_000 * 0.4),
    );
    this.operationHeartbeatMs = Math.max(
      1,
      Math.min(
        dependencies.operationHeartbeatMs ?? heartbeatCeiling,
        heartbeatCeiling,
      ),
    );
    this.sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  async initialize(): Promise<RuntimePlacement> {
    await ensureRuntimeStateDirectory(this.config.stateRoot);
    await ensurePrivateDirectory(this.config.credentialRoot);
    const image = await this.dependencies.deck.image(this.config.imageName);
    if (image.status !== "ready") throw runtimeFailure("managed_image_not_ready");
    const imageDigest = requiredMetadataString(image.metadata, "imageDigest");
    const rootfsSha256 = requiredMetadataString(image.metadata, "rootfsSha256");
    const kernelSha256 = requiredMetadataString(image.metadata, "kernelSha256");
    const host = await this.dependencies.console.registerHost({
      capacity: { driver: "firecracker" },
      displayName: this.config.hostName,
      environment: this.config.environment,
      health: { managedRuntimeControl: true },
      hostname: this.config.hostName,
      placementClasses: ["managed-ravi", "firecracker", "codex", "shared-small"],
      provider: this.config.hostProvider,
      region: this.config.region,
      status: "active",
    });
    const registeredImage = await this.dependencies.console.registerImage({
      architecture: os.arch() === "x64" ? "x86_64" : os.arch(),
      baseOs: image.os,
      digest: imageDigest,
      kernelRef: `deck:${image.id}:kernel:${kernelSha256}`,
      name: image.name,
      providerSupport: {
        codex: true,
        initialAgentId: "managed-ravi",
        managedAppliance: true,
      },
      rootfsRef: `deck:${image.id}:rootfs:${rootfsSha256}`,
      status: "active",
      version: runtimeImageVersion(image.raviVersion, imageDigest),
    });
    this.placement = { hostId: host.id, image, imageId: registeredImage.id };
    await this.heartbeat();
    return this.placement;
  }

  async runOnce(): Promise<
    | { action: ManagedAction; claimed: true; operationId: string }
    | { action: null; claimed: false; operationId: null }
    | { action: null; claimed: true; commandId: string; operationId: null }
  > {
    const placement = this.placement ?? await this.initialize();
    await this.heartbeat();
    const operation = await this.dependencies.console.claimOperation({
      claimOwner: this.config.claimOwner,
      claimTtlSeconds: this.config.claimTtlSeconds,
      hostId: placement.hostId,
      imageId: placement.imageId,
    });
    if (!operation) {
      const command = await this.dependencies.console.claimCommand({
        claimOwner: this.config.claimOwner,
        claimTtlSeconds: this.config.claimTtlSeconds,
        hostId: placement.hostId,
      });
      if (!command) {
        return { action: null, claimed: false, operationId: null };
      }
      this.launchCommand(command);
      return {
        action: null,
        claimed: true,
        commandId: command.id,
        operationId: null,
      };
    }

    const stopOperationHeartbeat = this.startOperationHeartbeat(operation.id);
    try {
      await this.processOperation(operation);
    } catch (error) {
      const code = safeFailureCode(error);
      safeLog("managed_runtime_operation_failed", {
        action: operation.action,
        code,
        operationId: operation.id,
      });
      await this.reportOperation({
        claimOwner: this.config.claimOwner,
        failureCode: code,
        observedState: failedObservedState(operation.action),
        operationId: operation.id,
        phase: "failed",
        progressPercent: 100,
        provisioningPhase: "failed",
        safeResult: { retryable: retryableFailure(code) },
        status: "failed",
      });
    } finally {
      stopOperationHeartbeat();
      this.runningOperationReports.delete(operation.id);
    }
    return { action: operation.action, claimed: true, operationId: operation.id };
  }

  async serve(signal?: AbortSignal): Promise<void> {
    this.placement ??= await this.initialize();
    while (!signal?.aborted) {
      try {
        const result = await this.runOnce();
        safeLog("managed_runtime_control_tick", result);
      } catch (error) {
        safeLog("managed_runtime_control_error", { code: safeFailureCode(error) });
      }
      if (!signal?.aborted) await this.sleep(this.config.pollIntervalMs);
    }
    for (const active of this.activeCommands.values()) active.abort.abort();
    await this.waitForActiveCommands();
  }

  async waitForActiveCommands(): Promise<void> {
    await Promise.allSettled(
      [...this.activeCommands.values()].map((active) => active.promise),
    );
  }

  private launchCommand(command: ManagedCommand): void {
    const abort = new AbortController();
    const promise = this.processCommand(command, abort.signal)
      .catch(async (error) => {
        const interrupted =
          new Set<ManagedCommandAction>([
            "chat_message_create",
            "prompt_send",
          ]).has(command.action) &&
          abort.signal.reason === INTERRUPT_ABORT_REASON;
        const failureCode = interrupted ? null : safeFailureCode(error);
        try {
          await this.dependencies.console.reportCommand({
            claimOwner: this.config.claimOwner,
            commandId: command.id,
            events: [],
            failureCode,
            phase: interrupted ? "interrupted" : "failed",
            safeResult: interrupted
              ? { interrupted: true, retryable: false }
              : { retryable: command.action !== "prompt_send" },
            status: interrupted ? "cancelled" : "failed",
          });
        } catch (reportError) {
          safeLog("managed_runtime_command_report_failed", {
            code: safeFailureCode(reportError),
            commandId: command.id,
          });
        }
      })
      .finally(() => {
        this.activeCommands.delete(command.id);
      });
    this.activeCommands.set(command.id, { abort, command, promise });
  }

  private async processCommand(
    command: ManagedCommand,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      ![
        "chat_message_create",
        "chat_sync",
        "prompt_send",
        "session_sync",
        "turn_interrupt",
      ].includes(
        command.action,
      )
    ) {
      throw runtimeFailure("managed_command_action_unsupported");
    }
    if (command.action === "prompt_send") {
      throw runtimeFailure("managed_runtime_legacy_prompt_unsupported");
    }
    const canonicalAction =
      command.action === "chat_message_create" ||
      command.action === "chat_sync" ||
      command.input.schemaVersion === "ravi.control.command/v1";
    const inputSessionKey = optionalCommandString(command.input, "sessionKey");
    if (!canonicalAction && inputSessionKey !== command.sessionKey) {
      throw runtimeFailure("managed_command_session_binding_invalid");
    }
    if (canonicalAction) assertCanonicalCommandBinding(command);
    const credential = await this.requireCredential(command.instanceId);
    const vm = await this.dependencies.deck.inspect(
      instanceRefFor(command.instanceId),
    );
    assertVmRunning(vm);
    const client = this.dependencies.ravi.create(
      vm.controlEndpoint,
      credential.contextKey,
    );
    const report = serializedCommandReporter(
      this.dependencies.console,
      this.config.claimOwner,
      command.id,
    );
    let eventCount = 0;
    const heartbeat = setInterval(() => {
      if (signal.aborted) return;
      void report({
        events: [],
        phase: "executing",
        safeResult: { eventCount },
        status: "running",
      }).catch((error) => {
        safeLog("managed_runtime_command_heartbeat_failed", {
          code: safeFailureCode(error),
          commandId: command.id,
        });
      });
    }, Math.max(5_000, Math.floor(this.config.claimTtlSeconds * 400)));

    try {
      await report({
        events: [],
        phase: "connecting",
        safeResult: { eventCount },
        status: "running",
      });

      if (canonicalAction) {
        await this.processCanonicalChatCommand({
          command,
          parentClient: client,
          report,
          signal,
          vm,
          eventCount: () => eventCount,
          incrementEventCount: () => {
            eventCount += 1;
            return eventCount;
          },
        });
        return;
      }

      if (command.action === "session_sync") {
        const history = await readBoundedHistory(
          client,
          command.sessionKey,
          this.historyReadTimeoutMs,
          signal,
        );
        await report({
          events: [],
          phase: "completed",
          result: { history },
          safeResult: {
            eventCount,
            historyCount: historyMessageCount(history),
            outputBytes: jsonBytes(history),
          },
          status: "succeeded",
        });
        return;
      }

      if (command.action === "turn_interrupt") {
        const targetCommandId = requiredCommandString(
          command.input,
          "targetCommandId",
        );
        const interrupted = await client.sessions.runtime.interrupt(
          command.sessionKey,
        );
        if (interrupted.ok === false) {
          throw runtimeFailure("managed_runtime_interrupt_rejected");
        }
        this.abortBoundPrompt(command, targetCommandId);
        const history = await readBoundedHistory(
          client,
          command.sessionKey,
          this.historyReadTimeoutMs,
          signal,
        );
        await report({
          events: [],
          phase: "completed",
          result: {
            history,
            interrupt: safeOperationProjection(interrupted),
          },
          safeResult: {
            eventCount,
            historyCount: historyMessageCount(history),
            outputBytes: jsonBytes(history),
          },
          status: "succeeded",
        });
        return;
      }
      throw runtimeFailure("managed_runtime_legacy_prompt_unsupported");
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async processCanonicalChatCommand(input: {
    command: ManagedCommand;
    eventCount: () => number;
    incrementEventCount: () => number;
    parentClient: ManagedRaviClient;
    report: (input: CommandReport) => Promise<void>;
    signal: AbortSignal;
    vm: ManagedVm;
  }): Promise<void> {
    const requestedPrincipal = canonicalCommandPrincipal(input.command);
    const ensureLease = await input.parentClient.context.remoteControl.issue(
      "chat-ensure",
      requestedPrincipal.organizationId,
      requestedPrincipal.installationId,
      requestedPrincipal.actorId,
      requestedPrincipal.agentId,
      input.command.id,
      { ttlSeconds: "120" },
    );
    const ensureClient = this.dependencies.ravi.create(
      input.vm.controlEndpoint,
      ensureLease.contextKey,
    );
    const ensured = await ensureClient.chats.ensure(
      requestedPrincipal.installationId,
      requestedPrincipal.actorId,
      requestedPrincipal.agentId,
      {
        actorName:
          optionalCommandString(input.command.input, "actorName") ?? undefined,
        title: "Ravi Control",
      },
    );
    if (
      (requestedPrincipal.chatId &&
        requestedPrincipal.chatId !== ensured.chat.id) ||
      (requestedPrincipal.sessionKey &&
        requestedPrincipal.sessionKey !== ensured.session.sessionKey)
    ) {
      throw runtimeFailure("ravi_control_chat_binding_invalid");
    }
    const principal: CanonicalCommandPrincipal = {
      ...requestedPrincipal,
      localActorId: ensured.actor.id,
      localPlatformIdentityId: ensured.actor.platformIdentityId,
      chatId: ensured.chat.id,
      sessionKey: ensured.session.sessionKey,
      sessionName: ensured.session.sessionName,
    };
    if (input.command.action === "chat_sync") {
      const scoped = await this.scopedRaviClient(
        input.parentClient,
        input.vm.controlEndpoint,
        "chat-turn",
        principal,
      );
      const history = await scoped.client.chats.read(principal.chatId, {
        limit: "200",
        order: "asc",
      });
      await input.report({
        events: [],
        phase: "completed",
        result: canonicalCommandResult(principal, history),
        safeResult: {
          eventCount: input.eventCount(),
          historyCount: history.messages.length,
          outputBytes: jsonBytes(history),
        },
        status: "succeeded",
      });
      return;
    }

    if (input.command.action === "turn_interrupt") {
      const targetCommandId = requiredCommandString(
        input.command.input,
        "targetCommandId",
      );
      const scoped = await this.scopedRaviClient(
        input.parentClient,
        input.vm.controlEndpoint,
        "turn-interrupt",
        principal,
      );
      const interrupted = await scoped.client.sessions.runtime.interrupt(
        principal.sessionKey,
      );
      if (interrupted.ok === false) {
        throw runtimeFailure("managed_runtime_interrupt_rejected");
      }
      this.abortBoundPrompt(input.command, targetCommandId);
      const history = await scoped.client.chats.read(principal.chatId, {
        limit: "200",
        order: "asc",
      });
      await input.report({
        events: [],
        phase: "completed",
        result: canonicalCommandResult(principal, history),
        safeResult: {
          eventCount: input.eventCount(),
          historyCount: history.messages.length,
          outputBytes: jsonBytes(history),
        },
        status: "succeeded",
      });
      return;
    }

    if (input.command.action !== "chat_message_create") {
      throw runtimeFailure("managed_command_action_unsupported");
    }
    const turn = await this.scopedRaviClient(
      input.parentClient,
      input.vm.controlEndpoint,
      "chat-turn",
      principal,
    );
    const streamAbort = new AbortController();
    const abortStreams = () => streamAbort.abort();
    input.signal.addEventListener("abort", abortStreams, { once: true });
    if (input.signal.aborted) streamAbort.abort();

    let sessionStreamAvailable = true;
    let chatStreamAvailable = true;
    let settleTerminal: (terminal: ManagedSessionTerminal) => void = () => undefined;
    const terminal = new Promise<ManagedSessionTerminal>((resolve) => {
      settleTerminal = resolve;
    });
    const stream = this.dependencies.ravi.createStream(
      input.vm.controlEndpoint,
      turn.contextKey,
    );
    const sessionIterator = stream
      .session(principal.sessionName, {
        signal: streamAbort.signal,
        timeout: 0,
      })
      [Symbol.asyncIterator]();
    const chatIterator = stream
      .chat(principal.chatId, {
        signal: streamAbort.signal,
        timeout: 0,
      })
      [Symbol.asyncIterator]();
    const firstSessionEvent = sessionIterator.next();
    const firstChatEvent = chatIterator.next();

    const consumeSession = (async () => {
      let next = await firstSessionEvent;
      while (!next.done) {
        const eventIndex = input.incrementEventCount();
        await input.report({
          events: [
            managedSessionEvent(
              input.command,
              next.value,
              eventIndex,
              this.now(),
            ),
          ],
          phase: "streaming",
          safeResult: { eventCount: input.eventCount() },
          status: "running",
        });
        const terminalState = managedSessionTerminal(next.value);
        if (terminalState) {
          settleTerminal(terminalState);
          break;
        }
        next = await sessionIterator.next();
      }
      if (next.done) settleTerminal({ kind: "stream_ended" });
    })().catch((error) => {
      if (!streamAbort.signal.aborted) {
        sessionStreamAvailable = false;
        safeLog("managed_runtime_session_stream_failed", {
          code: safeFailureCode(error),
          commandId: input.command.id,
        });
        settleTerminal({ kind: "stream_failed" });
      }
    });

    const consumeChat = (async () => {
      let next = await firstChatEvent;
      while (!next.done) {
        const eventIndex = input.incrementEventCount();
        await input.report({
          events: [
            managedSessionEvent(
              input.command,
              {
                ...next.value,
                id: `chat:${next.value.id ?? eventIndex}`,
              },
              eventIndex,
              this.now(),
            ),
          ],
          phase: "streaming",
          safeResult: { eventCount: input.eventCount() },
          status: "running",
        });
        next = await chatIterator.next();
      }
    })().catch((error) => {
      if (!streamAbort.signal.aborted) {
        chatStreamAvailable = false;
        safeLog("managed_runtime_chat_stream_failed", {
          code: safeFailureCode(error),
          commandId: input.command.id,
        });
      }
    });

    try {
      await this.sleep(25);
      await input.report({
        events: [],
        phase: "submitting",
        safeResult: {
          chatStreamAvailable,
          eventCount: input.eventCount(),
          sessionStreamAvailable,
        },
        status: "running",
      });
      const accepted = await turn.client.chats.messages.create(
        principal.chatId,
        principal.actorId,
        requiredCommandString(input.command.input, "clientMessageId"),
        requiredCommandString(input.command.input, "text"),
        {
          replyToMessageId:
            optionalCommandString(input.command.input, "replyToMessageId") ??
            undefined,
        },
      );
      const terminalState = await waitForManagedSessionTerminal(
        terminal,
        input.signal,
      );
      if (terminalState.kind === "failed") {
        throw runtimeFailure("managed_runtime_turn_failed");
      }
      if (terminalState.kind === "stream_failed") {
        throw runtimeFailure("managed_runtime_session_stream_failed");
      }
      if (terminalState.kind === "stream_ended") {
        throw runtimeFailure("managed_runtime_session_stream_ended");
      }
      const historyReader = await this.scopedRaviClient(
        input.parentClient,
        input.vm.controlEndpoint,
        "chat-turn",
        principal,
      );
      const history = await historyReader.client.chats.read(principal.chatId, {
        limit: "200",
        order: "asc",
      });
      await input.report({
        events: [],
        phase:
          terminalState.kind === "interrupted" ? "interrupted" : "completed",
        result: canonicalCommandResult(principal, history, accepted),
        safeResult: {
          chatStreamAvailable,
          eventCount: input.eventCount(),
          historyCount: history.messages.length,
          outputBytes: jsonBytes(history),
          sessionStreamAvailable,
        },
        status:
          terminalState.kind === "interrupted" ? "cancelled" : "succeeded",
      });
    } finally {
      streamAbort.abort();
      await Promise.allSettled([consumeSession, consumeChat]);
      input.signal.removeEventListener("abort", abortStreams);
    }
  }

  private async scopedRaviClient(
    parentClient: ManagedRaviClient,
    controlEndpoint: string,
    profile: "chat-turn" | "turn-interrupt",
    principal: CanonicalCommandPrincipal,
  ) {
    const lease = await parentClient.context.remoteControl.issue(
      profile,
      principal.organizationId,
      principal.installationId,
      principal.actorId,
      principal.agentId,
      principal.operationId,
      {
        chatId: principal.chatId,
        sessionKey: principal.sessionKey,
        sessionName: principal.sessionName,
        ttlSeconds: "300",
      },
    );
    return {
      client: this.dependencies.ravi.create(controlEndpoint, lease.contextKey),
      contextKey: lease.contextKey,
    };
  }

  private abortBoundPrompt(
    interruptCommand: ManagedCommand,
    targetCommandId: string,
  ): void {
    const target = this.activeCommands.get(targetCommandId);
    if (
      !target ||
      !new Set<ManagedCommandAction>([
        "chat_message_create",
        "prompt_send",
      ]).has(target.command.action) ||
      target.command.instanceId !== interruptCommand.instanceId ||
      target.command.sessionId !== interruptCommand.sessionId
    ) {
      return;
    }
    target.abort.abort(INTERRUPT_ABORT_REASON);
  }

  private async heartbeat() {
    if (!this.placement) return;
    await this.dependencies.console.heartbeatHost({
      capacity: { driver: "firecracker" },
      health: {
        imageId: this.placement.image.id,
        managedRuntimeControl: true,
        observedAt: this.now().toISOString(),
      },
      hostId: this.placement.hostId,
      placementClasses: ["managed-ravi", "firecracker", "codex", "shared-small"],
      status: "active",
    });
  }

  private startOperationHeartbeat(operationId: string): () => void {
    const timer = setInterval(() => {
      const latest = this.runningOperationReports.get(operationId);
      if (!latest) return;
      void this.reportOperation({ ...latest }).catch((error) => {
        safeLog("managed_runtime_operation_heartbeat_failed", {
          code: safeFailureCode(error),
          operationId,
        });
      });
    }, this.operationHeartbeatMs);
    return () => clearInterval(timer);
  }

  private async reportOperation(input: JsonRecord): Promise<void> {
    const operationId = typeof input.operationId === "string"
      ? input.operationId
      : null;
    if (!operationId) throw runtimeFailure("managed_operation_report_invalid");

    if (input.status === "running") {
      this.runningOperationReports.set(operationId, { ...input });
    } else {
      this.runningOperationReports.delete(operationId);
    }

    const previous = this.operationReportQueues.get(operationId)
      ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.dependencies.console.reportOperation(input));
    this.operationReportQueues.set(operationId, queued);
    try {
      await queued;
    } finally {
      if (this.operationReportQueues.get(operationId) === queued) {
        this.operationReportQueues.delete(operationId);
      }
    }
  }

  private async processOperation(operation: ManagedOperation): Promise<void> {
    if (!ACTIONS.includes(operation.action)) throw runtimeFailure("managed_action_unsupported");
    if (operation.instance.runtimeProvider !== "codex") {
      throw runtimeFailure("managed_provider_unsupported");
    }
    const action = effectiveOperationAction(operation);
    if (action === "backup") {
      await this.backup(operation);
      return;
    }
    if (action === "restore") {
      await this.restore(operation);
      return;
    }
    if (action === "rotate_controller") {
      await this.rotateController(operation);
      return;
    }

    if (action === "create") {
      await this.provision(operation);
      return;
    }
    if (action === "start") {
      await this.start(operation);
      return;
    }
    if (action === "stop") {
      await this.stop(operation);
      return;
    }
    if (action === "restart") {
      await this.restart(operation);
      return;
    }
    await this.destroy(operation);
  }

  private async provision(operation: ManagedOperation): Promise<void> {
    await this.reportRunning(operation, "reserving", 5, "reserving");
    const size = sizeForOperation(operation);
    const instanceRef = instanceRefFor(operation.instanceId);
    const vm = await this.findOrCreateVm(operation, instanceRef, size);
    assertVmHealthy(vm);
    await this.reportRunning(operation, "bootstrapping", 20, "bootstrapping");

    let credential = await this.readCredential(operation.instanceId);
    if (!credential) {
      let claim = await this.readPendingClaim(operation.instanceId);
      if (!claim) {
        if (vm.state !== "created") {
          throw runtimeFailure("managed_controller_claim_state_missing");
        }
        claim = await this.issueAndPersistBootstrap(operation, vm);
      }
      const bootstrapPaths = this.bootstrapPaths(vm.id);
      const prepared = await this.dependencies.deck.prepare({
        bootstrapPayload: bootstrapPaths.payload,
        bootstrapSignature: bootstrapPaths.signature,
        operationRef: operation.id,
        ref: instanceRef,
      });
      assertVmHealthy(prepared);
      await this.reportRunning(operation, "starting", 55, "starting");
      const started = await this.startVmWithProviderBroker(
        operation,
        prepared,
      );
      assertVmRunning(started);
      credential = await this.claimAndPersistCredential(operation.instanceId, started, claim);
    } else {
      await this.reportRunning(operation, "starting", 55, "starting");
      const startTarget = await this.dependencies.deck.inspect(instanceRef);
      const started = await this.startVmWithProviderBroker(
        operation,
        startTarget,
      );
      assertVmRunning(started);
    }

    await this.reportRunning(operation, "validating_sdk", 85, "validating_sdk");
    await this.validateRaviConnection(instanceRef, credential);
    await this.reportReady(operation);
  }

  private async start(operation: ManagedOperation): Promise<void> {
    await this.reportRunning(operation, "starting", 20, "starting");
    const credential = await this.requireCredential(operation.instanceId);
    const target = await this.dependencies.deck.inspect(
      instanceRefFor(operation.instanceId),
    );
    const vm = await this.startVmWithProviderBroker(operation, target);
    assertVmRunning(vm);
    await this.reportRunning(operation, "validating_sdk", 80, "validating_sdk");
    await this.validateRaviConnection(vm.instanceRef, credential);
    await this.reportReady(operation);
  }

  private async stop(operation: ManagedOperation): Promise<void> {
    await this.reportRunning(operation, "stopping", 20, "stopping");
    const target = await this.dependencies.deck.inspect(
      instanceRefFor(operation.instanceId),
    );
    await this.setProviderBrokerBinding(operation.instanceId, target, "revoked");
    const vm = await this.dependencies.deck.stop(instanceRefFor(operation.instanceId), operation.id);
    if (vm.state !== "stopped") throw runtimeFailure(vm.failureCode ?? "managed_stop_failed");
    await this.reportOperation({
      claimOwner: this.config.claimOwner,
      connection: connectionEvidence(operation.instanceId, vm.controlEndpoint, this.dependencies.ravi.protocolVersion, "offline"),
      observedState: "stopped",
      operationId: operation.id,
      phase: "stopped",
      progressPercent: 100,
      provisioningPhase: "stopped",
      safeResult: { deckState: vm.state },
      status: "succeeded",
    });
  }

  private async restart(operation: ManagedOperation): Promise<void> {
    await this.reportRunning(operation, "restarting", 20, "restarting");
    const credential = await this.requireCredential(operation.instanceId);
    const target = await this.dependencies.deck.inspect(
      instanceRefFor(operation.instanceId),
    );
    await this.setProviderBrokerBinding(operation.instanceId, target, "active");
    const vm = await this.dependencies.deck.restart(
      instanceRefFor(operation.instanceId),
      operation.id,
      this.config.waitReadySeconds,
    );
    assertVmRunning(vm);
    await this.reportRunning(operation, "validating_sdk", 80, "validating_sdk");
    await this.validateRaviConnection(vm.instanceRef, credential);
    await this.reportReady(operation);
  }

  private async backup(operation: ManagedOperation): Promise<void> {
    const instanceRef = instanceRefFor(operation.instanceId);
    const backupRef = backupRefForOperation(operation.id);
    const shouldResume = operation.instance.desiredState === "running";
    await this.reportRunning(operation, "backing_up", 10, "backing_up");
    let target = await this.dependencies.deck.inspect(instanceRef);
    assertVmHealthy(target);
    const credential = await this.requireCredential(operation.instanceId);

    if (target.state === "running") {
      await this.setProviderBrokerBinding(operation.instanceId, target, "revoked");
      target = await this.dependencies.deck.stop(instanceRef, operation.id);
    }
    if (target.state !== "stopped") {
      throw runtimeFailure("managed_backup_requires_stopped");
    }

    let result: { backup: ManagedBackup; vm: ManagedVm };
    try {
      result = await this.dependencies.deck.backup(
        instanceRef,
        backupRef,
        operation.id,
      );
      assertBackupBinding(result.backup, operation, target, backupRef);
      await writePrivateJson(
        this.backupCredentialPath(operation.instanceId, backupRef),
        credential,
      );
    } catch (error) {
      if (shouldResume) {
        await this.resumeAfterBackupFailure(operation, target, credential);
      }
      throw error;
    }

    if (shouldResume) {
      await this.reportRunning(operation, "starting", 75, "starting");
      const started = await this.startVmWithProviderBroker(operation, result.vm);
      assertVmRunning(started);
      await this.validateRaviConnection(instanceRef, credential);
      await this.reportOperation({
        claimOwner: this.config.claimOwner,
        connection: connectionEvidence(
          operation.instanceId,
          started.controlEndpoint,
          this.dependencies.ravi.protocolVersion,
          "online",
          credential.contextId,
        ),
        observedState: "ready",
        operationId: operation.id,
        phase: "ready",
        progressPercent: 100,
        provisioningPhase: "ready",
        safeResult: {
          backup: safeBackupProjection(result.backup),
          controllerAuthenticated: true,
          deckState: started.state,
        },
        status: "succeeded",
      });
      return;
    }

    await this.reportOperation({
      claimOwner: this.config.claimOwner,
      connection: connectionEvidence(
        operation.instanceId,
        result.vm.controlEndpoint,
        this.dependencies.ravi.protocolVersion,
        "offline",
        credential.contextId,
      ),
      observedState: "stopped",
      operationId: operation.id,
      phase: "stopped",
      progressPercent: 100,
      provisioningPhase: "stopped",
      safeResult: {
        backup: safeBackupProjection(result.backup),
        deckState: result.vm.state,
      },
      status: "succeeded",
    });
  }

  private async restore(operation: ManagedOperation): Promise<void> {
    const backupRef = requiredBackupRef(operation.safeInput.backupRef);
    const retryOperationId = operation.action === "retry"
      ? requiredRetryOperationId(operation.safeInput.retryOperationId)
      : null;
    const sourceOperationId = retryOperationId ?? operation.id;
    const instanceRef = instanceRefFor(operation.instanceId);
    await this.reportRunning(operation, "restoring", 10, "restoring");
    const source = await this.dependencies.deck.inspect(instanceRef);
    const replay =
      source.operationRef === sourceOperationId
      && source.restoredFromBackupRef === backupRef;
    if (!replay && source.state !== "stopped") {
      throw runtimeFailure("managed_restore_requires_stopped");
    }
    const historicalCredential = await this.readBackupCredential(
      operation.instanceId,
      backupRef,
    );
    if (!historicalCredential) {
      throw runtimeFailure("managed_backup_controller_snapshot_missing");
    }
    assertCredentialUsable(historicalCredential, this.now());

    await this.revokeProviderBrokerBinding(operation.instanceId);
    const restored = replay
      ? source
      : await this.dependencies.deck.restore(
          instanceRef,
          backupRef,
          operation.id,
        );
    if (
      !new Set(["running", "stopped"]).has(restored.state)
      || (!replay && restored.generation <= source.generation)
      || (!replay && restored.replacedVmId !== source.id)
      || restored.restoredFromBackupRef !== backupRef
      || restored.operationRef !== (replay ? sourceOperationId : operation.id)
    ) {
      throw runtimeFailure("managed_restore_replacement_invalid");
    }
    let currentCredential = await this.readCredential(operation.instanceId);
    if (!replay || !currentCredential) {
      await writePrivateJson(
        this.credentialPath(operation.instanceId),
        historicalCredential,
      );
      currentCredential = historicalCredential;
    }

    await this.reportRunning(operation, "starting", 45, "restoring");
    const started = restored.state === "running"
      ? restored
      : await this.startVmWithProviderBroker(operation, restored);
    assertVmRunning(started);
    await this.validateRaviConnection(
      instanceRef,
      currentCredential,
    );
    await this.reportOperation({
      claimOwner: this.config.claimOwner,
      connection: connectionEvidence(
        operation.instanceId,
        started.controlEndpoint,
        this.dependencies.ravi.protocolVersion,
        "online",
        currentCredential.contextId,
      ),
      observedState: "starting",
      operationId: operation.id,
      phase: "rotating_controller",
      progressPercent: 65,
      provisioningPhase: "restoring",
      safeResult: {
        controllerAuthenticated: true,
        restoredGeneration: restored.generation,
      },
      status: "running",
    });

    const pendingRotation = await this.readPendingRotation(operation.instanceId);
    const rotated =
      pendingRotation || currentCredential.contextId === historicalCredential.contextId
        ? await this.rotateController(operation, false)
        : {
            credential: currentCredential,
            controllerAuthenticated: true as const,
          };
    await this.setProviderBrokerBinding(operation.instanceId, started, "revoked");
    const stopped = await this.dependencies.deck.stop(instanceRef, operation.id);
    if (stopped.state !== "stopped") {
      throw runtimeFailure(stopped.failureCode ?? "managed_restore_stop_failed");
    }
    await this.reportOperation({
      claimOwner: this.config.claimOwner,
      connection: connectionEvidence(
        operation.instanceId,
        stopped.controlEndpoint,
        this.dependencies.ravi.protocolVersion,
        "offline",
        rotated.credential.contextId,
      ),
      observedState: "stopped",
      operationId: operation.id,
      phase: "stopped",
      progressPercent: 100,
      provisioningPhase: "stopped",
      safeResult: {
        backupRef,
        controllerAuthenticated: rotated.controllerAuthenticated,
        generation: stopped.generation,
        replacedVmId: stopped.replacedVmId,
      },
      status: "succeeded",
    });
  }

  private async resumeAfterBackupFailure(
    operation: ManagedOperation,
    target: ManagedVm,
    credential: ControllerCredential,
  ) {
    try {
      const started = await this.startVmWithProviderBroker(operation, target);
      assertVmRunning(started);
      await this.validateRaviConnection(target.instanceRef, credential);
    } catch (error) {
      safeLog("managed_backup_recovery_failed", {
        code: safeFailureCode(error),
        operationId: operation.id,
      });
    }
  }

  private async rotateController(
    operation: ManagedOperation,
    reportCompletion = true,
  ): Promise<{ controllerAuthenticated: true; credential: ControllerCredential }> {
    const rotationProgress = reportCompletion ? 10 : 75;
    const rotationProvisioningPhase = reportCompletion
      ? "rotating_controller"
      : "restoring";
    await this.reportRunning(
      operation,
      "rotating_controller",
      rotationProgress,
      rotationProvisioningPhase,
    );
    const instanceRef = instanceRefFor(operation.instanceId);
    const vm = await this.dependencies.deck.inspect(instanceRef);
    assertVmRunning(vm);
    let current = await this.resolveRotationCredential(operation, vm);
    let pending = await this.readPendingRotation(operation.instanceId);

    if (pending?.operationId !== operation.id) {
      if (
        pending?.stage === "guest_acknowledged"
        && pending.replacementContextId === current.contextId
      ) {
        await rm(this.pendingRotationPath(operation.instanceId), { force: true });
        pending = null;
      } else if (
        pending?.stage === "grant_issued"
        && rotationGrantExpired(pending, this.now())
      ) {
        await rm(this.pendingRotationPath(operation.instanceId), { force: true });
        pending = null;
      } else if (pending) {
        throw runtimeFailure("managed_controller_rotation_pending_conflict");
      }
    }

    if (!pending) {
      const response = await this.dependencies.console.issueControllerRotation({
        claimOwner: this.config.claimOwner,
        currentContextId: current.contextId,
        deckInstanceRef: vm.instanceRef,
        operationId: operation.id,
        vmId: vm.id,
      });
      pending = {
        deckInstanceRef: vm.instanceRef,
        grant: parseControllerRotationGrant(response.rotation),
        instanceId: operation.instanceId,
        operationId: operation.id,
        previousContextId: current.contextId,
        replacement: null,
        replacementContextId: null,
        schemaVersion: "ravi.managed-runtime.pending-controller-rotation/v1",
        stage: "grant_issued",
        vmId: vm.id,
      };
      await writePrivateJson(this.pendingRotationPath(operation.instanceId), pending);
    }
    assertPendingRotationBinding(pending, operation, vm, current);

    if (pending.stage === "grant_issued") {
      const grant = requireRotationGrant(pending);
      const body = await this.postGuestController(
        vm.controlEndpoint,
        "/controller/rotation/prepare",
        {
          payloadBase64: grant.payloadBase64,
          signatureBase64: grant.signatureBase64,
        },
      );
      if (
        body.ok !== true
        || body.grantId !== grant.grantId
        || !new Set(["claimable", "claimed"]).has(String(body.phase))
      ) {
        throw runtimeFailure("managed_controller_rotation_prepare_invalid");
      }
      pending.stage = "guest_prepared";
      await writePrivateJson(this.pendingRotationPath(operation.instanceId), pending);
    }

    if (pending.stage === "guest_prepared") {
      const grant = requireRotationGrant(pending);
      const body = await this.postGuestController(
        vm.controlEndpoint,
        "/controller/rotation/claim",
        { grantId: grant.grantId },
        grant.credentialClaimToken,
      );
      const replacement = parseControllerCredential(body, operation.instanceId);
      if (replacement.contextId === pending.previousContextId) {
        throw runtimeFailure("managed_controller_rotation_replacement_invalid");
      }
      assertCredentialUsable(replacement, this.now());
      pending.replacement = replacement;
      pending.replacementContextId = replacement.contextId;
      pending.stage = "credential_claimed";
      await writePrivateJson(this.pendingRotationPath(operation.instanceId), pending);
    }

    if (pending.stage === "credential_claimed") {
      const replacement = requireRotationReplacement(pending);
      await this.validateRaviConnection(instanceRef, replacement);
      await writePrivateJson(this.credentialPath(operation.instanceId), replacement);
      pending.stage = "credential_persisted";
      await writePrivateJson(this.pendingRotationPath(operation.instanceId), pending);
      current = replacement;
    }

    if (pending.stage === "credential_persisted") {
      const grant = requireRotationGrant(pending);
      const replacement = requireRotationReplacement(pending);
      const body = await this.postGuestController(
        vm.controlEndpoint,
        "/controller/rotation/ack",
        { contextId: replacement.contextId, grantId: grant.grantId },
        grant.credentialClaimToken,
      );
      if (
        body.ok !== true
        || body.acknowledged !== true
        || body.contextId !== replacement.contextId
        || body.grantId !== grant.grantId
      ) {
        throw runtimeFailure("managed_controller_rotation_ack_invalid");
      }
      pending = acknowledgedRotationState(pending, replacement.contextId);
      await writePrivateJson(this.pendingRotationPath(operation.instanceId), pending);
      current = replacement;
    }

    if (pending.stage !== "guest_acknowledged") {
      throw runtimeFailure("managed_controller_rotation_state_invalid");
    }
    if (pending.replacementContextId !== current.contextId) {
      current = await this.requireCredential(operation.instanceId);
    }
    if (pending.replacementContextId !== current.contextId) {
      throw runtimeFailure("managed_controller_rotation_state_conflict");
    }
    await this.reportRunning(
      operation,
      "validating_sdk",
      90,
      reportCompletion ? "validating_sdk" : "restoring",
    );
    await this.validateRaviConnection(instanceRef, current);
    if (reportCompletion) {
      await this.reportReady(operation);
    }
    await rm(this.pendingRotationPath(operation.instanceId), { force: true });
    return { controllerAuthenticated: true, credential: current };
  }

  private async resolveRotationCredential(
    operation: ManagedOperation,
    vm: ManagedVm,
  ): Promise<ControllerCredential> {
    const current = await this.requireCredential(operation.instanceId);
    try {
      await this.validateRaviConnection(vm.instanceRef, current);
      return current;
    } catch (currentError) {
      const backupRef = vm.restoredFromBackupRef;
      if (!backupRef) throw currentError;
      const historical = await this.readBackupCredential(
        operation.instanceId,
        backupRef,
      );
      if (!historical || historical.contextId === current.contextId) {
        throw currentError;
      }
      assertCredentialUsable(historical, this.now());
      try {
        await this.validateRaviConnection(vm.instanceRef, historical);
      } catch {
        throw currentError;
      }
      await writePrivateJson(
        this.credentialPath(operation.instanceId),
        historical,
      );
      safeLog("managed_controller_restore_credential_recovered", {
        backupRef,
        operationId: operation.id,
      });
      return historical;
    }
  }

  private async destroy(operation: ManagedOperation): Promise<void> {
    await this.reportRunning(operation, "deleting", 15, "deleting");
    await this.revokeProviderBrokerBinding(operation.instanceId);
    let vm: ManagedVm;
    try {
      vm = await this.dependencies.deck.destroy(
        instanceRefFor(operation.instanceId),
        operation.id,
      );
    } catch (error) {
      if (!isDeckVmNotFound(error)) throw error;
      const pendingClaim = await this.readPendingClaim(operation.instanceId);
      await this.deleteInstanceSecrets(
        operation.instanceId,
        pendingClaim?.vmId ?? null,
      );
      await this.reportOperation({
        claimOwner: this.config.claimOwner,
        observedState: "deleted",
        operationId: operation.id,
        phase: "deleted",
        progressPercent: 100,
        provisioningPhase: "deleted",
        safeResult: { cleanupVerified: true, deckState: "absent" },
        status: "succeeded",
      });
      return;
    }
    if (vm.state !== "destroyed" || hasDeckResources(vm.facts)) {
      throw runtimeFailure(vm.quarantinedReason ?? vm.failureCode ?? "managed_destroy_cleanup_failed");
    }
    await this.deleteInstanceSecrets(operation.instanceId, vm.id);
    await this.reportOperation({
      claimOwner: this.config.claimOwner,
      connection: connectionEvidence(operation.instanceId, vm.controlEndpoint, this.dependencies.ravi.protocolVersion, "revoked"),
      observedState: "deleted",
      operationId: operation.id,
      phase: "deleted",
      progressPercent: 100,
      provisioningPhase: "deleted",
      safeResult: { cleanupVerified: true, deckState: vm.state },
      status: "succeeded",
    });
  }

  private async issueAndPersistBootstrap(operation: ManagedOperation, vm: ManagedVm) {
    const response = await this.dependencies.console.issueBootstrap({
      claimOwner: this.config.claimOwner,
      deckInstanceRef: vm.instanceRef,
      operationId: operation.id,
      providerBrokerBaseUrl: providerBrokerBaseUrlFor(vm.controlEndpoint),
      vmId: vm.id,
    });
    const bootstrap = response.bootstrap;
    const paths = this.bootstrapPaths(vm.id);
    await ensurePrivateDirectory(paths.root);
    await writePrivateFile(paths.payload, Buffer.from(bootstrap.payloadBase64, "base64"));
    await writePrivateFile(paths.signature, Buffer.from(bootstrap.signatureBase64, "base64"));
    const claim: PendingControllerClaim = {
      bootstrapExpiresAt: bootstrap.expiresAt,
      claimToken: bootstrap.credentialClaimToken,
      instanceId: operation.instanceId,
      operationId: operation.id,
      schemaVersion: "ravi.managed-runtime.pending-controller-claim/v1",
      vmId: vm.id,
    };
    await writePrivateJson(this.pendingClaimPath(operation.instanceId), claim);
    return claim;
  }

  private async startVmWithProviderBroker(
    operation: ManagedOperation,
    target: ManagedVm,
  ) {
    await this.setProviderBrokerBinding(operation.instanceId, target, "active");
    let started: ManagedVm;
    try {
      started = await this.dependencies.deck.start(
        target.instanceRef,
        operation.id,
        this.config.waitReadySeconds,
      );
    } catch (error) {
      const readinessCode = await this.readReadinessFailure(target.controlEndpoint);
      await this.setProviderBrokerBinding(
        operation.instanceId,
        target,
        "revoked",
      );
      if (readinessCode) throw runtimeFailure(readinessCode);
      throw error;
    }
    if (started.state !== "running") {
      const readinessCode = await this.readReadinessFailure(started.controlEndpoint);
      await this.setProviderBrokerBinding(
        operation.instanceId,
        started,
        "revoked",
      );
      if (readinessCode) throw runtimeFailure(readinessCode);
    }
    return started;
  }

  private async readReadinessFailure(controlEndpoint: string) {
    try {
      const response = await this.fetchImpl(
        controllerControlUrl(controlEndpoint, "/health"),
        { method: "GET", signal: AbortSignal.timeout(3_000) },
      );
      const payload = await safeJson(response);
      return readinessDiagnosticCode(payload);
    } catch {
      return null;
    }
  }

  private async setProviderBrokerBinding(
    instanceId: string,
    vm: ManagedVm,
    status: "active" | "revoked",
  ) {
    const guestIp = guestIpForControlEndpoint(vm.controlEndpoint);
    const current = await readProviderBrokerRegistry(
      this.config.providerBrokerRegistryPath,
    );
    const updatedAt = this.now().toISOString();
    const entries = current.entries
      .filter((entry) => entry.instanceId !== instanceId)
      .slice(-999);
    entries.push({ guestIp, instanceId, status, updatedAt, vmId: vm.id });
    await writeProviderBrokerRegistry(
      this.config.providerBrokerRegistryPath,
      {
        entries,
        schemaVersion: "ravi.managed-provider-broker.registry/v1",
        updatedAt,
      },
    );
  }

  private async revokeProviderBrokerBinding(instanceId: string) {
    const current = await readProviderBrokerRegistry(
      this.config.providerBrokerRegistryPath,
    );
    const updatedAt = this.now().toISOString();
    const entries = current.entries.map((entry) =>
      entry.instanceId === instanceId
        ? { ...entry, status: "revoked" as const, updatedAt }
        : entry
    );
    await writeProviderBrokerRegistry(
      this.config.providerBrokerRegistryPath,
      {
        entries,
        schemaVersion: "ravi.managed-provider-broker.registry/v1",
        updatedAt,
      },
    );
  }

  private async findOrCreateVm(
    operation: ManagedOperation,
    instanceRef: string,
    size: { memoryMib: number; stateDiskMib: number; vcpu: number },
  ) {
    try {
      return await this.dependencies.deck.inspect(instanceRef);
    } catch (error) {
      if (!isDeckVmNotFound(error)) throw error;
    }
    return await this.dependencies.deck.create({
      image: this.config.imageName,
      instanceRef,
      memoryMib: String(size.memoryMib),
      name: deckNameFor(operation),
      networkPolicy: "codex-restricted-v1",
      operationRef: stableCreateOperationRef(operation.instanceId),
      stateDiskMib: String(size.stateDiskMib),
      vcpu: String(size.vcpu),
    });
  }

  private async claimAndPersistCredential(
    instanceId: string,
    vm: ManagedVm,
    claim: PendingControllerClaim,
  ) {
    if (claim.instanceId !== instanceId || claim.vmId !== vm.id) {
      throw runtimeFailure("managed_controller_claim_binding_invalid");
    }
    const claimUrl = controllerClaimUrl(vm.controlEndpoint);
    const response = await this.fetchImpl(claimUrl, {
      headers: {
        authorization: `Bearer ${claim.claimToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await safeJson(response);
    if (!response.ok) {
      throw runtimeFailure(safeRemoteCode(body) ?? "managed_controller_claim_failed");
    }
    const credential = parseControllerCredential(body, instanceId);
    await writePrivateJson(this.credentialPath(instanceId), credential);
    await rm(this.pendingClaimPath(instanceId), { force: true });
    return credential;
  }

  private async postGuestController(
    controlEndpoint: string,
    pathname: string,
    body: JsonRecord,
    token?: string,
  ) {
    const response = await this.fetchImpl(
      controllerControlUrl(controlEndpoint, pathname),
      {
        body: JSON.stringify(body),
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    const payload = await safeJson(response);
    if (!response.ok) {
      throw runtimeFailure(
        safeRemoteCode(payload) ?? "managed_controller_rotation_request_failed",
      );
    }
    return payload;
  }

  private async validateRaviConnection(instanceRef: string, credential: ControllerCredential) {
    assertCredentialUsable(credential, this.now());
    const vm = await this.dependencies.deck.inspect(instanceRef);
    assertVmRunning(vm);
    const client = this.dependencies.ravi.create(vm.controlEndpoint, credential.contextKey);
    await client.self.whoami();
  }

  private async reportRunning(
    operation: ManagedOperation,
    phase: string,
    progressPercent: number,
    provisioningPhase: string,
  ) {
    await this.reportOperation({
      claimOwner: this.config.claimOwner,
      observedState: observedStateForRunningPhase(phase),
      operationId: operation.id,
      phase,
      progressPercent,
      provisioningPhase,
      safeResult: { attempt: operation.attemptCount },
      status: "running",
    });
  }

  private async reportReady(operation: ManagedOperation) {
    const credential = await this.requireCredential(operation.instanceId);
    const vm = await this.dependencies.deck.inspect(instanceRefFor(operation.instanceId));
    await this.reportOperation({
      claimOwner: this.config.claimOwner,
      connection: connectionEvidence(
        operation.instanceId,
        vm.controlEndpoint,
        this.dependencies.ravi.protocolVersion,
        "online",
        credential.contextId,
      ),
      observedState: "ready",
      operationId: operation.id,
      phase: "ready",
      progressPercent: 100,
      provisioningPhase: "ready",
      runtimeVersion: this.placement?.image.raviVersion ?? null,
      safeResult: { controllerAuthenticated: true, deckState: vm.state },
      status: "succeeded",
    });
  }

  private async requireCredential(instanceId: string) {
    const credential = await this.readCredential(instanceId);
    if (!credential) throw runtimeFailure("managed_controller_credential_missing");
    assertCredentialUsable(credential, this.now());
    return credential;
  }

  private async readCredential(instanceId: string) {
    const value = await readJsonFile(this.credentialPath(instanceId));
    if (!value) return null;
    return parseStoredCredential(value, instanceId);
  }

  private async readPendingClaim(instanceId: string) {
    const value = await readJsonFile(this.pendingClaimPath(instanceId));
    if (!value) return null;
    return parsePendingClaim(value, instanceId);
  }

  private async readPendingRotation(instanceId: string) {
    const value = await readJsonFile(this.pendingRotationPath(instanceId));
    if (!value) return null;
    return parsePendingRotation(value, instanceId);
  }

  private async readBackupCredential(instanceId: string, backupRef: string) {
    const value = await readJsonFile(this.backupCredentialPath(instanceId, backupRef));
    if (!value) return null;
    return parseStoredCredential(value, instanceId);
  }

  private credentialPath(instanceId: string) {
    return path.join(this.config.credentialRoot, safeId(instanceId), "controller.json");
  }

  private pendingClaimPath(instanceId: string) {
    return path.join(this.config.credentialRoot, safeId(instanceId), "pending-claim.json");
  }

  private pendingRotationPath(instanceId: string) {
    return path.join(
      this.config.credentialRoot,
      safeId(instanceId),
      "pending-controller-rotation.json",
    );
  }

  private backupCredentialPath(instanceId: string, backupRef: string) {
    return path.join(
      this.config.credentialRoot,
      "backups",
      safeId(instanceId),
      requiredBackupRef(backupRef),
      "controller.json",
    );
  }

  private bootstrapPaths(vmId: string) {
    const root = path.join(this.config.stateRoot, "bootstrap", safeId(vmId));
    return {
      payload: path.join(root, "payload.json"),
      root,
      signature: path.join(root, "payload.sig"),
    };
  }

  private async deleteInstanceSecrets(instanceId: string, vmId: string | null) {
    await rm(path.dirname(this.credentialPath(instanceId)), { force: true, recursive: true });
    await rm(
      path.join(this.config.credentialRoot, "backups", safeId(instanceId)),
      { force: true, recursive: true },
    );
    if (vmId) {
      await rm(this.bootstrapPaths(vmId).root, { force: true, recursive: true });
    }
  }
}

type CommandReport = {
  events: Array<{
    eventType: string;
    occurredAt: string;
    payload: JsonRecord;
    severity: "debug" | "error" | "info" | "warning";
    sourceEventId: string;
  }>;
  failureCode?: string;
  phase: string;
  result?: JsonRecord;
  safeResult: JsonRecord;
  status: "cancelled" | "failed" | "running" | "succeeded";
};

function serializedCommandReporter(
  consoleApi: RuntimeControlConsoleApi,
  claimOwner: string,
  commandId: string,
) {
  let tail: Promise<void> = Promise.resolve();
  return (input: CommandReport) => {
    const next = tail.then(() =>
      consoleApi.reportCommand({
        claimOwner,
        commandId,
        ...input,
      }),
    );
    tail = next.catch(() => undefined);
    return next;
  };
}

function managedSessionEvent(
  command: ManagedCommand,
  event: ManagedRaviSseEvent,
  eventIndex: number,
  now: Date,
): CommandReport["events"][number] {
  const envelope = isRecord(event.data) ? event.data : {};
  const topic = typeof envelope.topic === "string" ? envelope.topic : event.event;
  const occurredAt = validIsoTimestamp(envelope.timestamp) ?? now.toISOString();
  return {
    eventType: safeEventType(topic),
    occurredAt,
    payload: boundedSessionEventPayload(event, envelope, topic),
    severity: topic.includes("error") || topic.includes("failed") ? "error" : "info",
    sourceEventId: `${command.id}:${event.id ?? eventIndex}`.slice(0, 200),
  };
}

function managedSessionTerminal(
  event: ManagedRaviSseEvent,
): ManagedSessionTerminal | null {
  const envelope = isRecord(event.data) ? event.data : null;
  if (!envelope || envelope.type !== "session.event") return null;
  const topic = typeof envelope.topic === "string" ? envelope.topic : "";
  if (!topic.endsWith(".runtime")) return null;
  const payload = isRecord(envelope.data) ? envelope.data : null;
  if (!payload || typeof payload.type !== "string") return null;
  if (payload.type === "turn.complete") return { kind: "completed" };
  if (payload.type === "turn.failed") return { kind: "failed" };
  if (payload.type === "turn.interrupted") return { kind: "interrupted" };
  return null;
}

function waitForManagedSessionTerminal(
  terminal: Promise<ManagedSessionTerminal>,
  signal: AbortSignal,
  timeoutMs = 5 * 60 * 1_000,
): Promise<ManagedSessionTerminal> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: ManagedSessionTerminal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => fail(runtimeFailure("managed_runtime_command_aborted"));
    const timer = setTimeout(
      () => fail(runtimeFailure("managed_runtime_session_terminal_timeout")),
      timeoutMs,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void terminal.then(finish, fail);
  });
}

function boundedSessionEventPayload(
  event: ManagedRaviSseEvent,
  envelope: JsonRecord,
  topic: string,
): JsonRecord {
  const contentTopic = /\.(prompt|response|stream)(\.|$)/.test(topic);
  const payload: JsonRecord = contentTopic
    ? {
        data: jsonValue(envelope.data),
        event: event.event,
        timestamp:
          typeof envelope.timestamp === "string" ? envelope.timestamp : null,
        topic,
        type: typeof envelope.type === "string" ? envelope.type : null,
      }
    : {
        event: event.event,
        metadata: safeRuntimeMetadata(envelope.data),
        timestamp:
          typeof envelope.timestamp === "string" ? envelope.timestamp : null,
        topic,
        type: typeof envelope.type === "string" ? envelope.type : null,
      };
  if (jsonBytes(payload) <= 64 * 1024) return payload;
  return {
    event: event.event,
    oversized: true,
    topic: topic.slice(0, 240),
    type: typeof envelope.type === "string" ? envelope.type : null,
  };
}

function safeRuntimeMetadata(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  const safe: JsonRecord = {};
  for (const key of [
    "event",
    "operation",
    "phase",
    "provider",
    "status",
    "threadId",
    "tool",
    "turnId",
    "type",
  ]) {
    const item = value[key];
    if (
      typeof item === "boolean" ||
      typeof item === "number" ||
      (typeof item === "string" && item.length <= 240)
    ) {
      safe[key] = item;
    }
  }
  return safe;
}

async function readBoundedHistory(
  client: ManagedRaviClient,
  sessionKey: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<JsonRecord> {
  const history = await waitForBoundedOperation(
    client.sessions.read(sessionKey, { count: MANAGED_HISTORY_READ_COUNT }),
    timeoutMs,
    signal,
    "managed_runtime_history_read_timeout",
  );
  if (jsonBytes(history) <= 384 * 1024) return history;
  const messages = Array.isArray(history.messages) ? history.messages : [];
  for (const count of [20, 10, 5, 1]) {
    const bounded = {
      ...history,
      messages: messages.slice(-count).map(jsonValue),
      truncated: true,
    };
    if (jsonBytes(bounded) <= 384 * 1024) return bounded;
  }
  return { messages: [], truncated: true };
}

async function waitForBoundedOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutCode: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let removeAbortListener: () => void = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(runtimeFailure(timeoutCode)), timeoutMs);
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(runtimeFailure("managed_runtime_command_aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    removeAbortListener();
  }
}

function historyMessageCount(history: JsonRecord): number {
  return Array.isArray(history.messages) ? history.messages.length : 0;
}

function runtimeImageVersion(raviVersion: string, imageDigest: string) {
  const base = (raviVersion.trim() || "managed").slice(0, 100);
  return `${base}+${imageDigest.slice(7, 19)}`;
}

function backupRefForOperation(operationId: string) {
  const compact = operationId.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) {
    throw runtimeFailure("managed_backup_operation_id_invalid");
  }
  return `mbk_${compact}`;
}

function requiredBackupRef(value: unknown) {
  if (typeof value !== "string" || !/^mbk_[a-f0-9]{32}$/.test(value)) {
    throw runtimeFailure("managed_backup_ref_invalid");
  }
  return value;
}

function requiredRetryOperationId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  ) {
    throw runtimeFailure("managed_retry_operation_id_invalid");
  }
  return value;
}

function effectiveOperationAction(operation: ManagedOperation): ManagedAction {
  if (operation.action !== "retry") return operation.action;
  const action = operation.safeInput.retryAction;
  if (
    typeof action !== "string" ||
    !new Set<ManagedAction>([
      "backup",
      "create",
      "restart",
      "restore",
      "rotate_controller",
      "start",
      "stop",
    ]).has(action as ManagedAction)
  ) {
    throw runtimeFailure("managed_retry_action_invalid");
  }
  return action as ManagedAction;
}

function assertBackupBinding(
  backup: ManagedBackup,
  operation: ManagedOperation,
  vm: ManagedVm,
  backupRef: string,
) {
  if (
    backup.backupRef !== backupRef
    || backup.instanceRef !== instanceRefFor(operation.instanceId)
    || backup.sourceVmId !== vm.id
    || !/^sha256:[a-f0-9]{64}$/.test(backup.imageDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(backup.contentDigest)
    || !Number.isSafeInteger(backup.sizeBytes)
    || backup.sizeBytes < 0
    || !Number.isSafeInteger(backup.stateDiskMib)
    || backup.stateDiskMib <= 0
    || !Number.isFinite(Date.parse(backup.createdAt))
  ) {
    throw runtimeFailure("managed_backup_binding_invalid");
  }
}

function safeBackupProjection(backup: ManagedBackup): JsonRecord {
  return {
    backupRef: backup.backupRef,
    contentDigest: backup.contentDigest,
    createdAt: new Date(backup.createdAt).toISOString(),
    sizeBytes: backup.sizeBytes,
    sourceVmId: backup.sourceVmId,
  };
}

function safeOperationProjection(value: JsonRecord): JsonRecord {
  return {
    ok: value.ok === true,
    operation:
      typeof value.operation === "string"
        ? value.operation.slice(0, 120)
        : null,
  };
}

function requiredCommandString(input: JsonRecord, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw runtimeFailure("managed_command_input_invalid");
  }
  return value;
}

function optionalCommandString(input: JsonRecord, key: string): string | null {
  const value = input[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw runtimeFailure("managed_command_input_invalid");
  }
  return value;
}

function assertCanonicalCommandBinding(command: ManagedCommand): void {
  canonicalCommandPrincipal(command);
}

function canonicalCommandPrincipal(
  command: ManagedCommand,
): CanonicalCommandPrincipal {
  if (command.input.schemaVersion !== "ravi.control.command/v1") {
    throw runtimeFailure("ravi_control_command_schema_invalid");
  }
  const organizationId = requiredCommandString(command.input, "organizationId");
  const installationId = requiredCommandString(command.input, "installationId");
  if (
    organizationId !== command.organizationId ||
    installationId !== command.instanceId
  ) {
    throw runtimeFailure("ravi_control_command_principal_mismatch");
  }
  const chatId = optionalCommandString(command.input, "chatId") ?? "";
  const sessionKey = optionalCommandString(command.input, "sessionKey") ?? "";
  const sessionName = optionalCommandString(command.input, "sessionName") ?? "";
  if (command.action !== "chat_message_create" && (!chatId || !sessionKey)) {
    throw runtimeFailure("ravi_control_chat_binding_invalid");
  }
  const actorId = requiredCommandString(command.input, "actorId");
  return {
    actorId,
    agentId: requiredCommandString(command.input, "agentId"),
    chatId,
    installationId,
    localActorId:
      optionalCommandString(command.input, "localActorId") ?? actorId,
    localPlatformIdentityId:
      optionalCommandString(command.input, "localPlatformIdentityId") ??
      actorId,
    operationId: command.id,
    organizationId,
    sessionKey,
    sessionName,
  };
}

function canonicalCommandResult(
  principal: CanonicalCommandPrincipal,
  history: CanonicalChatHistory,
  accepted?: CanonicalMessageAccepted,
): JsonRecord {
  return {
    binding: {
      actorId: principal.localActorId,
      chatId: principal.chatId,
      platformIdentityId: principal.localPlatformIdentityId,
      sessionKey: principal.sessionKey,
    },
    ...(accepted
      ? {
          accepted: {
            dispatchStatus: accepted.dispatch.status,
            duplicate: accepted.duplicate,
            messageId: accepted.message.id,
          },
        }
      : {}),
    history: {
      messages: history.messages.map((message) => ({
        actorType: message.actorType,
        ...(message.agentId ? { agentId: message.agentId } : {}),
        ...(message.content ? { content: message.content } : {}),
        createdAt: message.createdAt,
        id: message.id,
        ...(message.messageType ? { messageType: message.messageType } : {}),
        ...(message.platformIdentityId
          ? { platformIdentityId: message.platformIdentityId }
          : {}),
        sortKey: message.sortKey,
      })),
    },
  };
}

function validIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeEventType(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, ".")
    .replace(/^[^a-z]+/, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 120);
  return SAFE_CODE.test(normalized) ? normalized : "session.event";
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function jsonValue(value: unknown): JsonRecord[string] {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonRecord[string];
  } catch {
    return null;
  }
}

export class ManagedRuntimeConsoleClient implements RuntimeControlConsoleApi {
  constructor(
    private readonly config: Pick<
      ManagedRuntimeControlConfig,
      "consoleControlToken" | "consoleUrl" | "vercelBypassSecret"
    >,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async claimCommand(input: {
    claimOwner: string;
    claimTtlSeconds: number;
    hostId: string;
  }) {
    const response = await this.post(
      "/api/internal/runtime/commands/claim",
      input,
    );
    return response.claimed === true && isRecord(response.command)
      ? response.command as ManagedCommand
      : null;
  }

  async claimOperation(input: {
    claimOwner: string;
    claimTtlSeconds: number;
    hostId: string;
    imageId: string;
  }) {
    const response = await this.post("/api/internal/runtime/operations/claim", input);
    return response.claimed === true && isRecord(response.operation)
      ? response.operation as ManagedOperation
      : null;
  }

  async heartbeatHost(input: JsonRecord) {
    await this.post("/api/internal/runtime/hosts/heartbeat", input);
  }

  async issueBootstrap(input: {
    claimOwner: string;
    deckInstanceRef: string;
    operationId: string;
    providerBrokerBaseUrl: string;
    vmId: string;
  }) {
    return await this.post("/api/internal/runtime/bootstrap/issue", input) as {
      bootstrap: {
        credentialClaimToken: string;
        expiresAt: string;
        payloadBase64: string;
        signatureBase64: string;
      };
    };
  }

  async issueControllerRotation(input: {
    claimOwner: string;
    currentContextId: string;
    deckInstanceRef: string;
    operationId: string;
    vmId: string;
  }) {
    return await this.post(
      "/api/internal/runtime/controllers/rotation-grants/issue",
      input,
    ) as { rotation: ControllerRotationGrant };
  }

  async registerHost(input: JsonRecord) {
    const response = await this.post("/api/internal/runtime/hosts/register", input);
    if (!isRecord(response.host) || typeof response.host.id !== "string") {
      throw runtimeFailure("managed_console_host_response_invalid");
    }
    return { id: response.host.id };
  }

  async registerImage(input: JsonRecord) {
    const response = await this.post("/api/internal/runtime/images/register", input);
    if (!isRecord(response.image) || typeof response.image.id !== "string") {
      throw runtimeFailure("managed_console_image_response_invalid");
    }
    return { id: response.image.id };
  }

  async reportCommand(input: JsonRecord) {
    await this.post("/api/internal/runtime/commands/report", input);
  }

  async reportOperation(input: JsonRecord) {
    await this.post("/api/internal/runtime/operations/report", input);
  }

  private async post(route: string, body: object): Promise<JsonRecord> {
    const response = await this.fetchImpl(`${this.config.consoleUrl}${route}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.config.consoleControlToken}`,
        "content-type": "application/json",
        ...(this.config.vercelBypassSecret
          ? { "x-vercel-protection-bypass": this.config.vercelBypassSecret }
          : {}),
      },
      method: "POST",
    });
    const payload = await safeJson(response);
    if (!response.ok) throw runtimeFailure(safeRemoteCode(payload) ?? "managed_console_request_failed");
    return payload;
  }
}

export async function loadGeneratedSdkDependencies(config: ManagedRuntimeControlConfig) {
  const deckClientModule = await importModule(path.join(config.deckSdkPath, "client.js"));
  const deckTransportModule = await importModule(path.join(config.deckSdkPath, "transport/http.js"));
  const raviClientModule = await importModule(path.join(config.raviSdkPath, "client.js"));
  const raviStreamingModule = await importModule(
    path.join(config.raviSdkPath, "streaming.js"),
  );
  const raviTransportModule = await importModule(path.join(config.raviSdkPath, "transport/http.js"));
  const raviVersionModule = await importModule(path.join(config.raviSdkPath, "version.js"));

  const DeckClient = requiredConstructor(deckClientModule, "RaviDeckClient");
  const deckTransportFactory = requiredFunction(deckTransportModule, "createHttpTransport");
  const RaviClient = requiredConstructor(raviClientModule, "RaviClient");
  const raviStreamFactory = requiredFunction(
    raviStreamingModule,
    "createStreamClient",
  );
  const raviTransportFactory = requiredFunction(raviTransportModule, "createHttpTransport");
  const deckClient = new DeckClient(deckTransportFactory({
    baseUrl: config.deckGatewayUrl,
    contextKey: config.deckContextKey,
    timeoutMs: 240_000,
  })) as GeneratedDeckClient;

  const deck: RuntimeControlDeckApi = {
    async backup(ref, backupRef, operationRef) {
      const result = await deckClient.managed.backup(ref, {
        backupRef,
        operationRef,
      });
      return result;
    },
    async create(input) {
      const result = await deckClient.managed.create(input.name, input);
      return result.vm;
    },
    async destroy(ref, operationRef) {
      const result = await deckClient.managed.destroy(ref, { operationRef, yes: true });
      return result.vm;
    },
    async image(ref) {
      const result = await deckClient.images.show(ref);
      return result.image;
    },
    async inspect(ref) {
      const result = await deckClient.managed.inspect(ref);
      return result.vm;
    },
    async prepare(input) {
      const result = await deckClient.managed.prepare(input.ref, input);
      return result.vm;
    },
    async restart(ref, operationRef, waitReadySeconds) {
      const result = await deckClient.managed.restart(ref, {
        operationRef,
        waitReady: String(waitReadySeconds),
      });
      return result.vm;
    },
    async restore(ref, backupRef, operationRef) {
      const result = await deckClient.managed.restore(ref, {
        backupRef,
        operationRef,
      });
      return result.vm;
    },
    async start(ref, operationRef, waitReadySeconds) {
      const result = await deckClient.managed.start(ref, {
        operationRef,
        waitReady: String(waitReadySeconds),
      });
      return result.vm;
    },
    async stop(ref, operationRef) {
      const result = await deckClient.managed.stop(ref, { operationRef });
      return result.vm;
    },
  };

  const ravi: ManagedRaviClientFactory = {
    create(baseUrl, contextKey) {
      return new RaviClient(raviTransportFactory({
        baseUrl,
        contextKey,
        fetch: createBoundedRaviSdkFetch(),
        timeoutMs: 0,
      })) as ManagedRaviClient;
    },
    createStream(baseUrl, contextKey) {
      return raviStreamFactory({
        baseUrl,
        contextKey,
      }) as ManagedRaviStreamClient;
    },
    protocolVersion: typeof raviVersionModule.SDK_VERSION === "string"
      ? raviVersionModule.SDK_VERSION
      : "1",
  };
  return { deck, ravi };
}

export function createBoundedRaviSdkFetch(options: {
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
} = {}): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxResponseBytes = options.maxResponseBytes ?? RAVI_SDK_MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? RAVI_SDK_REQUEST_TIMEOUT_MS;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const upstreamSignal = init?.signal ?? null;
    const signal = upstreamSignal
      ? AbortSignal.any([upstreamSignal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await fetchImpl(input, { ...init, signal });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        await response.body?.cancel();
        throw new Error("managed_runtime_sdk_response_too_large");
      }
      const body = await readBoundedResponseBody(response, maxResponseBytes);
      const headers = new Headers(response.headers);
      headers.set("content-length", String(body.byteLength));
      const responseBody = body.byteLength > 0
        ? body.buffer.slice(
          body.byteOffset,
          body.byteOffset + body.byteLength,
        ) as ArrayBuffer
        : null;
      return new Response(responseBody, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !upstreamSignal?.aborted) {
        throw new Error("managed_runtime_sdk_request_timeout");
      }
      throw error;
    }
  }) as typeof fetch;
}

async function readBoundedResponseBody(
  response: Response,
  maxResponseBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxResponseBytes) {
      await reader.cancel();
      throw new Error("managed_runtime_sdk_response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

type GeneratedDeckClient = {
  images: {
    show(ref: string): Promise<{ image: RuntimeImage }>;
  };
  managed: {
    backup(
      ref: string,
      options: JsonRecord,
    ): Promise<{ backup: ManagedBackup; vm: ManagedVm }>;
    create(name: string, options: JsonRecord): Promise<{ vm: ManagedVm }>;
    destroy(ref: string, options: JsonRecord): Promise<{ vm: ManagedVm }>;
    inspect(ref: string): Promise<{ vm: ManagedVm }>;
    prepare(ref: string, options: JsonRecord): Promise<{ vm: ManagedVm }>;
    restart(ref: string, options: JsonRecord): Promise<{ vm: ManagedVm }>;
    restore(ref: string, options: JsonRecord): Promise<{ vm: ManagedVm }>;
    start(ref: string, options: JsonRecord): Promise<{ vm: ManagedVm }>;
    stop(ref: string, options: JsonRecord): Promise<{ vm: ManagedVm }>;
  };
};

export function loadManagedRuntimeControlConfig(env: NodeJS.ProcessEnv = process.env): ManagedRuntimeControlConfig {
  return {
    claimOwner: optionalEnv(env, "RAVI_MANAGED_CLAIM_OWNER", optionalEnv(env, "RAVI_MANAGED_HOSTNAME", os.hostname())),
    claimTtlSeconds: integerEnv(env, "RAVI_MANAGED_CLAIM_TTL_SECONDS", 60, 15, 300),
    consoleControlToken: requiredEnv(env, "RAVI_RUNTIME_CONTROL_TOKEN"),
    consoleUrl: normalizeUrl(requiredEnv(env, "RAVI_RUNTIME_CONSOLE_URL")),
    credentialRoot: requiredAbsoluteEnv(env, "RAVI_MANAGED_CREDENTIAL_ROOT", "/var/lib/ravi-runtime-control/credentials"),
    deckContextKey: requiredEnv(env, "RAVI_DECK_CONTEXT_KEY"),
    deckGatewayUrl: normalizeUrl(requiredEnv(env, "RAVI_DECK_GATEWAY_URL")),
    deckSdkPath: requiredAbsoluteEnv(env, "RAVI_DECK_SDK_PATH", "/var/lib/ravi-runtime-control/sdk/deck"),
    environment: environmentEnv(env),
    hostName: optionalEnv(env, "RAVI_MANAGED_HOSTNAME", os.hostname()),
    hostProvider: optionalEnv(env, "RAVI_MANAGED_HOST_PROVIDER", "ovh"),
    imageName: optionalEnv(env, "RAVI_MANAGED_IMAGE_NAME", "ravi-codex-p0b"),
    pollIntervalMs: integerEnv(env, "RAVI_MANAGED_POLL_INTERVAL_MS", 2_000, 250, 60_000),
    providerBrokerRegistryPath: requiredAbsoluteEnv(
      env,
      "RAVI_PROVIDER_BROKER_REGISTRY",
      "/var/lib/ravi-runtime-control/provider-broker/instances.json",
    ),
    raviSdkPath: requiredAbsoluteEnv(env, "RAVI_SDK_PATH", "/var/lib/ravi-runtime-control/sdk/ravi"),
    region: nullableEnv(env, "RAVI_MANAGED_REGION", "bhs"),
    stateRoot: requiredAbsoluteEnv(env, "RAVI_MANAGED_STATE_ROOT", "/var/lib/ravi-runtime-control"),
    vercelBypassSecret: nullableEnv(env, "VERCEL_AUTOMATION_BYPASS_SECRET", null),
    waitReadySeconds: integerEnv(env, "RAVI_MANAGED_WAIT_READY_SECONDS", 90, 10, 300),
  };
}

function sizeForOperation(operation: ManagedOperation) {
  const preset = typeof operation.safeInput.sizePreset === "string"
    ? operation.safeInput.sizePreset
    : "small";
  if (preset !== "small") throw runtimeFailure("managed_size_preset_unsupported");
  return { memoryMib: 4096, stateDiskMib: 8192, vcpu: 2 };
}

function instanceRefFor(instanceId: string) {
  return `managed-${safeId(instanceId)}`;
}

function stableCreateOperationRef(instanceId: string) {
  return `managed-create-${safeId(instanceId)}`;
}

function deckNameFor(operation: ManagedOperation) {
  const suffix = safeId(operation.instanceId)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  if (suffix.length < 8) throw runtimeFailure("managed_identifier_invalid");

  const maxDisplayLength = 63 - suffix.length - 1;
  const display = operation.instance.displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxDisplayLength)
    .replace(/-+$/g, "");
  return `${display || "managed-ravi"}-${suffix}`;
}

function safeId(value: string) {
  const safe = value.replace(UUID_FRAGMENT, "-");
  if (!safe || safe.length > 180) throw runtimeFailure("managed_identifier_invalid");
  return safe;
}

function assertVmHealthy(vm: ManagedVm) {
  if (vm.state === "failed" || vm.state === "quarantined" || vm.state === "destroyed") {
    throw runtimeFailure(vm.quarantinedReason ?? vm.failureCode ?? "managed_deck_vm_unhealthy");
  }
}

function assertVmRunning(vm: ManagedVm) {
  assertVmHealthy(vm);
  if (vm.state !== "running" || vm.facts.gatewayHealthy !== true) {
    throw runtimeFailure(vm.failureCode ?? "managed_deck_vm_not_ready");
  }
}

function hasDeckResources(facts: JsonRecord) {
  return Object.entries(facts).some(([key, value]) => key === "firecrackerPid" ? value !== null : value === true);
}

function controllerClaimUrl(controlEndpoint: string) {
  return controllerControlUrl(controlEndpoint, "/controller/claim");
}

function controllerControlUrl(controlEndpoint: string, pathname: string) {
  const url = new URL(controlEndpoint);
  if (!isPrivateAddress(url.hostname)) throw runtimeFailure("managed_guest_endpoint_not_private");
  url.port = "4212";
  url.pathname = pathname;
  url.search = "";
  return url.toString();
}

function guestIpForControlEndpoint(controlEndpoint: string) {
  const url = new URL(controlEndpoint);
  if (!isPrivateAddress(url.hostname) || !/^\d+(?:\.\d+){3}$/.test(url.hostname)) {
    throw runtimeFailure("managed_guest_endpoint_not_private");
  }
  return url.hostname;
}

function providerBrokerBaseUrlFor(controlEndpoint: string) {
  const guestIp = guestIpForControlEndpoint(controlEndpoint);
  const octets = guestIp.split(".").map(Number);
  if (
    octets.length !== 4
    || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    || octets[0] !== 172
    || octets[1] !== 30
  ) {
    throw runtimeFailure("managed_provider_broker_network_invalid");
  }
  const address = (
    ((octets[0] as number) << 24)
    + ((octets[1] as number) << 16)
    + ((octets[2] as number) << 8)
    + (octets[3] as number)
  ) >>> 0;
  if (address % 4 !== 2) {
    throw runtimeFailure("managed_provider_broker_network_invalid");
  }
  const gateway = address - 1;
  const gatewayIp = [24, 16, 8, 0]
    .map((shift) => (gateway >>> shift) & 255)
    .join(".");
  return `http://${gatewayIp}:7443/v1`;
}

function isPrivateAddress(hostname: string) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname.startsWith("10.")
    || hostname.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

function readinessDiagnosticCode(payload: JsonRecord) {
  if (payload.ready === true) return null;
  const currentCheck = safeReadinessCheck(payload.currentCheck);
  if (payload.code === "readiness_pending" && currentCheck) {
    return `managed_appliance_readiness_timeout_${currentCheck}`;
  }
  const failedChecks = Array.isArray(payload.failedChecks)
    ? payload.failedChecks.map(safeReadinessCheck).filter((value): value is string => Boolean(value))
    : [];
  if (payload.code === "readiness_failed" && failedChecks.length > 0) {
    return `managed_appliance_readiness_failed_${failedChecks[0]}`;
  }
  return null;
}

function safeReadinessCheck(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value)
    ? value
    : null;
}

function parseControllerCredential(body: JsonRecord, instanceId: string): ControllerCredential {
  const candidate = isRecord(body.credential) ? body.credential : null;
  if (!candidate) throw runtimeFailure("managed_controller_credential_response_invalid");
  return parseStoredCredential(candidate, instanceId);
}

function parseStoredCredential(value: JsonRecord, instanceId: string): ControllerCredential {
  if (
    value.schemaVersion !== "ravi.managed-appliance.controller-credential/v1"
    || typeof value.contextId !== "string"
    || typeof value.contextKey !== "string"
    || !value.contextKey.startsWith("rctx_")
    || value.instanceId !== instanceId
    || (value.expiresAt !== null && typeof value.expiresAt !== "string")
  ) {
    throw runtimeFailure("managed_controller_credential_invalid");
  }
  return value as ControllerCredential;
}

function parsePendingClaim(value: JsonRecord, instanceId: string): PendingControllerClaim {
  if (
    value.schemaVersion !== "ravi.managed-runtime.pending-controller-claim/v1"
    || value.instanceId !== instanceId
    || typeof value.operationId !== "string"
    || typeof value.vmId !== "string"
    || typeof value.claimToken !== "string"
    || !value.claimToken.startsWith("ravi_mcc_")
    || typeof value.bootstrapExpiresAt !== "string"
  ) {
    throw runtimeFailure("managed_controller_claim_invalid");
  }
  return value as PendingControllerClaim;
}

function parseControllerRotationGrant(value: unknown): ControllerRotationGrant {
  if (
    !isRecord(value)
    || typeof value.grantId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.grantId,
    )
    || typeof value.credentialClaimToken !== "string"
    || !/^ravi_mcc_[A-Za-z0-9_-]{32,128}$/.test(value.credentialClaimToken)
    || typeof value.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.expiresAt))
    || typeof value.payloadBase64 !== "string"
    || value.payloadBase64.length < 16
    || value.payloadBase64.length > 128 * 1024
    || typeof value.signatureBase64 !== "string"
    || value.signatureBase64.length < 16
    || value.signatureBase64.length > 2 * 1024
  ) {
    throw runtimeFailure("managed_controller_rotation_grant_invalid");
  }
  return {
    credentialClaimToken: value.credentialClaimToken,
    expiresAt: value.expiresAt,
    grantId: value.grantId,
    payloadBase64: value.payloadBase64,
    signatureBase64: value.signatureBase64,
  };
}

function parsePendingRotation(
  value: JsonRecord,
  instanceId: string,
): PendingControllerRotation {
  const stages = new Set([
    "credential_claimed",
    "credential_persisted",
    "grant_issued",
    "guest_acknowledged",
    "guest_prepared",
  ]);
  if (
    value.schemaVersion !== "ravi.managed-runtime.pending-controller-rotation/v1"
    || value.instanceId !== instanceId
    || typeof value.operationId !== "string"
    || typeof value.vmId !== "string"
    || typeof value.deckInstanceRef !== "string"
    || typeof value.stage !== "string"
    || !stages.has(value.stage)
  ) {
    throw runtimeFailure("managed_controller_rotation_state_invalid");
  }
  if (value.stage === "guest_acknowledged") {
    if (
      typeof value.replacementContextId !== "string"
      || value.grant !== null
      || value.previousContextId !== null
      || value.replacement !== null
    ) {
      throw runtimeFailure("managed_controller_rotation_state_invalid");
    }
  } else {
    parseControllerRotationGrant(value.grant);
    if (typeof value.previousContextId !== "string") {
      throw runtimeFailure("managed_controller_rotation_state_invalid");
    }
    if (
      new Set(["credential_claimed", "credential_persisted"]).has(value.stage)
      && (!isRecord(value.replacement)
        || parseStoredCredential(value.replacement, instanceId).contextId
          !== value.replacementContextId)
    ) {
      throw runtimeFailure("managed_controller_rotation_state_invalid");
    }
  }
  return value as PendingControllerRotation;
}

function requireRotationGrant(
  pending: PendingControllerRotation,
): ControllerRotationGrant {
  if (!pending.grant) {
    throw runtimeFailure("managed_controller_rotation_grant_missing");
  }
  return parseControllerRotationGrant(pending.grant);
}

function rotationGrantExpired(
  pending: PendingControllerRotation,
  now: Date,
): boolean {
  const expiresAt = Date.parse(requireRotationGrant(pending).expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function requireRotationReplacement(
  pending: PendingControllerRotation,
): ControllerCredential {
  if (!pending.replacement) {
    throw runtimeFailure("managed_controller_rotation_replacement_missing");
  }
  return parseStoredCredential(pending.replacement, pending.instanceId);
}

function assertPendingRotationBinding(
  pending: PendingControllerRotation,
  operation: ManagedOperation,
  vm: ManagedVm,
  current: ControllerCredential,
) {
  if (
    pending.instanceId !== operation.instanceId
    || pending.operationId !== operation.id
    || pending.vmId !== vm.id
    || pending.deckInstanceRef !== vm.instanceRef
    || pending.deckInstanceRef !== instanceRefFor(operation.instanceId)
  ) {
    throw runtimeFailure("managed_controller_rotation_binding_invalid");
  }
  const validContextIds = new Set([
    pending.previousContextId,
    pending.replacementContextId,
  ]);
  if (!validContextIds.has(current.contextId)) {
    throw runtimeFailure("managed_controller_rotation_state_conflict");
  }
}

function acknowledgedRotationState(
  pending: PendingControllerRotation,
  replacementContextId: string,
): PendingControllerRotation {
  return {
    deckInstanceRef: pending.deckInstanceRef,
    grant: null,
    instanceId: pending.instanceId,
    operationId: pending.operationId,
    previousContextId: null,
    replacement: null,
    replacementContextId,
    schemaVersion: "ravi.managed-runtime.pending-controller-rotation/v1",
    stage: "guest_acknowledged",
    vmId: pending.vmId,
  };
}

function assertCredentialUsable(credential: ControllerCredential, now: Date) {
  if (!credential.expiresAt) return;
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() + 60_000) {
    throw runtimeFailure("managed_controller_credential_expired");
  }
}

function connectionEvidence(
  instanceId: string,
  endpoint: string,
  protocolVersion: string,
  status: "offline" | "online" | "revoked",
  contextId?: string,
) {
  return {
    credentialRef: contextId
      ? `cred_${shortHash(`${instanceId}:${contextId}`)}`
      : null,
    kind: "private_ravi_sdk",
    protocolVersion: protocolVersion.slice(0, 40) || "1",
    safeEndpointRef: `endpoint_${shortHash(`${instanceId}:${endpoint}`)}`,
    status,
  };
}

function observedStateForRunningPhase(phase: string) {
  if (phase === "rotating_controller") return "starting";
  if (phase === "starting" || phase === "validating_sdk") return "starting";
  if (phase === "restarting") return "restarting";
  if (phase === "stopping") return "stopping";
  if (phase === "deleting") return "deleting";
  return "provisioning";
}

function failedObservedState(action: ManagedAction) {
  return action === "delete" ? "deleting" : "failed";
}

function retryableFailure(code: string) {
  return !new Set([
    "managed_action_unsupported",
    "managed_backup_operation_id_invalid",
    "managed_backup_ref_invalid",
    "managed_identifier_invalid",
    "managed_provider_unsupported",
    "managed_size_preset_unsupported",
  ]).has(code);
}

function isDeckVmNotFound(error: unknown) {
  return deckErrorCode(error) === "managed_vm_not_found";
}

function safeFailureCode(error: unknown) {
  if (error instanceof ManagedRuntimeControlError) return error.code;
  const deckCode = deckErrorCode(error);
  if (deckCode) return deckCode;
  return "managed_runtime_control_failed";
}

function deckErrorCode(error: unknown) {
  if (!isRecord(error)) return null;
  const body = isRecord(error.body) ? error.body : null;
  for (const candidate of [
    error.code,
    error.reason,
    error.error,
    error.message,
    body?.code,
    body?.reason,
    body?.error,
    body?.message,
  ]) {
    if (
      typeof candidate === "string"
      && SAFE_CODE.test(candidate)
      && !/token|secret|credential/i.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

class ManagedRuntimeControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ManagedRuntimeControlError";
  }
}

function runtimeFailure(code: string) {
  const safe = SAFE_CODE.test(code) && !/token|secret|credential_key/i.test(code)
    ? code
    : "managed_runtime_control_failed";
  return new ManagedRuntimeControlError(safe);
}

async function readJsonFile(filePath: string): Promise<JsonRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(value) ? value : null;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw runtimeFailure("managed_secret_store_read_failed");
  }
}

async function readProviderBrokerRegistry(
  filePath: string,
): Promise<ProviderBrokerRegistry> {
  let value: JsonRecord | null;
  try {
    value = await readJsonFile(filePath);
  } catch {
    throw runtimeFailure("managed_provider_broker_registry_invalid");
  }
  if (!value) {
    return {
      entries: [],
      schemaVersion: "ravi.managed-provider-broker.registry/v1",
      updatedAt: new Date(0).toISOString(),
    };
  }
  if (
    value.schemaVersion !== "ravi.managed-provider-broker.registry/v1"
    || typeof value.updatedAt !== "string"
    || !Array.isArray(value.entries)
    || !value.entries.every(isProviderBrokerRegistryEntry)
  ) {
    throw runtimeFailure("managed_provider_broker_registry_invalid");
  }
  return value as ProviderBrokerRegistry;
}

function isProviderBrokerRegistryEntry(
  value: unknown,
): value is ProviderBrokerRegistryEntry {
  if (!isRecord(value)) return false;
  try {
    guestIpForControlEndpoint(`http://${String(value.guestIp)}:4211`);
  } catch {
    return false;
  }
  return typeof value.instanceId === "string"
    && typeof value.vmId === "string"
    && typeof value.updatedAt === "string"
    && (value.status === "active" || value.status === "revoked");
}

async function writeProviderBrokerRegistry(
  filePath: string,
  value: ProviderBrokerRegistry,
) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { mode: 0o750, recursive: true });
  await chmod(directory, 0o750);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
    { mode: 0o640 },
  );
  await chmod(temporary, 0o640);
  await rename(temporary, filePath);
  await chmod(filePath, 0o640);
}

async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
}

async function ensureRuntimeStateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o750, recursive: true });
  await chmod(directory, 0o750);
}

async function writePrivateJson(filePath: string, value: object) {
  await writePrivateFile(filePath, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function writePrivateFile(filePath: string, value: Uint8Array) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

async function safeJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeRemoteCode(body: JsonRecord) {
  for (const candidate of [body.code, body.error, isRecord(body.error) ? body.error.code : null]) {
    if (typeof candidate === "string" && SAFE_CODE.test(candidate) && !/token|secret|credential/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function requiredMetadataString(metadata: JsonRecord, key: string) {
  const value = metadata[key];
  if (typeof value !== "string" || !value) throw runtimeFailure("managed_image_metadata_invalid");
  return value;
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function importModule(filePath: string): Promise<JsonRecord> {
  try {
    const value: unknown = await import(pathToFileURL(filePath).href);
    if (!isRecord(value)) throw new Error("module_invalid");
    return value;
  } catch {
    throw runtimeFailure("managed_generated_sdk_load_failed");
  }
}

function requiredConstructor(module: JsonRecord, key: string) {
  const value = module[key];
  if (typeof value !== "function") throw runtimeFailure("managed_generated_sdk_invalid");
  return value as new (transport: unknown) => unknown;
}

function requiredFunction(module: JsonRecord, key: string) {
  const value = module[key];
  if (typeof value !== "function") throw runtimeFailure("managed_generated_sdk_invalid");
  return value as (config: JsonRecord) => unknown;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw runtimeFailure("managed_runtime_control_config_missing");
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  return env[name]?.trim() || fallback;
}

function nullableEnv(env: NodeJS.ProcessEnv, name: string, fallback: string | null) {
  const value = env[name];
  if (value === undefined) return fallback;
  return value.trim() || null;
}

function requiredAbsoluteEnv(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  const value = optionalEnv(env, name, fallback);
  if (!path.isAbsolute(value)) throw runtimeFailure("managed_runtime_control_path_invalid");
  return value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw runtimeFailure("managed_runtime_control_config_invalid");
  }
  return value;
}

function environmentEnv(env: NodeJS.ProcessEnv) {
  const value = optionalEnv(env, "RAVI_MANAGED_ENVIRONMENT", "production");
  if (value === "development" || value === "preview" || value === "production") return value;
  throw runtimeFailure("managed_runtime_control_config_invalid");
}

function normalizeUrl(value: string) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw runtimeFailure("managed_runtime_control_url_invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function safeLog(event: string, details: JsonRecord) {
  console.log(JSON.stringify({ event, ...details }));
}

async function main() {
  const command = process.argv[2] ?? "serve";
  if (command === "help") {
    console.log("Usage: bun scripts/managed-runtime-control.ts [once|serve]");
    return;
  }
  if (command !== "once" && command !== "serve") {
    throw runtimeFailure("managed_runtime_control_command_invalid");
  }
  const config = loadManagedRuntimeControlConfig();
  const generated = await loadGeneratedSdkDependencies(config);
  const control = new ManagedRuntimeControl(config, {
    console: new ManagedRuntimeConsoleClient(config),
    deck: generated.deck,
    ravi: generated.ravi,
  });
  await control.initialize();
  if (command === "once") {
    safeLog("managed_runtime_control_once", await control.runOnce());
    return;
  }
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => abort.abort());
  }
  await control.serve(abort.signal);
}

if (import.meta.main) {
  main().catch((error) => {
    safeLog("managed_runtime_control_fatal", { code: safeFailureCode(error) });
    process.exitCode = 1;
  });
}
