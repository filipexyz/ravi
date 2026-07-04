import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { Returns } from "../decorators.js";
import { jsonObjectSchema, jsonValueSchema } from "../return-schemas.js";

export const looseObjectSchema = jsonObjectSchema;
export const looseObjectOrNullSchema = jsonObjectSchema.nullable();
export const unknownArraySchema = z.array(jsonValueSchema);
export const commandTargetSchema = z.object({ type: z.string() });

export function declareCommandReturns(target: Function, schemas: Record<string, ZodTypeAny>): void {
  for (const [method, schema] of Object.entries(schemas)) {
    const descriptor = Object.getOwnPropertyDescriptor(target.prototype, method);
    if (!descriptor) {
      throw new Error(`Cannot declare return schema for ${target.name}.${method}: method not found`);
    }
    Returns(schema)(target.prototype, method, descriptor);
  }
}

export const offsetPaginationReturnSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
  nextCommand: z.string().nullable(),
});

export const pagedItemsReturnSchema = z.object({
  total: z.number(),
  pagination: offsetPaginationReturnSchema,
  items: z.array(looseObjectSchema),
});

export const changedEntityReturnSchema = z.object({
  status: z.string(),
  changedCount: z.number(),
});

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

export const runtimeControlReturnSchema = z.object({
  ok: z.boolean(),
  operation: z.string().optional(),
  data: jsonValueSchema.optional(),
  error: z.string().optional(),
});

export const crmProfileReturnSchema = z.object({
  target: z.string(),
  crm: looseObjectSchema,
});

export const crmOpportunityReturnSchema = z.object({
  target: z.string(),
  opportunity: looseObjectSchema,
});

export const crmBoardReturnSchema = z.object({
  total: z.number(),
  opportunities: z.array(looseObjectSchema),
  stages: z.array(looseObjectSchema).optional(),
});

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

export const crmOpportunityContactsReturnSchema = z.object({
  total: z.number(),
  contacts: z.array(looseObjectSchema),
});

export const crmTaskReturnSchema = z.object({
  target: z.string(),
  task: looseObjectSchema,
});

export const inboxItemEnvelopeReturnSchema = z.object({
  item: looseObjectSchema,
});

export const inboxReadReturnSchema = z.object({
  item: looseObjectSchema,
  events: z.array(looseObjectSchema),
});

export const inboxSourcesReturnSchema = z.object({
  sources: z.array(looseObjectSchema),
});

export const inboxStatusReturnSchema = looseObjectSchema;

export const inboxToggleReturnSchema = z.object({
  enabled: z.boolean(),
  changed: z.boolean(),
});

export const inboxPollReturnSchema = z.object({
  ok: z.literal(true),
  snapshot: looseObjectSchema,
});

export const inboxItemsReturnSchema = z.object({
  total: z.number(),
  items: z.array(looseObjectSchema),
});

export const inboxReplayReturnSchema = z.object({
  ok: z.literal(true),
  itemId: z.string(),
  sequence: z.number(),
  subject: z.string(),
  replayedAt: z.string(),
});

export const proxRecordReturnSchema = looseObjectSchema;

export const proxProfileConfigureReturnSchema = z.object({
  profile: looseObjectSchema,
  provider_sync: jsonValueSchema.nullable(),
});

export const proxRulesReturnSchema = z.union([
  looseObjectSchema,
  z.object({
    rules: z.null(),
    message: z.string(),
  }),
]);

export const proxCallRequestReturnSchema = z.object({
  request: looseObjectSchema,
  blocked: z.boolean(),
  block_reason: z.string().nullable().optional(),
  provider_mode: z.enum(["stub", "live"]),
  hint: z.string(),
});

export const proxCallShowReturnSchema = z.object({
  request: looseObjectSchema,
  runs: z.array(looseObjectSchema),
  result: looseObjectOrNullSchema,
});

export const proxEventsReturnSchema = z.object({
  request_id: z.string(),
  total: z.number(),
  events: z.array(looseObjectSchema),
});

export const proxTranscriptReturnSchema = z.object({
  request_id: z.string(),
  outcome: z.string(),
  summary: z.string().nullable().optional(),
  transcript: z.string(),
});

export const proxCancelReturnSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  request_id: z.string(),
});

export const proxUnbindReturnSchema = z.object({
  success: z.literal(true),
  tool_id: z.string(),
});

