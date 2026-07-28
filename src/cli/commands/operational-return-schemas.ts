import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { Returns } from "../decorators.js";
import { jsonObjectSchema, jsonValueSchema } from "../return-schemas.js";
import { RUNTIME_EFFORT_LEVELS } from "../../runtime/effort.js";

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

const contextCapabilityReturnSchema = z
  .object({
    permission: z.string(),
    objectType: z.string(),
    objectId: z.string(),
    source: z.string().optional(),
  })
  .strict();

const contextSourceReturnSchema = z
  .object({
    channel: z.string(),
    accountId: z.string(),
    chatId: z.string(),
    threadId: z.string().optional(),
  })
  .strict();

const contextLineageSummaryReturnSchema = z
  .object({
    parentContextId: z.string().nullable(),
    parentContextKind: z.string().nullable(),
    issuedFor: z.string().nullable(),
    issuedAt: z.number().nullable(),
    issuanceMode: z.string().nullable(),
    approvalSource: jsonValueSchema.nullable(),
  })
  .strict();

const contextSummaryReturnSchema = z
  .object({
    contextId: z.string(),
    kind: z.string(),
    status: z.enum(["active", "expired", "revoked"]),
    agentId: z.string().nullable(),
    sessionKey: z.string().nullable(),
    sessionName: z.string().nullable(),
    createdAt: z.number(),
    expiresAt: z.number().nullable(),
    lastUsedAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
    capabilitiesCount: z.number(),
    parentContextId: z.string().nullable(),
    issuedFor: z.string().nullable(),
    issuanceMode: z.string().nullable(),
  })
  .strict();

const contextDetailReturnSchema = contextSummaryReturnSchema
  .extend({
    source: contextSourceReturnSchema.nullable(),
    metadata: jsonObjectSchema.nullable(),
    capabilities: z.array(contextCapabilityReturnSchema),
    lineage: contextLineageSummaryReturnSchema,
  })
  .strict();

const contextPaginationReturnSchema = z
  .object({
    limit: z.number(),
    offset: z.number(),
    returned: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
    nextOffset: z.number().nullable(),
    nextCommand: z.string().nullable(),
  })
  .strict();

export const contextListReturnSchema = z
  .object({
    count: z.number(),
    total: z.number(),
    pagination: contextPaginationReturnSchema,
    items: z.array(contextSummaryReturnSchema),
    contexts: z.array(contextSummaryReturnSchema),
  })
  .strict();

export const contextInfoReturnSchema = contextDetailReturnSchema;

export const contextWhoamiReturnSchema = contextDetailReturnSchema;

export const contextCapabilitiesReturnSchema = z
  .object({
    contextId: z.string(),
    kind: z.string(),
    agentId: z.string().nullable(),
    sessionKey: z.string().nullable(),
    sessionName: z.string().nullable(),
    capabilities: z.array(contextCapabilityReturnSchema),
  })
  .strict();

export const contextCheckReturnSchema = z
  .object({
    contextId: z.string(),
    agentId: z.string().nullable(),
    permission: z.string(),
    objectType: z.string(),
    objectId: z.string(),
    allowed: z.boolean(),
    capabilitiesCount: z.number(),
  })
  .strict();

