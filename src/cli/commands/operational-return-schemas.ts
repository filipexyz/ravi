import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { Returns } from "../decorators.js";

export const looseObjectSchema = z.object({}).passthrough();
export const looseObjectOrNullSchema = looseObjectSchema.nullable();
export const unknownArraySchema = z.array(z.unknown());
export const commandTargetSchema = z.object({ type: z.string() }).passthrough();

export function declareCommandReturns(target: Function, schemas: Record<string, ZodTypeAny>): void {
  for (const [method, schema] of Object.entries(schemas)) {
    const descriptor = Object.getOwnPropertyDescriptor(target.prototype, method);
    if (!descriptor) {
      throw new Error(`Cannot declare return schema for ${target.name}.${method}: method not found`);
    }
    Returns(schema)(target.prototype, method, descriptor);
  }
}

export const offsetPaginationReturnSchema = z
  .object({
    limit: z.number(),
    offset: z.number(),
    returned: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
    nextOffset: z.number().nullable(),
    nextCommand: z.string().nullable(),
  })
  .passthrough();

export const pagedItemsReturnSchema = z
  .object({
    total: z.number(),
    pagination: offsetPaginationReturnSchema,
    items: z.array(looseObjectSchema),
  })
  .passthrough();

export const changedEntityReturnSchema = z
  .object({
    status: z.string(),
    changedCount: z.number(),
  })
  .passthrough();

export const commandEnvelopeReturnSchema = looseObjectSchema;