export const proxVoiceAgentSyncReturnSchema = z.object({
  voice_agent_id: z.string(),
  provider: z.string(),
  provider_agent_id: z.string().nullable().optional(),
  dry_run: z.boolean(),
  intended_changes: looseObjectSchema,
  provider_sync: z.string(),
});

export const proxToolRunsReturnSchema = z.object({
  request_id: z.string(),
  total: z.number(),
  tool_runs: z.array(looseObjectSchema),
});

export const proxToolRunReturnSchema = z.object({
  ok: z.boolean(),
});

export const artifactRecordReturnSchema = looseObjectSchema;
export const artifactVersionReturnSchema = looseObjectSchema;

export const artifactMutationReturnSchema = z.object({
  success: z.literal(true),
});

export const artifactCreateReturnSchema = z.object({
  success: z.literal(true),
  artifact: looseObjectSchema,
  version: artifactVersionReturnSchema.optional(),
  package: looseObjectSchema.optional(),
});

export const artifactListReturnSchema = z.union([
  pagedItemsReturnSchema.extend({
    artifacts: z.array(looseObjectSchema),
  }),
  z.object({
    ok: z.literal(true),
    generatedAt: z.number(),
    query: looseObjectSchema,
    pagination: offsetPaginationReturnSchema,
    stats: looseObjectSchema,
    items: z.array(looseObjectSchema),
  }),
]);

export const artifactDetailsReturnSchema = z.object({
  artifact: looseObjectSchema,
  links: z.array(looseObjectSchema),
  events: z.array(looseObjectSchema),
  versions: z.array(looseObjectSchema),
});

export const artifactSnapshotReturnSchema = z.object({
  success: z.literal(true),
  version: artifactVersionReturnSchema,
});

export const artifactVersionsReturnSchema = z.object({
  artifactId: z.string(),
  total: z.number(),
  versions: z.array(artifactVersionReturnSchema),
});

export const artifactVersionShowReturnSchema = z.object({
  artifactId: z.string(),
  version: artifactVersionReturnSchema,
});

export const artifactRestoreReturnSchema = z.object({
  success: z.literal(true),
  artifact: artifactRecordReturnSchema,
  restoredFrom: artifactVersionReturnSchema,
  restoreVersion: artifactVersionReturnSchema,
});

export const artifactEventReturnSchema = z.object({
  success: z.literal(true),
  event: looseObjectSchema,
  artifact: artifactRecordReturnSchema.optional(),
});

export const artifactEventsReturnSchema = z.object({
  artifactId: z.string(),
  total: z.number(),
  events: z.array(looseObjectSchema),
});

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

export const artifactReleaseActivateReturnSchema = z.object({
  release: jsonValueSchema,
  site: jsonValueSchema,
  routes: unknownArraySchema,
  url: z.string().nullable(),
  localSync: looseObjectSchema.optional(),
});

export const mediaDeliveryReturnSchema = z.object({
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
});

export const audioGenerateReturnSchema = z.object({
  success: z.literal(true),
  audio: z.object({
    filePath: z.string(),
    mimeType: z.string(),
    text: z.string(),
    sendCommand: z.string(),
  }),
  options: looseObjectSchema,
  sent: mediaDeliveryReturnSchema.extend({ voiceNote: z.literal(true) }).optional(),
});

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
  z.object({
    success: z.literal(true),
    artifact_id: z.string(),
    artifactId: z.string(),
    status: z.string(),
    hint: z.string(),
    autoSend: z.boolean(),
    delivery: looseObjectSchema.optional(),
    events: z.string(),
    workerPid: z.number().optional(),
  }),
  z.object({
    success: z.literal(true),
    images: z.array(
      z.object({
        filePath: z.string(),
        mimeType: z.string(),
        prompt: z.string(),
        provider: z.string(),
        model: z.string(),
        artifactId: z.string(),
        sendCommand: z.string(),
      }),
    ),
    options: looseObjectSchema,
    sent: z.array(mediaDeliveryReturnSchema),
  }),
]);

export const imageAtlasSplitReturnSchema = z.object({
  success: z.literal(true),
  artifactId: z.string(),
  artifact_id: z.string(),
  manifestPath: z.string(),
  outputDir: z.string(),
  parentArtifactId: z.string().nullable(),
  crops: z.array(looseObjectSchema),
  sent: z.array(looseObjectSchema),
});

