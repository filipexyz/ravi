// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).

import type { Transport } from "./transport/types.js";
import type { AdaptersListReturn, AdaptersShowReturn, AgentsCreateReturn, AgentsDebounceReturn, AgentsDebugReturn, AgentsDeleteReturn, AgentsListReturn, AgentsResetReturn, AgentsSessionReturn, AgentsSetReturn, AgentsShowReturn, AgentsSpecModeReturn, AgentsSyncInstructionsReturn, ArtifactsArchiveReturn, ArtifactsAttachReturn, ArtifactsBlobReturn, ArtifactsCreateReturn, ArtifactsEventReturn, ArtifactsEventsReturn, ArtifactsListReturn, ArtifactsPublishReturn, ArtifactsReleaseActivateReturn, ArtifactsRestoreReturn, ArtifactsShowReturn, ArtifactsSnapshotReturn, ArtifactsUpdateReturn, ArtifactsVersionReturn, ArtifactsVersionsReturn, AudioGenerateReturn, ChatsBackfillProviderTimestampsReturn, ChatsListReturn, ChatsListsAddReturn, ChatsListsCreateReturn, ChatsListsDeltaReturn, ChatsListsListReturn, ChatsListsMarkReadReturn, ChatsListsMembersReturn, ChatsListsRemoveReturn, ChatsReadReturn, CommandsListReturn, CommandsRunReturn, CommandsShowReturn, CommandsValidateReturn, ContactsActivityReturn, ContactsAddReturn, ContactsAllowReturn, ContactsApproveReturn, ContactsBackfillReturn, ContactsBlockReturn, ContactsCheckReturn, ContactsDuplicatesReturn, ContactsFindReturn, ContactsGetReturn, ContactsInfoReturn, ContactsLinkReturn, ContactsListReturn, ContactsMergeReturn, ContactsMessagesReturn, ContactsMetadataListReturn, ContactsMetadataRemoveReturn, ContactsMetadataSetReturn, ContactsNoteReturn, ContactsPendingReturn, ContactsProfileReturn, ContactsRemoveReturn, ContactsSessionsReturn, ContactsSetReturn, ContactsTagReturn, ContactsTimelineReturn, ContactsUnlinkReturn, ContactsUntagReturn, ContextAuthorizeReturn, ContextCapabilitiesReturn, ContextCheckReturn, ContextCleanupAgentRuntimeReturn, ContextCodexBashHookReturn, ContextCredentialsAddReturn, ContextCredentialsListReturn, ContextCredentialsRemoveReturn, ContextCredentialsSetDefaultReturn, ContextInfoReturn, ContextIssueReturn, ContextLineageReturn, ContextListReturn, ContextRevokeReturn, ContextVisibilityReturn, ContextWhoamiReturn, CostsAgentReturn, CostsAgentsReturn, CostsSessionReturn, CostsSummaryReturn, CostsTopSessionsReturn, CrmAccountCreateReturn, CrmAccountLinkContactReturn, CrmAccountReturn, CrmAccountShowReturn, CrmBoardReturn, CrmContactReturn, CrmContactSetReturn, CrmContactShowReturn, CrmContactsReturn, CrmFactConfirmReturn, CrmFactListReturn, CrmFactProposeReturn, CrmFactRejectReturn, CrmNextReturn, CrmOpportunityContactsReturn, CrmOpportunityCreateReturn, CrmOpportunityLinkContactReturn, CrmOpportunityMoveReturn, CrmOpportunityReturn, CrmOpportunityShowReturn, CrmPipelineCreateReturn, CrmPipelineListReturn, CrmPipelineSetReturn, CrmPipelineShowReturn, CrmPipelineStageAddReturn, CrmPipelineStageArchiveReturn, CrmPipelineStageListReturn, CrmPipelineStageSetReturn, CrmPipelineStageShowReturn, CrmPipelineStageTopicAddReturn, CrmPipelineStageTopicArchiveReturn, CrmPipelineStageTopicSetReturn, CrmPipelineStageTopicsReturn, CrmTaskCancelReturn, CrmTaskCreateReturn, CrmTaskDoneReturn, CrmTaskListReturn, CrmTaskShowReturn, CrmTaskSnoozeReturn, CronAddReturn, CronDisableReturn, CronEnableReturn, CronListReturn, CronRmReturn, CronRunReturn, CronSetReturn, CronShowReturn, DaemonEnvReturn, DaemonInitAdminKeyReturn, DaemonInstallReturn, DaemonLogsReturn, DaemonRestartReturn, DaemonStartReturn, DaemonStatusReturn, DaemonStopReturn, DaemonUninstallReturn, DevinAuthCheckReturn, DevinSessionsArchiveReturn, DevinSessionsAttachmentsReturn, DevinSessionsCreateReturn, DevinSessionsInsightsReturn, DevinSessionsListReturn, DevinSessionsMessagesReturn, DevinSessionsSendReturn, DevinSessionsShowReturn, DevinSessionsSyncReturn, DevinSessionsTerminateReturn, EvalRunReturn, HeartbeatDisableReturn, HeartbeatEnableReturn, HeartbeatSetReturn, HeartbeatShowReturn, HeartbeatStatusReturn, HeartbeatTriggerReturn, HooksCreateReturn, HooksDisableReturn, HooksEnableReturn, HooksListReturn, HooksRmReturn, HooksShowReturn, HooksTestReturn, ImageAtlasSplitReturn, ImageGenerateReturn, InboxDisableReturn, InboxEnableReturn, InboxItemsReturn, InboxPollReturn, InboxReplayReturn, InboxStatusReturn, InsightsCreateReturn, InsightsListReturn, InsightsSearchReturn, InsightsShowReturn, InstancesCreateReturn, InstancesDeleteReturn, InstancesDeletedReturn, InstancesDisableReturn, InstancesDisconnectReturn, InstancesEnableReturn, InstancesGetReturn, InstancesListReturn, InstancesPendingApproveReturn, InstancesPendingListReturn, InstancesPendingRejectReturn, InstancesRestoreReturn, InstancesRoutesAddReturn, InstancesRoutesDeletedReturn, InstancesRoutesListReturn, InstancesRoutesRemoveReturn, InstancesRoutesRestoreReturn, InstancesRoutesSetReturn, InstancesRoutesShowReturn, InstancesSetReturn, InstancesShowReturn, InstancesStatusReturn, InstancesTargetReturn, MediaSendReturn, ObserversListReturn, ObserversProfilesInitReturn, ObserversProfilesListReturn, ObserversProfilesPreviewReturn, ObserversProfilesShowReturn, ObserversProfilesValidateReturn, ObserversRefreshReturn, ObserversRulesDisableReturn, ObserversRulesEnableReturn, ObserversRulesExplainReturn, ObserversRulesListReturn, ObserversRulesRmReturn, ObserversRulesSetReturn, ObserversRulesShowReturn, ObserversRulesValidateReturn, ObserversShowReturn, PermissionsCheckReturn, PermissionsClearReturn, PermissionsGrantReturn, PermissionsInitReturn, PermissionsListReturn, PermissionsRevokeReturn, PermissionsSyncReturn, ProjectsCreateReturn, ProjectsFixturesSeedReturn, ProjectsInitReturn, ProjectsLinkReturn, ProjectsListReturn, ProjectsNextReturn, ProjectsResourcesAddReturn, ProjectsResourcesImportReturn, ProjectsResourcesListReturn, ProjectsResourcesShowReturn, ProjectsShowReturn, ProjectsStatusReturn, ProjectsTasksAttachReturn, ProjectsTasksCreateReturn, ProjectsTasksDispatchReturn, ProjectsUpdateReturn, ProjectsWorkflowsAttachReturn, ProjectsWorkflowsStartReturn, ProxCallsCancelReturn, ProxCallsEventsReturn, ProxCallsProfilesConfigureReturn, ProxCallsProfilesListReturn, ProxCallsProfilesShowReturn, ProxCallsRequestReturn, ProxCallsRulesReturn, ProxCallsShowReturn, ProxCallsToolsBindReturn, ProxCallsToolsConfigureReturn, ProxCallsToolsCreateReturn, ProxCallsToolsListReturn, ProxCallsToolsRunReturn, ProxCallsToolsRunsReturn, ProxCallsToolsShowReturn, ProxCallsToolsUnbindReturn, ProxCallsTranscriptReturn, ProxCallsVoiceAgentsBindToolReturn, ProxCallsVoiceAgentsConfigureReturn, ProxCallsVoiceAgentsCreateReturn, ProxCallsVoiceAgentsListReturn, ProxCallsVoiceAgentsShowReturn, ProxCallsVoiceAgentsSyncReturn, ProxCallsVoiceAgentsUnbindToolReturn, ReactSendReturn, RoutesExplainReturn, RoutesListReturn, RoutesShowReturn, RulesImportReturn, RulesSourcesReturn, RuntimeCredentialsAddReturn, RuntimeCredentialsClassifyReturn, RuntimeCredentialsDisableReturn, RuntimeCredentialsEnableReturn, RuntimeCredentialsImportReturn, RuntimeCredentialsListReturn, RuntimeCredentialsRefreshReturn, RuntimeCredentialsResetHealthReturn, RuntimeCredentialsSelectReturn, RuntimeCredentialsStatusReturn, SdkClientCheckReturn, SdkClientGenerateReturn, SdkOpenapiCheckReturn, SdkOpenapiEmitReturn, SdkSwiftCheckReturn, SdkSwiftGenerateReturn, SelfChatReturn, SelfContextReturn, SelfExplainReturn, SelfKnowledgeReturn, SelfPermissionsReturn, SelfRecentReturn, SelfRouteReturn, SelfWhoamiReturn, ServiceStartReturn, ServiceTuiReturn, ServiceWaReturn, SessionsActionsReturn, SessionsAnswerReturn, SessionsAskReturn, SessionsAttachReturn, SessionsDeleteMessageReturn, SessionsDeleteReturn, SessionsDetachReturn, SessionsEditMessageReturn, SessionsExecuteReturn, SessionsExtendReturn, SessionsGoalReturn, SessionsInfoReturn, SessionsInformReturn, SessionsKeepReturn, SessionsListReturn, SessionsMuteReturn, SessionsPruneReturn, SessionsReadReturn, SessionsRenameReturn, SessionsResetReturn, SessionsRuntimeFollowUpReturn, SessionsRuntimeForkReturn, SessionsRuntimeInterruptReturn, SessionsRuntimeListReturn, SessionsRuntimeReadReturn, SessionsRuntimeRollbackReturn, SessionsRuntimeSteerReturn, SessionsSendReturn, SessionsSetDisplayReturn, SessionsSetModelReturn, SessionsSetThinkingReturn, SessionsSetTtlReturn, SessionsSubscriptionsReturn, SessionsTraceReturn, SessionsUnmuteReturn, SessionsVisibilityReturn, SettingsDeleteReturn, SettingsGetReturn, SettingsListReturn, SettingsSetReturn, SkillGatesDisableReturn, SkillGatesEnableReturn, SkillGatesListReturn, SkillGatesResetReturn, SkillGatesRmReturn, SkillGatesSetReturn, SkillGatesShowReturn, SkillsInstallReturn, SkillsListReturn, SkillsShowReturn, SkillsSyncReturn, SpecsGetReturn, SpecsListReturn, SpecsNewReturn, SpecsSyncReturn, StickersAddReturn, StickersListReturn, StickersRemoveReturn, StickersSendReturn, StickersShowReturn, TagRulesEvaluateReturn, TagRulesExplainReturn, TagRulesListReturn, TagRulesShowReturn, TagRulesTickReturn, TagRulesValidateReturn, TagsAttachReturn, TagsCreateReturn, TagsDetachReturn, TagsListReturn, TagsSearchReturn, TagsSetReturn, TagsShowReturn, TasksArchiveReturn, TasksAutomationsAddReturn, TasksAutomationsDisableReturn, TasksAutomationsEnableReturn, TasksAutomationsListReturn, TasksAutomationsRmReturn, TasksAutomationsShowReturn, TasksBlockReturn, TasksCommentReturn, TasksCreateReturn, TasksDepsAddReturn, TasksDepsLsReturn, TasksDepsRmReturn, TasksDispatchReturn, TasksDoneReturn, TasksFailReturn, TasksListReturn, TasksProfilesInitReturn, TasksProfilesListReturn, TasksProfilesPreviewReturn, TasksProfilesShowReturn, TasksProfilesValidateReturn, TasksReportReturn, TasksShowReturn, TasksUnarchiveReturn, ThreadsBriefReturn, ThreadsCloseReturn, ThreadsCommentReturn, ThreadsCreateReturn, ThreadsEntriesReturn, ThreadsLinkReturn, ThreadsListReturn, ThreadsNoteReturn, ThreadsShowReturn, ToolsListReturn, ToolsManifestReturn, ToolsSchemaReturn, ToolsShowReturn, ToolsTestReturn, TranscribeFileReturn, TriggersAddReturn, TriggersDisableReturn, TriggersEnableReturn, TriggersListReturn, TriggersRmReturn, TriggersSetReturn, TriggersShowReturn, TriggersTestReturn, TriggersTopicsReturn, VideoAnalyzeReturn, WatchConnectorsReturn, WatchCreateReturn, WatchDisableReturn, WatchEnableReturn, WatchEventsReturn, WatchListReturn, WatchRmReturn, WatchShowReturn, WatchTriggerReturn, WhatsappDmAckReturn, WhatsappDmReadReturn, WhatsappDmSendReturn, WhatsappGroupAddReturn, WhatsappGroupCreateReturn, WhatsappGroupDemoteReturn, WhatsappGroupDescriptionReturn, WhatsappGroupInfoReturn, WhatsappGroupInviteReturn, WhatsappGroupJoinReturn, WhatsappGroupLeaveReturn, WhatsappGroupListReturn, WhatsappGroupPromoteReturn, WhatsappGroupRemoveReturn, WhatsappGroupRenameReturn, WhatsappGroupRevokeInviteReturn, WhatsappGroupSendReturn, WhatsappGroupSettingsReturn, WorkflowsRunsArchiveNodeReturn, WorkflowsRunsCancelReturn, WorkflowsRunsListReturn, WorkflowsRunsReleaseReturn, WorkflowsRunsShowReturn, WorkflowsRunsSkipReturn, WorkflowsRunsStartReturn, WorkflowsRunsTaskAttachReturn, WorkflowsRunsTaskCreateReturn, WorkflowsSpecsCreateReturn, WorkflowsSpecsListReturn, WorkflowsSpecsShowReturn } from "./types.js";

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
      limit?: string;
      offset?: string;
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
    list: async (options?: {
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<AgentsListReturn> => {
      return this.transport.call({
        groupSegments: ["agents"],
        command: "list",
        body: { ...(options ?? {}) },
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
    create: async (options?: {
      assetBase?: string;
      basePath?: string;
      command?: string;
      costUsd?: string;
      durationMs?: string;
      entrypoint?: string;
      input?: string;
      inputTokens?: string;
      kind?: string;
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
        body: { ...(options ?? {}) },
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
      offset?: string;
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
    /** Publish a local artifact package through a Console-compatible endpoint */
    publish: async (target: string, options?: {
      artifactVersion?: string;
      assetBase?: string;
      basePath?: string;
      console?: string;
      description?: string;
      entrypoint?: string;
      idempotencyKey?: string;
      name?: string;
      noActivate?: boolean;
      project?: string;
      reason?: string;
      replaceRelease?: boolean;
      route?: string;
      site?: string;
      slug?: string;
      uploadSession?: string;
      visibility?: string;
    }): Promise<ArtifactsPublishReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "publish",
        body: { target, ...(options ?? {}) },
      });
    },
    release: {
      /** Activate an existing Pages release for a local artifact */
      activate: async (id: string, options?: {
        console?: string;
        release?: string;
        site?: string;
        version?: string;
      }): Promise<ArtifactsReleaseActivateReturn> => {
        return this.transport.call({
          groupSegments: ["artifacts","release"],
          command: "activate",
          body: { id, ...(options ?? {}) },
        });
      }
    },
    /** Restore current artifact content from an immutable version */
    restore: async (id: string, options?: {
      message?: string;
      version?: string;
    }): Promise<ArtifactsRestoreReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "restore",
        body: { id, ...(options ?? {}) },
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
    /** Create an immutable version snapshot for an artifact */
    snapshot: async (id: string, options?: {
      label?: string;
      manifest?: string;
      message?: string;
      metadata?: string;
      source?: string;
      status?: string;
    }): Promise<ArtifactsSnapshotReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "snapshot",
        body: { id, ...(options ?? {}) },
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
    /** Show one immutable artifact version */
    version: async (id: string, options?: {
      version?: string;
    }): Promise<ArtifactsVersionReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "version",
        body: { id, ...(options ?? {}) },
      });
    },
    /** List immutable versions for an artifact */
    versions: async (id: string): Promise<ArtifactsVersionsReturn> => {
      return this.transport.call({
        groupSegments: ["artifacts"],
        command: "versions",
        body: { id },
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

  readonly chats = {
    /** Backfill message provider timestamps from raw provenance */
    backfillProviderTimestamps: async (options?: {
      apply?: boolean;
      dryRun?: boolean;
      limit?: string;
    }): Promise<ChatsBackfillProviderTimestampsReturn> => {
      return this.transport.call({
        groupSegments: ["chats"],
        command: "backfill-provider-timestamps",
        body: { ...(options ?? {}) },
      });
    },
    /** List recent canonical chats */
    list: async (options?: {
      agent?: string;
      channel?: string;
      contact?: string;
      includeRaw?: boolean;
      instance?: string;
      limit?: string;
      offset?: string;
      query?: string;
      type?: string;
    }): Promise<ChatsListReturn> => {
      return this.transport.call({
        groupSegments: ["chats"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    lists: {
      /** Add a chat to a reading list */
      add: async (list: string, chat: string, options?: {
        channel?: string;
        includeRaw?: boolean;
        instance?: string;
        owner?: string;
        priority?: string;
        reason?: string;
      }): Promise<ChatsListsAddReturn> => {
        return this.transport.call({
          groupSegments: ["chats","lists"],
          command: "add",
          body: { list, chat, ...(options ?? {}) },
        });
      },
      /** Create or restore a chat reading list */
      create: async (name: string, options?: {
        description?: string;
        mode?: string;
        owner?: string;
        visibility?: string;
      }): Promise<ChatsListsCreateReturn> => {
        return this.transport.call({
          groupSegments: ["chats","lists"],
          command: "create",
          body: { name, ...(options ?? {}) },
        });
      },
      /** Read what changed in a chat since this list reader cursor */
      delta: async (list: string, chat: string, options?: {
        channel?: string;
        includeRaw?: boolean;
        instance?: string;
        limit?: string;
        markRead?: boolean;
        owner?: string;
        reader?: string;
      }): Promise<ChatsListsDeltaReturn> => {
        return this.transport.call({
          groupSegments: ["chats","lists"],
          command: "delta",
          body: { list, chat, ...(options ?? {}) },
        });
      },
      /** List chat reading lists */
      list: async (options?: {
        includeArchived?: boolean;
        limit?: string;
        offset?: string;
        owner?: string;
      }): Promise<ChatsListsListReturn> => {
        return this.transport.call({
          groupSegments: ["chats","lists"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Explicitly advance one reading-list cursor */
      markRead: async (list: string, chat: string, options?: {
        channel?: string;
        includeRaw?: boolean;
        instance?: string;
        message?: string;
        owner?: string;
        reader?: string;
        reason?: string;
      }): Promise<ChatsListsMarkReadReturn> => {
        return this.transport.call({
          groupSegments: ["chats","lists"],
          command: "mark-read",
          body: { list, chat, ...(options ?? {}) },
        });
      },
      /** List chats in a reading list with unread counts */
      members: async (list: string, options?: {
        includeRaw?: boolean;
        limit?: string;
        offset?: string;
        owner?: string;
        reader?: string;
      }): Promise<ChatsListsMembersReturn> => {
        return this.transport.call({
          groupSegments: ["chats","lists"],
          command: "members",
          body: { list, ...(options ?? {}) },
        });
      },
      /** Remove a chat from a reading list without deleting cursor history */
      remove: async (list: string, chat: string, options?: {
        channel?: string;
        instance?: string;
        owner?: string;
      }): Promise<ChatsListsRemoveReturn> => {
        return this.transport.call({
          groupSegments: ["chats","lists"],
          command: "remove",
          body: { list, chat, ...(options ?? {}) },
        });
      }
    },
    /** Read messages from one chat */
    read: async (chat: string, options?: {
      channel?: string;
      includeRaw?: boolean;
      instance?: string;
      limit?: string;
      offset?: string;
      order?: string;
      type?: string;
    }): Promise<ChatsReadReturn> => {
      return this.transport.call({
        groupSegments: ["chats"],
        command: "read",
        body: { chat, ...(options ?? {}) },
      });
    }
  };

  readonly commands = {
    /** List Ravi commands */
    list: async (options?: {
      agent?: string;
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<CommandsListReturn> => {
      return this.transport.call({
        groupSegments: ["commands"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Render a Ravi command into its composed prompt */
    run: async (name: string, args: string[], options?: {
      agent?: string;
    }): Promise<CommandsRunReturn> => {
      return this.transport.call({
        groupSegments: ["commands"],
        command: "run",
        body: { name, args, ...(options ?? {}) },
      });
    },
    /** Show one Ravi command */
    show: async (name: string, options?: {
      agent?: string;
    }): Promise<CommandsShowReturn> => {
      return this.transport.call({
        groupSegments: ["commands"],
        command: "show",
        body: { name, ...(options ?? {}) },
      });
    },
    /** Validate Ravi command files */
    validate: async (options?: {
      agent?: string;
    }): Promise<CommandsValidateReturn> => {
      return this.transport.call({
        groupSegments: ["commands"],
        command: "validate",
        body: { ...(options ?? {}) },
      });
    }
  };

  readonly contacts = {
    /** Show session activity attributed to a contact */
    activity: async (contact: string, options?: {
      limit?: string;
      offset?: string;
      raw?: boolean;
    }): Promise<ContactsActivityReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "activity",
        body: { contact, ...(options ?? {}) },
      });
    },
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
    /** Backfill canonical contacts from captured chats */
    backfill: async (options?: {
      apply?: boolean;
      channel?: string;
      createList?: string;
      dryRun?: boolean;
      instance?: string;
      limit?: string;
      listOwner?: string;
      mode?: string;
    }): Promise<ContactsBackfillReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "backfill",
        body: { ...(options ?? {}) },
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
      limit?: string;
      offset?: string;
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
    /** Show messages attributed to a contact */
    messages: async (contact: string, options?: {
      limit?: string;
      offset?: string;
    }): Promise<ContactsMessagesReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "messages",
        body: { contact, ...(options ?? {}) },
      });
    },
    metadata: {
      /** List current scoped metadata for a contact */
      list: async (contact: string, options?: {
        limit?: string;
        offset?: string;
        scope?: string;
      }): Promise<ContactsMetadataListReturn> => {
        return this.transport.call({
          groupSegments: ["contacts","metadata"],
          command: "list",
          body: { contact, ...(options ?? {}) },
        });
      },
      /** Remove scoped metadata from a contact */
      remove: async (contact: string, key: string, options?: {
        scope?: string;
        source?: string;
      }): Promise<ContactsMetadataRemoveReturn> => {
        return this.transport.call({
          groupSegments: ["contacts","metadata"],
          command: "remove",
          body: { contact, key, ...(options ?? {}) },
        });
      },
      /** Set scoped metadata for a contact */
      set: async (contact: string, key: string, value: string, options?: {
        scope?: string;
        source?: string;
      }): Promise<ContactsMetadataSetReturn> => {
        return this.transport.call({
          groupSegments: ["contacts","metadata"],
          command: "set",
          body: { contact, key, value, ...(options ?? {}) },
        });
      }
    },
    /** Append a note to a contact timeline */
    note: async (contact: string, text: string, options?: {
      scope?: string;
      source?: string;
    }): Promise<ContactsNoteReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "note",
        body: { contact, text, ...(options ?? {}) },
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
    /** Show a contact profile card */
    profile: async (contact: string, options?: {
      includeCrm?: boolean;
      limit?: string;
    }): Promise<ContactsProfileReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "profile",
        body: { contact, ...(options ?? {}) },
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
    /** Show session summaries attributed to a contact */
    sessions: async (contact: string, options?: {
      limit?: string;
      offset?: string;
    }): Promise<ContactsSessionsReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "sessions",
        body: { contact, ...(options ?? {}) },
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
    /** Show contact timeline events */
    timeline: async (contact: string, options?: {
      event?: string;
      limit?: string;
      offset?: string;
      scope?: string;
    }): Promise<ContactsTimelineReturn> => {
      return this.transport.call({
        groupSegments: ["contacts"],
        command: "timeline",
        body: { contact, ...(options ?? {}) },
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
    /** Dry-run or revoke stale agent-runtime contexts left by old turn-scoped issuance */
    cleanupAgentRuntime: async (options?: {
      agent?: string;
      olderThan?: string;
      reason?: string;
      revoke?: boolean;
      session?: string;
    }): Promise<ContextCleanupAgentRuntimeReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "cleanup-agent-runtime",
        body: { ...(options ?? {}) },
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
      list: async (options?: {
        limit?: string;
        offset?: string;
      }): Promise<ContextCredentialsListReturn> => {
        return this.transport.call({
          groupSegments: ["context","credentials"],
          command: "list",
          body: { ...(options ?? {}) },
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
      limit?: string;
      offset?: string;
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
    /** Show the current context session visibility */
    visibility: async (): Promise<ContextVisibilityReturn> => {
      return this.transport.call({
        groupSegments: ["context"],
        command: "visibility",
        body: {},
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

  readonly crm = {
    account: {
      /** Create a CRM account */
      create: async (name: string, options?: {
        contact?: string;
        domain?: string;
        idempotencyKey?: string;
        owner?: string;
      }): Promise<CrmAccountCreateReturn> => {
        return this.transport.call({
          groupSegments: ["crm","account"],
          command: "create",
          body: { name, ...(options ?? {}) },
        });
      },
      /** Link a contact to an account */
      linkContact: async (account: string, contact: string, options?: {
        primary?: boolean;
        role?: string;
      }): Promise<CrmAccountLinkContactReturn> => {
        return this.transport.call({
          groupSegments: ["crm","account"],
          command: "link-contact",
          body: { account, contact, ...(options ?? {}) },
        });
      },
      /** Show CRM account */
      show: async (account: string): Promise<CrmAccountShowReturn> => {
        return this.transport.call({
          groupSegments: ["crm","account"],
          command: "show",
          body: { account },
        });
      }
    },
    /** Show CRM account */
    accountCommand: async (account: string): Promise<CrmAccountReturn> => {
      return this.transport.call({
        groupSegments: ["crm"],
        command: "account",
        body: { account },
      });
    },
    /** Show open opportunity board */
    board: async (options?: {
      includeEmptyStages?: boolean;
      pipeline?: string;
    }): Promise<CrmBoardReturn> => {
      return this.transport.call({
        groupSegments: ["crm"],
        command: "board",
        body: { ...(options ?? {}) },
      });
    },
    contact: {
      /** Set one CRM contact profile field */
      set: async (contact: string, field: string, value: string, options?: {
        source?: string;
      }): Promise<CrmContactSetReturn> => {
        return this.transport.call({
          groupSegments: ["crm","contact"],
          command: "set",
          body: { contact, field, value, ...(options ?? {}) },
        });
      },
      /** Show CRM profile for one contact */
      show: async (contact: string): Promise<CrmContactShowReturn> => {
        return this.transport.call({
          groupSegments: ["crm","contact"],
          command: "show",
          body: { contact },
        });
      }
    },
    /** Show CRM profile for one contact */
    contactCommand: async (contact: string): Promise<CrmContactReturn> => {
      return this.transport.call({
        groupSegments: ["crm"],
        command: "contact",
        body: { contact },
      });
    },
    /** List CRM contact cards */
    contacts: async (options?: {
      limit?: string;
      offset?: string;
      owner?: string;
      status?: string;
    }): Promise<CrmContactsReturn> => {
      return this.transport.call({
        groupSegments: ["crm"],
        command: "contacts",
        body: { ...(options ?? {}) },
      });
    },
    fact: {
      /** Confirm a CRM fact */
      confirm: async (fact: string): Promise<CrmFactConfirmReturn> => {
        return this.transport.call({
          groupSegments: ["crm","fact"],
          command: "confirm",
          body: { fact },
        });
      },
      /** List CRM facts */
      list: async (options?: {
        account?: string;
        contact?: string;
        entity?: string;
        entityType?: string;
        key?: string;
        limit?: string;
        offset?: string;
        opportunity?: string;
        status?: string;
      }): Promise<CrmFactListReturn> => {
        return this.transport.call({
          groupSegments: ["crm","fact"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Propose or confirm a CRM fact */
      propose: async (entityType: string, entity: string, key: string, value: string, options?: {
        account?: string;
        confidence?: string;
        contact?: string;
        idempotencyKey?: string;
        opportunity?: string;
        status?: string;
      }): Promise<CrmFactProposeReturn> => {
        return this.transport.call({
          groupSegments: ["crm","fact"],
          command: "propose",
          body: { entityType, entity, key, value, ...(options ?? {}) },
        });
      },
      /** Reject a CRM fact */
      reject: async (fact: string): Promise<CrmFactRejectReturn> => {
        return this.transport.call({
          groupSegments: ["crm","fact"],
          command: "reject",
          body: { fact },
        });
      }
    },
    /** List open CRM next actions */
    next: async (options?: {
      account?: string;
      contact?: string;
      dueAfter?: string;
      dueBefore?: string;
      dueToday?: boolean;
      limit?: string;
      offset?: string;
      opportunity?: string;
      owner?: string;
      taskType?: string;
    }): Promise<CrmNextReturn> => {
      return this.transport.call({
        groupSegments: ["crm"],
        command: "next",
        body: { ...(options ?? {}) },
      });
    },
    opportunity: {
      /** List contacts linked to an opportunity */
      contacts: async (opportunity: string): Promise<CrmOpportunityContactsReturn> => {
        return this.transport.call({
          groupSegments: ["crm","opportunity"],
          command: "contacts",
          body: { opportunity },
        });
      },
      /** Create a CRM opportunity */
      create: async (title: string, options?: {
        account?: string;
        contact?: string;
        currency?: string;
        idempotencyKey?: string;
        owner?: string;
        stage?: string;
        value?: string;
      }): Promise<CrmOpportunityCreateReturn> => {
        return this.transport.call({
          groupSegments: ["crm","opportunity"],
          command: "create",
          body: { title, ...(options ?? {}) },
        });
      },
      /** Link a contact to an opportunity */
      linkContact: async (opportunity: string, contact: string, options?: {
        account?: string;
        primary?: boolean;
        role?: string;
      }): Promise<CrmOpportunityLinkContactReturn> => {
        return this.transport.call({
          groupSegments: ["crm","opportunity"],
          command: "link-contact",
          body: { opportunity, contact, ...(options ?? {}) },
        });
      },
      /** Move an opportunity to another stage */
      move: async (opportunity: string, stage: string, options?: {
        lostReason?: string;
      }): Promise<CrmOpportunityMoveReturn> => {
        return this.transport.call({
          groupSegments: ["crm","opportunity"],
          command: "move",
          body: { opportunity, stage, ...(options ?? {}) },
        });
      },
      /** Show CRM opportunity */
      show: async (opportunity: string): Promise<CrmOpportunityShowReturn> => {
        return this.transport.call({
          groupSegments: ["crm","opportunity"],
          command: "show",
          body: { opportunity },
        });
      }
    },
    /** Show CRM opportunity */
    opportunityCommand: async (opportunity: string): Promise<CrmOpportunityReturn> => {
      return this.transport.call({
        groupSegments: ["crm"],
        command: "opportunity",
        body: { opportunity },
      });
    },
    pipeline: {
      /** Create a CRM pipeline */
      create: async (name: string, options?: {
        default?: boolean;
        entityType?: string;
        idempotencyKey?: string;
        metadata?: string;
      }): Promise<CrmPipelineCreateReturn> => {
        return this.transport.call({
          groupSegments: ["crm","pipeline"],
          command: "create",
          body: { name, ...(options ?? {}) },
        });
      },
      /** List CRM pipelines */
      list: async (options?: {
        entityType?: string;
        includeArchived?: boolean;
        limit?: string;
        offset?: string;
      }): Promise<CrmPipelineListReturn> => {
        return this.transport.call({
          groupSegments: ["crm","pipeline"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Set a CRM pipeline field */
      set: async (pipeline: string, field: string, value: string): Promise<CrmPipelineSetReturn> => {
        return this.transport.call({
          groupSegments: ["crm","pipeline"],
          command: "set",
          body: { pipeline, field, value },
        });
      },
      /** Show one CRM pipeline with stages and topics */
      show: async (pipeline: string): Promise<CrmPipelineShowReturn> => {
        return this.transport.call({
          groupSegments: ["crm","pipeline"],
          command: "show",
          body: { pipeline },
        });
      },
      stage: {
        /** Add a stage to a CRM pipeline */
        add: async (pipeline: string, key: string, options?: {
          category?: string;
          idempotencyKey?: string;
          metadata?: string;
          name?: string;
          order?: string;
          probability?: string;
          terminal?: boolean;
        }): Promise<CrmPipelineStageAddReturn> => {
          return this.transport.call({
            groupSegments: ["crm","pipeline","stage"],
            command: "add",
            body: { pipeline, key, ...(options ?? {}) },
          });
        },
        /** Archive a CRM pipeline stage */
        archive: async (pipeline: string, stage: string): Promise<CrmPipelineStageArchiveReturn> => {
          return this.transport.call({
            groupSegments: ["crm","pipeline","stage"],
            command: "archive",
            body: { pipeline, stage },
          });
        },
        /** List stages in a CRM pipeline */
        list: async (pipeline: string, options?: {
          includeArchived?: boolean;
          limit?: string;
          offset?: string;
        }): Promise<CrmPipelineStageListReturn> => {
          return this.transport.call({
            groupSegments: ["crm","pipeline","stage"],
            command: "list",
            body: { pipeline, ...(options ?? {}) },
          });
        },
        /** Set a CRM pipeline stage field */
        set: async (pipeline: string, stage: string, field: string, value: string): Promise<CrmPipelineStageSetReturn> => {
          return this.transport.call({
            groupSegments: ["crm","pipeline","stage"],
            command: "set",
            body: { pipeline, stage, field, value },
          });
        },
        /** Show one CRM pipeline stage */
        show: async (pipeline: string, stage: string): Promise<CrmPipelineStageShowReturn> => {
          return this.transport.call({
            groupSegments: ["crm","pipeline","stage"],
            command: "show",
            body: { pipeline, stage },
          });
        },
        topic: {
          /** Add a topic to a CRM pipeline stage */
          add: async (pipeline: string, stage: string, key: string, options?: {
            description?: string;
            idempotencyKey?: string;
            metadata?: string;
            order?: string;
            title?: string;
            type?: string;
          }): Promise<CrmPipelineStageTopicAddReturn> => {
            return this.transport.call({
              groupSegments: ["crm","pipeline","stage","topic"],
              command: "add",
              body: { pipeline, stage, key, ...(options ?? {}) },
            });
          },
          /** Archive a CRM pipeline stage topic */
          archive: async (pipeline: string, stage: string, topic: string): Promise<CrmPipelineStageTopicArchiveReturn> => {
            return this.transport.call({
              groupSegments: ["crm","pipeline","stage","topic"],
              command: "archive",
              body: { pipeline, stage, topic },
            });
          },
          /** Set a CRM pipeline stage topic field */
          set: async (pipeline: string, stage: string, topic: string, field: string, value: string): Promise<CrmPipelineStageTopicSetReturn> => {
            return this.transport.call({
              groupSegments: ["crm","pipeline","stage","topic"],
              command: "set",
              body: { pipeline, stage, topic, field, value },
            });
          }
        },
        /** List topics configured for a CRM pipeline stage */
        topics: async (pipeline: string, stage: string, options?: {
          includeArchived?: boolean;
          limit?: string;
          offset?: string;
        }): Promise<CrmPipelineStageTopicsReturn> => {
          return this.transport.call({
            groupSegments: ["crm","pipeline","stage"],
            command: "topics",
            body: { pipeline, stage, ...(options ?? {}) },
          });
        }
      }
    },
    task: {
      /** Cancel a CRM task */
      cancel: async (task: string, options?: {
        reason?: string;
      }): Promise<CrmTaskCancelReturn> => {
        return this.transport.call({
          groupSegments: ["crm","task"],
          command: "cancel",
          body: { task, ...(options ?? {}) },
        });
      },
      /** Create a CRM relationship task */
      create: async (title: string, options?: {
        account?: string;
        body?: string;
        confidence?: string;
        contact?: string;
        due?: string;
        evidence?: string;
        idempotencyKey?: string;
        metadata?: string;
        opportunity?: string;
        owner?: string;
        priority?: string;
        source?: string;
        taskType?: string;
      }): Promise<CrmTaskCreateReturn> => {
        return this.transport.call({
          groupSegments: ["crm","task"],
          command: "create",
          body: { title, ...(options ?? {}) },
        });
      },
      /** Complete a CRM task */
      done: async (task: string): Promise<CrmTaskDoneReturn> => {
        return this.transport.call({
          groupSegments: ["crm","task"],
          command: "done",
          body: { task },
        });
      },
      /** List CRM tasks (all statuses) */
      list: async (options?: {
        account?: string;
        contact?: string;
        dueAfter?: string;
        dueBefore?: string;
        dueToday?: boolean;
        limit?: string;
        offset?: string;
        opportunity?: string;
        owner?: string;
        status?: string;
        taskType?: string;
      }): Promise<CrmTaskListReturn> => {
        return this.transport.call({
          groupSegments: ["crm","task"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Show CRM task */
      show: async (task: string): Promise<CrmTaskShowReturn> => {
        return this.transport.call({
          groupSegments: ["crm","task"],
          command: "show",
          body: { task },
        });
      },
      /** Snooze a CRM task to a new due_at */
      snooze: async (task: string, options?: {
        reason?: string;
        until?: string;
      }): Promise<CrmTaskSnoozeReturn> => {
        return this.transport.call({
          groupSegments: ["crm","task"],
          command: "snooze",
          body: { task, ...(options ?? {}) },
        });
      }
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
      envFile?: string;
      every?: string;
      exec?: string;
      isolated?: boolean;
      message?: string;
      onError?: string;
      shell?: string;
      timeout?: string;
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
    list: async (options?: {
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<CronListReturn> => {
      return this.transport.call({
        groupSegments: ["cron"],
        command: "list",
        body: { ...(options ?? {}) },
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
        offset?: string;
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
    list: async (options?: {
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<HooksListReturn> => {
      return this.transport.call({
        groupSegments: ["hooks"],
        command: "list",
        body: { ...(options ?? {}) },
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

  readonly inbox = {
    /** Disable inbox polling for the current Console+org */
    disable: async (): Promise<InboxDisableReturn> => {
      return this.transport.call({
        groupSegments: ["inbox"],
        command: "disable",
        body: {},
      });
    },
    /** Enable inbox polling for the current Console+org */
    enable: async (): Promise<InboxEnableReturn> => {
      return this.transport.call({
        groupSegments: ["inbox"],
        command: "enable",
        body: {},
      });
    },
    /** List recently delivered inbox items in the local mirror */
    items: async (options?: {
      limit?: string;
    }): Promise<InboxItemsReturn> => {
      return this.transport.call({
        groupSegments: ["inbox"],
        command: "items",
        body: { ...(options ?? {}) },
      });
    },
    /** Run a single inbox poll cycle (foreground) */
    poll: async (options?: {
      once?: boolean;
    }): Promise<InboxPollReturn> => {
      return this.transport.call({
        groupSegments: ["inbox"],
        command: "poll",
        body: { ...(options ?? {}) },
      });
    },
    /** Republish a locally stored inbox item to NATS */
    replay: async (ref: string): Promise<InboxReplayReturn> => {
      return this.transport.call({
        groupSegments: ["inbox"],
        command: "replay",
        body: { ref },
      });
    },
    /** Show inbox poller status and subscriptions */
    status: async (): Promise<InboxStatusReturn> => {
      return this.transport.call({
        groupSegments: ["inbox"],
        command: "status",
        body: {},
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
      tag?: string[];
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
      offset?: string;
      profile?: string;
      query?: string;
      rich?: boolean;
      session?: string;
      tag?: string;
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
    /** Create a new instance */
    create: async (name: string, options?: {
      agent?: string;
      channel?: string;
      contactIntakeMode?: string;
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
    list: async (options?: {
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<InstancesListReturn> => {
      return this.transport.call({
        groupSegments: ["instances"],
        command: "list",
        body: { ...(options ?? {}) },
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
      list: async (name: string, options?: {
        limit?: string;
        offset?: string;
      }): Promise<InstancesPendingListReturn> => {
        return this.transport.call({
          groupSegments: ["instances","pending"],
          command: "list",
          body: { name, ...(options ?? {}) },
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
      list: async (name: string, options?: {
        limit?: string;
        offset?: string;
        tag?: string;
      }): Promise<InstancesRoutesListReturn> => {
        return this.transport.call({
          groupSegments: ["instances","routes"],
          command: "list",
          body: { name, ...(options ?? {}) },
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

  readonly observers = {
    /** List session observer bindings */
    list: async (options?: {
      agent?: string;
      limit?: string;
      offset?: string;
      session?: string;
    }): Promise<ObserversListReturn> => {
      return this.transport.call({
        groupSegments: ["observers"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    profiles: {
      /** Create a Markdown observer profile scaffold */
      init: async (profileId: string, options?: {
        overwrite?: boolean;
        source?: string;
      }): Promise<ObserversProfilesInitReturn> => {
        return this.transport.call({
          groupSegments: ["observers","profiles"],
          command: "init",
          body: { profileId, ...(options ?? {}) },
        });
      },
      /** List observer profiles */
      list: async (options?: {
        limit?: string;
        offset?: string;
      }): Promise<ObserversProfilesListReturn> => {
        return this.transport.call({
          groupSegments: ["observers","profiles"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Render an observer profile preview */
      preview: async (profileId: string, options?: {
        event?: string;
      }): Promise<ObserversProfilesPreviewReturn> => {
        return this.transport.call({
          groupSegments: ["observers","profiles"],
          command: "preview",
          body: { profileId, ...(options ?? {}) },
        });
      },
      /** Show one observer profile */
      show: async (profileId: string): Promise<ObserversProfilesShowReturn> => {
        return this.transport.call({
          groupSegments: ["observers","profiles"],
          command: "show",
          body: { profileId },
        });
      },
      /** Validate observer profiles */
      validate: async (profileId?: string): Promise<ObserversProfilesValidateReturn> => {
        return this.transport.call({
          groupSegments: ["observers","profiles"],
          command: "validate",
          body: { profileId },
        });
      }
    },
    /** Apply observer rules to an existing source session */
    refresh: async (session: string): Promise<ObserversRefreshReturn> => {
      return this.transport.call({
        groupSegments: ["observers"],
        command: "refresh",
        body: { session },
      });
    },
    rules: {
      /** Disable an observer rule */
      disable: async (id: string): Promise<ObserversRulesDisableReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "disable",
          body: { id },
        });
      },
      /** Enable an observer rule */
      enable: async (id: string): Promise<ObserversRulesEnableReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "enable",
          body: { id },
        });
      },
      /** Explain observer rule matching for a source session */
      explain: async (session: string): Promise<ObserversRulesExplainReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "explain",
          body: { session },
        });
      },
      /** List observer rules */
      list: async (options?: {
        limit?: string;
        offset?: string;
      }): Promise<ObserversRulesListReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Delete an observer rule */
      rm: async (id: string): Promise<ObserversRulesRmReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "rm",
          body: { id },
        });
      },
      /** Create or overwrite an observer rule */
      set: async (id: string, observerAgentId: string, options?: {
        delivery?: string;
        disabled?: boolean;
        events?: string;
        meta?: string;
        mode?: string;
        model?: string;
        permissions?: string;
        priority?: string;
        profile?: string;
        provider?: string;
        role?: string;
        scope?: string;
        sourceAgent?: string;
        sourceProfile?: string;
        sourceProject?: string;
        sourceSession?: string;
        sourceTask?: string;
        tag?: string;
        tagInherited?: boolean;
        tagTarget?: string;
      }): Promise<ObserversRulesSetReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "set",
          body: { id, observerAgentId, ...(options ?? {}) },
        });
      },
      /** Show one observer rule */
      show: async (id: string): Promise<ObserversRulesShowReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "show",
          body: { id },
        });
      },
      /** Validate observer rules */
      validate: async (): Promise<ObserversRulesValidateReturn> => {
        return this.transport.call({
          groupSegments: ["observers","rules"],
          command: "validate",
          body: {},
        });
      }
    },
    /** Show one observer binding */
    show: async (bindingId: string): Promise<ObserversShowReturn> => {
      return this.transport.call({
        groupSegments: ["observers"],
        command: "show",
        body: { bindingId },
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
      limit?: string;
      object?: string;
      offset?: string;
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
      limit?: string;
      offset?: string;
      status?: string;
      tag?: string;
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
      tag?: string;
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
        limit?: string;
        offset?: string;
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
        list: async (options?: {
          limit?: string;
          offset?: string;
          tag?: string;
        }): Promise<ProxCallsProfilesListReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","profiles"],
            command: "list",
            body: { ...(options ?? {}) },
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
          limit?: string;
          offset?: string;
          profile?: string;
          tag?: string;
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
        list: async (options?: {
          limit?: string;
          offset?: string;
          tag?: string;
        }): Promise<ProxCallsVoiceAgentsListReturn> => {
          return this.transport.call({
            groupSegments: ["prox","calls","voice-agents"],
            command: "list",
            body: { ...(options ?? {}) },
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
    list: async (name?: string, options?: {
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<RoutesListReturn> => {
      return this.transport.call({
        groupSegments: ["routes"],
        command: "list",
        body: { name, ...(options ?? {}) },
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

  readonly rules = {
    /** Import provider rules into .ravi/rules/imported */
    import: async (source?: string, options?: {
      cwd?: string;
      force?: boolean;
      includeUser?: boolean;
      write?: boolean;
    }): Promise<RulesImportReturn> => {
      return this.transport.call({
        groupSegments: ["rules"],
        command: "import",
        body: { source, ...(options ?? {}) },
      });
    },
    /** List importable provider rule sources */
    sources: async (source?: string, options?: {
      cwd?: string;
      includeUser?: boolean;
    }): Promise<RulesSourcesReturn> => {
      return this.transport.call({
        groupSegments: ["rules"],
        command: "sources",
        body: { source, ...(options ?? {}) },
      });
    }
  };

  readonly runtime = {
    credentials: {
      /** Add a managed runtime provider credential */
      add: async (options?: {
        agents?: string;
        authMethod?: string;
        authProfile?: string;
        label?: string;
        models?: string;
        notes?: string;
        priority?: string;
        provider?: string;
        readOnly?: boolean;
        remoteForward?: boolean;
        secretEnv?: string;
        targetEnv?: string;
        taskProfiles?: string;
        upstream?: string;
      }): Promise<RuntimeCredentialsAddReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "add",
          body: { ...(options ?? {}) },
        });
      },
      /** Classify a provider failure for credential fallback */
      classify: async (options?: {
        credential?: string;
        headers?: string;
        message?: string;
        provider?: string;
        providerCode?: string;
        providerType?: string;
        record?: boolean;
        status?: string;
        upstream?: string;
      }): Promise<RuntimeCredentialsClassifyReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "classify",
          body: { ...(options ?? {}) },
        });
      },
      /** Disable a runtime credential immediately */
      disable: async (id: string): Promise<RuntimeCredentialsDisableReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "disable",
          body: { id },
        });
      },
      /** Enable a runtime credential */
      enable: async (id: string): Promise<RuntimeCredentialsEnableReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "enable",
          body: { id },
        });
      },
      /** Import/reference an existing provider-native credential source */
      import: async (options?: {
        fromClaudeCode?: boolean;
        fromCodexHome?: string;
        label?: string;
        managedRefresh?: boolean;
        provider?: string;
      }): Promise<RuntimeCredentialsImportReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "import",
          body: { ...(options ?? {}) },
        });
      },
      /** List runtime provider credentials */
      list: async (options?: {
        all?: boolean;
        limit?: string;
        offset?: string;
        provider?: string;
        status?: string;
        upstream?: string;
      }): Promise<RuntimeCredentialsListReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "list",
          body: { ...(options ?? {}) },
        });
      },
      /** Refresh or recover credential health before pool selection */
      refresh: async (id?: string, options?: {
        agent?: string;
        force?: boolean;
        model?: string;
        provider?: string;
        taskProfile?: string;
        upstream?: string;
      }): Promise<RuntimeCredentialsRefreshReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "refresh",
          body: { id, ...(options ?? {}) },
        });
      },
      /** Clear cooldown/error state for a credential */
      resetHealth: async (id: string): Promise<RuntimeCredentialsResetHealthReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "reset-health",
          body: { id },
        });
      },
      /** Preview which credential the pool would select */
      select: async (options?: {
        agent?: string;
        model?: string;
        provider?: string;
        taskProfile?: string;
        upstream?: string;
      }): Promise<RuntimeCredentialsSelectReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "select",
          body: { ...(options ?? {}) },
        });
      },
      /** Show credential health and provider health */
      status: async (id?: string): Promise<RuntimeCredentialsStatusReturn> => {
        return this.transport.call({
          groupSegments: ["runtime","credentials"],
          command: "status",
          body: { id },
        });
      }
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
    },
    swift: {
      /** Compare on-disk Ravi Swift SDK sources to a fresh emit; exit 1 on drift */
      check: async (options?: {
        out?: string;
        version?: string;
      }): Promise<SdkSwiftCheckReturn> => {
        return this.transport.call({
          groupSegments: ["sdk","swift"],
          command: "check",
          body: { ...(options ?? {}) },
        });
      },
      /** Generate the Ravi Swift SDK source files from the live registry */
      generate: async (options?: {
        out?: string;
        version?: string;
      }): Promise<SdkSwiftGenerateReturn> => {
        return this.transport.call({
          groupSegments: ["sdk","swift"],
          command: "generate",
          body: { ...(options ?? {}) },
        });
      }
    }
  };

  readonly self = {
    /** Show the current chat binding and participants */
    chat: async (options?: {
      depth?: string;
    }): Promise<SelfChatReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "chat",
        body: { ...(options ?? {}) },
      });
    },
    /** Show the full current self-context packet */
    context: async (options?: {
      depth?: string;
      limit?: string;
    }): Promise<SelfContextReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "context",
        body: { ...(options ?? {}) },
      });
    },
    /** Explain how Ravi resolved the current self-context */
    explain: async (): Promise<SelfExplainReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "explain",
        body: {},
      });
    },
    /** Show current knowledge integration status for this context */
    knowledge: async (): Promise<SelfKnowledgeReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "knowledge",
        body: {},
      });
    },
    /** Show capabilities inherited by the current context */
    permissions: async (): Promise<SelfPermissionsReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "permissions",
        body: {},
      });
    },
    /** Show bounded recent message metadata for the current chat */
    recent: async (options?: {
      limit?: string;
    }): Promise<SelfRecentReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "recent",
        body: { ...(options ?? {}) },
      });
    },
    /** Show route information that led to the current session */
    route: async (): Promise<SelfRouteReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "route",
        body: {},
      });
    },
    /** Show the current agent/session identity */
    whoami: async (): Promise<SelfWhoamiReturn> => {
      return this.transport.call({
        groupSegments: ["self"],
        command: "whoami",
        body: {},
      });
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
    /** Show available chat actions and recent own messages for a session */
    actions: async (nameOrKey?: string, options?: {
      limit?: string;
    }): Promise<SessionsActionsReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "actions",
        body: { nameOrKey, ...(options ?? {}) },
      });
    },
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
    /** Attach a chat as the session output target and input source */
    attach: async (nameOrKey: string, options?: {
      chat?: string;
      reason?: string;
    }): Promise<SessionsAttachReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "attach",
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
    /** Delete one of this session agent's own channel messages */
    deleteMessage: async (sessionOrMessage: string, messageRef?: string): Promise<SessionsDeleteMessageReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "delete-message",
        body: { sessionOrMessage, messageRef },
      });
    },
    /** Detach a chat/output target from a session */
    detach: async (nameOrKey: string, options?: {
      chat?: string;
    }): Promise<SessionsDetachReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "detach",
        body: { nameOrKey, ...(options ?? {}) },
      });
    },
    /** Edit one of this session agent's own text channel messages */
    editMessage: async (sessionOrMessage: string, messageOrText?: string, textArg?: string, options?: {
      text?: string;
    }): Promise<SessionsEditMessageReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "edit-message",
        body: { sessionOrMessage, messageOrText, textArg, ...(options ?? {}) },
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
    /** Inspect or mutate persisted session goal state */
    goal: async (action: string, nameOrKey: string, objective?: string, options?: {
      budget?: string;
      project?: string;
      seconds?: string;
      task?: string;
      tokens?: string;
    }): Promise<SessionsGoalReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "goal",
        body: { action, nameOrKey, objective, ...(options ?? {}) },
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
      limit?: string;
      live?: boolean;
      offset?: string;
      tag?: string;
    }): Promise<SessionsListReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Keep a subscribed chat as listen-only for a session */
    mute: async (nameOrKey: string, options?: {
      chat?: string;
    }): Promise<SessionsMuteReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "mute",
        body: { nameOrKey, ...(options ?? {}) },
      });
    },
    /** Prune sessions inactive for a duration (dry-run by default) */
    prune: async (options?: {
      agent?: string;
      ephemeral?: boolean;
      execute?: boolean;
      inactiveFor?: string;
      namePrefix?: string;
    }): Promise<SessionsPruneReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "prune",
        body: { ...(options ?? {}) },
      });
    },
    /** Read message history of a session (normalized) */
    read: async (nameOrKey?: string, options?: {
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
      thread?: string;
      threadOwner?: string;
      threadScope?: string;
      threadSummary?: string;
      threadTitle?: string;
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
    /** List chats attached to a session */
    subscriptions: async (nameOrKey: string): Promise<SessionsSubscriptionsReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "subscriptions",
        body: { nameOrKey },
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
    },
    /** Allow a subscribed chat to receive session responses */
    unmute: async (nameOrKey: string, options?: {
      chat?: string;
    }): Promise<SessionsUnmuteReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "unmute",
        body: { nameOrKey, ...(options ?? {}) },
      });
    },
    /** Show runtime session visibility state */
    visibility: async (nameOrKey: string): Promise<SessionsVisibilityReturn> => {
      return this.transport.call({
        groupSegments: ["sessions"],
        command: "visibility",
        body: { nameOrKey },
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
      limit?: string;
      offset?: string;
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

  readonly skillGates = {
    /** Disable a skill gate rule */
    disable: async (id: string): Promise<SkillGatesDisableReturn> => {
      return this.transport.call({
        groupSegments: ["skill-gates"],
        command: "disable",
        body: { id },
      });
    },
    /** Enable a configured skill gate rule */
    enable: async (id: string): Promise<SkillGatesEnableReturn> => {
      return this.transport.call({
        groupSegments: ["skill-gates"],
        command: "enable",
        body: { id },
      });
    },
    /** List skill gate rules */
    list: async (options?: {
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<SkillGatesListReturn> => {
      return this.transport.call({
        groupSegments: ["skill-gates"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Delete a configured override and restore the default behavior */
    reset: async (id: string): Promise<SkillGatesResetReturn> => {
      return this.transport.call({
        groupSegments: ["skill-gates"],
        command: "reset",
        body: { id },
      });
    },
    /** Remove a custom gate or disable a default gate */
    rm: async (id: string): Promise<SkillGatesRmReturn> => {
      return this.transport.call({
        groupSegments: ["skill-gates"],
        command: "rm",
        body: { id },
      });
    },
    /** Create or overwrite a skill gate rule */
    set: async (id: string, skill: string, options?: {
      command?: string;
      commandPrefix?: string;
      commandRegex?: string;
      groupRegex?: string;
      pattern?: string;
      tool?: string;
      toolPrefix?: string;
      toolRegex?: string;
    }): Promise<SkillGatesSetReturn> => {
      return this.transport.call({
        groupSegments: ["skill-gates"],
        command: "set",
        body: { id, skill, ...(options ?? {}) },
      });
    },
    /** Show one skill gate rule */
    show: async (id: string): Promise<SkillGatesShowReturn> => {
      return this.transport.call({
        groupSegments: ["skill-gates"],
        command: "show",
        body: { id },
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
      limit?: string;
      offset?: string;
      source?: string;
      tag?: string;
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
      limit?: string;
      offset?: string;
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
    list: async (options?: {
      limit?: string;
      offset?: string;
    }): Promise<StickersListReturn> => {
      return this.transport.call({
        groupSegments: ["stickers"],
        command: "list",
        body: { ...(options ?? {}) },
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

  readonly tagRules = {
    /** Evaluate a rule against a target asset */
    evaluate: async (ruleId: string, options?: {
      apply?: boolean;
      file?: string;
      target?: string;
    }): Promise<TagRulesEvaluateReturn> => {
      return this.transport.call({
        groupSegments: ["tag-rules"],
        command: "evaluate",
        body: { ruleId, ...(options ?? {}) },
      });
    },
    /** Explain which rules currently match a target asset (dry-run) */
    explain: async (options?: {
      target?: string;
    }): Promise<TagRulesExplainReturn> => {
      return this.transport.call({
        groupSegments: ["tag-rules"],
        command: "explain",
        body: { ...(options ?? {}) },
      });
    },
    /** List loaded tag rules from .ravi/tag-rules */
    list: async (options?: {
      limit?: string;
      offset?: string;
    }): Promise<TagRulesListReturn> => {
      return this.transport.call({
        groupSegments: ["tag-rules"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Show a single rule definition */
    show: async (id: string): Promise<TagRulesShowReturn> => {
      return this.transport.call({
        groupSegments: ["tag-rules"],
        command: "show",
        body: { id },
      });
    },
    /** Run all rules against all contacts (use for cron/periodic schedules) */
    tick: async (options?: {
      apply?: boolean;
      limit?: string;
    }): Promise<TagRulesTickReturn> => {
      return this.transport.call({
        groupSegments: ["tag-rules"],
        command: "tick",
        body: { ...(options ?? {}) },
      });
    },
    /** Validate all rule files without applying */
    validate: async (): Promise<TagRulesValidateReturn> => {
      return this.transport.call({
        groupSegments: ["tag-rules"],
        command: "validate",
        body: {},
      });
    }
  };

  readonly tags = {
    /** Attach a tag to a Ravi asset */
    attach: async (slug: string, options?: {
      agent?: string;
      artifact?: string;
      callProfile?: string;
      callRequest?: string;
      callTool?: string;
      callVoiceAgent?: string;
      chat?: string;
      command?: string;
      contact?: string;
      cronJob?: string;
      devinSession?: string;
      hook?: string;
      insight?: string;
      instance?: string;
      meta?: string;
      profile?: string;
      project?: string;
      route?: string;
      session?: string;
      skill?: string;
      skillGateRule?: string;
      source?: string;
      target?: string;
      task?: string;
      taskAutomation?: string;
      trigger?: string;
      workflowNode?: string;
      workflowRun?: string;
      workflowSpec?: string;
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
      source?: string;
    }): Promise<TagsCreateReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "create",
        body: { slug, ...(options ?? {}) },
      });
    },
    /** Detach a tag from a Ravi asset */
    detach: async (slug: string, options?: {
      agent?: string;
      artifact?: string;
      callProfile?: string;
      callRequest?: string;
      callTool?: string;
      callVoiceAgent?: string;
      chat?: string;
      command?: string;
      contact?: string;
      cronJob?: string;
      devinSession?: string;
      hook?: string;
      insight?: string;
      instance?: string;
      profile?: string;
      project?: string;
      route?: string;
      session?: string;
      skill?: string;
      skillGateRule?: string;
      source?: string;
      target?: string;
      task?: string;
      taskAutomation?: string;
      trigger?: string;
      workflowNode?: string;
      workflowRun?: string;
      workflowSpec?: string;
    }): Promise<TagsDetachReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "detach",
        body: { slug, ...(options ?? {}) },
      });
    },
    /** List tag definitions */
    list: async (options?: {
      cursor?: string;
      kind?: string;
      limit?: string;
      order?: string;
      query?: string;
      sort?: string;
      source?: string;
    }): Promise<TagsListReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Search bindings by tag or asset */
    search: async (options?: {
      agent?: string;
      artifact?: string;
      callProfile?: string;
      callRequest?: string;
      callTool?: string;
      callVoiceAgent?: string;
      chat?: string;
      command?: string;
      contact?: string;
      cronJob?: string;
      cursor?: string;
      devinSession?: string;
      hook?: string;
      insight?: string;
      instance?: string;
      kind?: string;
      limit?: string;
      order?: string;
      profile?: string;
      project?: string;
      route?: string;
      session?: string;
      skill?: string;
      skillGateRule?: string;
      sort?: string;
      source?: string;
      tag?: string;
      target?: string;
      task?: string;
      taskAutomation?: string;
      trigger?: string;
      workflowNode?: string;
      workflowRun?: string;
      workflowSpec?: string;
    }): Promise<TagsSearchReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "search",
        body: { ...(options ?? {}) },
      });
    },
    /** Set tag definition metadata */
    set: async (slug: string, key: string, value: string): Promise<TagsSetReturn> => {
      return this.transport.call({
        groupSegments: ["tags"],
        command: "set",
        body: { slug, key, value },
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
      list: async (options?: {
        limit?: string;
        offset?: string;
        tag?: string;
      }): Promise<TasksAutomationsListReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","automations"],
          command: "list",
          body: { ...(options ?? {}) },
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
      tag?: string[];
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
      ls: async (taskId: string, options?: {
        limit?: string;
        offset?: string;
      }): Promise<TasksDepsLsReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","deps"],
          command: "ls",
          body: { taskId, ...(options ?? {}) },
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
      allTime?: boolean;
      archived?: boolean;
      cursor?: string;
      last?: string;
      limit?: string;
      mine?: boolean;
      order?: string;
      parent?: string;
      profile?: string;
      root?: string;
      roots?: boolean;
      session?: string;
      since?: string;
      sort?: string;
      status?: string;
      tag?: string;
      text?: string;
      until?: string;
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
      list: async (options?: {
        limit?: string;
        offset?: string;
      }): Promise<TasksProfilesListReturn> => {
        return this.transport.call({
          groupSegments: ["tasks","profiles"],
          command: "list",
          body: { ...(options ?? {}) },
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
    }
  };

  readonly threads = {
    /** Render the bounded thread brief used for handoff */
    brief: async (thread: string, options?: {
      scope?: string;
    }): Promise<ThreadsBriefReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "brief",
        body: { thread, ...(options ?? {}) },
      });
    },
    /** Close a thread */
    close: async (thread: string, options?: {
      reason?: string;
      scope?: string;
    }): Promise<ThreadsCloseReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "close",
        body: { thread, ...(options ?? {}) },
      });
    },
    /** Append a comment to a thread */
    comment: async (thread: string, body: string, options?: {
      scope?: string;
      visibility?: string;
    }): Promise<ThreadsCommentReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "comment",
        body: { thread, body, ...(options ?? {}) },
      });
    },
    /** Create a Ravi-owned thread */
    create: async (slug: string, options?: {
      defaultAgent?: string;
      owner?: string;
      scope?: string;
      status?: string;
      summary?: string;
      title?: string;
    }): Promise<ThreadsCreateReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "create",
        body: { slug, ...(options ?? {}) },
      });
    },
    /** List thread entries */
    entries: async (thread: string, options?: {
      limit?: string;
      offset?: string;
      scope?: string;
    }): Promise<ThreadsEntriesReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "entries",
        body: { thread, ...(options ?? {}) },
      });
    },
    /** Link a thread to another Ravi object */
    link: async (thread: string, target: string, options?: {
      label?: string;
      role?: string;
      scope?: string;
      visibility?: string;
    }): Promise<ThreadsLinkReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "link",
        body: { thread, target, ...(options ?? {}) },
      });
    },
    /** List Ravi threads */
    list: async (options?: {
      limit?: string;
      offset?: string;
      owner?: string;
      scope?: string;
      search?: string;
      status?: string;
    }): Promise<ThreadsListReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Append a note to a thread */
    note: async (thread: string, body: string, options?: {
      scope?: string;
      visibility?: string;
    }): Promise<ThreadsNoteReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "note",
        body: { thread, body, ...(options ?? {}) },
      });
    },
    /** Show one thread with links and recent entries */
    show: async (thread: string, options?: {
      entries?: string;
      scope?: string;
    }): Promise<ThreadsShowReturn> => {
      return this.transport.call({
        groupSegments: ["threads"],
        command: "show",
        body: { thread, ...(options ?? {}) },
      });
    }
  };

  readonly tools = {
    /** List all available CLI tools */
    list: async (options?: {
      limit?: string;
      offset?: string;
    }): Promise<ToolsListReturn> => {
      return this.transport.call({
        groupSegments: ["tools"],
        command: "list",
        body: { ...(options ?? {}) },
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
    list: async (options?: {
      limit?: string;
      offset?: string;
      tag?: string;
    }): Promise<TriggersListReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "list",
        body: { ...(options ?? {}) },
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
    },
    /** List trigger-ready NATS topics */
    topics: async (): Promise<TriggersTopicsReturn> => {
      return this.transport.call({
        groupSegments: ["triggers"],
        command: "topics",
        body: {},
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

  readonly watch = {
    /** List available watch connectors and event types */
    connectors: async (options?: {
      provider?: string;
    }): Promise<WatchConnectorsReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "connectors",
        body: { ...(options ?? {}) },
      });
    },
    /** Create a watch */
    create: async (provider: string, resource: string, options?: {
      event?: string;
      installation?: string;
      name?: string;
      placement?: string;
      project?: string;
      resourceId?: string;
    }): Promise<WatchCreateReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "create",
        body: { provider, resource, ...(options ?? {}) },
      });
    },
    /** Disable a watch */
    disable: async (id: string): Promise<WatchDisableReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "disable",
        body: { id },
      });
    },
    /** Enable a watch */
    enable: async (id: string): Promise<WatchEnableReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "enable",
        body: { id },
      });
    },
    /** Show trigger-ready event subjects for a watch */
    events: async (id: string): Promise<WatchEventsReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "events",
        body: { id },
      });
    },
    /** List watches */
    list: async (options?: {
      limit?: string;
      offset?: string;
      provider?: string;
      status?: string;
    }): Promise<WatchListReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "list",
        body: { ...(options ?? {}) },
      });
    },
    /** Remove a watch */
    rm: async (id: string): Promise<WatchRmReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "rm",
        body: { id },
      });
    },
    /** Show watch details */
    show: async (id: string): Promise<WatchShowReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "show",
        body: { id },
      });
    },
    /** Create a trigger for a watch event in the current chat */
    trigger: async (id: string, options?: {
      account?: string;
      agent?: string;
      cooldown?: string;
      event?: string;
      message?: string;
      session?: string;
    }): Promise<WatchTriggerReturn> => {
      return this.transport.call({
        groupSegments: ["watch"],
        command: "trigger",
        body: { id, ...(options ?? {}) },
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
        limit?: string;
        offset?: string;
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
      /** Send a message to a WhatsApp group */
      send: async (groupId: string, message: string, options?: {
        account?: string;
        mention?: string[];
      }): Promise<WhatsappGroupSendReturn> => {
        return this.transport.call({
          groupSegments: ["whatsapp","group"],
          command: "send",
          body: { groupId, message, ...(options ?? {}) },
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
      list: async (options?: {
        limit?: string;
        offset?: string;
      }): Promise<WorkflowsRunsListReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","runs"],
          command: "list",
          body: { ...(options ?? {}) },
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
      list: async (options?: {
        limit?: string;
        offset?: string;
      }): Promise<WorkflowsSpecsListReturn> => {
        return this.transport.call({
          groupSegments: ["workflows","specs"],
          command: "list",
          body: { ...(options ?? {}) },
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
