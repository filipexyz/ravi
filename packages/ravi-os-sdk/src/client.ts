// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).

import type { Transport } from "./transport/types.js";
import type { AdaptersListReturn, AdaptersShowReturn, AgentsCreateReturn, AgentsDebounceReturn, AgentsDebugReturn, AgentsDeleteReturn, AgentsListReturn, AgentsResetReturn, AgentsSessionReturn, AgentsSetReturn, AgentsShowReturn, AgentsSpecModeReturn, AgentsSyncInstructionsReturn, ArtifactsArchiveReturn, ArtifactsAttachReturn, ArtifactsBlobReturn, ArtifactsCreateReturn, ArtifactsEventReturn, ArtifactsEventsReturn, ArtifactsListReturn, ArtifactsShowReturn, ArtifactsUpdateReturn, ArtifactsWatchReturn, AudioGenerateReturn, ContactsAddReturn, ContactsAllowReturn, ContactsApproveReturn, ContactsBlockReturn, ContactsCheckReturn, ContactsDuplicatesReturn, ContactsFindReturn, ContactsGetReturn, ContactsGroupTagReturn, ContactsGroupUntagReturn, ContactsIdentityAddReturn, ContactsIdentityRemoveReturn, ContactsInfoReturn, ContactsLinkReturn, ContactsListReturn, ContactsMergeReturn, ContactsPendingReturn, ContactsRemoveReturn, ContactsSetReturn, ContactsTagReturn, ContactsUnlinkReturn, ContactsUntagReturn, ContextAuthorizeReturn, ContextCapabilitiesReturn, ContextCheckReturn, ContextCodexBashHookReturn, ContextCredentialsAddReturn, ContextCredentialsListReturn, ContextCredentialsRemoveReturn, ContextCredentialsSetDefaultReturn, ContextInfoReturn, ContextIssueReturn, ContextLineageReturn, ContextListReturn, ContextRevokeReturn, ContextWhoamiReturn, CostsAgentReturn, CostsAgentsReturn, CostsSessionReturn, CostsSummaryReturn, CostsTopSessionsReturn, CronAddReturn, CronDisableReturn, CronEnableReturn, CronListReturn, CronRmReturn, CronRunReturn, CronSetReturn, CronShowReturn, DaemonDevReturn, DaemonEnvReturn, DaemonInitAdminKeyReturn, DaemonInstallReturn, DaemonLogsReturn, DaemonRestartReturn, DaemonRunReturn, DaemonStartReturn, DaemonStatusReturn, DaemonStopReturn, DaemonUninstallReturn, DevinAuthCheckReturn, DevinSessionsArchiveReturn, DevinSessionsAttachmentsReturn, DevinSessionsCreateReturn, DevinSessionsInsightsReturn, DevinSessionsListReturn, DevinSessionsMessagesReturn, DevinSessionsSendReturn, DevinSessionsShowReturn, DevinSessionsSyncReturn, DevinSessionsTerminateReturn, EvalRunReturn, EventsReplayReturn, EventsStreamReturn, HeartbeatDisableReturn, HeartbeatEnableReturn, HeartbeatSetReturn, HeartbeatShowReturn, HeartbeatStatusReturn, HeartbeatTriggerReturn, HooksCreateReturn, HooksDisableReturn, HooksEnableReturn, HooksListReturn, HooksRmReturn, HooksShowReturn, HooksTestReturn, ImageAtlasSplitReturn, ImageGenerateReturn, InsightsCreateReturn, InsightsListReturn, InsightsSearchReturn, InsightsShowReturn, InstancesConnectReturn, InstancesCreateReturn, InstancesDeleteReturn, InstancesDeletedReturn, InstancesDisableReturn, InstancesDisconnectReturn, InstancesEnableReturn, InstancesGetReturn, InstancesListReturn, InstancesPendingApproveReturn, InstancesPendingListReturn, InstancesPendingRejectReturn, InstancesRestoreReturn, InstancesRoutesAddReturn, InstancesRoutesDeletedReturn, InstancesRoutesListReturn, InstancesRoutesRemoveReturn, InstancesRoutesRestoreReturn, InstancesRoutesSetReturn, InstancesRoutesShowReturn, InstancesSetReturn, InstancesShowReturn, InstancesStatusReturn, InstancesTargetReturn, MediaSendReturn, PermissionsCheckReturn, PermissionsClearReturn, PermissionsGrantReturn, PermissionsInitReturn, PermissionsListReturn, PermissionsRevokeReturn, PermissionsSyncReturn, ProjectsCreateReturn, ProjectsFixturesSeedReturn, ProjectsInitReturn, ProjectsLinkReturn, ProjectsListReturn, ProjectsNextReturn, ProjectsResourcesAddReturn, ProjectsResourcesImportReturn, ProjectsResourcesListReturn, ProjectsResourcesShowReturn, ProjectsShowReturn, ProjectsStatusReturn, ProjectsTasksAttachReturn, ProjectsTasksCreateReturn, ProjectsTasksDispatchReturn, ProjectsUpdateReturn, ProjectsWorkflowsAttachReturn, ProjectsWorkflowsStartReturn, ProxCallsCancelReturn, ProxCallsEventsReturn, ProxCallsProfilesConfigureReturn, ProxCallsProfilesListReturn, ProxCallsProfilesShowReturn, ProxCallsRequestReturn, ProxCallsRulesReturn, ProxCallsShowReturn, ProxCallsToolsBindReturn, ProxCallsToolsConfigureReturn, ProxCallsToolsCreateReturn, ProxCallsToolsListReturn, ProxCallsToolsRunReturn, ProxCallsToolsRunsReturn, ProxCallsToolsShowReturn, ProxCallsToolsUnbindReturn, ProxCallsTranscriptReturn, ProxCallsVoiceAgentsBindToolReturn, ProxCallsVoiceAgentsConfigureReturn, ProxCallsVoiceAgentsCreateReturn, ProxCallsVoiceAgentsListReturn, ProxCallsVoiceAgentsShowReturn, ProxCallsVoiceAgentsSyncReturn, ProxCallsVoiceAgentsUnbindToolReturn, ReactSendReturn, RoutesExplainReturn, RoutesListReturn, RoutesShowReturn, SdkClientCheckReturn, SdkClientGenerateReturn, SdkOpenapiCheckReturn, SdkOpenapiEmitReturn, ServiceStartReturn, ServiceTuiReturn, ServiceWaReturn, SessionsAnswerReturn, SessionsAskReturn, SessionsDebugReturn, SessionsDeleteReturn, SessionsExecuteReturn, SessionsExtendReturn, SessionsInfoReturn, SessionsInformReturn, SessionsKeepReturn, SessionsListReturn, SessionsReadReturn, SessionsRenameReturn, SessionsResetReturn, SessionsRuntimeFollowUpReturn, SessionsRuntimeForkReturn, SessionsRuntimeInterruptReturn, SessionsRuntimeListReturn, SessionsRuntimeReadReturn, SessionsRuntimeRollbackReturn, SessionsRuntimeSteerReturn, SessionsSendReturn, SessionsSetDisplayReturn, SessionsSetModelReturn, SessionsSetThinkingReturn, SessionsSetTtlReturn, SessionsTraceReturn, SettingsDeleteReturn, SettingsGetReturn, SettingsListReturn, SettingsSetReturn, SkillsInstallReturn, SkillsListReturn, SkillsShowReturn, SkillsSyncReturn, SpecsGetReturn, SpecsListReturn, SpecsNewReturn, SpecsSyncReturn, StickersAddReturn, StickersListReturn, StickersRemoveReturn, StickersSendReturn, StickersShowReturn, TagsAttachReturn, TagsCreateReturn, TagsDetachReturn, TagsListReturn, TagsSearchReturn, TagsShowReturn, TasksArchiveReturn, TasksAutomationsAddReturn, TasksAutomationsDisableReturn, TasksAutomationsEnableReturn, TasksAutomationsListReturn, TasksAutomationsRmReturn, TasksAutomationsShowReturn, TasksBlockReturn, TasksCommentReturn, TasksCreateReturn, TasksDepsAddReturn, TasksDepsLsReturn, TasksDepsRmReturn, TasksDispatchReturn, TasksDoneReturn, TasksFailReturn, TasksListReturn, TasksProfilesInitReturn, TasksProfilesListReturn, TasksProfilesPreviewReturn, TasksProfilesShowReturn, TasksProfilesValidateReturn, TasksReportReturn, TasksShowReturn, TasksUnarchiveReturn, TasksWatchReturn, TmuxAttachReturn, TmuxListReturn, TmuxOpenReturn, TmuxWatchReturn, ToolsListReturn, ToolsManifestReturn, ToolsSchemaReturn, ToolsShowReturn, ToolsTestReturn, TranscribeFileReturn, TriggersAddReturn, TriggersDisableReturn, TriggersEnableReturn, TriggersListReturn, TriggersRmReturn, TriggersSetReturn, TriggersShowReturn, TriggersTestReturn, VideoAnalyzeReturn, WhatsappDmAckReturn, WhatsappDmReadReturn, WhatsappDmSendReturn, WhatsappGroupAddReturn, WhatsappGroupCreateReturn, WhatsappGroupDemoteReturn, WhatsappGroupDescriptionReturn, WhatsappGroupInfoReturn, WhatsappGroupInviteReturn, WhatsappGroupJoinReturn, WhatsappGroupLeaveReturn, WhatsappGroupListReturn, WhatsappGroupPromoteReturn, WhatsappGroupRemoveReturn, WhatsappGroupRenameReturn, WhatsappGroupRevokeInviteReturn, WhatsappGroupSettingsReturn, WorkflowsRunsArchiveNodeReturn, WorkflowsRunsCancelReturn, WorkflowsRunsListReturn, WorkflowsRunsReleaseReturn, WorkflowsRunsShowReturn, WorkflowsRunsSkipReturn, WorkflowsRunsStartReturn, WorkflowsRunsTaskAttachReturn, WorkflowsRunsTaskCreateReturn, WorkflowsSpecsCreateReturn, WorkflowsSpecsListReturn, WorkflowsSpecsShowReturn } from "./types.js";

/**
 * `RaviClient` exposes every registry command as a typed method.
 *
 * The class is generated 1:1 from `getRegistry()`. Every method calls into
 * the supplied `Transport`, which is responsible for validation, scope
 * enforcement, and audit (see `transport/http.ts` and
 * `transport/in-process.ts`).
 */
export class RaviClient {
  constructor(private readonly transport: Transport) {}