export const videoAnalyzeReturnSchema = z.object({
  success: z.literal(true),
  artifact: looseObjectSchema,
  video: z.object({
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
  }),
  options: looseObjectSchema,
});

export const cliTargetReturnSchema = z.object({
  type: z.string(),
  id: z.string(),
});

export const commandIssueReturnSchema = z.object({
  level: z.string(),
  code: z.string(),
  message: z.string(),
  id: z.string().nullable(),
  scope: z.string().nullable(),
  path: z.string().nullable(),
});

export const commandRecordReturnSchema = z.object({
  id: z.string(),
  token: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  argumentHint: z.string().nullable(),
  arguments: z.array(jsonValueSchema),
  disabled: z.boolean(),
  scope: z.string(),
  path: z.string(),
  relativePath: z.string(),
  shadowedBy: z.string().nullable(),
  shadows: z.array(z.string()),
  issues: z.array(commandIssueReturnSchema),
});

export const commandsListReturnSchema = pagedItemsReturnSchema.extend({
  agent: looseObjectSchema,
  locations: looseObjectSchema,
  commands: z.array(commandRecordReturnSchema),
  issues: z.array(commandIssueReturnSchema),
});

export const commandShowReturnSchema = z.object({
  agent: looseObjectSchema,
  command: commandRecordReturnSchema,
});

export const commandValidateReturnSchema = z.object({
  valid: z.boolean(),
  agent: looseObjectSchema,
  total: z.number(),
  effectiveTotal: z.number(),
  errors: z.array(commandIssueReturnSchema),
  warnings: z.array(commandIssueReturnSchema),
});

export const commandRunReturnSchema = z.object({
  agent: looseObjectSchema,
  command: commandRecordReturnSchema,
  metadata: looseObjectSchema,
  positionalArguments: z.array(jsonValueSchema),
  prompt: z.string(),
});

export const skillRecordReturnSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  skillFilePath: z.string(),
  source: z.string(),
  pluginName: z.string().nullable(),
});

export const skillsListReturnSchema = pagedItemsReturnSchema.extend({
  source: z.string(),
  skills: z.array(skillRecordReturnSchema),
});

export const skillShowReturnSchema = z.object({
  skill: skillRecordReturnSchema.extend({
    content: z.string(),
  }),
});

export const skillsInstallReturnSchema = z.object({
  success: z.literal(true),
  source: z.string(),
  installed: z.array(skillRecordReturnSchema),
  codexSynced: z.array(z.string()),
});

export const skillsSyncReturnSchema = z.object({
  success: z.literal(true),
  codexSynced: z.array(z.string()),
  total: z.number(),
});

export const specsListReturnSchema = pagedItemsReturnSchema.extend({
  specs: z.array(looseObjectSchema),
});

export const specContextReturnSchema = z.object({
  context: looseObjectSchema,
});

export const specCreateReturnSchema = z.object({
  status: z.literal("created"),
  spec: looseObjectSchema,
  createdFiles: z.array(z.string()),
  missingAncestors: z.array(looseObjectSchema),
});

export const specsSyncReturnSchema = z.object({
  status: z.literal("synced"),
  total: z.number(),
  rootPath: z.string(),
});

export const taskRecordReturnSchema = looseObjectSchema;
export const taskEventReturnSchema = looseObjectSchema;
export const taskProfileReturnSchema = looseObjectSchema;
export const taskAutomationReturnSchema = looseObjectSchema;

export const taskCreateReturnSchema = z.object({
  task: taskRecordReturnSchema,
  taskProfile: taskProfileReturnSchema,
  event: taskEventReturnSchema,
  relatedEvents: z.array(taskEventReturnSchema),
  parentTaskId: z.string().nullable(),
  readiness: looseObjectSchema,
  dependencies: z.array(looseObjectSchema),
  dependents: z.array(looseObjectSchema),
  launchPlan: looseObjectOrNullSchema,
});

export const taskListReturnSchema = z.object({
  total: z.number(),
  archiveMode: z.string(),
  limit: z.number().nullable(),
  page: looseObjectSchema,
  filters: looseObjectSchema,
  items: z.array(taskRecordReturnSchema),
  tasks: z.array(taskRecordReturnSchema),
});

export const taskShowReturnSchema = z.object({
  task: taskRecordReturnSchema,
  events: z.array(taskEventReturnSchema),
  comments: z.array(looseObjectSchema),
  historyLimit: z.number().nullable(),
  readiness: looseObjectSchema,
  dependencies: z.array(looseObjectSchema),
  dependents: z.array(looseObjectSchema),
  launchPlan: looseObjectOrNullSchema,
});