export const contextAuthorizeReturnSchema = contextCheckReturnSchema
  .extend({
    approved: z.boolean(),
    inherited: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();

export const contextIssueReturnSchema = z
  .object({
    contextId: z.string(),
    contextKey: z.string(),
    kind: z.string(),
    cliName: z.string(),
    agentId: z.string().nullable(),
    sessionKey: z.string().nullable(),
    sessionName: z.string().nullable(),
    parentContextId: z.string(),
    createdAt: z.number(),
    expiresAt: z.number().nullable(),
    capabilities: z.array(contextCapabilityReturnSchema),
    capabilitiesCount: z.number(),
    source: contextSourceReturnSchema.nullable(),
    metadata: jsonObjectSchema.nullable(),
    env: z.record(z.string(), z.string()),
  })
  .strict();

export const contextRevokeReturnSchema = z
  .object({
    context: contextDetailReturnSchema,
    cascaded: z.array(contextSummaryReturnSchema),
    revokedAt: z.number(),
  })
  .strict();

export const contextCleanupAgentRuntimeReturnSchema = z
  .object({
    dryRun: z.boolean(),
    reason: z.string().nullable(),
    olderThan: z.string(),
    olderThanMs: z.number(),
    cutoffAt: z.number(),
    scanned: z
      .object({
        kind: z.literal("agent-runtime"),
        agentId: z.string().nullable(),
        sessionKey: z.string().nullable(),
      })
      .strict(),
    candidatesCount: z.number(),
    revokedCount: z.number(),
    candidates: z.array(
      z
        .object({
          context: contextSummaryReturnSchema,
          lastSeenAt: z.number(),
          sessionExists: z.boolean(),
        })
        .strict(),
    ),
    revoked: z.array(
      z
        .object({
          context: contextDetailReturnSchema,
          cascaded: z.array(contextSummaryReturnSchema),
          revokedAt: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

export const contextPruneReturnSchema = z
  .object({
    status: z.enum(["pruned", "planned"]),
    dryRun: z.boolean(),
    olderThan: z.string(),
    matchedCount: z.number(),
    changedCount: z.number(),
  })
  .strict();

export const contextLineageReturnSchema = z
  .object({
    context: contextDetailReturnSchema,
    ancestors: z.array(contextSummaryReturnSchema),
    descendants: z.array(contextSummaryReturnSchema),
  })
  .strict();

export const contextCodexBashHookReturnSchema = z
  .object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.literal("PreToolUse"),
        permissionDecision: z.enum(["deny"]),
        permissionDecisionReason: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const contextVisibilityReturnSchema = z
  .object({
    sessionKey: z.string(),
    agentId: z.string(),
    provider: z.string().nullable(),
    tokens: z
      .object({
        used: z.number().nullable(),
        limit: z.number().nullable(),
        remaining: z.number().nullable(),
      })
      .strict(),
    compact: z
      .object({
        threshold: z.number().nullable(),
        willCompactAt: z.number().nullable(),
        lastCompactedAt: z.number().nullable(),
        count: z.number(),
      })
      .strict(),
    skills: z.array(
      z
        .object({
          id: z.string(),
          provider: z.string(),
          state: z.string(),
          confidence: z.string(),
          source: z.string().optional(),
          evidence: z
            .array(
              z
                .object({
                  kind: z.string(),
                  itemId: z.string().optional(),
                  detail: z.string().optional(),
                })
                .strict(),
            )
            .optional(),
          loadedAt: z.number().nullable().optional(),
          lastSeenAt: z.number(),
        })
        .strict(),
    ),
    loadedSkills: z.array(z.string()),
    lastUpdatedAt: z.number(),
  })
  .strict();

export const contextCredentialsListReturnSchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    default: z.string().nullable(),
    total: z.number(),
    pagination: contextPaginationReturnSchema,
    items: z.array(
      z
        .object({
          contextKey: z.string(),
          contextId: z.string(),
          agentId: z.string().nullable(),
          label: z.string().nullable(),
          kind: z.string().nullable(),
          issuedAt: z.number(),
          expiresAt: z.number().nullable(),
          isDefault: z.boolean(),
        })
        .strict(),
    ),
    entries: z.array(
      z
        .object({
          contextKey: z.string(),
          contextId: z.string(),
          agentId: z.string().nullable(),
          label: z.string().nullable(),
          kind: z.string().nullable(),
          issuedAt: z.number(),
          expiresAt: z.number().nullable(),
          isDefault: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const contextCredentialsAddReturnSchema = z
  .object({
    path: z.string(),
    default: z.string().nullable(),
    added: z.string(),
  })
  .strict();

export const contextCredentialsRemoveReturnSchema = z
  .object({
    path: z.string(),
    default: z.string().nullable(),
    removed: z.string(),
  })
  .strict();

export const contextCredentialsSetDefaultReturnSchema = z
  .object({
    path: z.string(),
    default: z.string().nullable(),
  })
  .strict();

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

const crmPipelineValidationIssueReturnSchema = z
  .object({
    path: z.string(),
    message: z.string(),
    severity: z.enum(["warning", "error"]),
    code: z.string().optional(),
  })
  .strict();

export const crmPipelineValidationReturnSchema = z
  .object({
    pipelineId: z.string(),
    ok: z.boolean(),
    errors: z.array(crmPipelineValidationIssueReturnSchema),
    warnings: z.array(crmPipelineValidationIssueReturnSchema),
    schema: jsonObjectSchema.optional(),
  })
  .strict();

const crmPipelineReviewFieldReturnSchema = z
  .object({
    group: z.enum(["identidade", "estrutura", "politicas", "tags", "comunicacao", "integracoes"]),
    field: z.string(),
    present: z.enum(["present", "absent", "partial"]),
    detail: z.string(),
    suggestion: z.string().optional(),
  })
  .strict();

export const crmPipelineReviewReturnSchema = z
  .object({
    pipelineId: z.string(),
    pipelineName: z.string(),
    highSeverityGaps: z.number(),
    totalGaps: z.number(),
    fields: z.array(crmPipelineReviewFieldReturnSchema),
  })
  .strict();

export const crmPipelineSendWindowCheckReturnSchema = z
  .object({
    pipelineId: z.string(),
    ok: z.boolean(),
    errors: z.array(crmPipelineValidationIssueReturnSchema),
    warnings: z.array(crmPipelineValidationIssueReturnSchema),
    decision: z
      .object({
        allowed: z.boolean(),
        reason: z.string(),
        releaseAtIso: z.string().optional(),
        evaluatedAtIso: z.string(),
        timezone: z.string(),
      })
      .strict(),
  })
  .strict();

export const crmPipelineHitlCheckReturnSchema = z
  .object({
    pipelineId: z.string(),
    ok: z.boolean(),
    errors: z.array(crmPipelineValidationIssueReturnSchema),
    warnings: z.array(crmPipelineValidationIssueReturnSchema),
    decision: z
      .object({
        hitlRequired: z.boolean(),
        matchedConditions: z.number(),
        reasons: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

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
    success: z.literal(true),
    consoleUrl: z.string(),
    authenticated: z.literal(true),
    uploadSession: jsonObjectSchema.nullable(),
    upload: z.object({
      attempted: z.number(),
      skipped: z.number(),
    }),
    artifact: jsonValueSchema,
    artifactVersion: jsonValueSchema,
    site: jsonValueSchema,
    publish: jsonValueSchema,
    release: jsonValueSchema,
    routes: z.array(jsonObjectSchema),
    url: z.string().nullable(),
    localSync: z.union([
      z.object({
        status: z.literal("skipped"),
        reason: z.literal("package_source"),
      }),
      z.object({
        status: z.literal("recorded"),
        artifactId: z.string(),
        versionId: z.string(),
        versionNumber: z.number(),
        eventType: z.literal("published"),
      }),
      z.object({
        status: z.literal("failed"),
        artifactId: z.string(),
        versionId: z.string(),
        versionNumber: z.number(),
        error: z.string(),
      }),
    ]),
  })
  .strict();

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

const ttsJsonObjectSchema = z.record(z.string(), jsonValueSchema);

const ttsTargetSchema = z.object({
  channel: z.string().optional(),
  accountId: z.string().optional(),
  instanceId: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  canonicalChatId: z.string().optional(),
});

const ttsVoiceSettingsSchema = z.object({
  stability: z.number().optional(),
  similarityBoost: z.number().optional(),
  style: z.number().optional(),
  useSpeakerBoost: z.boolean().optional(),
  speed: z.number().optional(),
});

const ttsElevenLabsOptionsSchema = z.object({
  enableLogging: z.boolean().optional(),
  optimizeStreamingLatency: z.number().optional(),
  pronunciationDictionaryLocators: z.array(jsonValueSchema).optional(),
  seed: z.number().optional(),
  previousText: z.string().optional(),
  nextText: z.string().optional(),
  previousRequestIds: z.array(z.string()).optional(),
  nextRequestIds: z.array(z.string()).optional(),
  usePvcAsIvc: z.boolean().optional(),
  applyTextNormalization: z.enum(["auto", "on", "off"]).optional(),
  applyLanguageTextNormalization: z.boolean().optional(),
});

const ttsVoiceConfigSchema = z.object({
  provider: z.literal("elevenlabs"),
  voiceId: z.string().optional(),
  modelId: z.string(),
  lang: z.string(),
  outputFormat: z.string(),
  voiceSettings: ttsVoiceSettingsSchema.optional(),
  elevenlabs: ttsElevenLabsOptionsSchema.optional(),
});

const ttsPlaybackSchema = z.object({
  target: z.enum(["extension", "channel", "none"]),
  autoplay: z.boolean(),
  clientId: z.string().optional(),
});

const ttsRequestSchema = z.object({
  id: z.string().optional(),
  requestId: z.string().optional(),
  text: z.string(),
  agentId: z.string().optional(),
  sessionName: z.string().optional(),
  sessionKey: z.string().optional(),
  emitId: z.string().optional(),
  target: ttsTargetSchema.optional(),
  playback: ttsPlaybackSchema.optional(),
  voice: ttsVoiceConfigSchema.optional(),
  metadata: ttsJsonObjectSchema.optional(),
  createdAt: z.number().optional(),
  source: ttsJsonObjectSchema.optional(),
});

const ttsPlaybackItemSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  status: z.enum(["ready", "failed"]),
  createdAt: z.number(),
  readyAt: z.number().optional(),
  failedAt: z.number().optional(),
  text: z.string(),
  textPreview: z.string(),
  agentId: z.string().optional(),
  sessionName: z.string().optional(),
  sessionKey: z.string().optional(),
  emitId: z.string().optional(),
  target: ttsTargetSchema.optional(),
  playback: ttsPlaybackSchema,
  voice: ttsVoiceConfigSchema,
  audio: z
    .object({
      id: z.string(),
      filePath: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number(),
      provider: z.literal("elevenlabs"),
      voiceId: z.string(),
      modelId: z.string(),
      outputFormat: z.string(),
    })
    .optional(),
  error: z.string().optional(),
  metadata: ttsJsonObjectSchema.optional(),
});

export const audioTtsReturnSchema = z.object({
  ok: z.literal(true),
  topic: z.literal("ravi.tts"),
  request: ttsRequestSchema,
});

export const audioPendingReturnSchema = z.object({
  ok: z.literal(true),
  generatedAt: z.number(),
  items: z.array(ttsPlaybackItemSchema),
});

export const audioVoicesReturnSchema = z.object({
  ok: z.literal(true),
  provider: z.literal("elevenlabs"),
  generatedAt: z.number(),
  hasMore: z.boolean(),
  totalCount: z.number().optional(),
  nextPageToken: z.string().optional(),
  voices: z.array(
    z.object({
      voiceId: z.string(),
      name: z.string(),
      category: z.string().optional(),
      description: z.string().optional(),
      previewUrl: z.string().optional(),
      labels: z.record(z.string(), z.string()).optional(),
      isOwner: z.boolean().optional(),
      isLegacy: z.boolean().optional(),
      highQualityBaseModelIds: z.array(z.string()).optional(),
      verifiedLanguages: z
        .array(
          z.object({
            language: z.string().optional(),
            locale: z.string().optional(),
            accent: z.string().optional(),
            previewUrl: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

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
        strategy: z.enum(["gemini", "subtitles"]),
        title: z.string(),
        duration: z.string(),
        summary: z.string(),
        topics: z.array(z.string()),
        transcript: z.string(),
        visualDescription: z.string(),
        subtitleLanguage: z.string().nullable().optional(),
        chapters: z.array(looseObjectSchema).optional(),
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

export const skillGrantRecordReturnSchema = z
  .object({
    agentId: z.string(),
    skillName: z.string(),
    note: z.string().optional(),
    grantedAt: z.number(),
  })
  .strict();

export const skillGrantMutationReturnSchema = z
  .object({
    success: z.boolean(),
    agentId: z.string(),
    skillName: z.string(),
    grant: skillGrantRecordReturnSchema.optional(),
  })
  .strict();

export const skillGrantWhoReturnSchema = z
  .object({
    // Filled with the positional skill argument; omitted for --agent / no-filter scopes.
    skillName: z.string().optional(),
    total: z.number(),
    grants: z.array(skillGrantRecordReturnSchema),
  })
  .strict();

export const skillGrantBatchReturnSchema = z
  .object({
    op: z.enum(["grant", "revoke"]),
    dryRun: z.boolean(),
    agentsTargeted: z.number(),
    skillsTargeted: z.number(),
    pairsAffected: z.number(),
    pairsSkipped: z.number(),
    errors: z.array(z.object({ agentId: z.string(), skillName: z.string(), error: z.string() }).strict()),
    sampleAgents: z.array(z.string()),
    sampleSkills: z.array(z.string()),
  })
  .strict();

export const skillInspectReturnSchema = z
  .object({
    agentId: z.string(),
    hasConfiguration: z.boolean(),
    allowlist: z.array(z.string()),
    provenance: z
      .object({
        baseline: z.array(z.string()),
        fromCapabilities: z.array(z.string()),
        fromGrants: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

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

export const meetingProfileReturnSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    label: z.string(),
    sourceKind: z.string(),
    source: z.string(),
    provider: z.string(),
    chrome: z
      .object({
        profileDir: z.string().nullable(),
        browserChannel: z.string().nullable(),
      })
      .strict(),
    voice: z
      .object({
        runtime: z.string(),
      })
      .strict(),
    live: z
      .object({
        enabled: z.boolean(),
        agentId: z.string().nullable(),
        contextChars: z.number(),
        includeSessionContext: z.boolean(),
        initialPromptChars: z.number(),
        initialPromptDelay: z.string().nullable(),
        tools: z.array(z.string()),
      })
      .strict(),
    defaults: z
      .object({
        name: z.string().optional(),
        out: z.string().optional(),
        duration: z.string().optional(),
        maxDuration: z.string().optional(),
        emptyGrace: z.string().optional(),
        capture: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const meetingOffsetPaginationReturnSchema = z
  .object({
    limit: z.number(),
    offset: z.number(),
    returned: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
    nextOffset: z.number().nullable(),
    nextCommand: z.string().nullable(),
  })
  .strict();

export const meetingProfilesListReturnSchema = z
  .object({
    total: z.number(),
    pagination: meetingOffsetPaginationReturnSchema,
    items: z.array(meetingProfileReturnSchema),
    profiles: z.array(meetingProfileReturnSchema),
  })
  .strict();

export const meetingProfileInitReturnSchema = z
  .object({
    sourceKind: z.string(),
    profileDir: z.string(),
    profilePath: z.string(),
  })
  .strict();

export const meetingProfilesValidateReturnSchema = z
  .object({
    valid: z.boolean(),
    results: z.array(
      z
        .object({
          id: z.string(),
          sourceKind: z.string(),
          source: z.string(),
          valid: z.boolean(),
          error: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const meetingVoiceRuntimeCandidateReturnSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    availability: z.string(),
    kind: z.string(),
    defaultModel: z.string().optional(),
    providerRuntime: z.string().optional(),
    docsUrl: z.string(),
    strengths: z.array(z.string()),
    constraints: z.array(z.string()),
  })
  .strict();

export const meetingVoiceRuntimesReturnSchema = z
  .object({
    defaultRuntimeId: z.string(),
    recommendation: z.string(),
    candidates: z.array(meetingVoiceRuntimeCandidateReturnSchema),
  })
  .strict();

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

const projectRealitySignalReferenceSchema = z
  .object({
    kind: z.enum([
      "required_blocker",
      "checkpoint_overdue",
      "missing_report",
      "document_divergence",
      "missing_workflow",
      "missing_task",
      "project_next_step",
      "focused_workflow_ready",
      "current_task",
      "project_without_execution",
    ]),
    ref: z.string(),
    project_id: z.string(),
    workflow_run_id: z.string().optional(),
    node_run_id: z.string().optional(),
    task_id: z.string().optional(),
    event_id: z.number().int().optional(),
    field: z.string().optional(),
  })
  .strict();

const projectRealityWorkflowNodeSchema = z
  .object({
    node_run_id: z.string(),
    node_key: z.string(),
    node_label: z.string(),
    kind: z.enum(["task", "gate", "approval"]),
    requirement: z.enum(["required", "optional"]),
    release_mode: z.enum(["auto", "manual"]),
    status: z.enum([
      "pending",
      "awaiting_release",
      "ready",
      "running",
      "blocked",
      "done",
      "failed",
      "skipped",
      "cancelled",
      "archived",
    ]),
    current_task_id: z.string().nullable(),
    task_attempt_ids: z.array(z.string()),
  })
  .strict();

const projectRealityWorkflowSchema = z
  .object({
    workflow_run_id: z.string(),
    title: z.string().nullable(),
    status: z
      .enum(["draft", "waiting", "ready", "running", "blocked", "done", "failed", "cancelled", "archived"])
      .nullable(),
    role: z.string().nullable(),
    is_focused: z.boolean(),
    exists: z.boolean(),
    nodes: z.array(projectRealityWorkflowNodeSchema),
  })
  .strict();

const projectRealityTaskDocumentSchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    frontmatter: z
      .object({
        title: z.string().nullable(),
        status: z.enum(["open", "dispatched", "in_progress", "blocked", "done", "failed"]).nullable(),
        priority: z.enum(["low", "normal", "high", "urgent"]).nullable(),
        progress: z.number().nullable(),
        summary: z.string().nullable(),
        blocker_reason: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const projectRealityTaskSchema = z
  .object({
    task_id: z.string(),
    title: z.string().nullable(),
    status: z.enum(["open", "dispatched", "in_progress", "blocked", "done", "failed"]).nullable(),
    priority: z.enum(["low", "normal", "high", "urgent"]).nullable(),
    progress: z.number().nullable(),
    summary: z.string().nullable(),
    blocker_reason: z.string().nullable(),
    workflow_run_id: z.string(),
    node_run_id: z.string(),
    node_key: z.string(),
    node_label: z.string(),
    node_requirement: z.enum(["required", "optional"]),
    is_current: z.boolean(),
    attempt: z.number().int().nullable(),
    assignment: z
      .object({
        assignment_id: z.string(),
        status: z.enum(["assigned", "accepted", "blocked", "done", "failed", "superseded"]),
        checkpoint_due_at: z.number().nullable(),
        checkpoint_last_report_at: z.number().nullable(),
        checkpoint_overdue_count: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    latest_checkpoint_event: z
      .object({
        event_id: z.number().int(),
        created_at: z.number(),
        message: z.string().nullable(),
      })
      .strict()
      .nullable(),
    latest_progress_at: z.number().nullable(),
    document: projectRealityTaskDocumentSchema,
  })
  .strict();

const projectRealitySourceSchema = z.enum([
  "task_runtime",
  "workflow_runtime",
  "checkpoint_event",
  "project_next_step",
  "project_state",
  "task_document",
]);

export const projectRealityReturnSchema = z
  .object({
    evaluated_at: z.number(),
    authority: z
      .object({
        project: z.literal("project_record"),
        workflows: z.literal("workflow_runtime"),
        tasks: z.literal("task_runtime"),
        task_document: z.literal("non_authoritative"),
      })
      .strict(),
    authoritative_state: z
      .object({
        project: z
          .object({
            project_id: z.string(),
            slug: z.string(),
            status: z.enum(["active", "paused", "blocked", "done", "archived"]),
            next_step: z.string(),
          })
          .strict(),
        workflows: z.array(projectRealityWorkflowSchema),
        tasks: z.array(projectRealityTaskSchema),
      })
      .strict(),
    attention_signals: z.array(
      z
        .object({
          type: projectRealitySignalReferenceSchema.shape.kind,
          severity: z.enum(["blocking", "attention"]),
          source: projectRealitySourceSchema,
          reason: z.string(),
          signal: projectRealitySignalReferenceSchema,
        })
        .strict(),
    ),
    document_divergences: z.array(
      z
        .object({
          task_id: z.string(),
          document_path: z.string(),
          field: z.enum(["title", "status", "priority", "progress", "summary", "blocker_reason"]),
          runtime_value: z.union([z.string(), z.number(), z.null()]),
          document_value: z.union([z.string(), z.number(), z.null()]),
          authoritative_source: z.literal("task_runtime"),
          signal: projectRealitySignalReferenceSchema,
        })
        .strict(),
    ),
    recommended_next_action: z
      .object({
        type: z.enum([
          "resolve_required_blocker",
          "request_checkpoint_report",
          "follow_project_next_step",
          "advance_focused_workflow",
          "continue_current_task",
          "reconcile_workflow_link",
          "define_project_execution",
        ]),
        action: z.string(),
        source: projectRealitySourceSchema.exclude(["task_document"]),
        reason: z.string(),
        signal: projectRealitySignalReferenceSchema,
        precedence: z
          .object({
            rank: z.number().int().min(1).max(5),
            rule: z.string(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const projectStatusReturnSchema = projectDetailsReturnSchema
  .extend({
    reality: projectRealityReturnSchema,
  })
  .passthrough();

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

export const projectWorkflowUnlinkReturnSchema = z
  .object({
    details: projectDetailsReturnSchema,
    removedWorkflow: looseObjectSchema,
    promotedPrimaryWorkflowRunId: z.string().nullable(),
  })
  .passthrough();

export const projectFocusReturnSchema = z
  .object({
    details: projectDetailsReturnSchema,
    focusedWorkflowRunId: z.string().nullable(),
  })
  .passthrough();

export const projectTasksListReturnSchema = z
  .object({
    total: z.number(),
    tasks: z.array(looseObjectSchema),
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

const runtimeCapabilityReturnSchema = z.object({
  permission: z.string().optional(),
  objectType: z.string().optional(),
  objectId: z.string().optional(),
  source: z.string().optional(),
});

const agentRuntimePermissionsConfigReturnSchema = z
  .object({
    profile: z.enum(["bootstrap", "full-access"]).optional(),
    capabilities: z.array(z.union([z.string(), runtimeCapabilityReturnSchema])).optional(),
  })
  .nullable();

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
    sessionOverrides: z.array(
      z
        .object({
          sessionName: z.string(),
          model: z.string().optional(),
          effort: z.enum(RUNTIME_EFFORT_LEVELS).optional(),
          thinking: z.enum(["off", "normal", "verbose"]).optional(),
        })
        .strict(),
    ),
  })
  .passthrough();

export const agentPermissionsReturnSchema = z.object({
  action: z.literal("permissions"),
  changed: z.boolean(),
  agentId: z.string(),
  profile: z.string().optional(),
  runtimePermissions: agentRuntimePermissionsConfigReturnSchema.optional(),
  before: agentRuntimePermissionsConfigReturnSchema.optional(),
  after: agentRuntimePermissionsConfigReturnSchema.optional(),
  defaults: jsonObjectSchema.nullable().optional(),
  command: z.string().optional(),
  agent: jsonObjectSchema.optional(),
});

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

export const devinSessionSummaryReturnSchema = z
  .object({
    devinId: z.string(),
    title: z.string().nullable(),
    status: z.string(),
    statusDetail: z.string().nullable(),
    url: z.string(),
    tags: z.array(z.string()),
    updatedAt: z.number(),
    id: z.string().optional(),
    originType: z.string().nullable().optional(),
    originId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    proxRunId: z.string().nullable().optional(),
    lastSyncedAt: z.number().nullable().optional(),
    devinMode: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    resumable: z.boolean().nullable().optional(),
    maxAcuLimit: z.number().nullable().optional(),
    maxAcuLimitSource: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    serviceUserId: z.string().nullable().optional(),
    effectiveCreateAsUserId: z.string().nullable().optional(),
    isArchived: z.boolean().optional(),
    acusConsumed: z.number().optional(),
    origin: z.string().nullable().optional(),
  })
  .passthrough();

export const devinAuthCheckReturnSchema = z
  .object({
    ok: z.boolean(),
    baseUrl: z.string(),
    configuredOrgId: z.string().optional(),
    self: z
      .object({
        principal_type: z.string().optional(),
        service_user_id: z.string().optional(),
        service_user_name: z.string().optional(),
        org_id: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const devinSessionCreateReturnSchema = z
  .object({
    status: z.literal("created"),
    maxAcuLimitSource: z.string(),
    maxAcuLimit: z.number().nullable(),
    devinMode: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    resumable: z.boolean().nullable().optional(),
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
    session: devinSessionSummaryReturnSchema,
  })
  .passthrough();

export const devinSessionMessagesReturnSchema = z
  .object({
    devinId: z.string(),
    total: z.number(),
    messages: z.array(
      z
        .object({
          eventId: z.string(),
          createdAt: z.number(),
          source: z.string(),
          message: z.string(),
        })
        .passthrough(),
    ),
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
    attachments: z.array(
      z
        .object({
          attachmentId: z.string(),
          name: z.string(),
          source: z.string(),
          url: z.string(),
          contentType: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const devinSessionInsightsReturnSchema = z
  .object({
    session: devinSessionSummaryReturnSchema,
    summary: z.object({}).passthrough().nullable(),
    insights: z
      .object({
        numUserMessages: z.number().optional(),
        numDevinMessages: z.number().optional(),
        sessionSize: z.string().nullable().optional(),
        analysis: z.object({}).passthrough().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const devinSessionSyncReturnSchema = z
  .object({
    session: devinSessionSummaryReturnSchema,
    messages: z.number(),
    attachments: z.number(),
    insights: z.object({}).passthrough().nullable(),
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
    source: looseObjectSchema.nullable(),
    mode: z.enum(["attach-missing", "detach-disabled", "refresh-profile", "full-reconcile"]),
    total: z.number(),
    created: z.array(observerBindingReturnSchema),
    disabled: z.array(observerBindingReturnSchema),
    refreshedProfiles: z.array(observerBindingReturnSchema),
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

const toolAccessSchema = z
  .object({
    kind: z.string(),
    resource: z.string(),
    action: z.string(),
    risk: z.string(),
  })
  .strict();

const toolSkillGateSchema = z
  .object({
    skill: z.string(),
    source: z.string(),
  })
  .strict();

const toolMetadataSchema = z
  .object({
    group: z.string(),
    command: z.string(),
    method: z.string(),
    args: z.array(jsonObjectSchema),
    options: z.array(jsonObjectSchema),
    scope: z.string().optional(),
    skillGate: toolSkillGateSchema.optional(),
    access: toolAccessSchema.optional(),
  })
  .strict();

const toolSummarySchema = z
  .object({
    name: z.string(),
    description: z.string(),
    metadata: toolMetadataSchema,
  })
  .strict();

const toolResultContentItemSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const toolTestReturnSchema = z
  .object({
    mode: z.literal("dry_run"),
    executed: z.literal(false),
    tool: toolSummarySchema,
    args: z.record(z.string(), jsonValueSchema),
    schema: jsonObjectSchema.nullable(),
    access: toolAccessSchema.nullable(),
    invokeCommand: z.string(),
  })
  .strict();

const toolsSearchItemReturnSchema = z
  .object({
    rank: z.number(),
    score: z.number(),
    name: z.string(),
    description: z.string(),
    group: z.string(),
    command: z.string(),
    matchedFields: z.array(z.string()),
  })
  .strict();

export const toolsSearchReturnSchema = z
  .object({
    query: z.string(),
    limit: z.number(),
    total: z.number(),
    returned: z.number(),
    items: z.array(toolsSearchItemReturnSchema),
  })
  .strict();

export const toolInvokeReturnSchema = z
  .object({
    mode: z.literal("executed"),
    executed: z.literal(true),
    tool: toolSummarySchema,
    args: z.record(z.string(), jsonValueSchema),
    result: z
      .object({
        isError: z.boolean(),
        content: z.array(toolResultContentItemSchema),
      })
      .strict(),
  })
  .strict();

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

const sessionGoalObjectSchema = z
  .object({
    sessionKey: z.string(),
    goalId: z.string(),
    objective: z.string(),
    status: z.enum(["active", "paused", "budget_limited", "blocked", "complete"]),
    tokenBudget: z.number().nullable(),
    tokensUsed: z.number(),
    timeUsedSeconds: z.number(),
    taskId: z.string().nullable(),
    projectId: z.string().nullable(),
    blockedReason: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const sessionGoalSessionSummarySchema = z
  .object({
    sessionKey: z.string(),
    agentId: z.string(),
    label: z.string(),
  })
  .strict();

export const sessionGoalReturnSchema = z
  .object({
    action: z.string(),
    changed: z.boolean(),
    session: sessionGoalSessionSummarySchema,
    goal: sessionGoalObjectSchema.nullable(),
  })
  .strict();

// ============================================================================
// Runtime model presets
// ============================================================================

const strictOffsetPaginationReturnSchema = z
  .object({
    limit: z.number(),
    offset: z.number(),
    returned: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
    nextOffset: z.number().nullable(),
    nextCommand: z.string().nullable(),
  })
  .strict();

const runtimeModelPresetObjectSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    model: z.string(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    version: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const runtimeModelPresetImpactAgentSchema = z
  .object({
    agentId: z.string(),
    name: z.string().nullable(),
    provider: z.string(),
    effectiveModel: z.string(),
    modelSource: z.literal("agent_preset"),
    shadowingSessions: z.number(),
  })
  .strict();

const runtimeModelPresetImpactSchema = z
  .object({
    presetId: z.string(),
    version: z.number(),
    provider: z.string(),
    model: z.string(),
    enabled: z.boolean(),
    referencingAgentsTotal: z.number(),
    shadowingSessionsTotal: z.number(),
    agents: z.array(runtimeModelPresetImpactAgentSchema),
    limit: z.number(),
    offset: z.number(),
    referenced: z.boolean(),
    correctionCommand: z.string().nullable(),
    pagination: strictOffsetPaginationReturnSchema,
  })
  .strict();

export const runtimeModelPresetsListReturnSchema = z
  .object({
    total: z.number(),
    pagination: strictOffsetPaginationReturnSchema,
    presets: z.array(runtimeModelPresetObjectSchema),
  })
  .strict();

export const runtimeModelPresetShowReturnSchema = z
  .object({
    preset: runtimeModelPresetObjectSchema,
    referencingAgentsTotal: z.number(),
  })
  .strict();

export const runtimeModelPresetMutationReturnSchema = z
  .object({
    action: z.enum(["create", "set-model", "enable", "disable", "delete"]),
    changed: z.boolean(),
    dryRun: z.boolean(),
    preset: runtimeModelPresetObjectSchema,
  })
  .strict();

export const runtimeModelPresetImpactReturnSchema = runtimeModelPresetImpactSchema;