  readonly adapters = {
    /** List session adapters with health and bind state */
    list: async (options?: {
      session?: string;
      status?: string;
    }): Promise<AdaptersListReturn> => {
      return this.transport.call({
        groupSegments: ["adapters"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Show a session adapter debug snapshot */
    show: async (adapterId: string): Promise<AdaptersShowReturn> => {
      return this.transport.call({
        groupSegments: ["adapters"],
        command: "show",
        body: { adapterId },
      });
    }
  };

  readonly agents = {
    /** Create a new agent */
    create: async (id: string, cwd: string, options?: {
      allowRuntimeMismatch?: boolean;
      provider?: string;
    }): Promise<AgentsCreateReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "create",
        body: { id, cwd, ...(options ?? {}) },
      });
    },
    /** Set message debounce time */
    debounce: async (id: string, ms?: string): Promise<AgentsDebounceReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "debounce",
        body: { id, ms },
      });
    },
    /** Show last turns of an agent session (what it received, what it responded) */
    debug: async (id: string, nameOrKey?: string, options?: {
      turns?: string;
    }): Promise<AgentsDebugReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "debug",
        body: { id, nameOrKey, ...(options ?? {}) },
      });
    },
    /** Delete an agent */
    delete: async (id: string): Promise<AgentsDeleteReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "delete",
        body: { id },
      });
    },
    /** List all agents */
    list: async (): Promise<AgentsListReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "list",
        body: {},
      });
    },
    /** Reset agent session */
    reset: async (id: string, nameOrKey?: string): Promise<AgentsResetReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "reset",
        body: { id, nameOrKey },
      });
    },
    /** Show agent session status */
    session: async (id: string): Promise<AgentsSessionReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "session",
        body: { id },
      });
    },
    /** Set agent property */
    set: async (id: string, key: string, value: string): Promise<AgentsSetReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "set",
        body: { id, key, value },
      });
    },
    /** Show agent details */
    show: async (id: string): Promise<AgentsShowReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "show",
        body: { id },
      });
    },
    /** Enable or disable spec mode for an agent */
    specMode: async (id: string, enabled?: string): Promise<AgentsSpecModeReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "spec-mode",
        body: { id, enabled },
      });
    },
    /** Migrate agent workspaces to AGENTS.md as the canonical file */
    syncInstructions: async (options?: {
      agent?: string;
      materializeMissing?: boolean;
    }): Promise<AgentsSyncInstructionsReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "sync-instructions",
        body: { ...(options ?? {}) },
      });
    }
  };

  readonly artifacts = {
    /** Soft-archive an artifact */
    archive: async (id: string): Promise<ArtifactsArchiveReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "archive",
        body: { id },
      });
    },
    /** Attach an artifact to a task, session, message or any target */
    attach: async (id: string, targetType: string, targetId: string, options?: {
      metadata?: string;
      relation?: string;
    }): Promise<ArtifactsAttachReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "attach",
        body: { id, targetType, targetId, ...(options ?? {}) },
      });
    },
    /** Stream raw artifact bytes */
    blob: async (id: string): Promise<ArtifactsBlobReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "blob",
        body: { id },
        binary: true,
      });
    },
    /** Create a generic Ravi artifact record */
    create: async (kind: string, options?: {
      command?: string;
      costUsd?: string;
      durationMs?: string;
      input?: string;
      inputTokens?: string;
      lineage?: string;
      message?: string;
      metadata?: string;
      metrics?: string;
      mime?: string;
      model?: string;
      output?: string;
      outputTokens?: string;
      path?: string;
      prompt?: string;
      provider?: string;
      session?: string;
      summary?: string;
      tags?: string;
      task?: string;
      title?: string;
      totalTokens?: string;
      uri?: string;
    }): Promise<ArtifactsCreateReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "create",
        body: { kind, ...(options ?? {}) },
      });
    },
    /** Append an artifact lifecycle event */
    event: async (id: string, eventType: string, options?: {
      message?: string;
      payload?: string;
      source?: string;
      status?: string;
    }): Promise<ArtifactsEventReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "event",
        body: { id, eventType, ...(options ?? {}) },
      });
    },
    /** List artifact lifecycle events */
    events: async (id: string): Promise<ArtifactsEventsReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "events",
        body: { id },
      });
    },
    /** List artifacts */
    list: async (options?: {
      agent?: string;
      includeDeleted?: boolean;
      kind?: string;
      lifecycle?: string;
      limit?: string;
      rich?: boolean;
      session?: string;
      tag?: string;
      task?: string;
    }): Promise<ArtifactsListReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Show artifact details, links and events */
    show: async (id: string): Promise<ArtifactsShowReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "show",
        body: { id },
      });
    },
    /** Edit artifact metadata and high-level fields */
    update: async (id: string, options?: {
      command?: string;
      costUsd?: string;
      durationMs?: string;
      input?: string;
      inputTokens?: string;
      lineage?: string;
      message?: string;
      metadata?: string;
      metrics?: string;
      mime?: string;
      model?: string;
      output?: string;
      outputTokens?: string;
      path?: string;
      prompt?: string;
      provider?: string;
      session?: string;
      status?: string;
      summary?: string;
      tags?: string;
      task?: string;
      title?: string;
      totalTokens?: string;
      uri?: string;
    }): Promise<ArtifactsUpdateReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "update",
        body: { id, ...(options ?? {}) },
      });
    },
    /** Watch artifact lifecycle until a terminal status */
    watch: async (id: string, options?: {
      intervalMs?: string;
      timeoutMs?: string;
    }): Promise<ArtifactsWatchReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "watch",
        body: { id, ...(options ?? {}) },
      });
    }
  };

  readonly audio = {
    /** Generate speech from text using ElevenLabs TTS */
    generate: async (text: string, options?: {
      caption?: string;
      format?: string;
      lang?: string;
      model?: string;
      output?: string;
      send?: boolean;
      speed?: string;
      voice?: string;
    }): Promise<AudioGenerateReturn> => {
      return this.transport.call({
        groupSegments: ["audio"],
        command: "generate",
        body: { text, ...(options ?? {}) },
      });
    }
  };

  readonly contacts = {
    /** Add/allow a contact */
    add: async (identity: string, name?: string, options?: {
      agent?: string;
      kind?: string;
    }): Promise<ContactsAddReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "add",
        body: { identity, name, ...(options ?? {}) },
      });
    },
    /** Allow a contact */
    allow: async (contact: string): Promise<ContactsAllowReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "allow",
        body: { contact },
      });
    },
    /** Approve pending contact */
    approve: async (contact: string, mode?: string, options?: {
      agent?: string;
    }): Promise<ContactsApproveReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "approve",
        body: { contact, mode, ...(options ?? {}) },
      });
    },
    /** Block a contact */
    block: async (contact: string): Promise<ContactsBlockReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "block",
        body: { contact },
      });
    },
    /** Check contact status (alias for info) */
    check: async (contact: string): Promise<ContactsCheckReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "check",
        body: { contact },
      });
    },
    /** Find likely duplicate contacts */
    duplicates: async (): Promise<ContactsDuplicatesReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "duplicates",
        body: {},
      });
    },
    /** Find contacts by tag or search query */
    find: async (query: string, options?: {
      tag?: boolean;
    }): Promise<ContactsFindReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "find",
        body: { query, ...(options ?? {}) },
      });
    },
    /** Show canonical contact details */
    get: async (contact: string): Promise<ContactsGetReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "get",
        body: { contact },
      });
    },
    /** Set a contact's tag in a specific group */
    groupTag: async (contact: string, group: string, tag: string): Promise<ContactsGroupTagReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "group-tag",
        body: { contact, group, tag },
      });
    },
    /** Remove a contact's tag from a specific group */
    groupUntag: async (contact: string, group: string): Promise<ContactsGroupUntagReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "group-untag",
        body: { contact, group },
      });
    },
    /** Add an identity to a contact (legacy alias for link) */
    identityAdd: async (contact: string, platform: string, value: string): Promise<ContactsIdentityAddReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "identity-add",
        body: { contact, platform, value },
      });
    },
    /** Remove an identity (legacy alias for unlink) */
    identityRemove: async (platform: string, value: string): Promise<ContactsIdentityRemoveReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "identity-remove",
        body: { platform, value },
      });
    },
    /** Show contact details with all identities */
    info: async (contact: string): Promise<ContactsInfoReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "info",
        body: { contact },
      });
    },
    /** Link a platform identity to a contact */
    link: async (contact: string, options?: {
      channel?: string;
      id?: string;
      instance?: string;
      reason?: string;
    }): Promise<ContactsLinkReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "link",
        body: { contact, ...(options ?? {}) },
      });
    },
    /** List all contacts */
    list: async (options?: {
      status?: string;
    }): Promise<ContactsListReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Merge two contacts (move identities from source to target) */
    merge: async (source: string, target: string): Promise<ContactsMergeReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "merge",
        body: { source, target },
      });
    },
    /** List pending contacts */
    pending: async (options?: {
      account?: string;
    }): Promise<ContactsPendingReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "pending",
        body: { ...(options ?? {}) },
      });
    },
    /** Remove a contact */
    remove: async (contact: string): Promise<ContactsRemoveReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "remove",
        body: { contact },
      });
    },
    /** Set contact property */
    set: async (contact: string, key: string, value: string): Promise<ContactsSetReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "set",
        body: { contact, key, value },
      });
    },
    /** Add a tag to a contact */
    tag: async (contact: string, tag: string): Promise<ContactsTagReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "tag",
        body: { contact, tag },
      });
    },
    /** Unlink a platform identity from its contact */
    unlink: async (platformIdentity: string, options?: {
      channel?: string;
      instance?: string;
      reason?: string;
    }): Promise<ContactsUnlinkReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "unlink",
        body: { platformIdentity, ...(options ?? {}) },
      });
    },
    /** Remove a tag from a contact */
    untag: async (contact: string, tag: string): Promise<ContactsUntagReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "untag",
        body: { contact, tag },
      });
    }
  };

  readonly context = {
    /** Request approval and extend the current runtime context if approved */
    authorize: async (permission: string, objectType: string, objectId: string): Promise<ContextAuthorizeReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "authorize",
        body: { permission, objectType, objectId },
      });
    },
    /** List inherited capabilities for the current runtime context */
    capabilities: async (): Promise<ContextCapabilitiesReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "capabilities",
        body: {},
      });
    },
    /** Check whether the current runtime context allows an action */
    check: async (permission: string, objectType: string, objectId: string): Promise<ContextCheckReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "check",
        body: { permission, objectType, objectId },
      });
    },
    /** Evaluate a Codex PreToolUse Bash hook payload from stdin using the current Ravi context */
    codexBashHook: async (): Promise<ContextCodexBashHookReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "codex-bash-hook",
        body: {},
      });
    },
    credentials: {
      /** Add a runtime context-key to the local credentials store */
      add: async (contextKey: string, options?: {
        label?: string;
        setDefault?: boolean;
      }): Promise<ContextCredentialsAddReturn> => {
        return this.transport.call({
          groupSegments: ["context","credentials"],
          command: "add",
          body: { contextKey, ...(options ?? {}) },
        });
      },
      /** List entries in the local credentials store */
      list: async (): Promise<ContextCredentialsListReturn> => {
        return this.transport.call({
          groupSegments: ["context","credentials"],
          command: "list",
          body: {},
        });
      },
      /** Remove a stored context-key from the credentials store */
      remove: async (contextKey: string): Promise<ContextCredentialsRemoveReturn> => {
        return this.transport.call({
          groupSegments: ["context","credentials"],
          command: "remove",
          body: { contextKey },
        });
      },
      /** Mark a stored context-key as the default */
      setDefault: async (contextKey: string): Promise<ContextCredentialsSetDefaultReturn> => {
        return this.transport.call({
          groupSegments: ["context","credentials"],
          command: "set-default",
          body: { contextKey },
        });
      }
    },
    /** Show full runtime context details without exposing the context key */
    info: async (contextId: string): Promise<ContextInfoReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "info",
        body: { contextId },
      });
    },
    /** Issue a least-privilege child context for an external CLI */
    issue: async (cliName: string, options?: {
      allow?: string;
      inherit?: boolean;
      ttl?: string;
    }): Promise<ContextIssueReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "issue",
        body: { cliName, ...(options ?? {}) },
      });
    },
    /** Show ancestor chain and descendant tree for a runtime context */
    lineage: async (contextId: string): Promise<ContextLineageReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "lineage",
        body: { contextId },
      });
    },
    /** List issued runtime contexts without exposing context keys */
    list: async (options?: {
      agent?: string;
      all?: boolean;
      kind?: string;
      session?: string;
    }): Promise<ContextListReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Revoke a runtime context by context ID */
    revoke: async (contextId: string, options?: {
      noCascade?: boolean;
      reason?: string;
    }): Promise<ContextRevokeReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "revoke",
        body: { contextId, ...(options ?? {}) },
      });
    },
    /** Resolve the current runtime context */
    whoami: async (): Promise<ContextWhoamiReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "whoami",
        body: {},
      });
    }
  };

  readonly costs = {
    /** Show detailed cost summary for one agent */
    agent: async (agentId: string, options?: {
      hours?: string;
    }): Promise<CostsAgentReturn> => {
      return this.transport.call({
        groupSegments: ["costs"],
        command: "agent",
        body: { agentId, ...(options ?? {}) },
      });
    },
    /** Show cost breakdown by agent */
    agents: async (options?: {
      hours?: string;
      limit?: string;
    }): Promise<CostsAgentsReturn> => {
      return this.transport.call({
        groupSegments: ["costs"],
        command: "agents",
        body: { ...(options ?? {}) },
      });
    },
    /** Show detailed cost summary for one session */
    session: async (nameOrKey: string): Promise<CostsSessionReturn> => {
      return this.transport.call({
        groupSegments: ["costs"],
        command: "session",
        body: { nameOrKey },
      });
    },
    /** Show total cost summary for a recent window */
    summary: async (options?: {
      hours?: string;
    }): Promise<CostsSummaryReturn> => {
      return this.transport.call({
        groupSegments: ["costs"],
        command: "summary",
        body: { ...(options ?? {}) },
      });
    },
    /** Show most expensive sessions */
    topSessions: async (options?: {
      hours?: string;
      limit?: string;
    }): Promise<CostsTopSessionsReturn> => {
      return this.transport.call({
        groupSegments: ["costs"],
        command: "top-sessions",
        body: { ...(options ?? {}) },
      });
    }
  };

  readonly cron = {
    /** Add a new scheduled job */
    add: async (name: string, options?: {
      account?: string;
      agent?: string;
      at?: string;
      cron?: string;
      deleteAfter?: boolean;
      description?: string;
      every?: string;
      isolated?: boolean;
      message?: string;
      tz?: string;
    }): Promise<CronAddReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "add",
        body: { name, ...(options ?? {}) },
      });
    },
    /** Disable a job */
    disable: async (id: string): Promise<CronDisableReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "disable",
        body: { id },
      });
    },
    /** Enable a job */
    enable: async (id: string): Promise<CronEnableReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "enable",
        body: { id },
      });
    },
    /** List all scheduled jobs */
    list: async (): Promise<CronListReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "list",
        body: {},
      });
    },
    /** Delete a job */
    rm: async (id: string): Promise<CronRmReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "rm",
        body: { id },
      });
    },
    /** Manually run a job (ignores schedule) */
    run: async (id: string): Promise<CronRunReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "run",
        body: { id },
      });
    },
    /** Set job property */
    set: async (id: string, key: string, value: string): Promise<CronSetReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "set",
        body: { id, key, value },
      });
    },
    /** Show job details */
    show: async (id: string): Promise<CronShowReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "show",
        body: { id },
      });
    }
  };

  readonly daemon = {
    /** Run daemon in dev mode with auto-rebuild on file changes */
    dev: async (): Promise<DaemonDevReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "dev",
        body: {},
      });
    },
    /** Edit environment file (~/.ravi/.env) */
    env: async (): Promise<DaemonEnvReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "env",
        body: {},
      });
    },
    /** Bootstrap the admin runtime context-key. Refuses to run if any live admin context already exists. */
    initAdminKey: async (options?: {
      fromEnv?: boolean;
      label?: string;
      noStore?: boolean;
      printOnly?: boolean;
    }): Promise<DaemonInitAdminKeyReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "init-admin-key",
        body: { ...(options ?? {}) },
      });
    },
    /** Save PM2 process list and suggest startup */
    install: async (): Promise<DaemonInstallReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "install",
        body: {},
      });
    },
    /** Show daemon logs (PM2) */
    logs: async (options?: {
      clear?: boolean;
      follow?: boolean;
      path?: boolean;
      tail?: string;
    }): Promise<DaemonLogsReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "logs",
        body: { ...(options ?? {}) },
      });
    },
    /** Restart the daemon */
    restart: async (options?: {
      build?: boolean;
      message?: string;
    }): Promise<DaemonRestartReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "restart",
        body: { ...(options ?? {}) },
      });
    },
    /** Run daemon in foreground (used by PM2) */
    run: async (): Promise<DaemonRunReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "run",
        body: {},
      });
    },
    /** Start the daemon via PM2 */
    start: async (): Promise<DaemonStartReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "start",
        body: {},
      });
    },
    /** Show daemon and infrastructure status */
    status: async (): Promise<DaemonStatusReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "status",
        body: {},
      });
    },
    /** Stop the daemon */
    stop: async (): Promise<DaemonStopReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "stop",
        body: {},
      });
    },
    /** Remove ravi from PM2 and clean up */
    uninstall: async (): Promise<DaemonUninstallReturn> => {
      return this.transport.call({
        groupSegments: ["daemon"],
        command: "uninstall",
        body: {},
      });
    }
  };

  readonly devin = {
    auth: {
      /** Validate Devin API credentials */
      check: async (): Promise<DevinAuthCheckReturn> => {
        return this.transport.call({
          groupSegments: ["devin","auth"],
          command: "check",
          body: {},
        });
      }
    },
    sessions: {
      /** Archive a Devin session */
      archive: async (session: string): Promise<DevinSessionsArchiveReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "archive",
          body: { session },
        });
      },
      /** List and cache session attachments */
      attachments: async (session: string, options?: {
        cached?: boolean;
      }): Promise<DevinSessionsAttachmentsReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "attachments",
          body: { session, ...(options ?? {}) },
        });
      },
      /** Create a Devin session */
      create: async (options?: {
        advancedMode?: string;
        asUser?: string;
        attachmentUrl?: string[];
        bypassApproval?: boolean;
        childPlaybook?: string;
        knowledge?: string[];
        maxAcu?: string;
        noMaxAcuLimit?: boolean;
        playbook?: string;
        project?: string;
        prompt?: string;
        promptFile?: string;
        proxRun?: string;
        repo?: string[];
        secret?: string[];
        sessionLink?: string[];
        structuredOutputSchema?: string;
        tag?: string[];
        task?: string;
        title?: string;
      }): Promise<DevinSessionsCreateReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "create",
          body: { ...(options ?? {}) },
        });
      },
      /** Show Devin session insights/activity summary */
      insights: async (session: string, options?: {
        generate?: boolean;
      }): Promise<DevinSessionsInsightsReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "insights",
          body: { session, ...(options ?? {}) },
        });
      },
      /** List local or remote Devin sessions */
      list: async (options?: {
        limit?: string;
        remote?: boolean;
        status?: string;
        tag?: string;
      }): Promise<DevinSessionsListReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** List and cache session messages */
      messages: async (session: string, options?: {
        cached?: boolean;
      }): Promise<DevinSessionsMessagesReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "messages",
          body: { session, ...(options ?? {}) },
        });
      },
      /** Send a message to a Devin session */
      send: async (session: string, message: string, options?: {
        asUser?: string;
      }): Promise<DevinSessionsSendReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "send",
          body: { session, message, ...(options ?? {}) },
        });
      },
      /** Show one Devin session */
      show: async (session: string, options?: {
        sync?: boolean;
      }): Promise<DevinSessionsShowReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "show",
          body: { session, ...(options ?? {}) },
        });
      },
      /** Sync session status, messages and attachments */
      sync: async (session: string, options?: {
        artifacts?: boolean;
        insights?: boolean;
      }): Promise<DevinSessionsSyncReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "sync",
          body: { session, ...(options ?? {}) },
        });
      },
      /** Terminate a Devin session */
      terminate: async (session: string, options?: {
        archive?: boolean;
      }): Promise<DevinSessionsTerminateReturn> => {
        return this.transport.call({
          groupSegments: ["devin","sessions"],
          command: "terminate",
          body: { session, ...(options ?? {}) },
        });
      }
    }
  };

  readonly eval = {
    /** Run an eval task spec and persist artifacts */
    run: async (specPath: string, options?: {
      output?: string;
    }): Promise<EvalRunReturn> => {
      return this.transport.call({
        groupSegments: ["eval"],
        command: "run",
        body: { specPath, ...(options ?? {}) },
      });
    }
  };

  readonly events = {
    /** Replay persisted JetStream events with filters */
    replay: async (options?: {
      agent?: string;
      chat?: string;
      contains?: string;
      limit?: string;
      raw?: boolean;
      scan?: string;
      session?: string;
      since?: string;
      stream?: string;
      subject?: string;
      type?: string;
      until?: string;
      where?: string;
    }): Promise<EventsReplayReturn> => {
      return this.transport.call({
        groupSegments: ["events"],
        command: "replay",
        body: { ...(options ?? {}) },
      });
    },
    /** Stream all events in real-time (default command) */
    stream: async (options?: {
      filter?: string;
      noClaude?: boolean;
      noHeartbeat?: boolean;
      only?: string;
    }): Promise<EventsStreamReturn> => {
      return this.transport.call({
        groupSegments: ["events"],
        command: "stream",
        body: { ...(options ?? {}) },
      });
    }
  };

  readonly heartbeat = {
    /** Disable heartbeat for an agent */
    disable: async (id: string): Promise<HeartbeatDisableReturn> => {
      return this.transport.call({
        groupSegments: ["heartbeat"],
        command: "disable",
        body: { id },
      });
    },
    /** Enable heartbeat for an agent */
    enable: async (id: string, interval?: string): Promise<HeartbeatEnableReturn> => {
      return this.transport.call({
        groupSegments: ["heartbeat"],
        command: "enable",
        body: { id, interval },
      });
    },
    /** Set heartbeat property */
    set: async (id: string, key: string, value: string): Promise<HeartbeatSetReturn> => {
      return this.transport.call({
        groupSegments: ["heartbeat"],
        command: "set",
        body: { id, key, value },
      });
    },
    /** Show heartbeat config for an agent */
    show: async (id: string): Promise<HeartbeatShowReturn> => {
      return this.transport.call({
        groupSegments: ["heartbeat"],
        command: "show",
        body: { id },
      });
    },
    /** Show heartbeat status for all agents */
    status: async (): Promise<HeartbeatStatusReturn> => {
      return this.transport.call({
        groupSegments: ["heartbeat"],
        command: "status",
        body: {},
      });
    },
    /** Manually trigger a heartbeat */
    trigger: async (id: string): Promise<HeartbeatTriggerReturn> => {
      return this.transport.call({
        groupSegments: ["heartbeat"],
        command: "trigger",
        body: { id },
      });
    }
  };

  readonly hooks = {
    /** Create a new runtime hook */
    create: async (name: string, options?: {
      action?: string;
      agent?: string;
      async?: boolean;
      barrier?: string;
      cooldown?: string;
      dedupeKey?: string;
      disabled?: boolean;
      event?: string;
      matcher?: string;
      message?: string;
      role?: string;
      scope?: string;
      session?: string;
      targetSession?: string;
      targetTask?: string;
      task?: string;
      workspace?: string;
    }): Promise<HooksCreateReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "create",
        body: { name, ...(options ?? {}) },
      });
    },
    /** Disable a hook */
    disable: async (id: string): Promise<HooksDisableReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "disable",
        body: { id },
      });
    },
    /** Enable a hook */
    enable: async (id: string): Promise<HooksEnableReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "enable",
        body: { id },
      });
    },
    /** List configured hooks */
    list: async (): Promise<HooksListReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "list",
        body: {},
      });
    },
    /** Delete a hook */
    rm: async (id: string): Promise<HooksRmReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "rm",
        body: { id },
      });
    },
    /** Show hook details */
    show: async (id: string): Promise<HooksShowReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "show",
        body: { id },
      });
    },
    /** Execute a hook once with a synthetic event */
    test: async (id: string): Promise<HooksTestReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "test",
        body: { id },
      });
    }
  };

  readonly image = {
    atlas: {
      /** Split an image atlas/contact sheet into deterministic crop artifacts */
      split: async (input: string, options?: {
        account?: string;
        background?: string;
        caption?: string;
        channel?: string;
        cols?: string;
        fit?: string;
        fuzz?: string;
        mode?: string;
        names?: string;
        output?: string;
        pad?: string;
        parentArtifact?: string;
        rows?: string;
        send?: boolean;
        size?: string;
        threadId?: string;
        to?: string;
      }): Promise<ImageAtlasSplitReturn> => {
        return this.transport.call({
          groupSegments: ["image","atlas"],
          command: "split",
          body: { input, ...(options ?? {}) },
        });
      }
    },
    /** Generate an image from a text prompt */
    generate: async (prompt: string, options?: {
      artifactId?: string;
      aspect?: string;
      async?: boolean;
      asyncWorker?: boolean;
      background?: string;
      caption?: string;
      compression?: string;
      format?: string;
      mode?: string;
      model?: string;
      output?: string;
      provider?: string;
      quality?: string;
      send?: boolean;
      size?: string;
      source?: string;
      sync?: boolean;
    }): Promise<ImageGenerateReturn> => {
      return this.transport.call({
        groupSegments: ["image"],
        command: "generate",
        body: { prompt, ...(options ?? {}) },
      });
    }
  };

  readonly insights = {
    /** Create a new insight with lineage captured from the current runtime context */
    create: async (summary: string, options?: {
      agent?: string;
      artifact?: string;
      autoContext?: boolean;
      comment?: string;
      confidence?: string;
      detail?: string;
      importance?: string;
      kind?: string;
      linkId?: string;
      linkType?: string;
      profile?: string;
      session?: string;
      task?: string;
    }): Promise<InsightsCreateReturn> => {
      return this.transport.call({
        groupSegments: ["insights"],
        command: "create",
        body: { summary, ...(options ?? {}) },
      });
    },
    /** List recent insights with optional filters */
    list: async (options?: {
      agent?: string;
      confidence?: string;
      importance?: string;
      kind?: string;
      limit?: string;
      profile?: string;
      query?: string;
      rich?: boolean;
      session?: string;
      task?: string;
    }): Promise<InsightsListReturn> => {
      return this.transport.call({
        groupSegments: ["insights"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Search insights by free text */
    search: async (text: string, options?: {
      limit?: string;
    }): Promise<InsightsSearchReturn> => {
      return this.transport.call({
        groupSegments: ["insights"],
        command: "search",
        body: { text, ...(options ?? {}) },
      });
    },
    /** Show one insight with lineage and comments */
    show: async (id: string): Promise<InsightsShowReturn> => {
      return this.transport.call({
        groupSegments: ["insights"],
        command: "show",
        body: { id },
      });
    }
  };

  readonly instances = {
    /** Connect an instance to omni (QR code for WhatsApp) */
    connect: async (name: string, options?: {
      agent?: string;
      channel?: string;
    }): Promise<InstancesConnectReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "connect",
        body: { name, ...(options ?? {}) },
      });
    },
    /** Create a new instance */
    create: async (name: string, options?: {
      agent?: string;
      channel?: string;
      dmPolicy?: string;
      groupPolicy?: string;
    }): Promise<InstancesCreateReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "create",
        body: { name, ...(options ?? {}) },
      });
    },
    /** Delete an instance (soft-delete, recoverable) */
    delete: async (name: string): Promise<InstancesDeleteReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "delete",
        body: { name },
      });
    },
    /** List soft-deleted instances */
    deleted: async (): Promise<InstancesDeletedReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "deleted",
        body: {},
      });
    },
    /** Disable an instance in Ravi without changing omni */
    disable: async (target: string): Promise<InstancesDisableReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "disable",
        body: { target },
      });
    },
    /** Disconnect an instance from omni */
    disconnect: async (name: string): Promise<InstancesDisconnectReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "disconnect",
        body: { name },
      });
    },
    /** Enable an instance in Ravi without changing omni */
    enable: async (target: string): Promise<InstancesEnableReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "enable",
        body: { target },
      });
    },
    /** Get an instance property */
    get: async (name: string, key: string): Promise<InstancesGetReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "get",
        body: { name, key },
      });
    },
    /** List all instances */
    list: async (): Promise<InstancesListReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "list",
        body: {},
      });
    },
    pending: {
      /** Approve a pending contact or chat */
      approve: async (name: string, contact: string, options?: {
        agent?: string;
      }): Promise<InstancesPendingApproveReturn> => {
        return this.transport.call({
          groupSegments: ["instances","pending"],
          command: "approve",
          body: { name, contact, ...(options ?? {}) },
        });
      },
      /** List pending contacts and chats for an instance */
      list: async (name: string): Promise<InstancesPendingListReturn> => {
        return this.transport.call({
          groupSegments: ["instances","pending"],
          command: "list",
          body: { name },
        });
      },
      /** Reject and remove a pending contact or chat */
      reject: async (name: string, contact: string): Promise<InstancesPendingRejectReturn> => {
        return this.transport.call({
          groupSegments: ["instances","pending"],
          command: "reject",
          body: { name, contact },
        });
      }
    },
    /** Restore a soft-deleted instance */
    restore: async (name: string): Promise<InstancesRestoreReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "restore",
        body: { name },
      });
    },
    routes: {
      /** Add a route to an instance */
      add: async (name: string, pattern: string, agent: string, options?: {
        allowRuntimeMismatch?: boolean;
        channel?: string;
        dmScope?: string;
        policy?: string;
        priority?: string;
        session?: string;
      }): Promise<InstancesRoutesAddReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "add",
          body: { name, pattern, agent, ...(options ?? {}) },
        });
      },
      /** List soft-deleted routes */
      deleted: async (name?: string): Promise<InstancesRoutesDeletedReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "deleted",
          body: { name },
        });
      },
      /** List routes for an instance */
      list: async (name: string): Promise<InstancesRoutesListReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "list",
          body: { name },
        });
      },
      /** Remove a route (soft-delete, recoverable) */
      remove: async (name: string, pattern: string, options?: {
        allowRuntimeMismatch?: boolean;
      }): Promise<InstancesRoutesRemoveReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "remove",
          body: { name, pattern, ...(options ?? {}) },
        });
      },
      /** Restore a soft-deleted route */
      restore: async (name: string, pattern: string, options?: {
        allowRuntimeMismatch?: boolean;
      }): Promise<InstancesRoutesRestoreReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "restore",
          body: { name, pattern, ...(options ?? {}) },
        });
      },
      /** Set a route property */
      set: async (name: string, pattern: string, key: string, value: string, options?: {
        allowRuntimeMismatch?: boolean;
      }): Promise<InstancesRoutesSetReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "set",
          body: { name, pattern, key, value, ...(options ?? {}) },
        });
      },
      /** Show route details */
      show: async (name: string, pattern: string): Promise<InstancesRoutesShowReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "show",
          body: { name, pattern },
        });
      }
    },
    /** Set an instance property */
    set: async (name: string, key: string, value: string): Promise<InstancesSetReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "set",
        body: { name, key, value },
      });
    },
    /** Show instance details */
    show: async (name: string): Promise<InstancesShowReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "show",
        body: { name },
      });
    },
    /** Show connection status for an instance */
    status: async (name: string): Promise<InstancesStatusReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "status",
        body: { name },
      });
    },
    /** Explain which runtime, DB, and live instance this CLI would affect */
    target: async (name: string, options?: {
      channel?: string;
      pattern?: string;
    }): Promise<InstancesTargetReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "target",
        body: { name, ...(options ?? {}) },
      });
    }
  };

  readonly media = {
    /** Send a media file (image, video, audio, document) */
    send: async (filePath: string, options?: {
      account?: string;
      caption?: string;
      channel?: string;
      ptt?: boolean;
      threadId?: string;
      to?: string;
    }): Promise<MediaSendReturn> => {
      return this.transport.call({
        groupSegments: ["media"],
        command: "send",
        body: { filePath, ...(options ?? {}) },
      });
    }
  };

  readonly permissions = {
    /** Check if a subject has a permission on an object */
    check: async (subject: string, permission: string, object: string): Promise<PermissionsCheckReturn> => {
      return this.transport.call({
        groupSegments: ["permissions"],
        command: "check",
        body: { subject, permission, object },
      });
    },
    /** Clear all manual relations */
    clear: async (options?: {
      all?: boolean;
    }): Promise<PermissionsClearReturn> => {
      return this.transport.call({
        groupSegments: ["permissions"],
        command: "clear",
        body: { ...(options ?? {}) },
      });
    },
    /** Grant a relation */
    grant: async (subject: string, relation: string, object: string): Promise<PermissionsGrantReturn> => {
      return this.transport.call({
        groupSegments: ["permissions"],
        command: "grant",
        body: { subject, relation, object },
      });
    },
    /** Apply a permission template to an agent */
    init: async (subject: string, template: string): Promise<PermissionsInitReturn> => {
      return this.transport.call({
        groupSegments: ["permissions"],
        command: "init",
        body: { subject, template },
      });
    },
    /** List relations */
    list: async (options?: {
      object?: string;
      relation?: string;
      source?: string;
      subject?: string;
    }): Promise<PermissionsListReturn> => {
      return this.transport.call({
        groupSegments: ["permissions"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Revoke a relation */
    revoke: async (subject: string, relation: string, object: string): Promise<PermissionsRevokeReturn> => {
      return this.transport.call({
        groupSegments: ["permissions"],
        command: "revoke",
        body: { subject, relation, object },
      });
    },
    /** Re-sync relations from agent configs */
    sync: async (): Promise<PermissionsSyncReturn> => {
      return this.transport.call({
        groupSegments: ["permissions"],
        command: "sync",
        body: {},
      });
    }
  };

  readonly projects = {
    /** Create one project */
    create: async (title: string, options?: {
      hypothesis?: string;
      lastSignalAt?: string;
      nextStep?: string;
      ownerAgent?: string;
      session?: string;
      slug?: string;
      status?: string;
      summary?: string;
    }): Promise<ProjectsCreateReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "create",
        body: { title, ...(options ?? {}) },
      });
    },
    fixtures: {
      /** Reset and seed the canonical project fixtures used in demos and smoke tests */
      seed: async (options?: {
        ownerAgent?: string;
      }): Promise<ProjectsFixturesSeedReturn> => {
        return this.transport.call({
          groupSegments: ["projects","fixtures"],
          command: "seed",
          body: { ...(options ?? {}) },
        });
      }
    },
    /** Materialize a project with cheap links and optional canonical workflows */
    init: async (title: string, options?: {
      hypothesis?: string;
      lastSignalAt?: string;
      nextStep?: string;
      ownerAgent?: string;
      resource?: string[];
      session?: string;
      slug?: string;
      status?: string;
      summary?: string;
      workflowRun?: string[];
      workflowTemplate?: string[];
    }): Promise<ProjectsInitReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "init",
        body: { title, ...(options ?? {}) },
      });
    },
    /** Link workflow/session/agent/resource/spec context to a project */
    link: async (assetType: string, project: string, target: string, options?: {
      label?: string;
      meta?: string;
      resourceType?: string;
      role?: string;
    }): Promise<ProjectsLinkReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "link",
        body: { assetType, project, target, ...(options ?? {}) },
      });
    },
    /** List projects */
    list: async (options?: {
      status?: string;
    }): Promise<ProjectsListReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** List projects as an operational next-work surface */
    next: async (options?: {
      status?: string;
    }): Promise<ProjectsNextReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "next",
        body: { ...(options ?? {}) },
      });
    },
    resources: {
      /** Add one resource link to a project */
      add: async (project: string, target: string, options?: {
        label?: string;
        meta?: string;
        role?: string;
        type?: string;
      }): Promise<ProjectsResourcesAddReturn> => {
        return this.transport.call({
          groupSegments: ["projects","resources"],
          command: "add",
          body: { project, target, ...(options ?? {}) },
        });
      },
      /** Import multiple cheap resources into a project */
      import: async (project: string, options?: {
        group?: string[];
        meta?: string;
        repo?: string[];
        role?: string;
        url?: string[];
        worktree?: string[];
      }): Promise<ProjectsResourcesImportReturn> => {
        return this.transport.call({
          groupSegments: ["projects","resources"],
          command: "import",
          body: { project, ...(options ?? {}) },
        });
      },
      /** List resource links for a project */
      list: async (project: string, options?: {
        type?: string;
      }): Promise<ProjectsResourcesListReturn> => {
        return this.transport.call({
          groupSegments: ["projects","resources"],
          command: "list",
          body: { project, ...(options ?? {}) },
        });
      },
      /** Show one resource link on a project */
      show: async (project: string, resource: string): Promise<ProjectsResourcesShowReturn> => {
        return this.transport.call({
          groupSegments: ["projects","resources"],
          command: "show",
          body: { project, resource },
        });
      }
    },
    /** Show one project with linked context */
    show: async (project: string): Promise<ProjectsShowReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "show",
        body: { project },
      });
    },
    /** Show one project with workflow runtime rollup */
    status: async (project: string): Promise<ProjectsStatusReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "status",
        body: { project },
      });
    },
    tasks: {
      /** Attach an existing task to a project workflow node */
      attach: async (project: string, nodeKey: string, taskId: string, options?: {
        agent?: string;
        dispatch?: boolean;
        session?: string;
        workflow?: string;
      }): Promise<ProjectsTasksAttachReturn> => {
        return this.transport.call({
          groupSegments: ["projects","tasks"],
          command: "attach",
          body: { project, nodeKey, taskId, ...(options ?? {}) },
        });
      },
      /** Create a task attempt from a project workflow node */
      create: async (project: string, nodeKey: string, title: string, options?: {
        agent?: string;
        dispatch?: boolean;
        instructions?: string;
        priority?: string;
        profile?: string;
        session?: string;
        workflow?: string;
      }): Promise<ProjectsTasksCreateReturn> => {
        return this.transport.call({
          groupSegments: ["projects","tasks"],
          command: "create",
          body: { project, nodeKey, title, ...(options ?? {}) },
        });
      },
      /** Dispatch a task using project owner/session defaults */
      dispatch: async (project: string, taskId: string, options?: {
        agent?: string;
        session?: string;
      }): Promise<ProjectsTasksDispatchReturn> => {
        return this.transport.call({
          groupSegments: ["projects","tasks"],
          command: "dispatch",
          body: { project, taskId, ...(options ?? {}) },
        });
      }
    },
    /** Update one project */
    update: async (project: string, options?: {
      hypothesis?: string;
      lastSignalAt?: string;
      nextStep?: string;
      ownerAgent?: string;
      session?: string;
      status?: string;
      summary?: string;
      title?: string;
      touchSignal?: boolean;
    }): Promise<ProjectsUpdateReturn> => {
      return this.transport.call({
        groupSegments: ["projects"],
        command: "update",
        body: { project, ...(options ?? {}) },
      });
    },
    workflows: {
      /** Attach one existing workflow run to a project in one step */
      attach: async (project: string, runId: string, options?: {
        role?: string;
      }): Promise<ProjectsWorkflowsAttachReturn> => {
        return this.transport.call({
          groupSegments: ["projects","workflows"],
          command: "attach",
          body: { project, runId, ...(options ?? {}) },
        });
      },
      /** Start one workflow run from a project and link it in one step */
      start: async (project: string, specId: string, options?: {
        role?: string;
        runId?: string;
      }): Promise<ProjectsWorkflowsStartReturn> => {
        return this.transport.call({
          groupSegments: ["projects","workflows"],
          command: "start",
          body: { project, specId, ...(options ?? {}) },
        });
      }
    }
  };

  readonly prox = {
    calls: {
      /** Cancel a pending call request */
      cancel: async (call_request_id: string, options?: {
        reason?: string;
      }): Promise<ProxCallsCancelReturn> => {
        return this.transport.call({
          groupSegments: ["prox","calls"],
          command: "cancel",
          body: { call_request_id, ...(options ?? {}) },
        });
      },
      /** Show event timeline for a call request */
      events: async (call_request_id: string): Promise<ProxCallsEventsReturn> => {
        return this.transport.call({
          groupSegments: ["prox","calls"],
          command: "events",
          body: { call_request_id },
        });
      },
      profiles: {
        /** Configure a call profile's provider settings */
        configure: async (profile_id: string, options?: {
          agentId?: string;
          dynamicPlaceholder?: string[];
          firstMessage?: string;
          language?: string;
          prompt?: string;
          provider?: string;
          skipProviderSync?: boolean;
          systemPromptPath?: string;
          twilioNumberId?: string;
          voicemailPolicy?: string;
        }): Promise<ProxCallsProfilesConfigureReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","profiles"],
            command: "configure",
            body: { profile_id, ...(options ?? {}) },
          });
        },
        /** List available call profiles */
        list: async (): Promise<ProxCallsProfilesListReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","profiles"],
            command: "list",
            body: {},
          });
        },
        /** Show a call profile by ID */
        show: async (profile_id: string): Promise<ProxCallsProfilesShowReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","profiles"],
            command: "show",
            body: { profile_id },
          });
        }
      },
      /** Request a call to a person */
      request: async (options?: {
        force?: boolean;
        person?: string;
        phone?: string;
        priority?: string;
        profile?: string;
        reason?: string;
        skipOriginNotify?: boolean;
        var?: string[];
      }): Promise<ProxCallsRequestReturn> => {
        return this.transport.call({
          groupSegments: ["prox","calls"],
          command: "request",
          body: { ...(options ?? {}) },
        });
      },
      /** Show active call rules */
      rules: async (options?: {
        scope?: string;
      }): Promise<ProxCallsRulesReturn> => {
        return this.transport.call({
          groupSegments: ["prox","calls"],
          command: "rules",
          body: { ...(options ?? {}) },
        });
      },
      /** Show details of a call request */
      show: async (call_request_id: string): Promise<ProxCallsShowReturn> => {
        return this.transport.call({
          groupSegments: ["prox","calls"],
          command: "show",
          body: { call_request_id },
        });
      },
      tools: {
        /** Bind a tool to a profile */
        bind: async (profile_id: string, tool_id: string, options?: {
          providerToolName?: string;
          required?: boolean;
          toolPrompt?: string;
        }): Promise<ProxCallsToolsBindReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "bind",
            body: { profile_id, tool_id, ...(options ?? {}) },
          });
        },
        /** Configure a call tool */
        configure: async (tool_id: string, options?: {
          enabled?: string;
          timeoutMs?: string;
        }): Promise<ProxCallsToolsConfigureReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "configure",
            body: { tool_id, ...(options ?? {}) },
          });
        },
        /** Create a new call tool */
        create: async (tool_id: string, options?: {
          description?: string;
          executor?: string;
          inputSchema?: string;
          name?: string;
          outputSchema?: string;
          sideEffect?: string;
        }): Promise<ProxCallsToolsCreateReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "create",
            body: { tool_id, ...(options ?? {}) },
          });
        },
        /** List call tools */
        list: async (options?: {
          profile?: string;
        }): Promise<ProxCallsToolsListReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "list",
            body: { ...(options ?? {}) },
          });
        },
        /** Execute a tool (dry-run validates without side effects) */
        run: async (tool_id: string, options?: {
          dryRun?: boolean;
          input?: string;
          profile?: string;
        }): Promise<ProxCallsToolsRunReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "run",
            body: { tool_id, ...(options ?? {}) },
          });
        },
        /** List tool runs for a call request */
        runs: async (call_request_id: string): Promise<ProxCallsToolsRunsReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "runs",
            body: { call_request_id },
          });
        },
        /** Show a call tool by ID */
        show: async (tool_id: string): Promise<ProxCallsToolsShowReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "show",
            body: { tool_id },
          });
        },
        /** Unbind a tool from a profile */
        unbind: async (profile_id: string, tool_id: string): Promise<ProxCallsToolsUnbindReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","tools"],
            command: "unbind",
            body: { profile_id, tool_id },
          });
        }
      },
      /** Show call transcript, syncing provider state when needed */
      transcript: async (call_request_id: string, options?: {
        sync?: boolean;
      }): Promise<ProxCallsTranscriptReturn> => {
        return this.transport.call({
          groupSegments: ["prox","calls"],
          command: "transcript",
          body: { call_request_id, ...(options ?? {}) },
        });
      },
      voiceAgents: {
        /** Bind a tool to a voice agent */
        bindTool: async (voice_agent_id: string, tool_id: string, options?: {
          providerToolName?: string;
        }): Promise<ProxCallsVoiceAgentsBindToolReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "bind-tool",
            body: { voice_agent_id, tool_id, ...(options ?? {}) },
          });
        },
        /** Configure a voice agent */
        configure: async (voice_agent_id: string, options?: {
          firstMessage?: string;
          providerAgentId?: string;
          systemPromptPath?: string;
          voiceId?: string;
        }): Promise<ProxCallsVoiceAgentsConfigureReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "configure",
            body: { voice_agent_id, ...(options ?? {}) },
          });
        },
        /** Create a new voice agent */
        create: async (voice_agent_id: string, options?: {
          name?: string;
          provider?: string;
          systemPromptPath?: string;
          voiceId?: string;
        }): Promise<ProxCallsVoiceAgentsCreateReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "create",
            body: { voice_agent_id, ...(options ?? {}) },
          });
        },
        /** List voice agents */
        list: async (): Promise<ProxCallsVoiceAgentsListReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "list",
            body: {},
          });
        },
        /** Show a voice agent by ID */
        show: async (voice_agent_id: string): Promise<ProxCallsVoiceAgentsShowReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "show",
            body: { voice_agent_id },
          });
        },
        /** Sync voice agent to provider (dry-run by default) */
        sync: async (voice_agent_id: string, options?: {
          dryRun?: boolean;
          provider?: boolean;
        }): Promise<ProxCallsVoiceAgentsSyncReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "sync",
            body: { voice_agent_id, ...(options ?? {}) },
          });
        },
        /** Unbind a tool from a voice agent */
        unbindTool: async (voice_agent_id: string, tool_id: string): Promise<ProxCallsVoiceAgentsUnbindToolReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "unbind-tool",
            body: { voice_agent_id, tool_id },
          });
        }
      }
    }
  };

  readonly react = {
    /** Send an emoji reaction to a message */
    send: async (messageId: string, emoji: string): Promise<ReactSendReturn> => {
      return this.transport.call({
        groupSegments: ["react"],
        command: "send",
        body: { messageId, emoji },
      });
    }
  };

  readonly routes = {
    /** Explain how a pattern resolves in config and the live router */
    explain: async (name: string, pattern: string, options?: {
      channel?: string;
    }): Promise<RoutesExplainReturn> => {
      return this.transport.call({
        groupSegments: ["routes"],
        command: "explain",
        body: { name, pattern, ...(options ?? {}) },
      });
    },
    /** List routes across all instances or for one instance */
    list: async (name?: string): Promise<RoutesListReturn> => {
      return this.transport.call({
        groupSegments: ["routes"],
        command: "list",
        body: { name },
      });
    },
    /** Show route details */
    show: async (name: string, pattern: string): Promise<RoutesShowReturn> => {
      return this.transport.call({
        groupSegments: ["routes"],
        command: "show",
        body: { name, pattern },
      });
    }
  };

  readonly sdk = {
    client: {
      /** Compare on-disk @ravi-os/sdk sources to a fresh emit; exit 1 on drift */
      check: async (options?: {
        out?: string;
        version?: string;
      }): Promise<SdkClientCheckReturn> => {
        return this.transport.call({
          groupSegments: ["sdk","client"],
          command: "check",
          body: { ...(options ?? {}) },
        });
      },
      /** Generate the four @ravi-os/sdk source files from the live registry */
      generate: async (options?: {
        out?: string;
        version?: string;
      }): Promise<SdkClientGenerateReturn> => {
        return this.transport.call({
          groupSegments: ["sdk","client"],
          command: "generate",
          body: { ...(options ?? {}) },
        });
      }
    },
    openapi: {
      /** Diff a stored OpenAPI spec against the live registry */
      check: async (options?: {
        against?: string;
      }): Promise<SdkOpenapiCheckReturn> => {
        return this.transport.call({
          groupSegments: ["sdk","openapi"],
          command: "check",
          body: { ...(options ?? {}) },
        });
      },
      /** Emit OpenAPI 3.1 spec from the CLI registry */
      emit: async (options?: {
        out?: string;
        stdout?: boolean;
      }): Promise<SdkOpenapiEmitReturn> => {
        return this.transport.call({
          groupSegments: ["sdk","openapi"],
          command: "emit",
          body: { ...(options ?? {}) },
        });
      }
    }
  };

  readonly service = {
    /** Start the bot server */
    start: async (): Promise<ServiceStartReturn> => {
      return this.transport.call({
        groupSegments: ["service"],
        command: "start",
        body: {},
      });
    },
    /** Start the TUI interface */
    tui: async (session?: string): Promise<ServiceTuiReturn> => {
      return this.transport.call({
        groupSegments: ["service"],
        command: "tui",
        body: { session },
      });
    },
    /** Start WhatsApp gateway (deprecated — use daemon start) */
    wa: async (): Promise<ServiceWaReturn> => {
      return this.transport.call({
        groupSegments: ["service"],
        command: "wa",
        body: {},
      });
    }
  };

  readonly sessions = {
    /** Answer a question from another session (fire-and-forget) */
    answer: async (target: string, message: string, sender?: string, options?: {
      barrier?: string;
      channel?: string;
      to?: string;
    }): Promise<SessionsAnswerReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "answer",
        body: { target, message, sender, ...(options ?? {}) },
      });
    },
    /** Ask a question to another session (fire-and-forget) */
    ask: async (target: string, message: string, sender?: string, options?: {
      barrier?: string;
      channel?: string;
      to?: string;
    }): Promise<SessionsAskReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "ask",
        body: { target, message, sender, ...(options ?? {}) },
      });
    },
    /** Tail live runtime events for a session (defaults to current session when available) */
    debug: async (nameOrKey?: string, options?: {
      timeout?: string;
    }): Promise<SessionsDebugReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "debug",
        body: { nameOrKey, ...(options ?? {}) },
      });
    },
    /** Delete a session permanently */
    delete: async (nameOrKey: string): Promise<SessionsDeleteReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "delete",
        body: { nameOrKey },
      });
    },
    /** Send an execute command to another session (fire-and-forget) */
    execute: async (target: string, message: string, options?: {
      barrier?: string;
      channel?: string;
      to?: string;
    }): Promise<SessionsExecuteReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "execute",
        body: { target, message, ...(options ?? {}) },
      });
    },
    /** Extend an ephemeral session's TTL */
    extend: async (nameOrKey: string, duration?: string): Promise<SessionsExtendReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "extend",
        body: { nameOrKey, duration },
      });
    },
    /** Show unified session inspection details */
    info: async (nameOrKey: string): Promise<SessionsInfoReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "info",
        body: { nameOrKey },
      });
    },
    /** Send an informational message to another session (fire-and-forget) */
    inform: async (target: string, message: string, options?: {
      barrier?: string;
      channel?: string;
      to?: string;
    }): Promise<SessionsInformReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "inform",
        body: { target, message, ...(options ?? {}) },
      });
    },
    /** Make an ephemeral session permanent */
    keep: async (nameOrKey: string): Promise<SessionsKeepReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "keep",
        body: { nameOrKey },
      });
    },
    /** List all sessions */
    list: async (options?: {
      agent?: string;
      ephemeral?: boolean;
    }): Promise<SessionsListReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Read message history of a session (normalized) */
    read: async (nameOrKey: string, options?: {
      count?: string;
      messageId?: string;
      workspace?: boolean;
    }): Promise<SessionsReadReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "read",
        body: { nameOrKey, ...(options ?? {}) },
      });
    },
    /** Rename canonical session name */
    rename: async (nameOrKey: string, newName: string): Promise<SessionsRenameReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "rename",
        body: { nameOrKey, newName },
      });
    },
    /** Reset a session (fresh start) */
    reset: async (nameOrKey: string): Promise<SessionsResetReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "reset",
        body: { nameOrKey },
      });
    },
    runtime: {
      /** Queue a follow-up after the active runtime turn */
      followUp: async (session: string, text: string, options?: {
        expectedTurn?: string;
        thread?: string;
        turn?: string;
      }): Promise<SessionsRuntimeFollowUpReturn> => {
        return this.transport.call({
          groupSegments: ["sessions","runtime"],
          command: "follow-up",
          body: { session, text, ...(options ?? {}) },
        });
      },
      /** Fork a runtime thread if the provider supports it */
      fork: async (session: string, threadId?: string, options?: {
        cwd?: string;
        path?: string;
      }): Promise<SessionsRuntimeForkReturn> => {
        return this.transport.call({
          groupSegments: ["sessions","runtime"],
          command: "fork",
          body: { session, threadId, ...(options ?? {}) },
        });
      },
      /** Interrupt the active runtime turn */
      interrupt: async (session: string, options?: {
        thread?: string;
        turn?: string;
      }): Promise<SessionsRuntimeInterruptReturn> => {
        return this.transport.call({
          groupSegments: ["sessions","runtime"],
          command: "interrupt",
          body: { session, ...(options ?? {}) },
        });
      },
      /** List runtime threads through an active session */
      list: async (session: string, options?: {
        archived?: boolean;
        cursor?: string;
        cwd?: string;
        limit?: string;
        search?: string;
      }): Promise<SessionsRuntimeListReturn> => {
        return this.transport.call({
          groupSegments: ["sessions","runtime"],
          command: "list",
          body: { session, ...(options ?? {}) },
        });
      },
      /** Read a runtime thread through an active session */
      read: async (session: string, threadId?: string, options?: {
        summaryOnly?: boolean;
      }): Promise<SessionsRuntimeReadReturn> => {
        return this.transport.call({
          groupSegments: ["sessions","runtime"],
          command: "read",
          body: { session, threadId, ...(options ?? {}) },
        });
      },
      /** Rollback completed runtime turns */
      rollback: async (session: string, turns?: string, options?: {
        thread?: string;
      }): Promise<SessionsRuntimeRollbackReturn> => {
        return this.transport.call({
          groupSegments: ["sessions","runtime"],
          command: "rollback",
          body: { session, turns, ...(options ?? {}) },
        });
      },
      /** Steer the active runtime turn */
      steer: async (session: string, text: string, options?: {
        expectedTurn?: string;
        thread?: string;
        turn?: string;
      }): Promise<SessionsRuntimeSteerReturn> => {
        return this.transport.call({
          groupSegments: ["sessions","runtime"],
          command: "steer",
          body: { session, text, ...(options ?? {}) },
        });
      }
    },
    /** Send a prompt to a session (fire-and-forget). Use -w to wait for response, -i for interactive. */
    send: async (nameOrKey: string, prompt?: string, options?: {
      agent?: string;
      barrier?: string;
      channel?: string;
      interactive?: boolean;
      to?: string;
      wait?: boolean;
    }): Promise<SessionsSendReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "send",
        body: { nameOrKey, prompt, ...(options ?? {}) },
      });
    },
    /** Set session display label */
    setDisplay: async (nameOrKey: string, displayName: string): Promise<SessionsSetDisplayReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "set-display",
        body: { nameOrKey, displayName },
      });
    },
    /** Set session model override */
    setModel: async (nameOrKey: string, model: string): Promise<SessionsSetModelReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "set-model",
        body: { nameOrKey, model },
      });
    },
    /** Set session thinking level */
    setThinking: async (nameOrKey: string, level: string): Promise<SessionsSetThinkingReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "set-thinking",
        body: { nameOrKey, level },
      });
    },
    /** Make a session ephemeral with a TTL */
    setTtl: async (nameOrKey: string, duration: string): Promise<SessionsSetTtlReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "set-ttl",
        body: { nameOrKey, duration },
      });
    },
    /** Read the SQLite session trace timeline */
    trace: async (nameOrKey: string, options?: {
      correlation?: string;
      explain?: boolean;
      includeStream?: boolean;
      limit?: string;
      message?: string;
      only?: string;
      raw?: boolean;
      run?: string;
      showSystemPrompt?: boolean;
      showUserPrompt?: boolean;
      since?: string;
      turn?: string;
      until?: string;
    }): Promise<SessionsTraceReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "trace",
        body: { nameOrKey, ...(options ?? {}) },
      });
    }
  };

  readonly settings = {
    /** Delete a setting */
    delete: async (key: string): Promise<SettingsDeleteReturn> => {
      return this.transport.call({
        groupSegments: ["settings"],
        command: "delete",
        body: { key },
      });
    },
    /** Get a setting value */
    get: async (key: string): Promise<SettingsGetReturn> => {
      return this.transport.call({
        groupSegments: ["settings"],
        command: "get",
        body: { key },
      });
    },
    /** List live settings (legacy account.* hidden by default) */
    list: async (options?: {
      legacy?: boolean;
    }): Promise<SettingsListReturn> => {
      return this.transport.call({
        groupSegments: ["settings"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Set a setting value */
    set: async (key: string, value: string): Promise<SettingsSetReturn> => {
      return this.transport.call({
        groupSegments: ["settings"],
        command: "set",
        body: { key, value },
      });
    }
  };

  readonly skills = {
    /** Install Ravi catalog skills or skills from an explicit source */
    install: async (name?: string, options?: {
      all?: boolean;
      overwrite?: boolean;
      plugin?: string;
      skill?: string;
      skipCodexSync?: boolean;
      source?: string;
    }): Promise<SkillsInstallReturn> => {
      return this.transport.call({
        groupSegments: ["skills"],
        command: "install",
        body: { name, ...(options ?? {}) },
      });
    },
    /** List Ravi catalog skills, installed skills or source skills */
    list: async (options?: {
      codex?: boolean;
      installed?: boolean;
      source?: string;
    }): Promise<SkillsListReturn> => {
      return this.transport.call({
        groupSegments: ["skills"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Show a Ravi catalog skill, installed skill or source skill */
    show: async (name: string, options?: {
      installed?: boolean;
      source?: string;
    }): Promise<SkillsShowReturn> => {
      return this.transport.call({
        groupSegments: ["skills"],
        command: "show",
        body: { name, ...(options ?? {}) },
      });
    },
    /** Sync Ravi plugin skills into the Codex skills directory */
    sync: async (): Promise<SkillsSyncReturn> => {
      return this.transport.call({
        groupSegments: ["skills"],
        command: "sync",
        body: {},
      });
    }
  };

  readonly specs = {
    /** Get inherited spec context */
    get: async (id: string, options?: {
      mode?: string;
    }): Promise<SpecsGetReturn> => {
      return this.transport.call({
        groupSegments: ["specs"],
        command: "get",
        body: { id, ...(options ?? {}) },
      });
    },
    /** List specs from .ravi/specs */
    list: async (options?: {
      domain?: string;
      kind?: string;
    }): Promise<SpecsListReturn> => {
      return this.transport.call({
        groupSegments: ["specs"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Create a new spec under .ravi/specs */
    new: async (id: string, options?: {
      full?: boolean;
      kind?: string;
      title?: string;
    }): Promise<SpecsNewReturn> => {
      return this.transport.call({
        groupSegments: ["specs"],
        command: "new",
        body: { id, ...(options ?? {}) },
      });
    },
    /** Rebuild the specs SQLite index from Markdown */
    sync: async (): Promise<SpecsSyncReturn> => {
      return this.transport.call({
        groupSegments: ["specs"],
        command: "sync",
        body: {},
      });
    }
  };

  readonly stickers = {
    /** Add or update a sticker catalog entry */
    add: async (id: string, mediaPath: string, options?: {
      agents?: string;
      avoid?: string;
      channels?: string;
      description?: string;
      disabled?: boolean;
      label?: string;
      overwrite?: boolean;
    }): Promise<StickersAddReturn> => {
      return this.transport.call({
        groupSegments: ["stickers"],
        command: "add",
        body: { id, mediaPath, ...(options ?? {}) },
      });
    },
    /** List stickers in the typed catalog */
    list: async (): Promise<StickersListReturn> => {
      return this.transport.call({
        groupSegments: ["stickers"],
        command: "list",
        body: {},
      });
    },
    /** Remove a sticker catalog entry */
    remove: async (id: string): Promise<StickersRemoveReturn> => {
      return this.transport.call({
        groupSegments: ["stickers"],
        command: "remove",
        body: { id },
      });
    },
    /** Send a sticker to the current WhatsApp chat */
    send: async (id: string, options?: {
      account?: string;
      channel?: string;
      session?: string;
      to?: string;
    }): Promise<StickersSendReturn> => {
      return this.transport.call({
        groupSegments: ["stickers"],
        command: "send",
        body: { id, ...(options ?? {}) },
      });
    },
    /** Show one sticker catalog entry */
    show: async (id: string): Promise<StickersShowReturn> => {
      return this.transport.call({
        groupSegments: ["stickers"],
        command: "show",
        body: { id },
      });
    }
  };

  readonly tags = {
    /** Attach a tag to an agent or session */
    attach: async (slug: string, options?: {
      agent?: string;
      meta?: string;
      session?: string;
    }): Promise<TagsAttachReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "attach",
        body: { slug, ...(options ?? {}) },
      });
    },
    /** Create a new tag definition */
    create: async (slug: string, options?: {
      description?: string;
      kind?: string;
      label?: string;
      meta?: string;
    }): Promise<TagsCreateReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "create",
        body: { slug, ...(options ?? {}) },
      });
    },
    /** Detach a tag from an agent or session */
    detach: async (slug: string, options?: {
      agent?: string;
      session?: string;
    }): Promise<TagsDetachReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "detach",
        body: { slug, ...(options ?? {}) },
      });
    },
    /** List tag definitions */
    list: async (): Promise<TagsListReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "list",
        body: {},
      });
    },
    /** Search bindings by tag or asset */
    search: async (options?: {
      agent?: string;
      session?: string;
      tag?: string;
    }): Promise<TagsSearchReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "search",
        body: { ...(options ?? {}) },
      });
    },
    /** Show one tag and its bindings */
    show: async (slug: string): Promise<TagsShowReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "show",
        body: { slug },
      });
    }
  };

  readonly tasks = {
    /** Archive a task without changing its execution status */
    archive: async (taskId: string, options?: {
      reason?: string;
    }): Promise<TasksArchiveReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "archive",
        body: { taskId, ...(options ?? {}) },
      });
    },
    automations: {
      /** Create a new task automation */
      add: async (name: string, options?: {
        agent?: string;
        checkpoint?: string;
        detached?: boolean;
        disabled?: boolean;
        filter?: string;
        freshCheckpoint?: boolean;
        freshReportEvents?: boolean;
        freshReportTo?: boolean;
        freshWorktree?: boolean;
        input?: string[];
        instructions?: string;
        on?: string;
        priority?: string;
        profile?: string;
        reportEvents?: string;
        reportTo?: string;
        session?: string;
        title?: string;
      }): Promise<TasksAutomationsAddReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","automations"],
          command: "add",
          body: { name, ...(options ?? {}) },
        });
      },
      /** Disable a task automation */
      disable: async (id: string): Promise<TasksAutomationsDisableReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","automations"],
          command: "disable",
          body: { id },
        });
      },
      /** Enable a task automation */
      enable: async (id: string): Promise<TasksAutomationsEnableReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","automations"],
          command: "enable",
          body: { id },
        });
      },
      /** List configured task automations */
      list: async (): Promise<TasksAutomationsListReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","automations"],
          command: "list",
          body: {},
        });
      },
      /** Delete a task automation */
      rm: async (id: string): Promise<TasksAutomationsRmReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","automations"],
          command: "rm",
          body: { id },
        });
      },
      /** Show one task automation and its recent runs */
      show: async (id: string): Promise<TasksAutomationsShowReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","automations"],
          command: "show",
          body: { id },
        });
      }
    },
    /** Mark a task as blocked */
    block: async (taskId: string, options?: {
      reason?: string;
    }): Promise<TasksBlockReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "block",
        body: { taskId, ...(options ?? {}) },
      });
    },
    /** Add a comment to a task and steer the assignee if it is active */
    comment: async (taskId: string, body: string): Promise<TasksCommentReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "comment",
        body: { taskId, body },
      });
    },
    /** Create a tracked task; unresolved dependencies arm launch plans instead of dispatching early */
    create: async (title: string, options?: {
      agent?: string;
      assignee?: string;
      checkpoint?: string;
      dependsOn?: string[];
      effort?: string;
      input?: string[];
      instructions?: string;
      model?: string;
      parent?: string;
      priority?: string;
      profile?: string;
      reportEvents?: string;
      reportTo?: string;
      session?: string;
      thinking?: string;
      worktreeBranch?: string;
      worktreeMode?: string;
      worktreePath?: string;
    }): Promise<TasksCreateReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "create",
        body: { title, ...(options ?? {}) },
      });
    },
    deps: {
      /** Add one gating dependency to a task */
      add: async (taskId: string, dependencyTaskId: string): Promise<TasksDepsAddReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","deps"],
          command: "add",
          body: { taskId, dependencyTaskId },
        });
      },
      /** List gating dependencies and dependents for a task */
      ls: async (taskId: string): Promise<TasksDepsLsReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","deps"],
          command: "ls",
          body: { taskId },
        });
      },
      /** Remove one gating dependency from a task */
      rm: async (taskId: string, dependencyTaskId: string): Promise<TasksDepsRmReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","deps"],
          command: "rm",
          body: { taskId, dependencyTaskId },
        });
      }
    },
    /** Dispatch a task now, or arm a launch plan if dependencies still gate start */
    dispatch: async (taskId: string, options?: {
      actorSession?: string;
      agent?: string;
      checkpoint?: string;
      effort?: string;
      model?: string;
      reportEvents?: string;
      reportTo?: string;
      session?: string;
      thinking?: string;
    }): Promise<TasksDispatchReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "dispatch",
        body: { taskId, ...(options ?? {}) },
      });
    },
    /** Mark a task as done */
    done: async (taskId: string, options?: {
      summary?: string;
    }): Promise<TasksDoneReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "done",
        body: { taskId, ...(options ?? {}) },
      });
    },
    /** Mark a task as failed */
    fail: async (taskId: string, options?: {
      reason?: string;
    }): Promise<TasksFailReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "fail",
        body: { taskId, ...(options ?? {}) },
      });
    },
    /** List tasks */
    list: async (options?: {
      agent?: string;
      all?: boolean;
      archived?: boolean;
      last?: string;
      mine?: boolean;
      parent?: string;
      profile?: string;
      root?: string;
      roots?: boolean;
      session?: string;
      status?: string;
      text?: string;
    }): Promise<TasksListReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    profiles: {
      /** Create a profile scaffold in the workspace or user catalog */
      init: async (profileId: string, options?: {
        preset?: string;
        source?: string;
      }): Promise<TasksProfilesInitReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","profiles"],
          command: "init",
          body: { profileId, ...(options ?? {}) },
        });
      },
      /** List resolved task profiles from all catalog sources */
      list: async (): Promise<TasksProfilesListReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","profiles"],
          command: "list",
          body: {},
        });
      },
      /** Render a profile preview with the resolved template context */
      preview: async (profileId: string, options?: {
        agent?: string;
        input?: string[];
        instructions?: string;
        session?: string;
        title?: string;
        worktreeBranch?: string;
        worktreeMode?: string;
        worktreePath?: string;
      }): Promise<TasksProfilesPreviewReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","profiles"],
          command: "preview",
          body: { profileId, ...(options ?? {}) },
        });
      },
      /** Show the resolved manifest for one task profile */
      show: async (profileId: string): Promise<TasksProfilesShowReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","profiles"],
          command: "show",
          body: { profileId },
        });
      },
      /** Validate one profile or the whole resolved catalog */
      validate: async (profileId?: string): Promise<TasksProfilesValidateReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","profiles"],
          command: "validate",
          body: { profileId },
        });
      }
    },
    /** Report task progress from a CLI or agent session */
    report: async (taskId: string, options?: {
      message?: string;
      progress?: string;
    }): Promise<TasksReportReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "report",
        body: { taskId, ...(options ?? {}) },
      });
    },
    /** Show task details and history */
    show: async (taskId: string, options?: {
      last?: string;
    }): Promise<TasksShowReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "show",
        body: { taskId, ...(options ?? {}) },
      });
    },
    /** Restore an archived task to the default list */
    unarchive: async (taskId: string): Promise<TasksUnarchiveReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "unarchive",
        body: { taskId },
      });
    },
    /** Watch task events live */
    watch: async (taskId?: string): Promise<TasksWatchReturn> => {
      return this.transport.call({
        groupSegments: ["tasks"],
        command: "watch",
        body: { taskId },
      });
    }
  };

  readonly tmux = {
    /** Attach or switch to an agent/session inside tmux */
    attach: async (agent: string, session?: string): Promise<TmuxAttachReturn> => {
      return this.transport.call({
        groupSegments: ["tmux"],
        command: "attach",
        body: { agent, session },
      });
    },
    /** List Ravi-managed tmux sessions and windows */
    list: async (): Promise<TmuxListReturn> => {
      return this.transport.call({
        groupSegments: ["tmux"],
        command: "list",
        body: {},
      });
    },
    /** Ensure a tmux session/window exists for an agent or session */
    open: async (agent: string, session?: string): Promise<TmuxOpenReturn> => {
      return this.transport.call({
        groupSegments: ["tmux"],
        command: "open",
        body: { agent, session },
      });
    },
    /** Listen to NATS prompts and open tmux windows automatically */
    watch: async (options?: {
      sync?: boolean;
    }): Promise<TmuxWatchReturn> => {
      return this.transport.call({
        groupSegments: ["tmux"],
        command: "watch",
        body: { ...(options ?? {}) },
      });
    }
  };

  readonly tools = {
    /** List all available CLI tools */
    list: async (): Promise<ToolsListReturn> => {
      return this.transport.call({
        groupSegments: ["tools"],
        command: "list",
        body: {},
      });
    },
    /** Export tools as JSON manifest */
    manifest: async (): Promise<ToolsManifestReturn> => {
      return this.transport.call({
        groupSegments: ["tools"],
        command: "manifest",
        body: {},
      });
    },
    /** Export tools as JSON Schema */
    schema: async (): Promise<ToolsSchemaReturn> => {
      return this.transport.call({
        groupSegments: ["tools"],
        command: "schema",
        body: {},
      });
    },
    /** Show details for a specific tool */
    show: async (name: string): Promise<ToolsShowReturn> => {
      return this.transport.call({
        groupSegments: ["tools"],
        command: "show",
        body: { name },
      });
    },
    /** Test a tool execution */
    test: async (name: string, args?: string): Promise<ToolsTestReturn> => {
      return this.transport.call({
        groupSegments: ["tools"],
        command: "test",
        body: { name, args },
      });
    }
  };

  readonly transcribe = {
    /** Transcribe a local audio file */
    file: async (path: string, options?: {
      lang?: string;
    }): Promise<TranscribeFileReturn> => {
      return this.transport.call({
        groupSegments: ["transcribe"],
        command: "file",
        body: { path, ...(options ?? {}) },
      });
    }
  };

  readonly triggers = {
    /** Add a new event trigger */
    add: async (name: string, options?: {
      account?: string;
      agent?: string;
      cooldown?: string;
      filter?: string;
      message?: string;
      session?: string;
      topic?: string;
    }): Promise<TriggersAddReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "add",
        body: { name, ...(options ?? {}) },
      });
    },
    /** Disable a trigger */
    disable: async (id: string): Promise<TriggersDisableReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "disable",
        body: { id },
      });
    },
    /** Enable a trigger */
    enable: async (id: string): Promise<TriggersEnableReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "enable",
        body: { id },
      });
    },
    /** List all event triggers */
    list: async (): Promise<TriggersListReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "list",
        body: {},
      });
    },
    /** Delete a trigger */
    rm: async (id: string): Promise<TriggersRmReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "rm",
        body: { id },
      });
    },
    /** Set trigger property */
    set: async (id: string, key: string, value: string): Promise<TriggersSetReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "set",
        body: { id, key, value },
      });
    },
    /** Show trigger details */
    show: async (id: string): Promise<TriggersShowReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "show",
        body: { id },
      });
    },
    /** Test trigger with fake event data */
    test: async (id: string): Promise<TriggersTestReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "test",
        body: { id },
      });
    }
  };

  readonly video = {
    /** Analyze a video (YouTube URL or local file) and save to markdown */
    analyze: async (url: string, options?: {
      output?: string;
      prompt?: string;
    }): Promise<VideoAnalyzeReturn> => {
      return this.transport.call({
        groupSegments: ["video"],
        command: "analyze",
        body: { url, ...(options ?? {}) },
      });
    }
  };

  readonly whatsapp = {
    dm: {
      /** Send read receipt (blue ticks) for a specific message */
      ack: async (contact: string, messageId: string, options?: {
        account?: string;
      }): Promise<WhatsappDmAckReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","dm"],
          command: "ack",
          body: { contact, messageId, ...(options ?? {}) },
        });
      },
      /** Read recent messages from a DM chat */
      read: async (contact: string, options?: {
        account?: string;
        last?: string;
        noAck?: boolean;
      }): Promise<WhatsappDmReadReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","dm"],
          command: "read",
          body: { contact, ...(options ?? {}) },
        });
      },
      /** Send a direct message to a contact */
      send: async (contact: string, message: string, options?: {
        account?: string;
      }): Promise<WhatsappDmSendReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","dm"],
          command: "send",
          body: { contact, message, ...(options ?? {}) },
        });
      }
    },
    group: {
      /** Add participants to a group */
      add: async (groupId: string, participants: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupAddReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "add",
          body: { groupId, participants, ...(options ?? {}) },
        });
      },
      /** Create a new group */
      create: async (name: string, participants: string, options?: {
        account?: string;
        agent?: string;
      }): Promise<WhatsappGroupCreateReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "create",
          body: { name, participants, ...(options ?? {}) },
        });
      },
      /** Demote participants from admin */
      demote: async (groupId: string, participants: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupDemoteReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "demote",
          body: { groupId, participants, ...(options ?? {}) },
        });
      },
      /** Update group description */
      description: async (groupId: string, text: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupDescriptionReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "description",
          body: { groupId, text, ...(options ?? {}) },
        });
      },
      /** Show group metadata */
      info: async (groupId: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupInfoReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "info",
          body: { groupId, ...(options ?? {}) },
        });
      },
      /** Get group invite link */
      invite: async (groupId: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupInviteReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "invite",
          body: { groupId, ...(options ?? {}) },
        });
      },
      /** Join a group via invite link/code */
      join: async (code: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupJoinReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "join",
          body: { code, ...(options ?? {}) },
        });
      },
      /** Leave a group */
      leave: async (groupId: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupLeaveReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "leave",
          body: { groupId, ...(options ?? {}) },
        });
      },
      /** List all groups the bot participates in */
      list: async (options?: {
        account?: string;
      }): Promise<WhatsappGroupListReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Promote participants to admin */
      promote: async (groupId: string, participants: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupPromoteReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "promote",
          body: { groupId, participants, ...(options ?? {}) },
        });
      },
      /** Remove participants from a group */
      remove: async (groupId: string, participants: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupRemoveReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "remove",
          body: { groupId, participants, ...(options ?? {}) },
        });
      },
      /** Rename a group */
      rename: async (groupId: string, name: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupRenameReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "rename",
          body: { groupId, name, ...(options ?? {}) },
        });
      },
      /** Revoke current invite link */
      revokeInvite: async (groupId: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupRevokeInviteReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "revoke-invite",
          body: { groupId, ...(options ?? {}) },
        });
      },
      /** Update group settings (announcement, not_announcement, locked, unlocked) */
      settings: async (groupId: string, setting: string, options?: {
        account?: string;
      }): Promise<WhatsappGroupSettingsReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "settings",
          body: { groupId, setting, ...(options ?? {}) },
        });
      }
    }
  };

  readonly workflows = {
    runs: {
      /** Archive one node run from workflow aggregate state */
      archiveNode: async (runId: string, nodeKey: string): Promise<WorkflowsRunsArchiveNodeReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "archive-node",
          body: { runId, nodeKey },
        });
      },
      /** Cancel one workflow node run */
      cancel: async (runId: string, nodeKey: string): Promise<WorkflowsRunsCancelReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "cancel",
          body: { runId, nodeKey },
        });
      },
      /** List workflow runs */
      list: async (): Promise<WorkflowsRunsListReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "list",
          body: {},
        });
      },
      /** Release a manual node transition or gate */
      release: async (runId: string, nodeKey: string): Promise<WorkflowsRunsReleaseReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "release",
          body: { runId, nodeKey },
        });
      },
      /** Show one workflow run with node state */
      show: async (runId: string): Promise<WorkflowsRunsShowReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "show",
          body: { runId },
        });
      },
      /** Skip one optional workflow node */
      skip: async (runId: string, nodeKey: string): Promise<WorkflowsRunsSkipReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "skip",
          body: { runId, nodeKey },
        });
      },
      /** Instantiate one workflow run from a spec */
      start: async (specId: string, options?: {
        runId?: string;
      }): Promise<WorkflowsRunsStartReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "start",
          body: { specId, ...(options ?? {}) },
        });
      },
      /** Attach an existing task to a workflow task node */
      taskAttach: async (runId: string, nodeKey: string, taskId: string): Promise<WorkflowsRunsTaskAttachReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "task-attach",
          body: { runId, nodeKey, taskId },
        });
      },
      /** Create a new task attempt for one workflow task node */
      taskCreate: async (runId: string, nodeKey: string, options?: {
        agent?: string;
        instructions?: string;
        priority?: string;
        profile?: string;
        session?: string;
        title?: string;
      }): Promise<WorkflowsRunsTaskCreateReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "task-create",
          body: { runId, nodeKey, ...(options ?? {}) },
        });
      }
    },
    specs: {
      /** Create one workflow spec from narrow JSON definition */
      create: async (specId: string, options?: {
        definition?: string;
        file?: string;
      }): Promise<WorkflowsSpecsCreateReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","specs"],
          command: "create",
          body: { specId, ...(options ?? {}) },
        });
      },
      /** List workflow specs */
      list: async (): Promise<WorkflowsSpecsListReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","specs"],
          command: "list",
          body: {},
        });
      },
      /** Show one workflow spec */
      show: async (specId: string): Promise<WorkflowsSpecsShowReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","specs"],
          command: "show",
          body: { specId },
        });
      }
    }
  };
}