export const taskMutationReturnSchema = z.object({
  task: taskRecordReturnSchema,
  event: taskEventReturnSchema,
});

export const taskCommentReturnSchema = taskMutationReturnSchema.extend({
  comment: looseObjectSchema,
});

export const taskDispatchReturnSchema = z.object({
  mode: z.string(),
  task: taskRecordReturnSchema,
  event: taskEventReturnSchema,
  readiness: looseObjectSchema.optional(),
});

export const taskDependencyListReturnSchema = z.object({
  taskId: z.string(),
  total: z.number(),
  pagination: offsetPaginationReturnSchema,
  readiness: looseObjectSchema,
  launchPlan: looseObjectOrNullSchema,
  items: z.array(looseObjectSchema),
  dependencies: z.array(looseObjectSchema),
  dependents: z.array(looseObjectSchema),
});

export const taskProfilesListReturnSchema = pagedItemsReturnSchema.extend({
  profiles: z.array(taskProfileReturnSchema),
});

export const taskProfilePreviewReturnSchema = z.object({
  profile: taskProfileReturnSchema,
  rendered: looseObjectSchema,
});

export const taskProfilesValidateReturnSchema = z.object({
  valid: z.boolean(),
  results: z.array(looseObjectSchema),
});

export const taskProfileInitReturnSchema = z.object({
  sourceKind: z.string(),
  profileDir: z.string(),
  manifestPath: z.string(),
});

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

export const taskAutomationsListReturnSchema = pagedItemsReturnSchema.extend({
  filters: looseObjectSchema,
  automations: z.array(taskAutomationReturnSchema),
});

export const taskAutomationShowReturnSchema = z.object({
  automation: taskAutomationReturnSchema,
  runs: z.array(looseObjectSchema),
});

export const taskAutomationMutationReturnSchema = changedEntityReturnSchema.extend({
  target: cliTargetReturnSchema,
  automation: taskAutomationReturnSchema,
});

export const threadReturnSchema = looseObjectSchema;

export const threadActionReturnSchema = z.object({
  action: z.string(),
  thread: threadReturnSchema,
});

export const threadListReturnSchema = z.object({
  action: z.literal("list"),
  items: z.array(threadReturnSchema),
  pagination: offsetPaginationReturnSchema,
});

export const threadShowReturnSchema = threadActionReturnSchema.extend({
  entries: z.array(looseObjectSchema),
  links: z.array(looseObjectSchema),
});

export const threadEntryReturnSchema = threadActionReturnSchema.extend({
  entry: looseObjectSchema,
});

export const threadLinkReturnSchema = threadActionReturnSchema.extend({
  link: looseObjectSchema,
});

export const threadEntriesReturnSchema = threadActionReturnSchema.extend({
  entries: z.array(looseObjectSchema),
});

export const threadBriefReturnSchema = threadActionReturnSchema.extend({
  brief: looseObjectSchema,
});

export const workflowSpecReturnSchema = looseObjectSchema;
export const workflowRunDetailsReturnSchema = looseObjectSchema;

export const workflowSpecsListReturnSchema = pagedItemsReturnSchema.extend({
  specs: z.array(workflowSpecReturnSchema),
});

export const workflowRunsListReturnSchema = pagedItemsReturnSchema.extend({
  runs: z.array(looseObjectSchema),
});

export const workflowRunMutationReturnSchema = z.object({
  details: workflowRunDetailsReturnSchema,
});

export const workflowTaskCreateReturnSchema = z.object({
  task: taskRecordReturnSchema,
  workflow: looseObjectOrNullSchema,
});

export const projectDetailsReturnSchema = looseObjectSchema;
export const projectResourceReturnSchema = looseObjectSchema;

export const projectInitReturnSchema = z.object({
  details: projectDetailsReturnSchema,
  workflows: z.array(looseObjectSchema),
});

export const projectsListReturnSchema = pagedItemsReturnSchema.extend({
  filters: looseObjectSchema,
  projects: z.array(looseObjectSchema),
});

export const projectsNextReturnSchema = z.object({
  total: z.number(),
  filters: looseObjectSchema,
  projects: z.array(looseObjectSchema),
});