export const runtimeControlReturnSchema = z
  .object({
    ok: z.boolean(),
    operation: z.string().optional(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export const crmProfileReturnSchema = z
  .object({
    target: z.string(),
    crm: looseObjectSchema,
  })
  .passthrough();

export const crmOpportunityReturnSchema = z
  .object({
    target: z.string(),
    opportunity: looseObjectSchema,
  })
  .passthrough();

export const crmBoardReturnSchema = z
  .object({
    total: z.number(),
    opportunities: z.array(looseObjectSchema),
    stages: z.array(looseObjectSchema).optional(),
  })
  .passthrough();

export const crmPipelineDetailsReturnSchema = looseObjectSchema;
export const crmPipelineStageDetailsReturnSchema = looseObjectSchema;

export const crmOpportunityContactsReturnSchema = z
  .object({
    total: z.number(),
    contacts: z.array(looseObjectSchema),
  })
  .passthrough();

export const crmTaskReturnSchema = z
  .object({
    target: z.string(),
    task: looseObjectSchema,
  })
  .passthrough();

export const inboxItemEnvelopeReturnSchema = z
  .object({
    item: looseObjectSchema,
  })
  .passthrough();

export const inboxReadReturnSchema = z
  .object({
    item: looseObjectSchema,
    events: z.array(looseObjectSchema),
  })
  .passthrough();

export const inboxSourcesReturnSchema = z
  .object({
    sources: z.array(looseObjectSchema),
  })
  .passthrough();

export const inboxStatusReturnSchema = looseObjectSchema;

export const inboxToggleReturnSchema = z
  .object({
    enabled: z.boolean(),
    changed: z.boolean(),
  })
  .passthrough();

export const inboxPollReturnSchema = z
  .object({
    ok: z.literal(true),
    snapshot: looseObjectSchema,
  })
  .passthrough();

export const inboxItemsReturnSchema = z
  .object({
    total: z.number(),
    items: z.array(looseObjectSchema),
  })
  .passthrough();

export const inboxReplayReturnSchema = z
  .object({
    ok: z.literal(true),
    itemId: z.string(),
    sequence: z.number(),
    subject: z.string(),
    replayedAt: z.string(),
  })
  .passthrough();

export const proxRecordReturnSchema = looseObjectSchema;

export const proxProfileConfigureReturnSchema = z
  .object({
    profile: looseObjectSchema,
    provider_sync: z.unknown().nullable(),
  })
  .passthrough();

export const proxRulesReturnSchema = z.union([
  looseObjectSchema,
  z
    .object({
      rules: z.null(),
      message: z.string(),
    })
    .passthrough(),
]);

export const proxCallRequestReturnSchema = z
  .object({
    request: looseObjectSchema,
    blocked: z.boolean(),
    block_reason: z.string().nullable().optional(),
    provider_mode: z.enum(["stub", "live"]),
    hint: z.string(),
  })
  .passthrough();

export const proxCallShowReturnSchema = z
  .object({
    request: looseObjectSchema,
    runs: z.array(looseObjectSchema),
    result: looseObjectOrNullSchema,
  })
  .passthrough();

export const proxEventsReturnSchema = z
  .object({
    request_id: z.string(),
    total: z.number(),
    events: z.array(looseObjectSchema),
  })
  .passthrough();

export const proxTranscriptReturnSchema = z
  .object({
    request_id: z.string(),
    outcome: z.string(),
    summary: z.string().nullable().optional(),
    transcript: z.string(),
  })
  .passthrough();

export const proxCancelReturnSchema = z
  .object({
    success: z.boolean(),
    message: z.string(),
    request_id: z.string(),
  })
  .passthrough();

export const proxUnbindReturnSchema = z
  .object({
    success: z.literal(true),
    tool_id: z.string(),
  })
  .passthrough();

export const proxVoiceAgentSyncReturnSchema = z
  .object({
    voice_agent_id: z.string(),
    provider: z.string(),
    provider_agent_id: z.string().nullable().optional(),
    dry_run: z.boolean(),
    intended_changes: looseObjectSchema,
    provider_sync: z.string(),
  })
  .passthrough();

export const proxToolRunsReturnSchema = z
  .object({
    request_id: z.string(),
    total: z.number(),
    tool_runs: z.array(looseObjectSchema),
  })
  .passthrough();

export const proxToolRunReturnSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();

export const artifactRecordReturnSchema = looseObjectSchema;
export const artifactVersionReturnSchema = looseObjectSchema;

export const artifactMutationReturnSchema = z
  .object({
    success: z.literal(true),
  })
  .passthrough();

export const artifactCreateReturnSchema = z
  .object({
    success: z.literal(true),
    artifact: looseObjectSchema,
    version: artifactVersionReturnSchema.optional(),
    package: looseObjectSchema.optional(),
  })
  .passthrough();

export const artifactListReturnSchema = z.union([
  pagedItemsReturnSchema.extend({
    artifacts: z.array(looseObjectSchema),
  }),
  z
    .object({
      ok: z.literal(true),
      generatedAt: z.number(),
      query: looseObjectSchema,
      pagination: offsetPaginationReturnSchema,
      stats: looseObjectSchema,
      items: z.array(looseObjectSchema),
    })
    .passthrough(),
]);

export const artifactDetailsReturnSchema = z
  .object({
    artifact: looseObjectSchema,
    links: z.array(looseObjectSchema),
    events: z.array(looseObjectSchema),
    versions: z.array(looseObjectSchema),
  })
  .passthrough();

export const artifactSnapshotReturnSchema = z
  .object({
    success: z.literal(true),
    version: artifactVersionReturnSchema,
  })
  .passthrough();

export const artifactVersionsReturnSchema = z
  .object({
    artifactId: z.string(),
    total: z.number(),
    versions: z.array(artifactVersionReturnSchema),
  })
  .passthrough();

export const artifactVersionShowReturnSchema = z
  .object({
    artifactId: z.string(),
    version: artifactVersionReturnSchema,
  })
  .passthrough();

export const artifactRestoreReturnSchema = z
  .object({
    success: z.literal(true),
    artifact: artifactRecordReturnSchema,
    restoredFrom: artifactVersionReturnSchema,
    restoreVersion: artifactVersionReturnSchema,
  })
  .passthrough();

export const artifactEventReturnSchema = z
  .object({
    success: z.literal(true),
    event: looseObjectSchema,
    artifact: artifactRecordReturnSchema.optional(),
  })
  .passthrough();

export const artifactEventsReturnSchema = z
  .object({
    artifactId: z.string(),
    total: z.number(),
    events: z.array(looseObjectSchema),
  })
  .passthrough();

export const artifactPublishReturnSchema = z
  .object({
    artifact: z.unknown(),
    artifactVersion: z.unknown(),
    publish: z.unknown(),
    release: z.unknown(),
    routes: unknownArraySchema,
    url: z.string().nullable(),
    upload: looseObjectSchema,
    localSync: looseObjectSchema.optional(),
  })
  .passthrough();

export const artifactReleaseActivateReturnSchema = z
  .object({
    release: z.unknown(),
    site: z.unknown(),
    routes: unknownArraySchema,
    url: z.string().nullable(),
    localSync: looseObjectSchema.optional(),
  })
  .passthrough();

export const mediaDeliveryReturnSchema = z
  .object({
    transport: z.string(),
    channel: z.string().optional(),
    accountId: z.string(),
    instanceId: z.string(),
    chatId: z.string(),
    threadId: z.string().optional(),
    filename: z.string(),
    caption: z.string(),
    messageId: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const audioGenerateReturnSchema = z
  .object({
    success: z.literal(true),
    audio: z
      .object({
        filePath: z.string(),
        mimeType: z.string(),
        text: z.string(),
        sendCommand: z.string(),
      })
      .passthrough(),
    options: looseObjectSchema,
    sent: mediaDeliveryReturnSchema.extend({ voiceNote: z.literal(true) }).optional(),
  })
  .passthrough();

export const imageGenerateReturnSchema = z.union([
  z
    .object({
      success: z.literal(true),
      artifact_id: z.string(),
      artifactId: z.string(),
      status: z.string(),
      hint: z.string(),
      autoSend: z.boolean(),
      delivery: looseObjectSchema.optional(),
      events: z.string(),
      workerPid: z.number().optional(),
    })
    .passthrough(),
  z
    .object({
      success: z.literal(true),
      images: z.array(
        z
          .object({
            filePath: z.string(),
            mimeType: z.string(),
            prompt: z.string(),
            provider: z.string(),
            model: z.string(),
            artifactId: z.string(),
            sendCommand: z.string(),
          })
          .passthrough(),
      ),
      options: looseObjectSchema,
      sent: z.array(mediaDeliveryReturnSchema),
    })
    .passthrough(),
]);

export const imageAtlasSplitReturnSchema = z
  .object({
    success: z.literal(true),
    artifactId: z.string(),
    artifact_id: z.string(),
    manifestPath: z.string(),
    outputDir: z.string(),
    parentArtifactId: z.string().nullable(),
    crops: z.array(looseObjectSchema),
    sent: z.array(looseObjectSchema),
  })
  .passthrough();

export const videoAnalyzeReturnSchema = z
  .object({
    success: z.literal(true),
    artifact: looseObjectSchema,
    video: z
      .object({
        source: z.string(),
        title: z.string(),
        duration: z.string(),
        summary: z.string(),
        topics: z.array(z.string()),
        transcript: z.string(),
        visualDescription: z.string(),
      })
      .passthrough(),
    options: looseObjectSchema,
  })
  .passthrough();

export const cliTargetReturnSchema = z
  .object({
    type: z.string(),
    id: z.string(),
  })
  .passthrough();

export const commandIssueReturnSchema = z
  .object({
    level: z.string(),
    code: z.string(),
    message: z.string(),
    id: z.string().nullable(),
    scope: z.string().nullable(),
    path: z.string().nullable(),
  })
  .passthrough();

export const commandRecordReturnSchema = z
  .object({
    id: z.string(),
    token: z.string(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    argumentHint: z.string().nullable(),
    arguments: z.array(z.unknown()),
    disabled: z.boolean(),
    scope: z.string(),
    path: z.string(),
    relativePath: z.string(),
    shadowedBy: z.string().nullable(),
    shadows: z.array(z.string()),
    issues: z.array(commandIssueReturnSchema),
  })
  .passthrough();

export const commandsListReturnSchema = pagedItemsReturnSchema
  .extend({
    agent: looseObjectSchema,
    locations: looseObjectSchema,
    commands: z.array(commandRecordReturnSchema),
    issues: z.array(commandIssueReturnSchema),
  })
  .passthrough();

export const commandShowReturnSchema = z
  .object({
    agent: looseObjectSchema,
    command: commandRecordReturnSchema,
  })
  .passthrough();

export const commandValidateReturnSchema = z
  .object({
    valid: z.boolean(),
    agent: looseObjectSchema,
    total: z.number(),
    effectiveTotal: z.number(),
    errors: z.array(commandIssueReturnSchema),
    warnings: z.array(commandIssueReturnSchema),
  })
  .passthrough();

export const commandRunReturnSchema = z
  .object({
    agent: looseObjectSchema,
    command: commandRecordReturnSchema,
    metadata: looseObjectSchema,
    positionalArguments: z.array(z.unknown()),
    prompt: z.string(),
  })
  .passthrough();

export const skillRecordReturnSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    path: z.string(),
    skillFilePath: z.string(),
    source: z.string(),
    pluginName: z.string().nullable(),
  })
  .passthrough();

export const skillsListReturnSchema = pagedItemsReturnSchema
  .extend({
    source: z.string(),
    skills: z.array(skillRecordReturnSchema),
  })
  .passthrough();

export const skillShowReturnSchema = z
  .object({
    skill: skillRecordReturnSchema.extend({
      content: z.string(),
    }),
  })
  .passthrough();

export const skillsInstallReturnSchema = z
  .object({
    success: z.literal(true),
    source: z.string(),
    installed: z.array(skillRecordReturnSchema),
    codexSynced: z.array(z.string()),
  })
  .passthrough();

export const skillsSyncReturnSchema = z
  .object({
    success: z.literal(true),
    codexSynced: z.array(z.string()),
    total: z.number(),
  })
  .passthrough();

export const specsListReturnSchema = pagedItemsReturnSchema
  .extend({
    specs: z.array(looseObjectSchema),
  })
  .passthrough();

export const specContextReturnSchema = z
  .object({
    context: looseObjectSchema,
  })
  .passthrough();

export const specCreateReturnSchema = z
  .object({
    status: z.literal("created"),
    spec: looseObjectSchema,
    createdFiles: z.array(z.string()),
    missingAncestors: z.array(looseObjectSchema),
  })
  .passthrough();

export const specsSyncReturnSchema = z
  .object({
    status: z.literal("synced"),
    total: z.number(),
    rootPath: z.string(),
  })
  .passthrough();

export const taskRecordReturnSchema = looseObjectSchema;
export const taskEventReturnSchema = looseObjectSchema;
export const taskProfileReturnSchema = looseObjectSchema;
export const taskAutomationReturnSchema = looseObjectSchema;

export const taskCreateReturnSchema = z
  .object({
    task: taskRecordReturnSchema,
    taskProfile: taskProfileReturnSchema,
    event: taskEventReturnSchema,
    relatedEvents: z.array(taskEventReturnSchema),
    parentTaskId: z.string().nullable(),
    readiness: looseObjectSchema,
    dependencies: z.array(looseObjectSchema),
    dependents: z.array(looseObjectSchema),
    launchPlan: looseObjectOrNullSchema,
  })
  .passthrough();

export const taskListReturnSchema = z
  .object({
    total: z.number(),
    archiveMode: z.string(),
    limit: z.number().nullable(),
    page: looseObjectSchema,
    filters: looseObjectSchema,
    items: z.array(taskRecordReturnSchema),
    tasks: z.array(taskRecordReturnSchema),
  })
  .passthrough();

export const taskShowReturnSchema = z
  .object({
    task: taskRecordReturnSchema,
    events: z.array(taskEventReturnSchema),
    comments: z.array(looseObjectSchema),
    historyLimit: z.number().nullable(),
    readiness: looseObjectSchema,
    dependencies: z.array(looseObjectSchema),
    dependents: z.array(looseObjectSchema),
    launchPlan: looseObjectOrNullSchema,
  })
  .passthrough();

export const taskMutationReturnSchema = z
  .object({
    task: taskRecordReturnSchema,
    event: taskEventReturnSchema,
  })
  .passthrough();

export const taskCommentReturnSchema = taskMutationReturnSchema
  .extend({
    comment: looseObjectSchema,
  })
  .passthrough();

export const taskDispatchReturnSchema = z
  .object({
    mode: z.string(),
    task: taskRecordReturnSchema,
    event: taskEventReturnSchema,
    readiness: looseObjectSchema.optional(),
  })
  .passthrough();

export const taskDependencyListReturnSchema = z
  .object({
    taskId: z.string(),
    total: z.number(),
    pagination: offsetPaginationReturnSchema,
    readiness: looseObjectSchema,
    launchPlan: looseObjectOrNullSchema,
    items: z.array(looseObjectSchema),
    dependencies: z.array(looseObjectSchema),
    dependents: z.array(looseObjectSchema),
  })
  .passthrough();

export const taskProfilesListReturnSchema = pagedItemsReturnSchema
  .extend({
    profiles: z.array(taskProfileReturnSchema),
  })
  .passthrough();

export const taskProfilePreviewReturnSchema = z
  .object({
    profile: taskProfileReturnSchema,
    rendered: looseObjectSchema,
  })
  .passthrough();

export const taskProfilesValidateReturnSchema = z
  .object({
    valid: z.boolean(),
    results: z.array(looseObjectSchema),
  })
  .passthrough();

export const taskProfileInitReturnSchema = z
  .object({
    sourceKind: z.string(),
    profileDir: z.string(),
    manifestPath: z.string(),
  })
  .passthrough();

export const taskAutomationsListReturnSchema = pagedItemsReturnSchema
  .extend({
    filters: looseObjectSchema,
    automations: z.array(taskAutomationReturnSchema),
  })
  .passthrough();

export const taskAutomationShowReturnSchema = z
  .object({
    automation: taskAutomationReturnSchema,
    runs: z.array(looseObjectSchema),
  })
  .passthrough();

export const taskAutomationMutationReturnSchema = changedEntityReturnSchema
  .extend({
    target: cliTargetReturnSchema,
    automation: taskAutomationReturnSchema,
  })
  .passthrough();

export const threadReturnSchema = looseObjectSchema;

export const threadActionReturnSchema = z
  .object({
    action: z.string(),
    thread: threadReturnSchema,
  })
  .passthrough();

export const threadListReturnSchema = z
  .object({
    action: z.literal("list"),
    items: z.array(threadReturnSchema),
    pagination: offsetPaginationReturnSchema,
  })
  .passthrough();

export const threadShowReturnSchema = threadActionReturnSchema
  .extend({
    entries: z.array(looseObjectSchema),
    links: z.array(looseObjectSchema),
  })
  .passthrough();

export const threadEntryReturnSchema = threadActionReturnSchema
  .extend({
    entry: looseObjectSchema,
  })
  .passthrough();

export const threadLinkReturnSchema = threadActionReturnSchema
  .extend({
    link: looseObjectSchema,
  })
  .passthrough();

export const threadEntriesReturnSchema = threadActionReturnSchema
  .extend({
    entries: z.array(looseObjectSchema),
  })
  .passthrough();

export const threadBriefReturnSchema = threadActionReturnSchema
  .extend({
    brief: looseObjectSchema,
  })
  .passthrough();

export const workflowSpecReturnSchema = looseObjectSchema;
export const workflowRunDetailsReturnSchema = looseObjectSchema;

export const workflowSpecsListReturnSchema = pagedItemsReturnSchema
  .extend({
    specs: z.array(workflowSpecReturnSchema),
  })
  .passthrough();

export const workflowRunsListReturnSchema = pagedItemsReturnSchema
  .extend({
    runs: z.array(looseObjectSchema),
  })
  .passthrough();

export const workflowRunMutationReturnSchema = z
  .object({
    details: workflowRunDetailsReturnSchema,
  })
  .passthrough();

export const workflowTaskCreateReturnSchema = z
  .object({
    task: taskRecordReturnSchema,
    workflow: looseObjectOrNullSchema,
  })
  .passthrough();

export const projectDetailsReturnSchema = looseObjectSchema;
export const projectResourceReturnSchema = looseObjectSchema;

export const projectInitReturnSchema = z
  .object({
    details: projectDetailsReturnSchema,
    workflows: z.array(looseObjectSchema),
  })
  .passthrough();

export const projectsListReturnSchema = pagedItemsReturnSchema
  .extend({
    filters: looseObjectSchema,
    projects: z.array(looseObjectSchema),
  })
  .passthrough();

export const projectsNextReturnSchema = z
  .object({
    total: z.number(),
    filters: looseObjectSchema,
    projects: z.array(looseObjectSchema),
  })
  .passthrough();

export const projectWorkflowOperationReturnSchema = z
  .object({
    details: projectDetailsReturnSchema,
    workflow: looseObjectSchema,
  })
  .passthrough();

export const projectTaskOperationReturnSchema = z
  .object({
    details: projectDetailsReturnSchema,
    workflow: looseObjectSchema,
    defaults: looseObjectSchema,
  })
  .passthrough();

export const projectResourcesListReturnSchema = pagedItemsReturnSchema
  .extend({
    resources: z.array(projectResourceReturnSchema),
  })
  .passthrough();

export const projectResourcesImportReturnSchema = z
  .object({
    total: z.number(),
    resources: z.array(projectResourceReturnSchema),
  })
  .passthrough();

export const projectFixturesSeedReturnSchema = z
  .object({
    total: z.number(),
    fixtures: z.array(looseObjectSchema),
  })
  .passthrough();

export const daemonStatusReturnSchema = z
  .object({
    pm2Available: z.boolean(),
    processName: z.string(),
    ravi: looseObjectSchema,
    infrastructure: looseObjectSchema,
    processes: z.array(looseObjectSchema),
  })
  .passthrough();

export const daemonMutationReturnSchema = z
  .object({
    action: z.string(),
    changed: z.boolean(),
  })
  .passthrough();

export const daemonLogsReturnSchema = z
  .object({
    action: z.string(),
  })
  .passthrough();

export const daemonEnvReturnSchema = z
  .object({
    action: z.literal("env"),
    path: z.string(),
    existedBefore: z.boolean(),
    created: z.boolean(),
    openedEditor: z.boolean(),
  })
  .passthrough();

export const daemonInitAdminKeyReturnSchema = z
  .object({
    action: z.literal("init-admin-key"),
    changed: z.boolean(),
  })
  .passthrough();

export const runtimeCredentialsListReturnSchema = z
  .object({
    total: z.number(),
    pagination: offsetPaginationReturnSchema,
    credentials: z.array(looseObjectSchema),
    providerHealth: z.array(looseObjectSchema),
  })
  .passthrough();

export const runtimeCredentialEnvelopeReturnSchema = z
  .object({
    credential: looseObjectSchema,
  })
  .passthrough();

export const runtimeCredentialStatusReturnSchema = z
  .object({
    credential: looseObjectSchema,
    health: looseObjectOrNullSchema,
  })
  .passthrough();

export const runtimeCredentialRefreshReturnSchema = z
  .object({
    refreshed: z.array(looseObjectSchema),
  })
  .passthrough();

export const runtimeCredentialSelectReturnSchema = z
  .object({
    selected: looseObjectOrNullSchema,
    candidates: z.array(looseObjectSchema),
    rejected: z.array(looseObjectSchema),
  })
  .passthrough();

export const runtimeCredentialClassifyReturnSchema = z
  .object({
    signal: looseObjectSchema,
    pressure: looseObjectSchema,
  })
  .passthrough();

export const triggerTopicsReturnSchema = z
  .object({
    topics: z.array(looseObjectSchema),
  })
  .passthrough();

export const triggerListReturnSchema = pagedItemsReturnSchema.extend({
  triggers: z.array(looseObjectSchema),
});

export const triggerShowReturnSchema = z
  .object({
    trigger: looseObjectSchema,
  })
  .passthrough();

export const triggerMutationReturnSchema = z
  .object({
    status: z.string(),
    target: commandTargetSchema,
    changedCount: z.number(),
    trigger: looseObjectOrNullSchema,
  })
  .passthrough();

export const cronListReturnSchema = pagedItemsReturnSchema.extend({
  jobs: z.array(looseObjectSchema),
});

export const cronShowReturnSchema = z
  .object({
    job: looseObjectSchema,
  })
  .passthrough();

export const cronMutationReturnSchema = z
  .object({
    status: z.string(),
    target: commandTargetSchema,
    changedCount: z.number(),
    job: looseObjectOrNullSchema,
  })
  .passthrough();

export const watchConnectorsReturnSchema = z
  .object({
    total: z.number(),
    connectors: z.array(looseObjectSchema),
    items: z.array(looseObjectSchema),
  })
  .passthrough();

export const watchCreateReturnSchema = z
  .object({
    status: z.string(),
    watch: looseObjectSchema,
    capabilities: looseObjectSchema,
    next: looseObjectSchema,
  })
  .passthrough();

export const watchListReturnSchema = pagedItemsReturnSchema.extend({
  watches: z.array(looseObjectSchema),
});

export const watchShowReturnSchema = z
  .object({
    watch: looseObjectSchema,
  })
  .passthrough();

export const watchMutationReturnSchema = z
  .object({
    status: z.string(),
    watch: looseObjectSchema,
  })
  .passthrough();

export const watchRemoveReturnSchema = z
  .object({
    deleted: z.boolean(),
    id: z.string(),
  })
  .passthrough();

export const watchEventsReturnSchema = z
  .object({
    watchId: z.string(),
    eventTypes: z.array(z.string()),
    subjects: z.array(z.string()),
  })
  .passthrough();

export const watchTriggerReturnSchema = z
  .object({
    status: z.string(),
    watch: looseObjectSchema,
    trigger: looseObjectSchema,
  })
  .passthrough();

export const hookListReturnSchema = pagedItemsReturnSchema.extend({
  hooks: z.array(looseObjectSchema),
});

export const hookShowReturnSchema = z
  .object({
    hook: looseObjectSchema,
  })
  .passthrough();

export const hookMutationReturnSchema = z
  .object({
    status: z.string(),
    target: commandTargetSchema,
    changedCount: z.number(),
    hook: looseObjectSchema,
  })
  .passthrough();

export const hookTestReturnSchema = looseObjectSchema;

export const agentRecordReturnSchema = looseObjectSchema;

export const agentsListReturnSchema = pagedItemsReturnSchema
  .extend({
    defaultAgent: z.string(),
    filters: looseObjectSchema,
    agents: z.array(agentRecordReturnSchema),
  })
  .passthrough();

export const agentShowReturnSchema = z
  .object({
    agent: agentRecordReturnSchema,
    permissionsCommand: z.string(),
  })
  .passthrough();

export const agentCreateReturnSchema = z
  .object({
    action: z.literal("create"),
    changed: z.boolean(),
    agent: agentRecordReturnSchema,
    runtimeTarget: looseObjectSchema,
    permissions: looseObjectSchema,
  })
  .passthrough();

export const agentInstructionSyncReturnSchema = z
  .object({
    total: z.number(),
    migrated: z.number(),
    alreadyCanonical: z.number(),
    missing: z.number(),
    manualReview: z.number(),
    incomplete: z.number(),
    results: z.array(looseObjectSchema),
  })
  .passthrough();

export const agentDeleteReturnSchema = z
  .object({
    action: z.literal("delete"),
    changed: z.boolean(),
    agentId: z.string(),
    before: agentRecordReturnSchema.optional(),
  })
  .passthrough();

export const agentSetReturnSchema = z
  .object({
    action: z.literal("set"),
    changed: z.boolean(),
    agentId: z.string(),
    key: z.string(),
    value: z.unknown(),
    agent: agentRecordReturnSchema.optional(),
  })
  .passthrough();

export const agentDebounceReturnSchema = z
  .object({
    action: z.string().optional(),
    changed: z.boolean().optional(),
    agentId: z.string(),
    debounceMs: z.number().nullable(),
    enabled: z.boolean(),
  })
  .passthrough();

export const agentSpecModeReturnSchema = z
  .object({
    action: z.string().optional(),
    changed: z.boolean().optional(),
    agentId: z.string(),
    specMode: z.boolean(),
  })
  .passthrough();

export const agentSessionReturnSchema = z
  .object({
    agent: agentRecordReturnSchema,
    total: z.number(),
    sessions: z.array(looseObjectSchema),
  })
  .passthrough();

export const agentResetReturnSchema = z
  .object({
    action: z.literal("reset"),
    changed: z.boolean(),
    agentId: z.string(),
    target: z.string(),
    resetSessions: z.array(looseObjectSchema).optional(),
    count: z.number().optional(),
    session: looseObjectSchema.optional(),
    reason: z.string().optional(),
    availableSessions: z.array(z.string()).optional(),
  })
  .passthrough();

export const agentDebugReturnSchema = z.union([
  z
    .object({
      error: z.string(),
      agentId: z.string(),
      availableSessions: z.array(z.string()),
    })
    .passthrough(),
  z
    .object({
      session: looseObjectSchema,
      transcript: looseObjectSchema,
      entries: z.array(z.unknown()),
    })
    .passthrough(),
]);

export const devinSessionSummaryReturnSchema = looseObjectSchema;

export const devinAuthCheckReturnSchema = z
  .object({
    ok: z.boolean(),
    baseUrl: z.string(),
    configuredOrgId: z.string().optional(),
    self: looseObjectSchema,
  })
  .passthrough();

export const devinSessionCreateReturnSchema = z
  .object({
    status: z.literal("created"),
    maxAcuLimitSource: z.string(),
    maxAcuLimit: z.number().nullable(),
    session: devinSessionSummaryReturnSchema,
  })
  .passthrough();

export const devinSessionsListReturnSchema = pagedItemsReturnSchema
  .extend({
    source: z.string(),
    hasNextPage: z.boolean().optional(),
    sessions: z.array(devinSessionSummaryReturnSchema),
  })
  .passthrough();

export const devinSessionShowReturnSchema = z
  .object({
    session: looseObjectSchema,
  })
  .passthrough();

export const devinSessionMessagesReturnSchema = z
  .object({
    devinId: z.string(),
    total: z.number(),
    messages: z.array(looseObjectSchema),
  })
  .passthrough();

export const devinSessionSendReturnSchema = z
  .object({
    status: z.literal("sent"),
    session: devinSessionSummaryReturnSchema,
  })
  .passthrough();

export const devinSessionAttachmentsReturnSchema = z
  .object({
    devinId: z.string(),
    total: z.number(),
    attachments: z.array(looseObjectSchema),
  })
  .passthrough();

export const devinSessionInsightsReturnSchema = z
  .object({
    session: devinSessionSummaryReturnSchema,
    summary: looseObjectOrNullSchema,
    insights: looseObjectSchema,
  })
  .passthrough();

export const devinSessionSyncReturnSchema = z
  .object({
    session: devinSessionSummaryReturnSchema,
    messages: z.number(),
    attachments: z.number(),
    insights: looseObjectOrNullSchema,
    artifacts: z.array(z.string()),
  })
  .passthrough();

export const devinSessionTerminateReturnSchema = z
  .object({
    status: z.literal("terminated"),
    archive: z.boolean(),
    session: devinSessionSummaryReturnSchema,
  })
  .passthrough();

export const devinSessionArchiveReturnSchema = z
  .object({
    status: z.literal("archived"),
    session: devinSessionSummaryReturnSchema,
  })
  .passthrough();

export const insightCreateReturnSchema = z
  .object({
    success: z.literal(true),
    insight: looseObjectSchema,
    comment: looseObjectSchema.optional(),
    tags: z.array(z.string()),
  })
  .passthrough();

const overlayInsightsReturnSchema = z
  .object({
    ok: z.literal(true),
    generatedAt: z.number(),
    query: looseObjectSchema,
    stats: looseObjectSchema,
    items: z.array(looseObjectSchema),
  })
  .passthrough();

const insightsListPlainReturnSchema = z
  .object({
    count: z.number(),
    total: z.number(),
    pagination: offsetPaginationReturnSchema,
    query: looseObjectSchema,
    items: z.array(looseObjectSchema),
    insights: z.array(looseObjectSchema),
  })
  .passthrough();

export const insightsListReturnSchema = z.union([insightsListPlainReturnSchema, overlayInsightsReturnSchema]);

export const insightShowReturnSchema = z
  .object({
    insight: looseObjectSchema,
    tags: z.array(z.string()),
  })
  .passthrough();

export const insightsSearchReturnSchema = z
  .object({
    count: z.number(),
    query: looseObjectSchema,
    insights: z.array(looseObjectSchema),
  })
  .passthrough();

export const observerBindingReturnSchema = looseObjectSchema;
export const observerRuleReturnSchema = looseObjectSchema;
export const observerProfileReturnSchema = looseObjectSchema;

export const observerBindingsListReturnSchema = pagedItemsReturnSchema
  .extend({
    bindings: z.array(observerBindingReturnSchema),
  })
  .passthrough();

export const observerBindingShowReturnSchema = z
  .object({
    binding: observerBindingReturnSchema,
  })
  .passthrough();

export const observerRefreshReturnSchema = z
  .object({
    source: looseObjectSchema,
    total: z.number(),
    created: z.array(observerBindingReturnSchema),
    bindings: z.array(observerBindingReturnSchema),
    skipped: z.array(looseObjectSchema),
  })
  .passthrough();

export const observerRulesListReturnSchema = pagedItemsReturnSchema
  .extend({
    rules: z.array(observerRuleReturnSchema),
  })
  .passthrough();

export const observerRuleShowReturnSchema = z
  .object({
    rule: observerRuleReturnSchema,
  })
  .passthrough();

export const observerRuleMutationReturnSchema = z
  .object({
    success: z.literal(true),
    rule: observerRuleReturnSchema,
  })
  .passthrough();

export const observerRuleRemoveReturnSchema = z
  .object({
    success: z.literal(true),
    deleted: z.unknown(),
  })
  .passthrough();

export const observerRulesValidateReturnSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(looseObjectSchema),
  })
  .passthrough();

export const observerRuleExplainReturnSchema = z
  .object({
    source: looseObjectSchema,
    rules: z.array(looseObjectSchema),
    bindings: z.array(observerBindingReturnSchema),
  })
  .passthrough();

export const observerProfilesListReturnSchema = pagedItemsReturnSchema
  .extend({
    profiles: z.array(observerProfileReturnSchema),
  })
  .passthrough();

export const observerProfileShowReturnSchema = z
  .object({
    profile: observerProfileReturnSchema,
    body: z.string(),
  })
  .passthrough();

export const observerProfilePreviewReturnSchema = z
  .object({
    profile: observerProfileReturnSchema,
    eventType: z.string(),
    eventMarkdown: z.string(),
    prompt: z.string(),
  })
  .passthrough();

export const observerProfilesValidateReturnSchema = z
  .object({
    ok: z.boolean(),
    profiles: z.array(looseObjectSchema),
    errors: z.array(looseObjectSchema),
  })
  .passthrough();

export const observerProfileInitReturnSchema = z
  .object({
    sourceKind: z.string(),
    profileDir: z.string(),
    profilePath: z.string(),
  })
  .passthrough();

const selfSectionReturnSchema = z
  .object({
    status: z.enum(["ok", "partial", "missing", "unavailable"]),
    reason: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export const selfWhoamiReturnSchema = z
  .object({
    generatedAt: z.number(),
    identity: looseObjectSchema,
    actor: selfSectionReturnSchema,
    session: selfSectionReturnSchema,
    chat: selfSectionReturnSchema,
    route: selfSectionReturnSchema,
    nextReads: z.array(z.string()),
  })
  .passthrough();

export const selfContextReturnSchema = z
  .object({
    generatedAt: z.number(),
    depth: z.string(),
    limit: z.number(),
    identity: looseObjectSchema,
    actor: selfSectionReturnSchema,
    session: selfSectionReturnSchema,
    chat: selfSectionReturnSchema,
    route: selfSectionReturnSchema,
    recent: selfSectionReturnSchema,
    permissions: selfSectionReturnSchema,
    knowledge: selfSectionReturnSchema,
    explain: z.array(looseObjectSchema),
    nextReads: z.array(z.string()),
  })
  .passthrough();

export const selfSectionOnlyReturnSchema = selfSectionReturnSchema;

export const selfExplainReturnSchema = z
  .object({
    generatedAt: z.number(),
    explain: z.array(looseObjectSchema),
    nextReads: z.array(z.string()),
  })
  .passthrough();

const tagPageReturnSchema = z
  .object({
    limit: z.number(),
    count: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    nextCommand: z.string().nullable(),
    sort: z.string(),
    order: z.string(),
  })
  .passthrough();

export const tagMutationReturnSchema = z
  .object({
    status: z.string(),
    target: looseObjectSchema,
    changedCount: z.number(),
    tag: looseObjectSchema.optional(),
    binding: looseObjectSchema.optional(),
    behaviorConsumers: z.array(looseObjectSchema).optional(),
  })
  .passthrough();

export const tagsListReturnSchema = z
  .object({
    total: z.number(),
    page: tagPageReturnSchema,
    filters: looseObjectSchema,
    items: z.array(looseObjectSchema),
    tags: z.array(looseObjectSchema),
  })
  .passthrough();

export const tagShowReturnSchema = z
  .object({
    tag: looseObjectSchema,
    bindings: z.array(looseObjectSchema),
    behaviorConsumers: z.array(looseObjectSchema),
  })
  .passthrough();

export const tagDetachReturnSchema = z
  .object({
    status: z.literal("detached"),
    target: looseObjectSchema,
    changedCount: z.number(),
  })
  .passthrough();

export const tagsSearchReturnSchema = z
  .object({
    total: z.number(),
    page: tagPageReturnSchema,
    filters: looseObjectSchema,
    items: z.array(looseObjectSchema),
    bindings: z.array(looseObjectSchema),
    behaviorConsumers: z.array(looseObjectSchema),
  })
  .passthrough();

export const tagRulesListReturnSchema = z
  .object({
    rules: z.array(looseObjectSchema),
    errors: z.array(looseObjectSchema),
    pagination: z
      .object({
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
        returned: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const tagRuleShowReturnSchema = z
  .object({
    rule: looseObjectSchema,
    source: z.string().optional(),
  })
  .passthrough();

export const tagRulesValidateReturnSchema = z
  .object({
    status: z.enum(["ok", "error"]),
    ruleCount: z.number(),
    errors: z.array(looseObjectSchema),
  })
  .passthrough();

export const tagRulesExplainReturnSchema = z
  .object({
    target: looseObjectSchema,
    rules: looseObjectSchema,
    loaded: looseObjectSchema,
    outcomes: z.array(looseObjectSchema),
  })
  .passthrough();

export const tagRulesTickReturnSchema = z
  .object({
    rulesLoaded: z.number(),
    loadErrors: z.array(looseObjectSchema),
    contactsProcessed: z.number(),
    matched: z.number(),
    appliedActions: z.number(),
    contacts: z.array(looseObjectSchema),
  })
  .passthrough();

export const tagRulesEvaluateReturnSchema = z
  .object({
    ruleId: z.string(),
    target: looseObjectSchema,
    apply: z.boolean(),
    outcomes: z.array(looseObjectSchema),
    traces: z.array(looseObjectSchema),
  })
  .passthrough();

export const toolsListReturnSchema = pagedItemsReturnSchema
  .extend({
    groups: z.array(
      z
        .object({
          name: z.string(),
          tools: z.array(looseObjectSchema),
        })
        .passthrough(),
    ),
    tools: z.array(looseObjectSchema),
  })
  .passthrough();

export const toolShowReturnSchema = z
  .object({
    tool: looseObjectSchema,
  })
  .passthrough();

export const toolsManifestReturnSchema = z
  .object({
    total: z.number(),
    tools: z.array(looseObjectSchema),
  })
  .passthrough();

export const toolsSchemaReturnSchema = z
  .object({
    schema: looseObjectSchema,
  })
  .passthrough();

export const toolTestReturnSchema = z
  .object({
    tool: looseObjectSchema,
    args: looseObjectSchema,
    result: z
      .object({
        isError: z.boolean(),
        content: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

export const routesListReturnSchema = pagedItemsReturnSchema
  .extend({
    instance: z.string().nullable(),
    filter: looseObjectSchema,
    routes: z.array(looseObjectSchema),
  })
  .passthrough();

export const routeShowReturnSchema = z
  .object({
    instance: z.string(),
    pattern: z.string(),
    route: looseObjectSchema,
  })
  .passthrough();

export const routeExplainReturnSchema = z
  .object({
    target: looseObjectSchema,
    instance: z.string(),
    pattern: z.string().nullable(),
    channel: z.string().nullable(),
    configuredRoute: looseObjectOrNullSchema,
    liveEffect: looseObjectOrNullSchema,
  })
  .passthrough();