export const projectWorkflowOperationReturnSchema = z.object({
  details: projectDetailsReturnSchema,
  workflow: looseObjectSchema,
});

export const projectTaskOperationReturnSchema = z.object({
  details: projectDetailsReturnSchema,
  workflow: looseObjectSchema,
  defaults: looseObjectSchema,
});

export const projectResourcesListReturnSchema = pagedItemsReturnSchema.extend({
  resources: z.array(projectResourceReturnSchema),
});

export const projectResourcesImportReturnSchema = z.object({
  total: z.number(),
  resources: z.array(projectResourceReturnSchema),
});

export const projectFixturesSeedReturnSchema = z.object({
  total: z.number(),
  fixtures: z.array(looseObjectSchema),
});

export const daemonStatusReturnSchema = z.object({
  pm2Available: z.boolean(),
  processName: z.string(),
  ravi: looseObjectSchema,
  infrastructure: looseObjectSchema,
  processes: z.array(looseObjectSchema),
});

export const daemonMutationReturnSchema = z.object({
  action: z.string(),
  changed: z.boolean(),
});

export const daemonLogsReturnSchema = z.object({
  action: z.string(),
});

export const daemonEnvReturnSchema = z.object({
  action: z.literal("env"),
  path: z.string(),
  existedBefore: z.boolean(),
  created: z.boolean(),
  openedEditor: z.boolean(),
});

export const daemonInitAdminKeyReturnSchema = z.object({
  action: z.literal("init-admin-key"),
  changed: z.boolean(),
});

export const runtimeCredentialsListReturnSchema = z.object({
  total: z.number(),
  pagination: offsetPaginationReturnSchema,
  credentials: z.array(looseObjectSchema),
  providerHealth: z.array(looseObjectSchema),
});

export const runtimeCredentialEnvelopeReturnSchema = z.object({
  credential: looseObjectSchema,
});

export const runtimeCredentialStatusReturnSchema = z.object({
  credential: looseObjectSchema,
  health: looseObjectOrNullSchema,
});

export const runtimeCredentialRefreshReturnSchema = z.object({
  refreshed: z.array(looseObjectSchema),
});

export const runtimeCredentialSelectReturnSchema = z.object({
  selected: looseObjectOrNullSchema,
  candidates: z.array(looseObjectSchema),
  rejected: z.array(looseObjectSchema),
});

export const runtimeCredentialClassifyReturnSchema = z.object({
  signal: looseObjectSchema,
  pressure: looseObjectSchema,
});

export const triggerTopicsReturnSchema = z.object({
  topics: z.array(looseObjectSchema),
});

export const triggerListReturnSchema = pagedItemsReturnSchema.extend({
  triggers: z.array(looseObjectSchema),
});

export const triggerShowReturnSchema = z.object({
  trigger: looseObjectSchema,
});

export const triggerMutationReturnSchema = z.object({
  status: z.string(),
  target: commandTargetSchema,
  changedCount: z.number(),
  trigger: looseObjectOrNullSchema,
});

export const cronListReturnSchema = pagedItemsReturnSchema.extend({
  jobs: z.array(looseObjectSchema),
});

export const cronShowReturnSchema = z.object({
  job: looseObjectSchema,
});

export const cronMutationReturnSchema = z.object({
  status: z.string(),
  target: commandTargetSchema,
  changedCount: z.number(),
  job: looseObjectOrNullSchema,
});

export const watchConnectorsReturnSchema = z.object({
  total: z.number(),
  connectors: z.array(looseObjectSchema),
  items: z.array(looseObjectSchema),
});

export const watchCreateReturnSchema = z.object({
  status: z.string(),
  watch: looseObjectSchema,
  capabilities: looseObjectSchema,
  next: looseObjectSchema,
});

export const watchListReturnSchema = pagedItemsReturnSchema.extend({
  watches: z.array(looseObjectSchema),
});

export const watchShowReturnSchema = z.object({
  watch: looseObjectSchema,
});

export const watchMutationReturnSchema = z.object({
  status: z.string(),
  watch: looseObjectSchema,
});

export const watchRemoveReturnSchema = z.object({
  deleted: z.boolean(),
  id: z.string(),
});

export const watchEventsReturnSchema = z.object({
  watchId: z.string(),
  eventTypes: z.array(z.string()),
  subjects: z.array(z.string()),
});

export const watchTriggerReturnSchema = z.object({
  status: z.string(),
  watch: looseObjectSchema,
  trigger: looseObjectSchema,
});

export const hookListReturnSchema = pagedItemsReturnSchema.extend({
  hooks: z.array(looseObjectSchema),
});

export const hookShowReturnSchema = z.object({
  hook: looseObjectSchema,
});

export const hookMutationReturnSchema = z.object({
  status: z.string(),
  target: commandTargetSchema,
  changedCount: z.number(),
  hook: looseObjectSchema,
});

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

export const agentsListReturnSchema = pagedItemsReturnSchema.extend({
  defaultAgent: z.string(),
  filters: looseObjectSchema,
  agents: z.array(agentRecordReturnSchema),
});

export const agentShowReturnSchema = z.object({
  agent: agentRecordReturnSchema,
  permissionsCommand: z.string(),
});

export const agentCreateReturnSchema = z.object({
  action: z.literal("create"),
  changed: z.boolean(),
  agent: agentRecordReturnSchema,
  runtimeTarget: looseObjectSchema,
  permissions: looseObjectSchema,
});

export const agentInstructionSyncReturnSchema = z.object({
  total: z.number(),
  migrated: z.number(),
  alreadyCanonical: z.number(),
  missing: z.number(),
  manualReview: z.number(),
  incomplete: z.number(),
  results: z.array(looseObjectSchema),
});

export const agentDeleteReturnSchema = z.object({
  action: z.literal("delete"),
  changed: z.boolean(),
  agentId: z.string(),
  before: agentRecordReturnSchema.optional(),
});

export const agentSetReturnSchema = z.object({
  action: z.literal("set"),
  changed: z.boolean(),
  agentId: z.string(),
  key: z.string(),
  value: jsonValueSchema,
  agent: agentRecordReturnSchema.optional(),
});

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

export const agentDebounceReturnSchema = z.object({
  action: z.string().optional(),
  changed: z.boolean().optional(),
  agentId: z.string(),
  debounceMs: z.number().nullable(),
  enabled: z.boolean(),
});

export const agentSpecModeReturnSchema = z.object({
  action: z.string().optional(),
  changed: z.boolean().optional(),
  agentId: z.string(),
  specMode: z.boolean(),
});

export const agentSessionReturnSchema = z.object({
  agent: agentRecordReturnSchema,
  total: z.number(),
  sessions: z.array(looseObjectSchema),
});

export const agentResetReturnSchema = z.object({
  action: z.literal("reset"),
  changed: z.boolean(),
  agentId: z.string(),
  target: z.string(),
  resetSessions: z.array(looseObjectSchema).optional(),
  count: z.number().optional(),
  session: looseObjectSchema.optional(),
  reason: z.string().optional(),
  availableSessions: z.array(z.string()).optional(),
});

export const agentDebugReturnSchema = z.union([
  z.object({
    error: z.string(),
    agentId: z.string(),
    availableSessions: z.array(z.string()),
  }),
  z.object({
    session: looseObjectSchema,
    transcript: looseObjectSchema,
    entries: z.array(jsonValueSchema),
  }),
]);

export const devinSessionSummaryReturnSchema = looseObjectSchema;

export const devinAuthCheckReturnSchema = z.object({
  ok: z.boolean(),
  baseUrl: z.string(),
  configuredOrgId: z.string().optional(),
  self: looseObjectSchema,
});

export const devinSessionCreateReturnSchema = z.object({
  status: z.literal("created"),
  maxAcuLimitSource: z.string(),
  maxAcuLimit: z.number().nullable(),
  session: devinSessionSummaryReturnSchema,
});

export const devinSessionsListReturnSchema = pagedItemsReturnSchema.extend({
  source: z.string(),
  hasNextPage: z.boolean().optional(),
  sessions: z.array(devinSessionSummaryReturnSchema),
});

export const devinSessionShowReturnSchema = z.object({
  session: looseObjectSchema,
});

export const devinSessionMessagesReturnSchema = z.object({
  devinId: z.string(),
  total: z.number(),
  messages: z.array(looseObjectSchema),
});

export const devinSessionSendReturnSchema = z.object({
  status: z.literal("sent"),
  session: devinSessionSummaryReturnSchema,
});

export const devinSessionAttachmentsReturnSchema = z.object({
  devinId: z.string(),
  total: z.number(),
  attachments: z.array(looseObjectSchema),
});

export const devinSessionInsightsReturnSchema = z.object({
  session: devinSessionSummaryReturnSchema,
  summary: looseObjectOrNullSchema,
  insights: looseObjectSchema,
});

export const devinSessionSyncReturnSchema = z.object({
  session: devinSessionSummaryReturnSchema,
  messages: z.number(),
  attachments: z.number(),
  insights: looseObjectOrNullSchema,
  artifacts: z.array(z.string()),
});

export const devinSessionTerminateReturnSchema = z.object({
  status: z.literal("terminated"),
  archive: z.boolean(),
  session: devinSessionSummaryReturnSchema,
});

export const devinSessionArchiveReturnSchema = z.object({
  status: z.literal("archived"),
  session: devinSessionSummaryReturnSchema,
});

export const insightCreateReturnSchema = z.object({
  success: z.literal(true),
  insight: looseObjectSchema,
  comment: looseObjectSchema.optional(),
  tags: z.array(z.string()),
});

const overlayInsightsReturnSchema = z.object({
  ok: z.literal(true),
  generatedAt: z.number(),
  query: looseObjectSchema,
  stats: looseObjectSchema,
  items: z.array(looseObjectSchema),
});

const insightsListPlainReturnSchema = z.object({
  count: z.number(),
  total: z.number(),
  pagination: offsetPaginationReturnSchema,
  query: looseObjectSchema,
  items: z.array(looseObjectSchema),
  insights: z.array(looseObjectSchema),
});

export const insightsListReturnSchema = z.union([insightsListPlainReturnSchema, overlayInsightsReturnSchema]);

export const insightShowReturnSchema = z.object({
  insight: looseObjectSchema,
  tags: z.array(z.string()),
});

export const insightsSearchReturnSchema = z.object({
  count: z.number(),
  query: looseObjectSchema,
  insights: z.array(looseObjectSchema),
});

export const observerBindingReturnSchema = looseObjectSchema;
export const observerRuleReturnSchema = looseObjectSchema;
export const observerProfileReturnSchema = looseObjectSchema;

export const observerBindingsListReturnSchema = pagedItemsReturnSchema.extend({
  bindings: z.array(observerBindingReturnSchema),
});

export const observerBindingShowReturnSchema = z.object({
  binding: observerBindingReturnSchema,
});

export const observerRefreshReturnSchema = z.object({
  source: looseObjectSchema,
  total: z.number(),
  created: z.array(observerBindingReturnSchema),
  bindings: z.array(observerBindingReturnSchema),
  skipped: z.array(looseObjectSchema),
});

export const observerRulesListReturnSchema = pagedItemsReturnSchema.extend({
  rules: z.array(observerRuleReturnSchema),
});

export const observerRuleShowReturnSchema = z.object({
  rule: observerRuleReturnSchema,
});

export const observerRuleMutationReturnSchema = z.object({
  success: z.literal(true),
  rule: observerRuleReturnSchema,
});

export const observerRuleRemoveReturnSchema = z.object({
  success: z.literal(true),
  deleted: jsonValueSchema,
});

export const observerRulesValidateReturnSchema = z.object({
  ok: z.boolean(),
  errors: z.array(looseObjectSchema),
});

export const observerRuleExplainReturnSchema = z.object({
  source: looseObjectSchema,
  rules: z.array(looseObjectSchema),
  bindings: z.array(observerBindingReturnSchema),
});

export const observerProfilesListReturnSchema = pagedItemsReturnSchema.extend({
  profiles: z.array(observerProfileReturnSchema),
});

export const observerProfileShowReturnSchema = z.object({
  profile: observerProfileReturnSchema,
  body: z.string(),
});

export const observerProfilePreviewReturnSchema = z.object({
  profile: observerProfileReturnSchema,
  eventType: z.string(),
  eventMarkdown: z.string(),
  prompt: z.string(),
});

export const observerProfilesValidateReturnSchema = z.object({
  ok: z.boolean(),
  profiles: z.array(looseObjectSchema),
  errors: z.array(looseObjectSchema),
});

export const observerProfileInitReturnSchema = z.object({
  sourceKind: z.string(),
  profileDir: z.string(),
  profilePath: z.string(),
});

const selfSectionReturnSchema = z.object({
  status: z.enum(["ok", "partial", "missing", "unavailable"]),
  reason: z.string().optional(),
  data: jsonValueSchema.optional(),
});

export const selfWhoamiReturnSchema = z.object({
  generatedAt: z.number(),
  identity: looseObjectSchema,
  actor: selfSectionReturnSchema,
  session: selfSectionReturnSchema,
  chat: selfSectionReturnSchema,
  route: selfSectionReturnSchema,
  nextReads: z.array(z.string()),
});

export const selfContextReturnSchema = z.object({
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
});

export const selfSectionOnlyReturnSchema = selfSectionReturnSchema;

export const selfExplainReturnSchema = z.object({
  generatedAt: z.number(),
  explain: z.array(looseObjectSchema),
  nextReads: z.array(z.string()),
});

const tagPageReturnSchema = z.object({
  limit: z.number(),
  count: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  nextCommand: z.string().nullable(),
  sort: z.string(),
  order: z.string(),
});

export const tagMutationReturnSchema = z.object({
  status: z.string(),
  target: looseObjectSchema,
  changedCount: z.number(),
  tag: looseObjectSchema.optional(),
  binding: looseObjectSchema.optional(),
  behaviorConsumers: z.array(looseObjectSchema).optional(),
});

export const tagsListReturnSchema = z.object({
  total: z.number(),
  page: tagPageReturnSchema,
  filters: looseObjectSchema,
  items: z.array(looseObjectSchema),
  tags: z.array(looseObjectSchema),
});

export const tagShowReturnSchema = z.object({
  tag: looseObjectSchema,
  bindings: z.array(looseObjectSchema),
  behaviorConsumers: z.array(looseObjectSchema),
});

export const tagDetachReturnSchema = z.object({
  status: z.literal("detached"),
  target: looseObjectSchema,
  changedCount: z.number(),
});

export const tagsSearchReturnSchema = z.object({
  total: z.number(),
  page: tagPageReturnSchema,
  filters: looseObjectSchema,
  items: z.array(looseObjectSchema),
  bindings: z.array(looseObjectSchema),
  behaviorConsumers: z.array(looseObjectSchema),
});

export const tagRulesListReturnSchema = z.object({
  rules: z.array(looseObjectSchema),
  errors: z.array(looseObjectSchema),
  pagination: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    returned: z.number().optional(),
  }),
});

export const tagRuleShowReturnSchema = z.object({
  rule: looseObjectSchema,
  source: z.string().optional(),
});

export const tagRulesValidateReturnSchema = z.object({
  status: z.enum(["ok", "error"]),
  ruleCount: z.number(),
  errors: z.array(looseObjectSchema),
});

export const tagRulesExplainReturnSchema = z.object({
  target: looseObjectSchema,
  rules: looseObjectSchema,
  loaded: looseObjectSchema,
  outcomes: z.array(looseObjectSchema),
});

export const tagRulesTickReturnSchema = z.object({
  rulesLoaded: z.number(),
  loadErrors: z.array(looseObjectSchema),
  contactsProcessed: z.number(),
  matched: z.number(),
  appliedActions: z.number(),
  contacts: z.array(looseObjectSchema),
});

export const tagRulesEvaluateReturnSchema = z.object({
  ruleId: z.string(),
  target: looseObjectSchema,
  apply: z.boolean(),
  outcomes: z.array(looseObjectSchema),
  traces: z.array(looseObjectSchema),
});

export const toolsListReturnSchema = pagedItemsReturnSchema.extend({
  groups: z.array(
    z.object({
      name: z.string(),
      tools: z.array(looseObjectSchema),
    }),
  ),
  tools: z.array(looseObjectSchema),
});

export const toolShowReturnSchema = z.object({
  tool: looseObjectSchema,
});

export const toolsManifestReturnSchema = z.object({
  total: z.number(),
  tools: z.array(looseObjectSchema),
});

export const toolsSchemaReturnSchema = z.object({
  schema: looseObjectSchema,
});

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

export const routesListReturnSchema = pagedItemsReturnSchema.extend({
  instance: z.string().nullable(),
  filter: looseObjectSchema,
  routes: z.array(looseObjectSchema),
});

export const routeShowReturnSchema = z.object({
  instance: z.string(),
  pattern: z.string(),
  route: looseObjectSchema,
});

export const routeExplainReturnSchema = z.object({
  target: looseObjectSchema,
  instance: z.string(),
  pattern: z.string().nullable(),
  channel: z.string().nullable(),
  configuredRoute: looseObjectOrNullSchema,
  liveEffect: looseObjectOrNullSchema,
});
