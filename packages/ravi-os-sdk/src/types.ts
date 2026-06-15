// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).

/** Input shape for `adapters.list`. */
export type AdaptersListInput = {
  limit?: string;
  offset?: string;
  session?: string;
  status?: string;
};

/** Return shape for `adapters.list`. */
export type AdaptersListReturn = {
  adapters: Array<{
    adapterId: string;
    adapterName: string;
    bind: {
      agentId: string | null;
      bound: boolean;
      cliName: string | null;
      contextId: string | null;
      contextKey?: unknown;
      sessionKey: string;
      sessionName: string | null;
      [k: string]: unknown;
    };
    diagnosticState: "live" | "dead" | "unbound" | "protocol-invalid" | "stopped" | "configured";
    health: Record<string, unknown>;
    lastCommand: (Record<string, unknown>) | null;
    lastEvent: (Record<string, unknown>) | null;
    lastProtocolError: (Record<string, unknown>) | null;
    sessionKey: string;
    sessionName: string | null;
    status: string;
    transport: string;
    updatedAt: number;
    [k: string]: unknown;
  }>;
  count: number;
  items: Array<{
    adapterId: string;
    adapterName: string;
    bind: {
      agentId: string | null;
      bound: boolean;
      cliName: string | null;
      contextId: string | null;
      contextKey?: unknown;
      sessionKey: string;
      sessionName: string | null;
      [k: string]: unknown;
    };
    diagnosticState: "live" | "dead" | "unbound" | "protocol-invalid" | "stopped" | "configured";
    health: Record<string, unknown>;
    lastCommand: (Record<string, unknown>) | null;
    lastEvent: (Record<string, unknown>) | null;
    lastProtocolError: (Record<string, unknown>) | null;
    sessionKey: string;
    sessionName: string | null;
    status: string;
    transport: string;
    updatedAt: number;
    [k: string]: unknown;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
};

/** Input shape for `adapters.show`. */
export type AdaptersShowInput = {
  adapterId: string;
};

/** Return shape for `adapters.show`. */
export type AdaptersShowReturn = {
  adapterId: string;
  adapterName: string;
  bind: {
    agentId: string | null;
    bound: boolean;
    cliName: string | null;
    contextId: string | null;
    contextKey?: unknown;
    sessionKey: string;
    sessionName: string | null;
    [k: string]: unknown;
  };
  diagnosticState: "live" | "dead" | "unbound" | "protocol-invalid" | "stopped" | "configured";
  health: Record<string, unknown>;
  lastCommand: (Record<string, unknown>) | null;
  lastEvent: (Record<string, unknown>) | null;
  lastProtocolError: (Record<string, unknown>) | null;
  sessionKey: string;
  sessionName: string | null;
  status: string;
  transport: string;
  updatedAt: number;
  [k: string]: unknown;
};

/** Input shape for `agents.create`. */
export type AgentsCreateInput = {
  allowRuntimeMismatch?: boolean;
  cwd: string;
  id: string;
  model?: string;
  provider?: string;
};

/** Return shape for `agents.create`. */
export type AgentsCreateReturn = {
  action: "create";
  agent: Record<string, unknown>;
  changed: boolean;
  permissions: Record<string, unknown>;
  runtimeTarget: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `agents.debounce`. */
export type AgentsDebounceInput = {
  id: string;
  ms?: string;
};

/** Return shape for `agents.debounce`. */
export type AgentsDebounceReturn = {
  action?: string;
  agentId: string;
  changed?: boolean;
  debounceMs: number | null;
  enabled: boolean;
  [k: string]: unknown;
};

/** Input shape for `agents.debug`. */
export type AgentsDebugInput = {
  id: string;
  nameOrKey?: string;
  turns?: string;
};

/** Return shape for `agents.debug`. */
export type AgentsDebugReturn = ({
  agentId: string;
  availableSessions: string[];
  error: string;
  [k: string]: unknown;
}) | ({
  entries: unknown[];
  session: Record<string, unknown>;
  transcript: Record<string, unknown>;
  [k: string]: unknown;
});

/** Input shape for `agents.delete`. */
export type AgentsDeleteInput = {
  id: string;
};

/** Return shape for `agents.delete`. */
export type AgentsDeleteReturn = {
  action: "delete";
  agentId: string;
  before?: Record<string, unknown>;
  changed: boolean;
  [k: string]: unknown;
};

/** Input shape for `agents.list`. */
export type AgentsListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `agents.list`. */
export type AgentsListReturn = {
  agents: Array<Record<string, unknown>>;
  defaultAgent: string;
  filters: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `agents.reset`. */
export type AgentsResetInput = {
  id: string;
  nameOrKey?: string;
};

/** Return shape for `agents.reset`. */
export type AgentsResetReturn = {
  action: "reset";
  agentId: string;
  availableSessions?: string[];
  changed: boolean;
  count?: number;
  reason?: string;
  resetSessions?: Array<Record<string, unknown>>;
  session?: Record<string, unknown>;
  target: string;
  [k: string]: unknown;
};

/** Input shape for `agents.session`. */
export type AgentsSessionInput = {
  id: string;
};

/** Return shape for `agents.session`. */
export type AgentsSessionReturn = {
  agent: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `agents.set`. */
export type AgentsSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `agents.set`. */
export type AgentsSetReturn = {
  action: "set";
  agent?: Record<string, unknown>;
  agentId: string;
  changed: boolean;
  key: string;
  value: unknown;
  [k: string]: unknown;
};

/** Input shape for `agents.show`. */
export type AgentsShowInput = {
  id: string;
};

/** Return shape for `agents.show`. */
export type AgentsShowReturn = {
  agent: Record<string, unknown>;
  permissionsCommand: string;
  [k: string]: unknown;
};

/** Input shape for `agents.spec-mode`. */
export type AgentsSpecModeInput = {
  enabled?: string;
  id: string;
};

/** Return shape for `agents.spec-mode`. */
export type AgentsSpecModeReturn = {
  action?: string;
  agentId: string;
  changed?: boolean;
  specMode: boolean;
  [k: string]: unknown;
};

/** Input shape for `agents.sync-instructions`. */
export type AgentsSyncInstructionsInput = {
  agent?: string;
  materializeMissing?: boolean;
};

/** Return shape for `agents.sync-instructions`. */
export type AgentsSyncInstructionsReturn = {
  alreadyCanonical: number;
  incomplete: number;
  manualReview: number;
  migrated: number;
  missing: number;
  results: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `apps.check`. */
export type AppsCheckInput = {
  id?: string;
};

/** Return shape for `apps.check`. */
export type AppsCheckReturn = {
  checked: number;
  ok: boolean;
  results: Array<{
    errors: string[];
    id: string;
    ok: boolean;
    path: string;
    source: "repo" | "plugin" | "state";
    warnings: string[];
  }>;
};

/** Input shape for `apps.guide`. */
export type AppsGuideInput = {
  id?: string;
};

/** Return shape for `apps.guide`. */
export type AppsGuideReturn = {
  app: ({
    description: string | null;
    errors: string[];
    id: string;
    interfaceNames: string[];
    manifest: unknown | null;
    name: string | null;
    path: string;
    permissions: {
      mutating: string[];
      optional: string[];
      provider: ({
        cacheTtlSec?: number;
        decisionSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        failClosed: true;
        id: string;
        interface: "builtin" | "cli" | "sdk" | "tool";
        operation: string;
        requestSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        scope?: string[];
        timeoutMs?: number;
        version: string;
      }) | null;
      required: string[];
    };
    relativePath: string;
    rootPath: string;
    schema: string | null;
    source: "repo" | "plugin" | "state";
    valid: boolean;
    version: string | null;
    warnings: string[];
  }) | null;
  appId: string | null;
  nextCommands: string[];
  prompts: Array<{
    commands: string[];
    id: string;
    prompt: string;
    title: string;
  }>;
  skill: string;
  skillGate: {
    group: string;
    skill: string;
  };
};

/** Input shape for `apps.import-cli`. */
export type AppsImportCliInput = {
  command: string;
  description?: string;
  dryRun?: boolean;
  force?: boolean;
  id?: string;
  name?: string;
  skipSkill?: boolean;
  skipSpec?: boolean;
  skipUi?: boolean;
  source?: string;
};

/** Return shape for `apps.import-cli`. */
export type AppsImportCliReturn = {
  command: string;
  confidence: "high" | "medium" | "low";
  debugCandidates: Array<{
    command: string;
    confidence: "high" | "medium" | "low";
    description: string | null;
    destructive: boolean;
    id: string;
    interactive: boolean;
    json: boolean;
    mutating: boolean;
    name: string;
    reviewRequired: string[];
    streaming: boolean;
  }>;
  description: string;
  dryRun: boolean;
  files: Array<{
    action: "planned" | "created" | "overwritten";
    kind: "manifest" | "spec" | "skill";
    path: string;
  }>;
  force: boolean;
  id: string;
  manifest: Record<string, unknown>;
  manifestPath: string;
  name: string;
  nextCommands: string[];
  operationCandidates: Array<{
    command: string;
    confidence: "high" | "medium" | "low";
    description: string | null;
    destructive: boolean;
    id: string;
    interactive: boolean;
    json: boolean;
    mutating: boolean;
    name: string;
    reviewRequired: string[];
    streaming: boolean;
  }>;
  reviewRequired: string[];
  skill: string | null;
  skillPath: string | null;
  source: "manifest" | "registry" | "help";
  sourceCommand: string;
  specPath: string | null;
  warnings: string[];
};

/** Input shape for `apps.list`. */
export type AppsListInput = {
  limit?: string;
  offset?: string;
  source?: string;
};

/** Return shape for `apps.list`. */
export type AppsListReturn = {
  apps: Array<{
    description: string | null;
    errors: string[];
    id: string;
    interfaceNames: string[];
    name: string | null;
    path: string;
    permissions: {
      mutating: string[];
      optional: string[];
      provider: ({
        cacheTtlSec?: number;
        decisionSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        failClosed: true;
        id: string;
        interface: "builtin" | "cli" | "sdk" | "tool";
        operation: string;
        requestSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        scope?: string[];
        timeoutMs?: number;
        version: string;
      }) | null;
      required: string[];
    };
    relativePath: string;
    rootPath: string;
    schema: string | null;
    source: "repo" | "plugin" | "state";
    valid: boolean;
    version: string | null;
    warnings: string[];
  }>;
  items: Array<{
    description: string | null;
    errors: string[];
    id: string;
    interfaceNames: string[];
    name: string | null;
    path: string;
    permissions: {
      mutating: string[];
      optional: string[];
      provider: ({
        cacheTtlSec?: number;
        decisionSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        failClosed: true;
        id: string;
        interface: "builtin" | "cli" | "sdk" | "tool";
        operation: string;
        requestSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        scope?: string[];
        timeoutMs?: number;
        version: string;
      }) | null;
      required: string[];
    };
    relativePath: string;
    rootPath: string;
    schema: string | null;
    source: "repo" | "plugin" | "state";
    valid: boolean;
    version: string | null;
    warnings: string[];
  }>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  total: number;
};

/** Input shape for `apps.prompts`. */
export type AppsPromptsInput = {
  id?: string;
};

/** Return shape for `apps.prompts`. */
export type AppsPromptsReturn = {
  app: ({
    description: string | null;
    errors: string[];
    id: string;
    interfaceNames: string[];
    manifest: unknown | null;
    name: string | null;
    path: string;
    permissions: {
      mutating: string[];
      optional: string[];
      provider: ({
        cacheTtlSec?: number;
        decisionSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        failClosed: true;
        id: string;
        interface: "builtin" | "cli" | "sdk" | "tool";
        operation: string;
        requestSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        scope?: string[];
        timeoutMs?: number;
        version: string;
      }) | null;
      required: string[];
    };
    relativePath: string;
    rootPath: string;
    schema: string | null;
    source: "repo" | "plugin" | "state";
    valid: boolean;
    version: string | null;
    warnings: string[];
  }) | null;
  appId: string | null;
  nextCommands: string[];
  prompts: Array<{
    commands: string[];
    id: string;
    prompt: string;
    title: string;
  }>;
  skill: string;
  skillGate: {
    group: string;
    skill: string;
  };
};

/** Input shape for `apps.run`. */
export type AppsRunInput = {
  args?: string[];
  id: string;
  operation?: string;
};

/** Return shape for `apps.run`. */
export type AppsRunReturn = {
  appId: string | null;
  channel?: string;
  command?: string;
  durationMs: number;
  error?: string;
  exitCode?: number | null;
  handler?: string;
  interface: ("builtin" | "cli" | "sdk" | "tool" | "stream") | null;
  mutating: boolean;
  ok: boolean;
  operation: string | null;
  operationId: string | null;
  permissionProvider?: {
    audit?: unknown;
    cache: {
      hit: boolean;
      ttlSec?: number;
    };
    decision: "allow" | "deny" | "needs_grant" | "not_applicable" | "error" | "invalid";
    durationMs: number;
    error?: string;
    grantSuggestion?: unknown;
    interface: "builtin" | "cli" | "sdk" | "tool";
    providerId: string;
    providerOperationId: string;
    providerVersion: string;
    reason?: string;
    reasonCode: string | null;
    requestId: string;
  };
  result?: unknown;
  status: "completed" | "failed";
  stderr?: string;
  stdout?: string;
};

/** Input shape for `apps.scaffold`. */
export type AppsScaffoldInput = {
  command?: string;
  description?: string;
  dryRun?: boolean;
  force?: boolean;
  id: string;
  name?: string;
  skipSkill?: boolean;
  skipSpec?: boolean;
  skipUi?: boolean;
};

/** Return shape for `apps.scaffold`. */
export type AppsScaffoldReturn = {
  command: string;
  description: string;
  dryRun: boolean;
  files: Array<{
    action: "planned" | "created" | "overwritten";
    kind: "manifest" | "spec" | "skill";
    path: string;
  }>;
  force: boolean;
  id: string;
  manifest: Record<string, unknown>;
  manifestPath: string;
  name: string;
  nextCommands: string[];
  skill: string | null;
  skillPath: string | null;
  specPath: string | null;
};

/** Input shape for `apps.show`. */
export type AppsShowInput = {
  id: string;
};

/** Return shape for `apps.show`. */
export type AppsShowReturn = {
  app: {
    description: string | null;
    errors: string[];
    id: string;
    interfaceNames: string[];
    manifest: unknown | null;
    name: string | null;
    path: string;
    permissions: {
      mutating: string[];
      optional: string[];
      provider: ({
        cacheTtlSec?: number;
        decisionSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        failClosed: true;
        id: string;
        interface: "builtin" | "cli" | "sdk" | "tool";
        operation: string;
        requestSchema: {
          kind: "ref" | "inline" | "unknown";
          ref: string | null;
          schema: string | null;
          type: string | null;
        };
        scope?: string[];
        timeoutMs?: number;
        version: string;
      }) | null;
      required: string[];
    };
    relativePath: string;
    rootPath: string;
    schema: string | null;
    source: "repo" | "plugin" | "state";
    valid: boolean;
    version: string | null;
    warnings: string[];
  };
};

/** Input shape for `artifacts.archive`. */
export type ArtifactsArchiveInput = {
  id: string;
};

/** Return shape for `artifacts.archive`. */
export type ArtifactsArchiveReturn = {
  success: true;
  [k: string]: unknown;
};

/** Input shape for `artifacts.attach`. */
export type ArtifactsAttachInput = {
  id: string;
  metadata?: string;
  relation?: string;
  targetId: string;
  targetType: string;
};

/** Return shape for `artifacts.attach`. */
export type ArtifactsAttachReturn = {
  success: true;
  [k: string]: unknown;
};

/** Input shape for `artifacts.blob`. */
export type ArtifactsBlobInput = {
  id: string;
};

/** Return shape for `artifacts.blob`. (binary — raw HTTP Response) */
export type ArtifactsBlobReturn = Response;

/** Input shape for `artifacts.create`. */
export type ArtifactsCreateInput = {
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
};

/** Return shape for `artifacts.create`. */
export type ArtifactsCreateReturn = {
  artifact: Record<string, unknown>;
  package?: Record<string, unknown>;
  success: true;
  version?: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `artifacts.event`. */
export type ArtifactsEventInput = {
  eventType: string;
  id: string;
  message?: string;
  payload?: string;
  source?: string;
  status?: string;
};

/** Return shape for `artifacts.event`. */
export type ArtifactsEventReturn = {
  artifact?: Record<string, unknown>;
  event: Record<string, unknown>;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `artifacts.events`. */
export type ArtifactsEventsInput = {
  id: string;
};

/** Return shape for `artifacts.events`. */
export type ArtifactsEventsReturn = {
  artifactId: string;
  events: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `artifacts.list`. */
export type ArtifactsListInput = {
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
};

/** Return shape for `artifacts.list`. */
export type ArtifactsListReturn = ({
  artifacts: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
}) | ({
  generatedAt: number;
  items: Array<Record<string, unknown>>;
  ok: true;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  query: Record<string, unknown>;
  stats: Record<string, unknown>;
  [k: string]: unknown;
});

/** Input shape for `artifacts.publish`. */
export type ArtifactsPublishInput = {
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
  target: string;
  uploadSession?: string;
  visibility?: string;
};

/** Return shape for `artifacts.publish`. */
export type ArtifactsPublishReturn = {
  artifact: unknown;
  artifactVersion: unknown;
  localSync?: Record<string, unknown>;
  publish: unknown;
  release: unknown;
  routes: unknown[];
  upload: Record<string, unknown>;
  url: string | null;
  [k: string]: unknown;
};

/** Input shape for `artifacts.release.activate`. */
export type ArtifactsReleaseActivateInput = {
  console?: string;
  id: string;
  release?: string;
  site?: string;
  version?: string;
};

/** Return shape for `artifacts.release.activate`. */
export type ArtifactsReleaseActivateReturn = {
  localSync?: Record<string, unknown>;
  release: unknown;
  routes: unknown[];
  site: unknown;
  url: string | null;
  [k: string]: unknown;
};

/** Input shape for `artifacts.restore`. */
export type ArtifactsRestoreInput = {
  id: string;
  message?: string;
  version?: string;
};

/** Return shape for `artifacts.restore`. */
export type ArtifactsRestoreReturn = {
  artifact: Record<string, unknown>;
  restoreVersion: Record<string, unknown>;
  restoredFrom: Record<string, unknown>;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `artifacts.show`. */
export type ArtifactsShowInput = {
  id: string;
};

/** Return shape for `artifacts.show`. */
export type ArtifactsShowReturn = {
  artifact: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `artifacts.snapshot`. */
export type ArtifactsSnapshotInput = {
  id: string;
  label?: string;
  manifest?: string;
  message?: string;
  metadata?: string;
  source?: string;
  status?: string;
};

/** Return shape for `artifacts.snapshot`. */
export type ArtifactsSnapshotReturn = {
  success: true;
  version: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `artifacts.update`. */
export type ArtifactsUpdateInput = {
  command?: string;
  costUsd?: string;
  durationMs?: string;
  id: string;
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
};

/** Return shape for `artifacts.update`. */
export type ArtifactsUpdateReturn = {
  success: true;
  [k: string]: unknown;
};

/** Input shape for `artifacts.version`. */
export type ArtifactsVersionInput = {
  id: string;
  version?: string;
};

/** Return shape for `artifacts.version`. */
export type ArtifactsVersionReturn = {
  artifactId: string;
  version: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `artifacts.versions`. */
export type ArtifactsVersionsInput = {
  id: string;
};

/** Return shape for `artifacts.versions`. */
export type ArtifactsVersionsReturn = {
  artifactId: string;
  total: number;
  versions: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `audio.blob`. */
export type AudioBlobInput = {
  id: string;
};

/** Return shape for `audio.blob`. (binary — raw HTTP Response) */
export type AudioBlobReturn = Response;

/** Input shape for `audio.generate`. */
export type AudioGenerateInput = {
  caption?: string;
  format?: string;
  lang?: string;
  model?: string;
  output?: string;
  send?: boolean;
  speed?: string;
  text: string;
  voice?: string;
};

/** Return shape for `audio.generate`. */
export type AudioGenerateReturn = {
  audio: {
    filePath: string;
    mimeType: string;
    sendCommand: string;
    text: string;
    [k: string]: unknown;
  };
  options: Record<string, unknown>;
  sent?: {
    accountId: string;
    caption: string;
    channel?: string;
    chatId: string;
    filename: string;
    instanceId: string;
    messageId?: string;
    status?: string;
    threadId?: string;
    transport: string;
    voiceNote: true;
    [k: string]: unknown;
  };
  success: true;
  [k: string]: unknown;
};

/** Input shape for `audio.pending`. */
export type AudioPendingInput = {
  agent?: string;
  chat?: string;
  clientId?: string;
  id?: string;
  includeFailed?: boolean;
  limit?: string;
  requestId?: string;
  session?: string;
  sessionKey?: string;
  since?: string;
};

/** Return shape for `audio.pending`. */
export type AudioPendingReturn = {
  generatedAt: number;
  items: Array<{
    agentId?: string;
    audio?: {
      filePath: string;
      filename: string;
      id: string;
      mimeType: string;
      modelId: string;
      outputFormat: string;
      provider: "elevenlabs";
      sizeBytes: number;
      voiceId: string;
    };
    createdAt: number;
    emitId?: string;
    error?: string;
    failedAt?: number;
    id: string;
    metadata?: Record<string, unknown>;
    playback: {
      autoplay: boolean;
      clientId?: string;
      target: "extension" | "channel" | "none";
    };
    readyAt?: number;
    requestId: string;
    sessionKey?: string;
    sessionName?: string;
    status: "ready" | "failed";
    target?: {
      accountId?: string;
      canonicalChatId?: string;
      channel?: string;
      chatId?: string;
      instanceId?: string;
      threadId?: string;
    };
    text: string;
    textPreview: string;
    voice: {
      elevenlabs?: {
        applyLanguageTextNormalization?: boolean;
        applyTextNormalization?: "auto" | "on" | "off";
        enableLogging?: boolean;
        nextRequestIds?: string[];
        nextText?: string;
        optimizeStreamingLatency?: number;
        previousRequestIds?: string[];
        previousText?: string;
        pronunciationDictionaryLocators?: unknown[];
        seed?: number;
        usePvcAsIvc?: boolean;
      };
      lang: string;
      modelId: string;
      outputFormat: string;
      provider: "elevenlabs";
      voiceId?: string;
      voiceSettings?: {
        similarityBoost?: number;
        speed?: number;
        stability?: number;
        style?: number;
        useSpeakerBoost?: boolean;
      };
    };
  }>;
  ok: true;
};

/** Input shape for `audio.tts`. */
export type AudioTtsInput = {
  account?: string;
  agent?: string;
  channel?: string;
  chat?: string;
  clientId?: string;
  elevenlabs?: string;
  format?: string;
  id?: string;
  lang?: string;
  model?: string;
  noAutoplay?: boolean;
  session?: string;
  sessionKey?: string;
  speed?: string;
  text: string;
  voice?: string;
  voiceSettings?: string;
};

/** Return shape for `audio.tts`. */
export type AudioTtsReturn = {
  ok: true;
  request: {
    agentId?: string;
    createdAt?: number;
    emitId?: string;
    id?: string;
    metadata?: Record<string, unknown>;
    playback?: {
      autoplay: boolean;
      clientId?: string;
      target: "extension" | "channel" | "none";
    };
    requestId?: string;
    sessionKey?: string;
    sessionName?: string;
    source?: Record<string, unknown>;
    target?: {
      accountId?: string;
      canonicalChatId?: string;
      channel?: string;
      chatId?: string;
      instanceId?: string;
      threadId?: string;
    };
    text: string;
    voice?: {
      elevenlabs?: {
        applyLanguageTextNormalization?: boolean;
        applyTextNormalization?: "auto" | "on" | "off";
        enableLogging?: boolean;
        nextRequestIds?: string[];
        nextText?: string;
        optimizeStreamingLatency?: number;
        previousRequestIds?: string[];
        previousText?: string;
        pronunciationDictionaryLocators?: unknown[];
        seed?: number;
        usePvcAsIvc?: boolean;
      };
      lang: string;
      modelId: string;
      outputFormat: string;
      provider: "elevenlabs";
      voiceId?: string;
      voiceSettings?: {
        similarityBoost?: number;
        speed?: number;
        stability?: number;
        style?: number;
        useSpeakerBoost?: boolean;
      };
    };
  };
  topic: "ravi.tts";
};

/** Input shape for `audio.voices`. */
export type AudioVoicesInput = {
  category?: string;
  limit?: string;
  search?: string;
  voiceType?: string;
};

/** Return shape for `audio.voices`. */
export type AudioVoicesReturn = {
  generatedAt: number;
  hasMore: boolean;
  nextPageToken?: string;
  ok: true;
  provider: "elevenlabs";
  totalCount?: number;
  voices: Array<{
    category?: string;
    description?: string;
    highQualityBaseModelIds?: string[];
    isLegacy?: boolean;
    isOwner?: boolean;
    labels?: Record<string, string>;
    name: string;
    previewUrl?: string;
    verifiedLanguages?: Array<{
      accent?: string;
      language?: string;
      locale?: string;
      previewUrl?: string;
    }>;
    voiceId: string;
  }>;
};

/** Input shape for `bridges.create`. */
export type BridgesCreateInput = {
  allow?: string;
  console?: string;
  description?: string;
  name?: string;
  project?: string;
  session?: string;
};

/** Return shape for `bridges.create`. */
export type BridgesCreateReturn = {
  bridge: Record<string, unknown>;
  bridgeToken: string | null;
  bridgeUrl: string | null;
  consoleUrl: string;
  projectRef: string;
  success: true;
};

/** Input shape for `bridges.list`. */
export type BridgesListInput = {
  console?: string;
  limit?: string;
  offset?: string;
  project?: string;
};

/** Return shape for `bridges.list`. */
export type BridgesListReturn = {
  bridges: Array<Record<string, unknown>>;
  consoleUrl: string;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  projectRef: string;
  success: true;
  total: number;
};

/** Input shape for `bridges.revoke`. */
export type BridgesRevokeInput = {
  console?: string;
  id: string;
  yes?: boolean;
};

/** Return shape for `bridges.revoke`. */
export type BridgesRevokeReturn = {
  bridgeId: string;
  consoleUrl: string;
  revoked: boolean;
  success: true;
};

/** Input shape for `calendar.accounts.create`. */
export type CalendarAccountsCreateInput = {
  credentialsRef?: string;
  id?: string;
  name?: string;
  provider?: string;
};

/** Return shape for `calendar.accounts.create`. */
export type CalendarAccountsCreateReturn = {
  account: {
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultCalendarId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  };
};

/** Input shape for `calendar.accounts.list`. */
export type CalendarAccountsListInput = {
  limit?: string;
  offset?: string;
  provider?: string;
  status?: string;
};

/** Return shape for `calendar.accounts.list`. */
export type CalendarAccountsListReturn = {
  accounts: Array<{
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultCalendarId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  }>;
};

/** Input shape for `calendar.accounts.sync`. */
export type CalendarAccountsSyncInput = {
  account: string;
  once?: boolean;
};

/** Return shape for `calendar.accounts.sync`. */
export type CalendarAccountsSyncReturn = ({
  account: {
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultCalendarId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  };
  localFirst: true;
  ok: true;
  status: "adapter_not_required";
}) | ({
  account: {
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultCalendarId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  };
  message: string;
  ok: false;
  status: "adapter_not_started";
});

/** Input shape for `calendar.availability`. */
export type CalendarAvailabilityInput = {
  calendar?: string;
  from?: string;
  limit?: string;
  to?: string;
};

/** Return shape for `calendar.availability`. */
export type CalendarAvailabilityReturn = {
  busy: Array<{
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    endAt: number;
    eventId?: string;
    redacted: boolean;
    startAt: number;
    title: string;
  }>;
  window: {
    from: string;
    to: string;
  };
};

/** Input shape for `calendar.calendars.create`. */
export type CalendarCalendarsCreateInput = {
  account?: string;
  color?: string;
  default?: boolean;
  description?: string;
  name?: string;
  owner?: string;
  providerCalendarId?: string;
  role?: string;
  timezone?: string;
  visibility?: string;
};

/** Return shape for `calendar.calendars.create`. */
export type CalendarCalendarsCreateReturn = {
  calendar: {
    accountId: string;
    color: string | null;
    createdAt: number;
    description: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    name: string;
    ownerId: string;
    ownerType: string;
    providerCalendarId: string | null;
    role: string;
    status: "active" | "paused" | "disabled" | "deleted";
    timezone: string | null;
    updatedAt: number;
    visibility: "private" | "shared" | "public" | "local_only";
  };
};

/** Input shape for `calendar.calendars.disable`. */
export type CalendarCalendarsDisableInput = {
  calendar: string;
};

/** Return shape for `calendar.calendars.disable`. */
export type CalendarCalendarsDisableReturn = {
  calendar: {
    accountId: string;
    color: string | null;
    createdAt: number;
    description: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    name: string;
    ownerId: string;
    ownerType: string;
    providerCalendarId: string | null;
    role: string;
    status: "active" | "paused" | "disabled" | "deleted";
    timezone: string | null;
    updatedAt: number;
    visibility: "private" | "shared" | "public" | "local_only";
  };
};

/** Input shape for `calendar.calendars.list`. */
export type CalendarCalendarsListInput = {
  account?: string;
  limit?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `calendar.calendars.list`. */
export type CalendarCalendarsListReturn = {
  calendars: Array<{
    accountId: string;
    color: string | null;
    createdAt: number;
    description: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    name: string;
    ownerId: string;
    ownerType: string;
    providerCalendarId: string | null;
    role: string;
    status: "active" | "paused" | "disabled" | "deleted";
    timezone: string | null;
    updatedAt: number;
    visibility: "private" | "shared" | "public" | "local_only";
  }>;
};

/** Input shape for `calendar.calendars.share`. */
export type CalendarCalendarsShareInput = {
  calendar: string;
  expiresAt?: string;
  relation?: string;
  with?: string;
};

/** Return shape for `calendar.calendars.share`. */
export type CalendarCalendarsShareReturn = {
  calendar: {
    accountId: string;
    color: string | null;
    createdAt: number;
    description: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    name: string;
    ownerId: string;
    ownerType: string;
    providerCalendarId: string | null;
    role: string;
    status: "active" | "paused" | "disabled" | "deleted";
    timezone: string | null;
    updatedAt: number;
    visibility: "private" | "shared" | "public" | "local_only";
  };
  member: {
    calendarId: string;
    createdAt: number;
    expiresAt: number | null;
    id: string;
    memberId: string;
    memberType: string;
    relation: "owner" | "reader" | "writer" | "manager" | "free_busy";
    updatedAt: number;
  };
};

/** Input shape for `calendar.calendars.show`. */
export type CalendarCalendarsShowInput = {
  calendar: string;
  members?: boolean;
};

/** Return shape for `calendar.calendars.show`. */
export type CalendarCalendarsShowReturn = {
  calendar: {
    accountId: string;
    color: string | null;
    createdAt: number;
    description: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    name: string;
    ownerId: string;
    ownerType: string;
    providerCalendarId: string | null;
    role: string;
    status: "active" | "paused" | "disabled" | "deleted";
    timezone: string | null;
    updatedAt: number;
    visibility: "private" | "shared" | "public" | "local_only";
  };
  members?: Array<{
    calendarId: string;
    createdAt: number;
    expiresAt: number | null;
    id: string;
    memberId: string;
    memberType: string;
    relation: "owner" | "reader" | "writer" | "manager" | "free_busy";
    updatedAt: number;
  }>;
};

/** Input shape for `calendar.events.cancel`. */
export type CalendarEventsCancelInput = {
  event: string;
  idempotencyKey?: string;
};

/** Return shape for `calendar.events.cancel`. */
export type CalendarEventsCancelReturn = {
  event: ({
    accountId: string;
    allDay: boolean;
    attendees: Array<{
      agentId: string | null;
      contactId: string | null;
      createdAt: number;
      displayName: string | null;
      email: string | null;
      eventId: string;
      id: string;
      kind: "organizer" | "required" | "optional" | "resource" | "informational";
      normalizedEmail: string | null;
      platformIdentityId: string | null;
      providerAttendeeId: string | null;
      raw: Record<string, unknown>;
      responseStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
      updatedAt: number;
    }>;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    createdAt: number;
    creatorAgentId: string | null;
    creatorContactId: string | null;
    creatorPlatformIdentityId: string | null;
    deletedAt: number | null;
    description: string | null;
    descriptionRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    endAt: number;
    endTimezone: string | null;
    etag: string | null;
    icalUid: string | null;
    id: string;
    location: string | null;
    locationRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    organizerAgentId: string | null;
    organizerContactId: string | null;
    organizerPlatformIdentityId: string | null;
    originalStartAt: number | null;
    providerEventId: string | null;
    providerProvenance: Record<string, unknown>;
    providerRecurringEventId: string | null;
    recurrence: Record<string, unknown>;
    recurrenceRule: string | null;
    safePayload: Record<string, unknown>;
    sequence: number;
    seriesId: string | null;
    startAt: number;
    startTimezone: string | null;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: string;
    uid: string;
    updatedAt: number;
    visibility: "default" | "private" | "public" | "confidential";
  }) | ({
    accountId: string;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    endAt: number;
    id: string;
    redacted: true;
    startAt: number;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: "Busy";
  });
  outbox: ({
    accountId: string;
    attemptCount: number;
    calendarId: string;
    createdAt: number;
    eventId: string;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    nextAttemptAt: number;
    operation: "create" | "update" | "cancel" | "delete" | "respond";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  }) | null;
};

/** Input shape for `calendar.events.create`. */
export type CalendarEventsCreateInput = {
  attendee?: string;
  calendar?: string;
  description?: string;
  end?: string;
  idempotencyKey?: string;
  location?: string;
  start?: string;
  timezone?: string;
  title?: string;
};

/** Return shape for `calendar.events.create`. */
export type CalendarEventsCreateReturn = {
  event: ({
    accountId: string;
    allDay: boolean;
    attendees: Array<{
      agentId: string | null;
      contactId: string | null;
      createdAt: number;
      displayName: string | null;
      email: string | null;
      eventId: string;
      id: string;
      kind: "organizer" | "required" | "optional" | "resource" | "informational";
      normalizedEmail: string | null;
      platformIdentityId: string | null;
      providerAttendeeId: string | null;
      raw: Record<string, unknown>;
      responseStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
      updatedAt: number;
    }>;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    createdAt: number;
    creatorAgentId: string | null;
    creatorContactId: string | null;
    creatorPlatformIdentityId: string | null;
    deletedAt: number | null;
    description: string | null;
    descriptionRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    endAt: number;
    endTimezone: string | null;
    etag: string | null;
    icalUid: string | null;
    id: string;
    location: string | null;
    locationRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    organizerAgentId: string | null;
    organizerContactId: string | null;
    organizerPlatformIdentityId: string | null;
    originalStartAt: number | null;
    providerEventId: string | null;
    providerProvenance: Record<string, unknown>;
    providerRecurringEventId: string | null;
    recurrence: Record<string, unknown>;
    recurrenceRule: string | null;
    safePayload: Record<string, unknown>;
    sequence: number;
    seriesId: string | null;
    startAt: number;
    startTimezone: string | null;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: string;
    uid: string;
    updatedAt: number;
    visibility: "default" | "private" | "public" | "confidential";
  }) | ({
    accountId: string;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    endAt: number;
    id: string;
    redacted: true;
    startAt: number;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: "Busy";
  });
  outbox: ({
    accountId: string;
    attemptCount: number;
    calendarId: string;
    createdAt: number;
    eventId: string;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    nextAttemptAt: number;
    operation: "create" | "update" | "cancel" | "delete" | "respond";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  }) | null;
};

/** Input shape for `calendar.events.list`. */
export type CalendarEventsListInput = {
  calendar?: string;
  from?: string;
  includeCancelled?: boolean;
  limit?: string;
  offset?: string;
  query?: string;
  status?: string;
  to?: string;
};

/** Return shape for `calendar.events.list`. */
export type CalendarEventsListReturn = {
  events: Array<({
    accountId: string;
    allDay: boolean;
    attendees: Array<{
      agentId: string | null;
      contactId: string | null;
      createdAt: number;
      displayName: string | null;
      email: string | null;
      eventId: string;
      id: string;
      kind: "organizer" | "required" | "optional" | "resource" | "informational";
      normalizedEmail: string | null;
      platformIdentityId: string | null;
      providerAttendeeId: string | null;
      raw: Record<string, unknown>;
      responseStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
      updatedAt: number;
    }>;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    createdAt: number;
    creatorAgentId: string | null;
    creatorContactId: string | null;
    creatorPlatformIdentityId: string | null;
    deletedAt: number | null;
    description: string | null;
    descriptionRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    endAt: number;
    endTimezone: string | null;
    etag: string | null;
    icalUid: string | null;
    id: string;
    location: string | null;
    locationRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    organizerAgentId: string | null;
    organizerContactId: string | null;
    organizerPlatformIdentityId: string | null;
    originalStartAt: number | null;
    providerEventId: string | null;
    providerProvenance: Record<string, unknown>;
    providerRecurringEventId: string | null;
    recurrence: Record<string, unknown>;
    recurrenceRule: string | null;
    safePayload: Record<string, unknown>;
    sequence: number;
    seriesId: string | null;
    startAt: number;
    startTimezone: string | null;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: string;
    uid: string;
    updatedAt: number;
    visibility: "default" | "private" | "public" | "confidential";
  }) | ({
    accountId: string;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    endAt: number;
    id: string;
    redacted: true;
    startAt: number;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: "Busy";
  })>;
  window: {
    from: string;
    to: string;
  };
};

/** Input shape for `calendar.events.read`. */
export type CalendarEventsReadInput = {
  event: string;
};

/** Return shape for `calendar.events.read`. */
export type CalendarEventsReadReturn = {
  event: ({
    accountId: string;
    allDay: boolean;
    attendees: Array<{
      agentId: string | null;
      contactId: string | null;
      createdAt: number;
      displayName: string | null;
      email: string | null;
      eventId: string;
      id: string;
      kind: "organizer" | "required" | "optional" | "resource" | "informational";
      normalizedEmail: string | null;
      platformIdentityId: string | null;
      providerAttendeeId: string | null;
      raw: Record<string, unknown>;
      responseStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
      updatedAt: number;
    }>;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    createdAt: number;
    creatorAgentId: string | null;
    creatorContactId: string | null;
    creatorPlatformIdentityId: string | null;
    deletedAt: number | null;
    description: string | null;
    descriptionRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    endAt: number;
    endTimezone: string | null;
    etag: string | null;
    icalUid: string | null;
    id: string;
    location: string | null;
    locationRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    organizerAgentId: string | null;
    organizerContactId: string | null;
    organizerPlatformIdentityId: string | null;
    originalStartAt: number | null;
    providerEventId: string | null;
    providerProvenance: Record<string, unknown>;
    providerRecurringEventId: string | null;
    recurrence: Record<string, unknown>;
    recurrenceRule: string | null;
    safePayload: Record<string, unknown>;
    sequence: number;
    seriesId: string | null;
    startAt: number;
    startTimezone: string | null;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: string;
    uid: string;
    updatedAt: number;
    visibility: "default" | "private" | "public" | "confidential";
  }) | ({
    accountId: string;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    endAt: number;
    id: string;
    redacted: true;
    startAt: number;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: "Busy";
  });
};

/** Input shape for `calendar.events.respond`. */
export type CalendarEventsRespondInput = {
  attendeeAgent?: string;
  attendeeEmail?: string;
  event: string;
  idempotencyKey?: string;
  status?: string;
};

/** Return shape for `calendar.events.respond`. */
export type CalendarEventsRespondReturn = {
  event: ({
    accountId: string;
    allDay: boolean;
    attendees: Array<{
      agentId: string | null;
      contactId: string | null;
      createdAt: number;
      displayName: string | null;
      email: string | null;
      eventId: string;
      id: string;
      kind: "organizer" | "required" | "optional" | "resource" | "informational";
      normalizedEmail: string | null;
      platformIdentityId: string | null;
      providerAttendeeId: string | null;
      raw: Record<string, unknown>;
      responseStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
      updatedAt: number;
    }>;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    createdAt: number;
    creatorAgentId: string | null;
    creatorContactId: string | null;
    creatorPlatformIdentityId: string | null;
    deletedAt: number | null;
    description: string | null;
    descriptionRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    endAt: number;
    endTimezone: string | null;
    etag: string | null;
    icalUid: string | null;
    id: string;
    location: string | null;
    locationRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    organizerAgentId: string | null;
    organizerContactId: string | null;
    organizerPlatformIdentityId: string | null;
    originalStartAt: number | null;
    providerEventId: string | null;
    providerProvenance: Record<string, unknown>;
    providerRecurringEventId: string | null;
    recurrence: Record<string, unknown>;
    recurrenceRule: string | null;
    safePayload: Record<string, unknown>;
    sequence: number;
    seriesId: string | null;
    startAt: number;
    startTimezone: string | null;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: string;
    uid: string;
    updatedAt: number;
    visibility: "default" | "private" | "public" | "confidential";
  }) | ({
    accountId: string;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    endAt: number;
    id: string;
    redacted: true;
    startAt: number;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: "Busy";
  });
  outbox: {
    accountId: string;
    attemptCount: number;
    calendarId: string;
    createdAt: number;
    eventId: string;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    nextAttemptAt: number;
    operation: "create" | "update" | "cancel" | "delete" | "respond";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
};

/** Input shape for `calendar.events.update`. */
export type CalendarEventsUpdateInput = {
  busy?: string;
  description?: string;
  end?: string;
  event: string;
  idempotencyKey?: string;
  location?: string;
  start?: string;
  status?: string;
  title?: string;
  visibility?: string;
};

/** Return shape for `calendar.events.update`. */
export type CalendarEventsUpdateReturn = {
  event: ({
    accountId: string;
    allDay: boolean;
    attendees: Array<{
      agentId: string | null;
      contactId: string | null;
      createdAt: number;
      displayName: string | null;
      email: string | null;
      eventId: string;
      id: string;
      kind: "organizer" | "required" | "optional" | "resource" | "informational";
      normalizedEmail: string | null;
      platformIdentityId: string | null;
      providerAttendeeId: string | null;
      raw: Record<string, unknown>;
      responseStatus: "accepted" | "declined" | "tentative" | "needs_action" | "unknown";
      updatedAt: number;
    }>;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    createdAt: number;
    creatorAgentId: string | null;
    creatorContactId: string | null;
    creatorPlatformIdentityId: string | null;
    deletedAt: number | null;
    description: string | null;
    descriptionRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    endAt: number;
    endTimezone: string | null;
    etag: string | null;
    icalUid: string | null;
    id: string;
    location: string | null;
    locationRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    organizerAgentId: string | null;
    organizerContactId: string | null;
    organizerPlatformIdentityId: string | null;
    originalStartAt: number | null;
    providerEventId: string | null;
    providerProvenance: Record<string, unknown>;
    providerRecurringEventId: string | null;
    recurrence: Record<string, unknown>;
    recurrenceRule: string | null;
    safePayload: Record<string, unknown>;
    sequence: number;
    seriesId: string | null;
    startAt: number;
    startTimezone: string | null;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: string;
    uid: string;
    updatedAt: number;
    visibility: "default" | "private" | "public" | "confidential";
  }) | ({
    accountId: string;
    busyStatus: "busy" | "free" | "tentative" | "out_of_office" | "unknown";
    calendarId: string;
    endAt: number;
    id: string;
    redacted: true;
    startAt: number;
    status: "confirmed" | "tentative" | "cancelled" | "draft" | "unknown";
    title: "Busy";
  });
  outbox: ({
    accountId: string;
    attemptCount: number;
    calendarId: string;
    createdAt: number;
    eventId: string;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    nextAttemptAt: number;
    operation: "create" | "update" | "cancel" | "delete" | "respond";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  }) | null;
};

/** Input shape for `calendar.outbox.inspect`. */
export type CalendarOutboxInspectInput = {
  outbox: string;
};

/** Return shape for `calendar.outbox.inspect`. */
export type CalendarOutboxInspectReturn = {
  outbox: {
    accountId: string;
    attemptCount: number;
    calendarId: string;
    createdAt: number;
    eventId: string;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    nextAttemptAt: number;
    operation: "create" | "update" | "cancel" | "delete" | "respond";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
};

/** Input shape for `calendar.outbox.list`. */
export type CalendarOutboxListInput = {
  calendar?: string;
  limit?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `calendar.outbox.list`. */
export type CalendarOutboxListReturn = {
  outbox: Array<{
    accountId: string;
    attemptCount: number;
    calendarId: string;
    createdAt: number;
    eventId: string;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    nextAttemptAt: number;
    operation: "create" | "update" | "cancel" | "delete" | "respond";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  }>;
};

/** Input shape for `calendar.outbox.retry`. */
export type CalendarOutboxRetryInput = {
  outbox: string;
};

/** Return shape for `calendar.outbox.retry`. */
export type CalendarOutboxRetryReturn = {
  outbox: {
    accountId: string;
    attemptCount: number;
    calendarId: string;
    createdAt: number;
    eventId: string;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    nextAttemptAt: number;
    operation: "create" | "update" | "cancel" | "delete" | "respond";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
};

/** Input shape for `calendar.outbox.status`. */
export type CalendarOutboxStatusInput = Record<string, never>;

/** Return shape for `calendar.outbox.status`. */
export type CalendarOutboxStatusReturn = {
  counts: Record<string, number>;
  total: number;
};

/** Input shape for `chats.backfill-provider-timestamps`. */
export type ChatsBackfillProviderTimestampsInput = {
  apply?: boolean;
  dryRun?: boolean;
  limit?: string;
};

/** Return shape for `chats.backfill-provider-timestamps`. */
export type ChatsBackfillProviderTimestampsReturn = Record<string, unknown>;

/** Input shape for `chats.list`. */
export type ChatsListInput = {
  agent?: string;
  channel?: string;
  contact?: string;
  includeRaw?: boolean;
  instance?: string;
  limit?: string;
  offset?: string;
  query?: string;
  type?: string;
};

/** Return shape for `chats.list`. */
export type ChatsListReturn = Record<string, unknown>;

/** Input shape for `chats.lists.add`. */
export type ChatsListsAddInput = {
  channel?: string;
  chat: string;
  includeRaw?: boolean;
  instance?: string;
  list: string;
  owner?: string;
  priority?: string;
  reason?: string;
};

/** Return shape for `chats.lists.add`. */
export type ChatsListsAddReturn = Record<string, unknown>;

/** Input shape for `chats.lists.create`. */
export type ChatsListsCreateInput = {
  description?: string;
  mode?: string;
  name: string;
  owner?: string;
  visibility?: string;
};

/** Return shape for `chats.lists.create`. */
export type ChatsListsCreateReturn = Record<string, unknown>;

/** Input shape for `chats.lists.delta`. */
export type ChatsListsDeltaInput = {
  channel?: string;
  chat: string;
  includeRaw?: boolean;
  instance?: string;
  limit?: string;
  list: string;
  markRead?: boolean;
  owner?: string;
  reader?: string;
};

/** Return shape for `chats.lists.delta`. */
export type ChatsListsDeltaReturn = Record<string, unknown>;

/** Input shape for `chats.lists.list`. */
export type ChatsListsListInput = {
  includeArchived?: boolean;
  limit?: string;
  offset?: string;
  owner?: string;
};

/** Return shape for `chats.lists.list`. */
export type ChatsListsListReturn = Record<string, unknown>;

/** Input shape for `chats.lists.mark-read`. */
export type ChatsListsMarkReadInput = {
  channel?: string;
  chat: string;
  includeRaw?: boolean;
  instance?: string;
  list: string;
  message?: string;
  owner?: string;
  reader?: string;
  reason?: string;
};

/** Return shape for `chats.lists.mark-read`. */
export type ChatsListsMarkReadReturn = Record<string, unknown>;

/** Input shape for `chats.lists.members`. */
export type ChatsListsMembersInput = {
  includeRaw?: boolean;
  limit?: string;
  list: string;
  offset?: string;
  owner?: string;
  reader?: string;
};

/** Return shape for `chats.lists.members`. */
export type ChatsListsMembersReturn = Record<string, unknown>;

/** Input shape for `chats.lists.recompute`. */
export type ChatsListsRecomputeInput = {
  list: string;
  owner?: string;
};

/** Return shape for `chats.lists.recompute`. */
export type ChatsListsRecomputeReturn = {
  list: {
    archivedAt?: number;
    createdAt: number;
    description?: string;
    id: string;
    metadata?: Record<string, unknown>;
    mode: string;
    name: string;
    ownerId: string;
    ownerType: string;
    selector?: Record<string, unknown>;
    updatedAt: number;
    visibility: string;
  };
  recompute: {
    added: number;
    addedChatIds: string[];
    eligible: number;
    eligibleChatIds: string[];
    kept: number;
    keptChatIds: string[];
    list: {
      archivedAt?: number;
      createdAt: number;
      description?: string;
      id: string;
      metadata?: Record<string, unknown>;
      mode: string;
      name: string;
      ownerId: string;
      ownerType: string;
      selector?: Record<string, unknown>;
      updatedAt: number;
      visibility: string;
    };
    preserved: number;
    preservedChatIds: string[];
    removed: number;
    removedChatIds: string[];
    selector: Record<string, unknown>;
  };
};

/** Input shape for `chats.lists.remove`. */
export type ChatsListsRemoveInput = {
  channel?: string;
  chat: string;
  instance?: string;
  list: string;
  owner?: string;
};

/** Return shape for `chats.lists.remove`. */
export type ChatsListsRemoveReturn = Record<string, unknown>;

/** Input shape for `chats.read`. */
export type ChatsReadInput = {
  channel?: string;
  chat: string;
  includeRaw?: boolean;
  instance?: string;
  limit?: string;
  offset?: string;
  order?: string;
  type?: string;
};

/** Return shape for `chats.read`. */
export type ChatsReadReturn = Record<string, unknown>;

/** Input shape for `cloud.projects.create`. */
export type CloudProjectsCreateInput = {
  console?: string;
  defaultPageSite?: string;
  description?: string;
  name?: string;
  slug: string;
  visibility?: string;
};

/** Return shape for `cloud.projects.create`. */
export type CloudProjectsCreateReturn = {
  consoleUrl: string;
  project: Record<string, unknown>;
  redirectTo: string | null;
  success: true;
};

/** Input shape for `cloud.projects.list`. */
export type CloudProjectsListInput = {
  console?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `cloud.projects.list`. */
export type CloudProjectsListReturn = {
  consoleUrl: string;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  projects: Array<Record<string, unknown>>;
  success: true;
  total: number;
};

/** Input shape for `commands.list`. */
export type CommandsListInput = {
  agent?: string;
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `commands.list`. */
export type CommandsListReturn = {
  agent: Record<string, unknown>;
  commands: Array<{
    argumentHint: string | null;
    arguments: unknown[];
    description: string | null;
    disabled: boolean;
    id: string;
    issues: Array<{
      code: string;
      id: string | null;
      level: string;
      message: string;
      path: string | null;
      scope: string | null;
      [k: string]: unknown;
    }>;
    path: string;
    relativePath: string;
    scope: string;
    shadowedBy: string | null;
    shadows: string[];
    title: string | null;
    token: string;
    [k: string]: unknown;
  }>;
  issues: Array<{
    code: string;
    id: string | null;
    level: string;
    message: string;
    path: string | null;
    scope: string | null;
    [k: string]: unknown;
  }>;
  items: Array<Record<string, unknown>>;
  locations: Record<string, unknown>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `commands.run`. */
export type CommandsRunInput = {
  agent?: string;
  args?: string[];
  name: string;
};

/** Return shape for `commands.run`. */
export type CommandsRunReturn = {
  agent: Record<string, unknown>;
  command: {
    argumentHint: string | null;
    arguments: unknown[];
    description: string | null;
    disabled: boolean;
    id: string;
    issues: Array<{
      code: string;
      id: string | null;
      level: string;
      message: string;
      path: string | null;
      scope: string | null;
      [k: string]: unknown;
    }>;
    path: string;
    relativePath: string;
    scope: string;
    shadowedBy: string | null;
    shadows: string[];
    title: string | null;
    token: string;
    [k: string]: unknown;
  };
  metadata: Record<string, unknown>;
  positionalArguments: unknown[];
  prompt: string;
  [k: string]: unknown;
};

/** Input shape for `commands.show`. */
export type CommandsShowInput = {
  agent?: string;
  name: string;
};

/** Return shape for `commands.show`. */
export type CommandsShowReturn = {
  agent: Record<string, unknown>;
  command: {
    argumentHint: string | null;
    arguments: unknown[];
    description: string | null;
    disabled: boolean;
    id: string;
    issues: Array<{
      code: string;
      id: string | null;
      level: string;
      message: string;
      path: string | null;
      scope: string | null;
      [k: string]: unknown;
    }>;
    path: string;
    relativePath: string;
    scope: string;
    shadowedBy: string | null;
    shadows: string[];
    title: string | null;
    token: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `commands.validate`. */
export type CommandsValidateInput = {
  agent?: string;
};

/** Return shape for `commands.validate`. */
export type CommandsValidateReturn = {
  agent: Record<string, unknown>;
  effectiveTotal: number;
  errors: Array<{
    code: string;
    id: string | null;
    level: string;
    message: string;
    path: string | null;
    scope: string | null;
    [k: string]: unknown;
  }>;
  total: number;
  valid: boolean;
  warnings: Array<{
    code: string;
    id: string | null;
    level: string;
    message: string;
    path: string | null;
    scope: string | null;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
};

/** Input shape for `connectors.list`. */
export type ConnectorsListInput = {
  limit?: string;
  offset?: string;
  project?: string;
  provider?: string;
};

/** Return shape for `connectors.list`. */
export type ConnectorsListReturn = {
  connections: Array<{
    createdAt: string;
    displayName: string;
    id: string;
    projectId: string;
    provider: string;
    requiresReauth: boolean;
    scopes: string[];
    status: string;
  }>;
  pagination: {
    limit: number;
    offset: number;
    returned: number;
    total: number;
  };
};

/** Input shape for `connectors.revoke`. */
export type ConnectorsRevokeInput = {
  id: string;
  yes?: boolean;
};

/** Return shape for `connectors.revoke`. */
export type ConnectorsRevokeReturn = {
  id: string;
  revoked: true;
};

/** Input shape for `connectors.show`. */
export type ConnectorsShowInput = {
  id: string;
};

/** Return shape for `connectors.show`. */
export type ConnectorsShowReturn = {
  connection: {
    capabilities: string[];
    createdAt: string;
    displayName: string;
    externalAccountLogin: string | null;
    grantedAt: string;
    id: string;
    lastReauthAt: string | null;
    projectId: string;
    provider: string;
    requiresReauth: boolean;
    scopes: string[];
    status: string;
  };
};

/** Input shape for `contacts.activity`. */
export type ContactsActivityInput = {
  contact: string;
  limit?: string;
  offset?: string;
  raw?: boolean;
};

/** Return shape for `contacts.activity`. */
export type ContactsActivityReturn = Record<string, unknown>;

/** Input shape for `contacts.add`. */
export type ContactsAddInput = {
  agent?: string;
  identity: string;
  kind?: string;
  name?: string;
};

/** Return shape for `contacts.add`. */
export type ContactsAddReturn = Record<string, unknown>;

/** Input shape for `contacts.allow`. */
export type ContactsAllowInput = {
  contact: string;
};

/** Return shape for `contacts.allow`. */
export type ContactsAllowReturn = Record<string, unknown>;

/** Input shape for `contacts.approve`. */
export type ContactsApproveInput = {
  agent?: string;
  contact: string;
  mode?: string;
};

/** Return shape for `contacts.approve`. */
export type ContactsApproveReturn = Record<string, unknown>;

/** Input shape for `contacts.backfill`. */
export type ContactsBackfillInput = {
  apply?: boolean;
  channel?: string;
  createList?: string;
  dryRun?: boolean;
  instance?: string;
  limit?: string;
  listOwner?: string;
  mode?: string;
};

/** Return shape for `contacts.backfill`. */
export type ContactsBackfillReturn = Record<string, unknown>;

/** Input shape for `contacts.block`. */
export type ContactsBlockInput = {
  contact: string;
};

/** Return shape for `contacts.block`. */
export type ContactsBlockReturn = Record<string, unknown>;

/** Input shape for `contacts.check`. */
export type ContactsCheckInput = {
  contact: string;
};

/** Return shape for `contacts.check`. */
export type ContactsCheckReturn = Record<string, unknown>;

/** Input shape for `contacts.duplicates`. */
export type ContactsDuplicatesInput = Record<string, never>;

/** Return shape for `contacts.duplicates`. */
export type ContactsDuplicatesReturn = Record<string, unknown>;

/** Input shape for `contacts.find`. */
export type ContactsFindInput = {
  query: string;
  tag?: boolean;
};

/** Return shape for `contacts.find`. */
export type ContactsFindReturn = Record<string, unknown>;

/** Input shape for `contacts.get`. */
export type ContactsGetInput = {
  contact: string;
};

/** Return shape for `contacts.get`. */
export type ContactsGetReturn = Record<string, unknown>;

/** Input shape for `contacts.info`. */
export type ContactsInfoInput = {
  contact: string;
};

/** Return shape for `contacts.info`. */
export type ContactsInfoReturn = Record<string, unknown>;

/** Input shape for `contacts.link`. */
export type ContactsLinkInput = {
  channel?: string;
  contact: string;
  id?: string;
  instance?: string;
  reason?: string;
};

/** Return shape for `contacts.link`. */
export type ContactsLinkReturn = Record<string, unknown>;

/** Input shape for `contacts.list`. */
export type ContactsListInput = {
  limit?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `contacts.list`. */
export type ContactsListReturn = Record<string, unknown>;

/** Input shape for `contacts.merge`. */
export type ContactsMergeInput = {
  source: string;
  target: string;
};

/** Return shape for `contacts.merge`. */
export type ContactsMergeReturn = Record<string, unknown>;

/** Input shape for `contacts.messages`. */
export type ContactsMessagesInput = {
  contact: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `contacts.messages`. */
export type ContactsMessagesReturn = Record<string, unknown>;

/** Input shape for `contacts.metadata.list`. */
export type ContactsMetadataListInput = {
  contact: string;
  limit?: string;
  offset?: string;
  scope?: string;
};

/** Return shape for `contacts.metadata.list`. */
export type ContactsMetadataListReturn = Record<string, unknown>;

/** Input shape for `contacts.metadata.remove`. */
export type ContactsMetadataRemoveInput = {
  contact: string;
  key: string;
  scope?: string;
  source?: string;
};

/** Return shape for `contacts.metadata.remove`. */
export type ContactsMetadataRemoveReturn = Record<string, unknown>;

/** Input shape for `contacts.metadata.set`. */
export type ContactsMetadataSetInput = {
  contact: string;
  key: string;
  scope?: string;
  source?: string;
  value: string;
};

/** Return shape for `contacts.metadata.set`. */
export type ContactsMetadataSetReturn = Record<string, unknown>;

/** Input shape for `contacts.note`. */
export type ContactsNoteInput = {
  contact: string;
  scope?: string;
  source?: string;
  text: string;
};

/** Return shape for `contacts.note`. */
export type ContactsNoteReturn = Record<string, unknown>;

/** Input shape for `contacts.pending`. */
export type ContactsPendingInput = {
  account?: string;
};

/** Return shape for `contacts.pending`. */
export type ContactsPendingReturn = Record<string, unknown>;

/** Input shape for `contacts.profile`. */
export type ContactsProfileInput = {
  contact: string;
  includeCrm?: boolean;
  limit?: string;
};

/** Return shape for `contacts.profile`. */
export type ContactsProfileReturn = Record<string, unknown>;

/** Input shape for `contacts.remove`. */
export type ContactsRemoveInput = {
  contact: string;
};

/** Return shape for `contacts.remove`. */
export type ContactsRemoveReturn = Record<string, unknown>;

/** Input shape for `contacts.sessions`. */
export type ContactsSessionsInput = {
  contact: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `contacts.sessions`. */
export type ContactsSessionsReturn = Record<string, unknown>;

/** Input shape for `contacts.set`. */
export type ContactsSetInput = {
  contact: string;
  key: string;
  value: string;
};

/** Return shape for `contacts.set`. */
export type ContactsSetReturn = Record<string, unknown>;

/** Input shape for `contacts.tag`. */
export type ContactsTagInput = {
  contact: string;
  tag: string;
};

/** Return shape for `contacts.tag`. */
export type ContactsTagReturn = Record<string, unknown>;

/** Input shape for `contacts.timeline`. */
export type ContactsTimelineInput = {
  contact: string;
  event?: string;
  limit?: string;
  offset?: string;
  scope?: string;
};

/** Return shape for `contacts.timeline`. */
export type ContactsTimelineReturn = Record<string, unknown>;

/** Input shape for `contacts.unlink`. */
export type ContactsUnlinkInput = {
  channel?: string;
  instance?: string;
  platformIdentity: string;
  reason?: string;
};

/** Return shape for `contacts.unlink`. */
export type ContactsUnlinkReturn = Record<string, unknown>;

/** Input shape for `contacts.untag`. */
export type ContactsUntagInput = {
  contact: string;
  tag: string;
};

/** Return shape for `contacts.untag`. */
export type ContactsUntagReturn = Record<string, unknown>;

/** Input shape for `context.authorize`. */
export type ContextAuthorizeInput = {
  objectId: string;
  objectType: string;
  permission: string;
};

/** Return shape for `context.authorize`. */
export type ContextAuthorizeReturn = Record<string, unknown>;

/** Input shape for `context.capabilities`. */
export type ContextCapabilitiesInput = Record<string, never>;

/** Return shape for `context.capabilities`. */
export type ContextCapabilitiesReturn = Record<string, unknown>;

/** Input shape for `context.check`. */
export type ContextCheckInput = {
  objectId: string;
  objectType: string;
  permission: string;
};

/** Return shape for `context.check`. */
export type ContextCheckReturn = Record<string, unknown>;

/** Input shape for `context.cleanup-agent-runtime`. */
export type ContextCleanupAgentRuntimeInput = {
  agent?: string;
  olderThan?: string;
  reason?: string;
  revoke?: boolean;
  session?: string;
};

/** Return shape for `context.cleanup-agent-runtime`. */
export type ContextCleanupAgentRuntimeReturn = Record<string, unknown>;

/** Input shape for `context.codex-bash-hook`. */
export type ContextCodexBashHookInput = Record<string, never>;

/** Return shape for `context.codex-bash-hook`. */
export type ContextCodexBashHookReturn = Record<string, unknown>;

/** Input shape for `context.credentials.add`. */
export type ContextCredentialsAddInput = {
  contextKey: string;
  label?: string;
  setDefault?: boolean;
};

/** Return shape for `context.credentials.add`. */
export type ContextCredentialsAddReturn = Record<string, unknown>;

/** Input shape for `context.credentials.list`. */
export type ContextCredentialsListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `context.credentials.list`. */
export type ContextCredentialsListReturn = Record<string, unknown>;

/** Input shape for `context.credentials.remove`. */
export type ContextCredentialsRemoveInput = {
  contextKey: string;
};

/** Return shape for `context.credentials.remove`. */
export type ContextCredentialsRemoveReturn = Record<string, unknown>;

/** Input shape for `context.credentials.set-default`. */
export type ContextCredentialsSetDefaultInput = {
  contextKey: string;
};

/** Return shape for `context.credentials.set-default`. */
export type ContextCredentialsSetDefaultReturn = Record<string, unknown>;

/** Input shape for `context.info`. */
export type ContextInfoInput = {
  contextId: string;
};

/** Return shape for `context.info`. */
export type ContextInfoReturn = Record<string, unknown>;

/** Input shape for `context.issue`. */
export type ContextIssueInput = {
  allow?: string;
  cliName: string;
  inherit?: boolean;
  ttl?: string;
};

/** Return shape for `context.issue`. */
export type ContextIssueReturn = Record<string, unknown>;

/** Input shape for `context.lineage`. */
export type ContextLineageInput = {
  contextId: string;
};

/** Return shape for `context.lineage`. */
export type ContextLineageReturn = Record<string, unknown>;

/** Input shape for `context.list`. */
export type ContextListInput = {
  agent?: string;
  all?: boolean;
  kind?: string;
  limit?: string;
  offset?: string;
  session?: string;
};

/** Return shape for `context.list`. */
export type ContextListReturn = Record<string, unknown>;

/** Input shape for `context.prune`. */
export type ContextPruneInput = {
  apply?: boolean;
  confirm?: string;
  olderThan?: string;
};

/** Return shape for `context.prune`. */
export type ContextPruneReturn = Record<string, unknown>;

/** Input shape for `context.revoke`. */
export type ContextRevokeInput = {
  contextId: string;
  noCascade?: boolean;
  reason?: string;
};

/** Return shape for `context.revoke`. */
export type ContextRevokeReturn = Record<string, unknown>;

/** Input shape for `context.visibility`. */
export type ContextVisibilityInput = Record<string, never>;

/** Return shape for `context.visibility`. */
export type ContextVisibilityReturn = Record<string, unknown>;

/** Input shape for `context.whoami`. */
export type ContextWhoamiInput = Record<string, never>;

/** Return shape for `context.whoami`. */
export type ContextWhoamiReturn = Record<string, unknown>;

/** Input shape for `costs.agent`. */
export type CostsAgentInput = {
  agentId: string;
  hours?: string;
};

/** Return shape for `costs.agent`. */
export type CostsAgentReturn = {
  agentId: string;
  summary: {
    total_cache_creation: number;
    total_cache_read: number;
    total_cost: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
    turns: number;
  };
  window: {
    effectiveHours: number;
    requestedHours: string | null;
    sinceMs: number;
    untilMs: number;
  };
};

/** Input shape for `costs.agents`. */
export type CostsAgentsInput = {
  hours?: string;
  limit?: string;
};

/** Return shape for `costs.agents`. */
export type CostsAgentsReturn = {
  agents: Array<{
    agentId: string;
    models: string[];
    total_cache_creation: number;
    total_cache_read: number;
    total_cost: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
    turns: number;
    [k: string]: unknown;
  }>;
  limit: number;
  totalAgents: number;
  window: {
    effectiveHours: number;
    requestedHours: string | null;
    sinceMs: number;
    untilMs: number;
  };
};

/** Input shape for `costs.pricing`. */
export type CostsPricingInput = {
  dryRun?: boolean;
  hours?: string;
  includePriced?: boolean;
  limit?: string;
  recompute?: boolean;
};

/** Return shape for `costs.pricing`. */
export type CostsPricingReturn = {
  recompute?: {
    attempted: number;
    dryRun: boolean;
    includePriced: boolean;
    limit: number;
    priced: number;
    rows: Array<{
      id: number;
      model: string;
      previousPricingStatus: string;
      pricingError: string | null;
      pricingModel: string | null;
      pricingSource: string | null;
      pricingStatus: string;
      totalCost: number;
    }>;
    unpriced: number;
    updated: number;
  };
  rows: Array<{
    events: number;
    lastCreatedAt: number | null;
    model: string;
    pricingModel: string | null;
    pricingSource: string | null;
    pricingStatus: string;
    totalCost: number;
    totalTokens: number;
  }>;
  window: {
    effectiveHours: number;
    requestedHours: string | null;
    sinceMs: number;
    untilMs: number;
  };
};

/** Input shape for `costs.session`. */
export type CostsSessionInput = {
  nameOrKey: string;
};

/** Return shape for `costs.session`. */
export type CostsSessionReturn = {
  agentId: string | null;
  sessionKey: string;
  sessionName: string | null;
  summary: {
    total_cache_creation: number;
    total_cache_read: number;
    total_cost: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
    turns: number;
  };
};

/** Input shape for `costs.summary`. */
export type CostsSummaryInput = {
  hours?: string;
};

/** Return shape for `costs.summary`. */
export type CostsSummaryReturn = {
  summary: {
    total_cache_creation: number;
    total_cache_read: number;
    total_cost: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
    turns: number;
  };
  window: {
    effectiveHours: number;
    requestedHours: string | null;
    sinceMs: number;
    untilMs: number;
  };
};

/** Input shape for `costs.top-sessions`. */
export type CostsTopSessionsInput = {
  hours?: string;
  limit?: string;
};

/** Return shape for `costs.top-sessions`. */
export type CostsTopSessionsReturn = {
  limit: number;
  sessions: Array<{
    agentId: string;
    name: string;
    sessionKey: string;
    sessionName: string | null;
    total_cache_creation: number;
    total_cache_read: number;
    total_cost: number;
    total_input: number;
    total_output: number;
    total_tokens: number;
    turns: number;
    [k: string]: unknown;
  }>;
  window: {
    effectiveHours: number;
    requestedHours: string | null;
    sinceMs: number;
    untilMs: number;
  };
};

/** Input shape for `crm.account`. */
export type CrmAccountInput = {
  account: string;
};

/** Return shape for `crm.account`. */
export type CrmAccountReturn = {
  crm: Record<string, unknown>;
  target: string;
  [k: string]: unknown;
};

/** Input shape for `crm.account.create`. */
export type CrmAccountCreateInput = {
  contact?: string;
  domain?: string;
  idempotencyKey?: string;
  name: string;
  owner?: string;
};

/** Return shape for `crm.account.create`. */
export type CrmAccountCreateReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.account.link-contact`. */
export type CrmAccountLinkContactInput = {
  account: string;
  contact: string;
  primary?: boolean;
  role?: string;
};

/** Return shape for `crm.account.link-contact`. */
export type CrmAccountLinkContactReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.account.show`. */
export type CrmAccountShowInput = {
  account: string;
};

/** Return shape for `crm.account.show`. */
export type CrmAccountShowReturn = {
  crm: Record<string, unknown>;
  target: string;
  [k: string]: unknown;
};

/** Input shape for `crm.board`. */
export type CrmBoardInput = {
  includeEmptyStages?: boolean;
  pipeline?: string;
};

/** Return shape for `crm.board`. */
export type CrmBoardReturn = {
  opportunities: Array<Record<string, unknown>>;
  stages?: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.contact`. */
export type CrmContactInput = {
  contact: string;
};

/** Return shape for `crm.contact`. */
export type CrmContactReturn = {
  crm: Record<string, unknown>;
  target: string;
  [k: string]: unknown;
};

/** Input shape for `crm.contact.set`. */
export type CrmContactSetInput = {
  contact: string;
  field: string;
  source?: string;
  value: string;
};

/** Return shape for `crm.contact.set`. */
export type CrmContactSetReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.contact.show`. */
export type CrmContactShowInput = {
  contact: string;
};

/** Return shape for `crm.contact.show`. */
export type CrmContactShowReturn = {
  crm: Record<string, unknown>;
  target: string;
  [k: string]: unknown;
};

/** Input shape for `crm.contacts`. */
export type CrmContactsInput = {
  limit?: string;
  offset?: string;
  owner?: string;
  status?: string;
};

/** Return shape for `crm.contacts`. */
export type CrmContactsReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.fact.confirm`. */
export type CrmFactConfirmInput = {
  fact: string;
};

/** Return shape for `crm.fact.confirm`. */
export type CrmFactConfirmReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.fact.list`. */
export type CrmFactListInput = {
  account?: string;
  contact?: string;
  entity?: string;
  entityType?: string;
  key?: string;
  limit?: string;
  offset?: string;
  opportunity?: string;
  status?: string;
};

/** Return shape for `crm.fact.list`. */
export type CrmFactListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.fact.propose`. */
export type CrmFactProposeInput = {
  account?: string;
  confidence?: string;
  contact?: string;
  entity: string;
  entityType: string;
  idempotencyKey?: string;
  key: string;
  opportunity?: string;
  status?: string;
  value: string;
};

/** Return shape for `crm.fact.propose`. */
export type CrmFactProposeReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.fact.reject`. */
export type CrmFactRejectInput = {
  fact: string;
};

/** Return shape for `crm.fact.reject`. */
export type CrmFactRejectReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.next`. */
export type CrmNextInput = {
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
};

/** Return shape for `crm.next`. */
export type CrmNextReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.opportunity`. */
export type CrmOpportunityInput = {
  opportunity: string;
};

/** Return shape for `crm.opportunity`. */
export type CrmOpportunityReturn = {
  opportunity: Record<string, unknown>;
  target: string;
  [k: string]: unknown;
};

/** Input shape for `crm.opportunity.contacts`. */
export type CrmOpportunityContactsInput = {
  opportunity: string;
};

/** Return shape for `crm.opportunity.contacts`. */
export type CrmOpportunityContactsReturn = {
  contacts: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.opportunity.create`. */
export type CrmOpportunityCreateInput = {
  account?: string;
  contact?: string;
  currency?: string;
  idempotencyKey?: string;
  owner?: string;
  pipeline?: string;
  stage?: string;
  title: string;
  value?: string;
};

/** Return shape for `crm.opportunity.create`. */
export type CrmOpportunityCreateReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.opportunity.link-contact`. */
export type CrmOpportunityLinkContactInput = {
  account?: string;
  contact: string;
  opportunity: string;
  primary?: boolean;
  role?: string;
};

/** Return shape for `crm.opportunity.link-contact`. */
export type CrmOpportunityLinkContactReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.opportunity.move`. */
export type CrmOpportunityMoveInput = {
  lostReason?: string;
  opportunity: string;
  stage: string;
};

/** Return shape for `crm.opportunity.move`. */
export type CrmOpportunityMoveReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.opportunity.show`. */
export type CrmOpportunityShowInput = {
  opportunity: string;
};

/** Return shape for `crm.opportunity.show`. */
export type CrmOpportunityShowReturn = {
  opportunity: Record<string, unknown>;
  target: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.create`. */
export type CrmPipelineCreateInput = {
  default?: boolean;
  entityType?: string;
  idempotencyKey?: string;
  metadata?: string;
  name: string;
};

/** Return shape for `crm.pipeline.create`. */
export type CrmPipelineCreateReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.list`. */
export type CrmPipelineListInput = {
  entityType?: string;
  includeArchived?: boolean;
  limit?: string;
  offset?: string;
};

/** Return shape for `crm.pipeline.list`. */
export type CrmPipelineListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.set`. */
export type CrmPipelineSetInput = {
  field: string;
  pipeline: string;
  value: string;
};

/** Return shape for `crm.pipeline.set`. */
export type CrmPipelineSetReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.show`. */
export type CrmPipelineShowInput = {
  pipeline: string;
};

/** Return shape for `crm.pipeline.show`. */
export type CrmPipelineShowReturn = Record<string, unknown>;

/** Input shape for `crm.pipeline.stage.add`. */
export type CrmPipelineStageAddInput = {
  category?: string;
  idempotencyKey?: string;
  key: string;
  metadata?: string;
  name?: string;
  order?: string;
  pipeline: string;
  probability?: string;
  terminal?: boolean;
};

/** Return shape for `crm.pipeline.stage.add`. */
export type CrmPipelineStageAddReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.stage.archive`. */
export type CrmPipelineStageArchiveInput = {
  pipeline: string;
  stage: string;
};

/** Return shape for `crm.pipeline.stage.archive`. */
export type CrmPipelineStageArchiveReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.stage.list`. */
export type CrmPipelineStageListInput = {
  includeArchived?: boolean;
  limit?: string;
  offset?: string;
  pipeline: string;
};

/** Return shape for `crm.pipeline.stage.list`. */
export type CrmPipelineStageListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.stage.set`. */
export type CrmPipelineStageSetInput = {
  field: string;
  pipeline: string;
  stage: string;
  value: string;
};

/** Return shape for `crm.pipeline.stage.set`. */
export type CrmPipelineStageSetReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.stage.show`. */
export type CrmPipelineStageShowInput = {
  pipeline: string;
  stage: string;
};

/** Return shape for `crm.pipeline.stage.show`. */
export type CrmPipelineStageShowReturn = Record<string, unknown>;

/** Input shape for `crm.pipeline.stage.topic.add`. */
export type CrmPipelineStageTopicAddInput = {
  description?: string;
  idempotencyKey?: string;
  key: string;
  metadata?: string;
  order?: string;
  pipeline: string;
  stage: string;
  title?: string;
  type?: string;
};

/** Return shape for `crm.pipeline.stage.topic.add`. */
export type CrmPipelineStageTopicAddReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.stage.topic.archive`. */
export type CrmPipelineStageTopicArchiveInput = {
  pipeline: string;
  stage: string;
  topic: string;
};

/** Return shape for `crm.pipeline.stage.topic.archive`. */
export type CrmPipelineStageTopicArchiveReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.stage.topic.set`. */
export type CrmPipelineStageTopicSetInput = {
  field: string;
  pipeline: string;
  stage: string;
  topic: string;
  value: string;
};

/** Return shape for `crm.pipeline.stage.topic.set`. */
export type CrmPipelineStageTopicSetReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.stage.topics`. */
export type CrmPipelineStageTopicsInput = {
  includeArchived?: boolean;
  limit?: string;
  offset?: string;
  pipeline: string;
  stage: string;
};

/** Return shape for `crm.pipeline.stage.topics`. */
export type CrmPipelineStageTopicsReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.task.cancel`. */
export type CrmTaskCancelInput = {
  reason?: string;
  task: string;
};

/** Return shape for `crm.task.cancel`. */
export type CrmTaskCancelReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.task.create`. */
export type CrmTaskCreateInput = {
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
  title: string;
};

/** Return shape for `crm.task.create`. */
export type CrmTaskCreateReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.task.done`. */
export type CrmTaskDoneInput = {
  task: string;
};

/** Return shape for `crm.task.done`. */
export type CrmTaskDoneReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.task.list`. */
export type CrmTaskListInput = {
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
};

/** Return shape for `crm.task.list`. */
export type CrmTaskListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `crm.task.show`. */
export type CrmTaskShowInput = {
  task: string;
};

/** Return shape for `crm.task.show`. */
export type CrmTaskShowReturn = {
  target: string;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `crm.task.snooze`. */
export type CrmTaskSnoozeInput = {
  reason?: string;
  task: string;
  until?: string;
};

/** Return shape for `crm.task.snooze`. */
export type CrmTaskSnoozeReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `cron.add`. */
export type CronAddInput = {
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
  name: string;
  onError?: string;
  shell?: string;
  timeout?: string;
  tz?: string;
};

/** Return shape for `cron.add`. */
export type CronAddReturn = {
  changedCount: number;
  job: (Record<string, unknown>) | null;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `cron.disable`. */
export type CronDisableInput = {
  id: string;
};

/** Return shape for `cron.disable`. */
export type CronDisableReturn = {
  changedCount: number;
  job: (Record<string, unknown>) | null;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `cron.enable`. */
export type CronEnableInput = {
  id: string;
};

/** Return shape for `cron.enable`. */
export type CronEnableReturn = {
  changedCount: number;
  job: (Record<string, unknown>) | null;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `cron.list`. */
export type CronListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `cron.list`. */
export type CronListReturn = {
  items: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `cron.rm`. */
export type CronRmInput = {
  id: string;
};

/** Return shape for `cron.rm`. */
export type CronRmReturn = {
  changedCount: number;
  job: (Record<string, unknown>) | null;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `cron.run`. */
export type CronRunInput = {
  id: string;
};

/** Return shape for `cron.run`. */
export type CronRunReturn = {
  changedCount: number;
  job: (Record<string, unknown>) | null;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `cron.set`. */
export type CronSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `cron.set`. */
export type CronSetReturn = {
  changedCount: number;
  job: (Record<string, unknown>) | null;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `cron.show`. */
export type CronShowInput = {
  id: string;
};

/** Return shape for `cron.show`. */
export type CronShowReturn = {
  job: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `daemon.env`. */
export type DaemonEnvInput = Record<string, never>;

/** Return shape for `daemon.env`. */
export type DaemonEnvReturn = {
  action: "env";
  created: boolean;
  existedBefore: boolean;
  openedEditor: boolean;
  path: string;
  [k: string]: unknown;
};

/** Input shape for `daemon.init-admin-key`. */
export type DaemonInitAdminKeyInput = {
  fromEnv?: boolean;
  label?: string;
  noStore?: boolean;
  printOnly?: boolean;
};

/** Return shape for `daemon.init-admin-key`. */
export type DaemonInitAdminKeyReturn = {
  action: "init-admin-key";
  changed: boolean;
  [k: string]: unknown;
};

/** Input shape for `daemon.install`. */
export type DaemonInstallInput = Record<string, never>;

/** Return shape for `daemon.install`. */
export type DaemonInstallReturn = {
  action: string;
  changed: boolean;
  [k: string]: unknown;
};

/** Input shape for `daemon.logs`. */
export type DaemonLogsInput = {
  clear?: boolean;
  follow?: boolean;
  path?: boolean;
  tail?: string;
};

/** Return shape for `daemon.logs`. */
export type DaemonLogsReturn = {
  action: string;
  [k: string]: unknown;
};

/** Input shape for `daemon.restart`. */
export type DaemonRestartInput = {
  build?: boolean;
  message?: string;
};

/** Return shape for `daemon.restart`. */
export type DaemonRestartReturn = {
  action: string;
  changed: boolean;
  [k: string]: unknown;
};

/** Input shape for `daemon.start`. */
export type DaemonStartInput = Record<string, never>;

/** Return shape for `daemon.start`. */
export type DaemonStartReturn = {
  action: string;
  changed: boolean;
  [k: string]: unknown;
};

/** Input shape for `daemon.status`. */
export type DaemonStatusInput = Record<string, never>;

/** Return shape for `daemon.status`. */
export type DaemonStatusReturn = {
  infrastructure: Record<string, unknown>;
  pm2Available: boolean;
  processName: string;
  processes: Array<Record<string, unknown>>;
  ravi: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `daemon.stop`. */
export type DaemonStopInput = Record<string, never>;

/** Return shape for `daemon.stop`. */
export type DaemonStopReturn = {
  action: string;
  changed: boolean;
  [k: string]: unknown;
};

/** Input shape for `daemon.uninstall`. */
export type DaemonUninstallInput = Record<string, never>;

/** Return shape for `daemon.uninstall`. */
export type DaemonUninstallReturn = {
  action: string;
  changed: boolean;
  [k: string]: unknown;
};

/** Input shape for `devin.auth.check`. */
export type DevinAuthCheckInput = Record<string, never>;

/** Return shape for `devin.auth.check`. */
export type DevinAuthCheckReturn = {
  baseUrl: string;
  configuredOrgId?: string;
  ok: boolean;
  self: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.archive`. */
export type DevinSessionsArchiveInput = {
  session: string;
};

/** Return shape for `devin.sessions.archive`. */
export type DevinSessionsArchiveReturn = {
  session: Record<string, unknown>;
  status: "archived";
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.attachments`. */
export type DevinSessionsAttachmentsInput = {
  cached?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.attachments`. */
export type DevinSessionsAttachmentsReturn = {
  attachments: Array<Record<string, unknown>>;
  devinId: string;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.create`. */
export type DevinSessionsCreateInput = {
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
};

/** Return shape for `devin.sessions.create`. */
export type DevinSessionsCreateReturn = {
  maxAcuLimit: number | null;
  maxAcuLimitSource: string;
  session: Record<string, unknown>;
  status: "created";
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.insights`. */
export type DevinSessionsInsightsInput = {
  generate?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.insights`. */
export type DevinSessionsInsightsReturn = {
  insights: Record<string, unknown>;
  session: Record<string, unknown>;
  summary: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.list`. */
export type DevinSessionsListInput = {
  limit?: string;
  offset?: string;
  remote?: boolean;
  status?: string;
  tag?: string;
};

/** Return shape for `devin.sessions.list`. */
export type DevinSessionsListReturn = {
  hasNextPage?: boolean;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  sessions: Array<Record<string, unknown>>;
  source: string;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.messages`. */
export type DevinSessionsMessagesInput = {
  cached?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.messages`. */
export type DevinSessionsMessagesReturn = {
  devinId: string;
  messages: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.send`. */
export type DevinSessionsSendInput = {
  asUser?: string;
  message: string;
  session: string;
};

/** Return shape for `devin.sessions.send`. */
export type DevinSessionsSendReturn = {
  session: Record<string, unknown>;
  status: "sent";
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.show`. */
export type DevinSessionsShowInput = {
  session: string;
  sync?: boolean;
};

/** Return shape for `devin.sessions.show`. */
export type DevinSessionsShowReturn = {
  session: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.sync`. */
export type DevinSessionsSyncInput = {
  artifacts?: boolean;
  insights?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.sync`. */
export type DevinSessionsSyncReturn = {
  artifacts: string[];
  attachments: number;
  insights: (Record<string, unknown>) | null;
  messages: number;
  session: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.terminate`. */
export type DevinSessionsTerminateInput = {
  archive?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.terminate`. */
export type DevinSessionsTerminateReturn = {
  archive: boolean;
  session: Record<string, unknown>;
  status: "terminated";
  [k: string]: unknown;
};

/** Input shape for `eval.run`. */
export type EvalRunInput = {
  output?: string;
  specPath: string;
};

/** Return shape for `eval.run`. */
export type EvalRunReturn = {
  execution: Record<string, unknown>;
  grade: Record<string, unknown>;
  outputDir: string;
  runId: string;
  session: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `gmail.list`. */
export type GmailListInput = {
  connector?: string;
  cursor?: string;
  label?: string;
  max?: string;
  q?: string;
};

/** Return shape for `gmail.list`. */
export type GmailListReturn = {
  capability: string;
  refreshed: boolean;
  result?: unknown;
};

/** Input shape for `gmail.read`. */
export type GmailReadInput = {
  connector?: string;
  format?: string;
  id: string;
};

/** Return shape for `gmail.read`. */
export type GmailReadReturn = {
  capability: string;
  refreshed: boolean;
  result?: unknown;
};

/** Input shape for `heartbeat.disable`. */
export type HeartbeatDisableInput = {
  id: string;
};

/** Return shape for `heartbeat.disable`. */
export type HeartbeatDisableReturn = {
  agent: {
    cwd: string;
    id: string;
    model: string | null;
    name: string | null;
    provider: string | null;
    [k: string]: unknown;
  };
  changedCount: number;
  heartbeat: {
    accountId: string | null;
    activeEnd: string | null;
    activeHours: string;
    activeStart: string | null;
    enabled: boolean;
    intervalDescription: string;
    intervalMs: number;
    lastRunAt: number | null;
    model: string | null;
    [k: string]: unknown;
  };
  heartbeatFile: string;
  heartbeatFileExists: boolean;
  property?: string;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  value?: unknown;
};

/** Input shape for `heartbeat.enable`. */
export type HeartbeatEnableInput = {
  id: string;
  interval?: string;
};

/** Return shape for `heartbeat.enable`. */
export type HeartbeatEnableReturn = {
  agent: {
    cwd: string;
    id: string;
    model: string | null;
    name: string | null;
    provider: string | null;
    [k: string]: unknown;
  };
  changedCount: number;
  heartbeat: {
    accountId: string | null;
    activeEnd: string | null;
    activeHours: string;
    activeStart: string | null;
    enabled: boolean;
    intervalDescription: string;
    intervalMs: number;
    lastRunAt: number | null;
    model: string | null;
    [k: string]: unknown;
  };
  heartbeatFile: string;
  heartbeatFileExists: boolean;
  property?: string;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  value?: unknown;
};

/** Input shape for `heartbeat.set`. */
export type HeartbeatSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `heartbeat.set`. */
export type HeartbeatSetReturn = {
  agent: {
    cwd: string;
    id: string;
    model: string | null;
    name: string | null;
    provider: string | null;
    [k: string]: unknown;
  };
  changedCount: number;
  heartbeat: {
    accountId: string | null;
    activeEnd: string | null;
    activeHours: string;
    activeStart: string | null;
    enabled: boolean;
    intervalDescription: string;
    intervalMs: number;
    lastRunAt: number | null;
    model: string | null;
    [k: string]: unknown;
  };
  heartbeatFile: string;
  heartbeatFileExists: boolean;
  property?: string;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  value?: unknown;
};

/** Input shape for `heartbeat.show`. */
export type HeartbeatShowInput = {
  id: string;
};

/** Return shape for `heartbeat.show`. */
export type HeartbeatShowReturn = {
  agent: {
    cwd: string;
    id: string;
    model: string | null;
    name: string | null;
    provider: string | null;
    [k: string]: unknown;
  };
  heartbeat: {
    accountId: string | null;
    activeEnd: string | null;
    activeHours: string;
    activeStart: string | null;
    enabled: boolean;
    intervalDescription: string;
    intervalMs: number;
    lastRunAt: number | null;
    model: string | null;
    [k: string]: unknown;
  };
  heartbeatFile: string;
  heartbeatFileExists: boolean;
};

/** Input shape for `heartbeat.status`. */
export type HeartbeatStatusInput = Record<string, never>;

/** Return shape for `heartbeat.status`. */
export type HeartbeatStatusReturn = {
  agents: Array<{
    agent: {
      cwd: string;
      id: string;
      model: string | null;
      name: string | null;
      provider: string | null;
      [k: string]: unknown;
    };
    heartbeat: {
      accountId: string | null;
      activeEnd: string | null;
      activeHours: string;
      activeStart: string | null;
      enabled: boolean;
      intervalDescription: string;
      intervalMs: number;
      lastRunAt: number | null;
      model: string | null;
      [k: string]: unknown;
    };
    heartbeatFile: string;
    heartbeatFileExists: boolean;
  }>;
  total: number;
};

/** Input shape for `heartbeat.trigger`. */
export type HeartbeatTriggerInput = {
  id: string;
};

/** Return shape for `heartbeat.trigger`. */
export type HeartbeatTriggerReturn = {
  changedCount: number;
  heartbeatFile: string;
  reason?: string;
  sessionName?: string;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `hooks.create`. */
export type HooksCreateInput = {
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
  name: string;
  role?: string;
  scope?: string;
  session?: string;
  targetSession?: string;
  targetTask?: string;
  task?: string;
  workspace?: string;
};

/** Return shape for `hooks.create`. */
export type HooksCreateReturn = {
  changedCount: number;
  hook: Record<string, unknown>;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `hooks.disable`. */
export type HooksDisableInput = {
  id: string;
};

/** Return shape for `hooks.disable`. */
export type HooksDisableReturn = {
  changedCount: number;
  hook: Record<string, unknown>;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `hooks.enable`. */
export type HooksEnableInput = {
  id: string;
};

/** Return shape for `hooks.enable`. */
export type HooksEnableReturn = {
  changedCount: number;
  hook: Record<string, unknown>;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `hooks.list`. */
export type HooksListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `hooks.list`. */
export type HooksListReturn = {
  hooks: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `hooks.rm`. */
export type HooksRmInput = {
  id: string;
};

/** Return shape for `hooks.rm`. */
export type HooksRmReturn = {
  changedCount: number;
  hook: Record<string, unknown>;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `hooks.show`. */
export type HooksShowInput = {
  id: string;
};

/** Return shape for `hooks.show`. */
export type HooksShowReturn = {
  hook: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `hooks.test`. */
export type HooksTestInput = {
  id: string;
};

/** Return shape for `hooks.test`. */
export type HooksTestReturn = Record<string, unknown>;

/** Input shape for `image.atlas.split`. */
export type ImageAtlasSplitInput = {
  account?: string;
  background?: string;
  caption?: string;
  channel?: string;
  cols?: string;
  fit?: string;
  fuzz?: string;
  input: string;
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
};

/** Return shape for `image.atlas.split`. */
export type ImageAtlasSplitReturn = {
  artifactId: string;
  artifact_id: string;
  crops: Array<Record<string, unknown>>;
  manifestPath: string;
  outputDir: string;
  parentArtifactId: string | null;
  sent: Array<Record<string, unknown>>;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `image.generate`. */
export type ImageGenerateInput = {
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
  prompt: string;
  provider?: string;
  quality?: string;
  send?: boolean;
  size?: string;
  source?: string;
  sync?: boolean;
};

/** Return shape for `image.generate`. */
export type ImageGenerateReturn = ({
  artifactId: string;
  artifact_id: string;
  autoSend: boolean;
  delivery?: Record<string, unknown>;
  events: string;
  hint: string;
  status: string;
  success: true;
  workerPid?: number;
  [k: string]: unknown;
}) | ({
  images: Array<{
    artifactId: string;
    filePath: string;
    mimeType: string;
    model: string;
    prompt: string;
    provider: string;
    sendCommand: string;
    [k: string]: unknown;
  }>;
  options: Record<string, unknown>;
  sent: Array<{
    accountId: string;
    caption: string;
    channel?: string;
    chatId: string;
    filename: string;
    instanceId: string;
    messageId?: string;
    status?: string;
    threadId?: string;
    transport: string;
    [k: string]: unknown;
  }>;
  success: true;
  [k: string]: unknown;
});

/** Input shape for `inbox.archive`. */
export type InboxArchiveInput = {
  item: string;
};

/** Return shape for `inbox.archive`. */
export type InboxArchiveReturn = {
  item: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `inbox.disable`. */
export type InboxDisableInput = Record<string, never>;

/** Return shape for `inbox.disable`. */
export type InboxDisableReturn = {
  changed: boolean;
  enabled: boolean;
  [k: string]: unknown;
};

/** Input shape for `inbox.done`. */
export type InboxDoneInput = {
  item: string;
};

/** Return shape for `inbox.done`. */
export type InboxDoneReturn = {
  item: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `inbox.enable`. */
export type InboxEnableInput = Record<string, never>;

/** Return shape for `inbox.enable`. */
export type InboxEnableReturn = {
  changed: boolean;
  enabled: boolean;
  [k: string]: unknown;
};

/** Input shape for `inbox.items`. */
export type InboxItemsInput = {
  limit?: string;
};

/** Return shape for `inbox.items`. */
export type InboxItemsReturn = {
  items: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `inbox.list`. */
export type InboxListInput = {
  includeArchived?: boolean;
  limit?: string;
  offset?: string;
  source?: string;
  status?: string;
};

/** Return shape for `inbox.list`. */
export type InboxListReturn = {
  items: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `inbox.poll`. */
export type InboxPollInput = {
  once?: boolean;
};

/** Return shape for `inbox.poll`. */
export type InboxPollReturn = {
  ok: true;
  snapshot: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `inbox.read`. */
export type InboxReadInput = {
  item: string;
};

/** Return shape for `inbox.read`. */
export type InboxReadReturn = {
  events: Array<Record<string, unknown>>;
  item: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `inbox.replay`. */
export type InboxReplayInput = {
  ref: string;
};

/** Return shape for `inbox.replay`. */
export type InboxReplayReturn = {
  itemId: string;
  ok: true;
  replayedAt: string;
  sequence: number;
  subject: string;
  [k: string]: unknown;
};

/** Input shape for `inbox.snooze`. */
export type InboxSnoozeInput = {
  item: string;
  until?: string;
};

/** Return shape for `inbox.snooze`. */
export type InboxSnoozeReturn = {
  item: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `inbox.sources`. */
export type InboxSourcesInput = Record<string, never>;

/** Return shape for `inbox.sources`. */
export type InboxSourcesReturn = {
  sources: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `inbox.status`. */
export type InboxStatusInput = Record<string, never>;

/** Return shape for `inbox.status`. */
export type InboxStatusReturn = Record<string, unknown>;

/** Input shape for `insights.create`. */
export type InsightsCreateInput = {
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
  summary: string;
  tag?: string[];
  task?: string;
};

/** Return shape for `insights.create`. */
export type InsightsCreateReturn = {
  comment?: Record<string, unknown>;
  insight: Record<string, unknown>;
  success: true;
  tags: string[];
  [k: string]: unknown;
};

/** Input shape for `insights.list`. */
export type InsightsListInput = {
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
};

/** Return shape for `insights.list`. */
export type InsightsListReturn = ({
  count: number;
  insights: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  query: Record<string, unknown>;
  total: number;
  [k: string]: unknown;
}) | ({
  generatedAt: number;
  items: Array<Record<string, unknown>>;
  ok: true;
  query: Record<string, unknown>;
  stats: Record<string, unknown>;
  [k: string]: unknown;
});

/** Input shape for `insights.search`. */
export type InsightsSearchInput = {
  limit?: string;
  text: string;
};

/** Return shape for `insights.search`. */
export type InsightsSearchReturn = {
  count: number;
  insights: Array<Record<string, unknown>>;
  query: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `insights.show`. */
export type InsightsShowInput = {
  id: string;
};

/** Return shape for `insights.show`. */
export type InsightsShowReturn = {
  insight: Record<string, unknown>;
  tags: string[];
  [k: string]: unknown;
};

/** Input shape for `instances.create`. */
export type InstancesCreateInput = {
  agent?: string;
  channel?: string;
  contactIntakeMode?: string;
  dmPolicy?: string;
  groupPolicy?: string;
  name: string;
};

/** Return shape for `instances.create`. */
export type InstancesCreateReturn = Record<string, unknown>;

/** Input shape for `instances.delete`. */
export type InstancesDeleteInput = {
  name: string;
};

/** Return shape for `instances.delete`. */
export type InstancesDeleteReturn = Record<string, unknown>;

/** Input shape for `instances.deleted`. */
export type InstancesDeletedInput = Record<string, never>;

/** Return shape for `instances.deleted`. */
export type InstancesDeletedReturn = Record<string, unknown>;

/** Input shape for `instances.disable`. */
export type InstancesDisableInput = {
  target: string;
};

/** Return shape for `instances.disable`. */
export type InstancesDisableReturn = Record<string, unknown>;

/** Input shape for `instances.disconnect`. */
export type InstancesDisconnectInput = {
  name: string;
};

/** Return shape for `instances.disconnect`. */
export type InstancesDisconnectReturn = Record<string, unknown>;

/** Input shape for `instances.enable`. */
export type InstancesEnableInput = {
  target: string;
};

/** Return shape for `instances.enable`. */
export type InstancesEnableReturn = Record<string, unknown>;

/** Input shape for `instances.get`. */
export type InstancesGetInput = {
  key: string;
  name: string;
};

/** Return shape for `instances.get`. */
export type InstancesGetReturn = Record<string, unknown>;

/** Input shape for `instances.list`. */
export type InstancesListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `instances.list`. */
export type InstancesListReturn = Record<string, unknown>;

/** Input shape for `instances.pending.approve`. */
export type InstancesPendingApproveInput = {
  agent?: string;
  contact: string;
  name: string;
};

/** Return shape for `instances.pending.approve`. */
export type InstancesPendingApproveReturn = Record<string, unknown>;

/** Input shape for `instances.pending.list`. */
export type InstancesPendingListInput = {
  limit?: string;
  name: string;
  offset?: string;
};

/** Return shape for `instances.pending.list`. */
export type InstancesPendingListReturn = Record<string, unknown>;

/** Input shape for `instances.pending.reject`. */
export type InstancesPendingRejectInput = {
  contact: string;
  name: string;
};

/** Return shape for `instances.pending.reject`. */
export type InstancesPendingRejectReturn = Record<string, unknown>;

/** Input shape for `instances.restore`. */
export type InstancesRestoreInput = {
  name: string;
};

/** Return shape for `instances.restore`. */
export type InstancesRestoreReturn = Record<string, unknown>;

/** Input shape for `instances.routes.add`. */
export type InstancesRoutesAddInput = {
  agent: string;
  allowRuntimeMismatch?: boolean;
  channel?: string;
  dmScope?: string;
  name: string;
  pattern: string;
  policy?: string;
  priority?: string;
  session?: string;
};

/** Return shape for `instances.routes.add`. */
export type InstancesRoutesAddReturn = Record<string, unknown>;

/** Input shape for `instances.routes.deleted`. */
export type InstancesRoutesDeletedInput = {
  name?: string;
};

/** Return shape for `instances.routes.deleted`. */
export type InstancesRoutesDeletedReturn = Record<string, unknown>;

/** Input shape for `instances.routes.list`. */
export type InstancesRoutesListInput = {
  limit?: string;
  name: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `instances.routes.list`. */
export type InstancesRoutesListReturn = Record<string, unknown>;

/** Input shape for `instances.routes.remove`. */
export type InstancesRoutesRemoveInput = {
  allowRuntimeMismatch?: boolean;
  name: string;
  pattern: string;
};

/** Return shape for `instances.routes.remove`. */
export type InstancesRoutesRemoveReturn = Record<string, unknown>;

/** Input shape for `instances.routes.restore`. */
export type InstancesRoutesRestoreInput = {
  allowRuntimeMismatch?: boolean;
  name: string;
  pattern: string;
};

/** Return shape for `instances.routes.restore`. */
export type InstancesRoutesRestoreReturn = Record<string, unknown>;

/** Input shape for `instances.routes.set`. */
export type InstancesRoutesSetInput = {
  allowRuntimeMismatch?: boolean;
  key: string;
  name: string;
  pattern: string;
  value: string;
};

/** Return shape for `instances.routes.set`. */
export type InstancesRoutesSetReturn = Record<string, unknown>;

/** Input shape for `instances.routes.show`. */
export type InstancesRoutesShowInput = {
  name: string;
  pattern: string;
};

/** Return shape for `instances.routes.show`. */
export type InstancesRoutesShowReturn = Record<string, unknown>;

/** Input shape for `instances.set`. */
export type InstancesSetInput = {
  key: string;
  name: string;
  value: string;
};

/** Return shape for `instances.set`. */
export type InstancesSetReturn = Record<string, unknown>;

/** Input shape for `instances.show`. */
export type InstancesShowInput = {
  name: string;
};

/** Return shape for `instances.show`. */
export type InstancesShowReturn = Record<string, unknown>;

/** Input shape for `instances.status`. */
export type InstancesStatusInput = {
  name: string;
};

/** Return shape for `instances.status`. */
export type InstancesStatusReturn = Record<string, unknown>;

/** Input shape for `instances.target`. */
export type InstancesTargetInput = {
  channel?: string;
  name: string;
  pattern?: string;
};

/** Return shape for `instances.target`. */
export type InstancesTargetReturn = Record<string, unknown>;

/** Input shape for `mail.accounts.create`. */
export type MailAccountsCreateInput = {
  credentialsRef?: string;
  id?: string;
  name?: string;
  provider?: string;
};

/** Return shape for `mail.accounts.create`. */
export type MailAccountsCreateReturn = {
  account: {
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultMailboxId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  };
};

/** Input shape for `mail.accounts.list`. */
export type MailAccountsListInput = {
  limit?: string;
  offset?: string;
  provider?: string;
  status?: string;
};

/** Return shape for `mail.accounts.list`. */
export type MailAccountsListReturn = {
  accounts: Array<{
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultMailboxId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  }>;
};

/** Input shape for `mail.accounts.sync`. */
export type MailAccountsSyncInput = {
  account: string;
  once?: boolean;
};

/** Return shape for `mail.accounts.sync`. */
export type MailAccountsSyncReturn = ({
  account: {
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultMailboxId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  };
  inboxCreated: number;
  mailboxesImported: number;
  messagesImported: number;
  ok: true;
  provider: "ravi-mail";
  status: "synced";
}) | ({
  account: {
    capabilities: Record<string, unknown>;
    createdAt: number;
    credentialsRef: string | null;
    defaultMailboxId: string | null;
    displayName: string;
    id: string;
    provider: string;
    settings: Record<string, unknown>;
    status: "active" | "paused" | "auth_required" | "disabled";
    updatedAt: number;
  };
  message: string;
  ok: false;
  status: "adapter_not_started";
});

/** Input shape for `mail.domains.create`. */
export type MailDomainsCreateInput = {
  console?: string;
  domain: string;
};

/** Return shape for `mail.domains.create`. */
export type MailDomainsCreateReturn = Record<string, unknown>;

/** Input shape for `mail.domains.list`. */
export type MailDomainsListInput = {
  console?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `mail.domains.list`. */
export type MailDomainsListReturn = Record<string, unknown>;

/** Input shape for `mail.mailboxes.create`. */
export type MailMailboxesCreateInput = {
  account?: string;
  address: string;
  default?: boolean;
  name?: string;
  providerMailboxId?: string;
  role?: string;
};

/** Return shape for `mail.mailboxes.create`. */
export type MailMailboxesCreateReturn = {
  mailbox: {
    accountId: string;
    address: string;
    createdAt: number;
    displayName: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    normalizedAddress: string;
    providerMailboxId: string | null;
    role: "primary" | "alias" | "shared" | "system" | "unknown";
    status: "active" | "paused" | "disabled";
    updatedAt: number;
  };
};

/** Input shape for `mail.mailboxes.disable`. */
export type MailMailboxesDisableInput = {
  mailbox: string;
};

/** Return shape for `mail.mailboxes.disable`. */
export type MailMailboxesDisableReturn = {
  mailbox: {
    accountId: string;
    address: string;
    createdAt: number;
    displayName: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    normalizedAddress: string;
    providerMailboxId: string | null;
    role: "primary" | "alias" | "shared" | "system" | "unknown";
    status: "active" | "paused" | "disabled";
    updatedAt: number;
  };
};

/** Input shape for `mail.mailboxes.list`. */
export type MailMailboxesListInput = {
  account?: string;
  limit?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `mail.mailboxes.list`. */
export type MailMailboxesListReturn = {
  mailboxes: Array<{
    accountId: string;
    address: string;
    createdAt: number;
    displayName: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    normalizedAddress: string;
    providerMailboxId: string | null;
    role: "primary" | "alias" | "shared" | "system" | "unknown";
    status: "active" | "paused" | "disabled";
    updatedAt: number;
  }>;
};

/** Input shape for `mail.mailboxes.show`. */
export type MailMailboxesShowInput = {
  mailbox: string;
};

/** Return shape for `mail.mailboxes.show`. */
export type MailMailboxesShowReturn = {
  mailbox: {
    accountId: string;
    address: string;
    createdAt: number;
    displayName: string | null;
    id: string;
    isDefault: boolean;
    lastSyncedAt: number | null;
    metadata: Record<string, unknown>;
    normalizedAddress: string;
    providerMailboxId: string | null;
    role: "primary" | "alias" | "shared" | "system" | "unknown";
    status: "active" | "paused" | "disabled";
    updatedAt: number;
  };
};

/** Input shape for `mail.messages.import`. */
export type MailMessagesImportInput = {
  body?: string;
  from?: string;
  mailbox?: string;
  provider?: string;
  providerMessageId?: string;
  providerThreadId?: string;
  rfcMessageId?: string;
  subject?: string;
  to?: string;
};

/** Return shape for `mail.messages.import`. */
export type MailMessagesImportReturn = {
  inboxCreated: boolean;
  inboxItem: (Record<string, unknown>) | null;
  message: ({
    accountId: string;
    addresses: Array<{
      address: string;
      agentId: string | null;
      contactId: string | null;
      displayName: string | null;
      id: string;
      kind: "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
      messageId: string;
      normalizedAddress: string;
      platformIdentityId: string | null;
      raw: Record<string, unknown>;
    }>;
    attachments: Array<{
      contentType: string | null;
      filename: string | null;
      id: string;
      localBlobRef: string | null;
      messageId: string;
      metadata: Record<string, unknown>;
      providerAttachmentId: string | null;
      redactionStatus: string | null;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  }) | ({
    accountId: string;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  });
};

/** Input shape for `mail.messages.list`. */
export type MailMessagesListInput = {
  addresses?: boolean;
  limit?: string;
  mailbox?: string;
  offset?: string;
  query?: string;
  status?: string;
};

/** Return shape for `mail.messages.list`. */
export type MailMessagesListReturn = {
  messages: Array<({
    accountId: string;
    addresses: Array<{
      address: string;
      agentId: string | null;
      contactId: string | null;
      displayName: string | null;
      id: string;
      kind: "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
      messageId: string;
      normalizedAddress: string;
      platformIdentityId: string | null;
      raw: Record<string, unknown>;
    }>;
    attachments: Array<{
      contentType: string | null;
      filename: string | null;
      id: string;
      localBlobRef: string | null;
      messageId: string;
      metadata: Record<string, unknown>;
      providerAttachmentId: string | null;
      redactionStatus: string | null;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  }) | ({
    accountId: string;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  })>;
};

/** Input shape for `mail.messages.read`. */
export type MailMessagesReadInput = {
  addresses?: boolean;
  message: string;
};

/** Return shape for `mail.messages.read`. */
export type MailMessagesReadReturn = {
  message: ({
    accountId: string;
    addresses: Array<{
      address: string;
      agentId: string | null;
      contactId: string | null;
      displayName: string | null;
      id: string;
      kind: "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
      messageId: string;
      normalizedAddress: string;
      platformIdentityId: string | null;
      raw: Record<string, unknown>;
    }>;
    attachments: Array<{
      contentType: string | null;
      filename: string | null;
      id: string;
      localBlobRef: string | null;
      messageId: string;
      metadata: Record<string, unknown>;
      providerAttachmentId: string | null;
      redactionStatus: string | null;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  }) | ({
    accountId: string;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  });
};

/** Input shape for `mail.messages.search`. */
export type MailMessagesSearchInput = {
  limit?: string;
  mailbox?: string;
  query: string;
};

/** Return shape for `mail.messages.search`. */
export type MailMessagesSearchReturn = {
  messages: Array<({
    accountId: string;
    addresses: Array<{
      address: string;
      agentId: string | null;
      contactId: string | null;
      displayName: string | null;
      id: string;
      kind: "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
      messageId: string;
      normalizedAddress: string;
      platformIdentityId: string | null;
      raw: Record<string, unknown>;
    }>;
    attachments: Array<{
      contentType: string | null;
      filename: string | null;
      id: string;
      localBlobRef: string | null;
      messageId: string;
      metadata: Record<string, unknown>;
      providerAttachmentId: string | null;
      redactionStatus: string | null;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  }) | ({
    accountId: string;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  })>;
};

/** Input shape for `mail.outbox.inspect`. */
export type MailOutboxInspectInput = {
  outbox: string;
};

/** Return shape for `mail.outbox.inspect`. */
export type MailOutboxInspectReturn = {
  outbox: {
    accountId: string;
    ackedAt: number | null;
    attemptCount: number;
    createdAt: number;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    mailboxId: string;
    messageId: string;
    nextAttemptAt: number;
    operation: "send" | "reply" | "draft" | "update_draft" | "delete_draft";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
};

/** Input shape for `mail.outbox.list`. */
export type MailOutboxListInput = {
  limit?: string;
  mailbox?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `mail.outbox.list`. */
export type MailOutboxListReturn = {
  outbox: Array<{
    accountId: string;
    ackedAt: number | null;
    attemptCount: number;
    createdAt: number;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    mailboxId: string;
    messageId: string;
    nextAttemptAt: number;
    operation: "send" | "reply" | "draft" | "update_draft" | "delete_draft";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  }>;
};

/** Input shape for `mail.outbox.retry`. */
export type MailOutboxRetryInput = {
  outbox: string;
};

/** Return shape for `mail.outbox.retry`. */
export type MailOutboxRetryReturn = {
  outbox: {
    accountId: string;
    ackedAt: number | null;
    attemptCount: number;
    createdAt: number;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    mailboxId: string;
    messageId: string;
    nextAttemptAt: number;
    operation: "send" | "reply" | "draft" | "update_draft" | "delete_draft";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
};

/** Input shape for `mail.outbox.status`. */
export type MailOutboxStatusInput = Record<string, never>;

/** Return shape for `mail.outbox.status`. */
export type MailOutboxStatusReturn = {
  counts: Record<string, number>;
  total: number;
};

/** Input shape for `mail.providers.list`. */
export type MailProvidersListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `mail.providers.list`. */
export type MailProvidersListReturn = {
  providers: Array<{
    accounts: number;
    default: boolean;
    localFirst: boolean;
    provider: string;
  }>;
};

/** Input shape for `mail.providers.ravi-mail.mailboxes.create`. */
export type MailProvidersRaviMailMailboxesCreateInput = {
  addressOrLocalPart: string;
  console?: string;
  domain?: string;
};

/** Return shape for `mail.providers.ravi-mail.mailboxes.create`. */
export type MailProvidersRaviMailMailboxesCreateReturn = Record<string, unknown>;

/** Input shape for `mail.providers.ravi-mail.mailboxes.disable`. */
export type MailProvidersRaviMailMailboxesDisableInput = {
  console?: string;
  mailbox: string;
};

/** Return shape for `mail.providers.ravi-mail.mailboxes.disable`. */
export type MailProvidersRaviMailMailboxesDisableReturn = Record<string, unknown>;

/** Input shape for `mail.providers.ravi-mail.mailboxes.list`. */
export type MailProvidersRaviMailMailboxesListInput = {
  console?: string;
  domain?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `mail.providers.ravi-mail.mailboxes.list`. */
export type MailProvidersRaviMailMailboxesListReturn = Record<string, unknown>;

/** Input shape for `mail.providers.ravi-mail.mailboxes.show`. */
export type MailProvidersRaviMailMailboxesShowInput = {
  console?: string;
  mailbox: string;
};

/** Return shape for `mail.providers.ravi-mail.mailboxes.show`. */
export type MailProvidersRaviMailMailboxesShowReturn = Record<string, unknown>;

/** Input shape for `mail.providers.ravi-mail.messages.list`. */
export type MailProvidersRaviMailMessagesListInput = {
  addresses?: boolean;
  console?: string;
  limit?: string;
  mailbox?: string;
  offset?: string;
};

/** Return shape for `mail.providers.ravi-mail.messages.list`. */
export type MailProvidersRaviMailMessagesListReturn = Record<string, unknown>;

/** Input shape for `mail.providers.ravi-mail.messages.read`. */
export type MailProvidersRaviMailMessagesReadInput = {
  console?: string;
  message: string;
  payload?: string;
};

/** Return shape for `mail.providers.ravi-mail.messages.read`. */
export type MailProvidersRaviMailMessagesReadReturn = Record<string, unknown>;

/** Input shape for `mail.providers.ravi-mail.messages.show`. */
export type MailProvidersRaviMailMessagesShowInput = {
  addresses?: boolean;
  console?: string;
  message: string;
};

/** Return shape for `mail.providers.ravi-mail.messages.show`. */
export type MailProvidersRaviMailMessagesShowReturn = Record<string, unknown>;

/** Input shape for `mail.providers.ravi-mail.send`. */
export type MailProvidersRaviMailSendInput = {
  body?: string;
  console?: string;
  from?: string;
  idempotencyKey?: string;
  subject?: string;
  to?: string;
};

/** Return shape for `mail.providers.ravi-mail.send`. */
export type MailProvidersRaviMailSendReturn = Record<string, unknown>;

/** Input shape for `mail.reply`. */
export type MailReplyInput = {
  bcc?: string;
  body?: string;
  cc?: string;
  from?: string;
  idempotencyKey?: string;
  message: string;
  subject?: string;
  to?: string;
};

/** Return shape for `mail.reply`. */
export type MailReplyReturn = {
  message: ({
    accountId: string;
    addresses: Array<{
      address: string;
      agentId: string | null;
      contactId: string | null;
      displayName: string | null;
      id: string;
      kind: "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
      messageId: string;
      normalizedAddress: string;
      platformIdentityId: string | null;
      raw: Record<string, unknown>;
    }>;
    attachments: Array<{
      contentType: string | null;
      filename: string | null;
      id: string;
      localBlobRef: string | null;
      messageId: string;
      metadata: Record<string, unknown>;
      providerAttachmentId: string | null;
      redactionStatus: string | null;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  }) | ({
    accountId: string;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  });
  outbox: {
    accountId: string;
    ackedAt: number | null;
    attemptCount: number;
    createdAt: number;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    mailboxId: string;
    messageId: string;
    nextAttemptAt: number;
    operation: "send" | "reply" | "draft" | "update_draft" | "delete_draft";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
  queued: true;
};

/** Input shape for `mail.send`. */
export type MailSendInput = {
  body?: string;
  from?: string;
  idempotencyKey?: string;
  subject?: string;
  to?: string;
};

/** Return shape for `mail.send`. */
export type MailSendReturn = {
  message: ({
    accountId: string;
    addresses: Array<{
      address: string;
      agentId: string | null;
      contactId: string | null;
      displayName: string | null;
      id: string;
      kind: "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
      messageId: string;
      normalizedAddress: string;
      platformIdentityId: string | null;
      raw: Record<string, unknown>;
    }>;
    attachments: Array<{
      contentType: string | null;
      filename: string | null;
      id: string;
      localBlobRef: string | null;
      messageId: string;
      metadata: Record<string, unknown>;
      providerAttachmentId: string | null;
      redactionStatus: string | null;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  }) | ({
    accountId: string;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  });
  outbox: {
    accountId: string;
    ackedAt: number | null;
    attemptCount: number;
    createdAt: number;
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    mailboxId: string;
    messageId: string;
    nextAttemptAt: number;
    operation: "send" | "reply" | "draft" | "update_draft" | "delete_draft";
    payload: Record<string, unknown>;
    providerResult: (Record<string, unknown>) | null;
    status: "pending" | "leased" | "sending" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
  queued: true;
};

/** Input shape for `mail.threads.read`. */
export type MailThreadsReadInput = {
  addresses?: boolean;
  thread: string;
};

/** Return shape for `mail.threads.read`. */
export type MailThreadsReadReturn = {
  messages: Array<({
    accountId: string;
    addresses: Array<{
      address: string;
      agentId: string | null;
      contactId: string | null;
      displayName: string | null;
      id: string;
      kind: "from" | "to" | "cc" | "bcc" | "reply_to" | "sender";
      messageId: string;
      normalizedAddress: string;
      platformIdentityId: string | null;
      raw: Record<string, unknown>;
    }>;
    attachments: Array<{
      contentType: string | null;
      filename: string | null;
      id: string;
      localBlobRef: string | null;
      messageId: string;
      metadata: Record<string, unknown>;
      providerAttachmentId: string | null;
      redactionStatus: string | null;
      sha256: string | null;
      sizeBytes: number | null;
    }>;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  }) | ({
    accountId: string;
    bodyRedactionStatus: "full_local" | "preview_only" | "redacted" | "missing";
    createdAt: number;
    dateHeaderAt: number | null;
    direction: "inbound" | "outbound" | "draft" | "system";
    id: string;
    mailboxId: string;
    providerHistoryId: string | null;
    providerMessageId: string | null;
    providerProvenance: Record<string, unknown>;
    providerThreadId: string | null;
    receivedAt: number | null;
    rfcMessageId: string | null;
    safePayload: Record<string, unknown>;
    sentAt: number | null;
    snippet: string | null;
    status: "received" | "queued" | "sending" | "sent" | "delivered" | "failed" | "archived" | "trashed" | "spam";
    subject: string | null;
    subjectNormalized: string | null;
    threadId: string;
    updatedAt: number;
  })>;
  thread: {
    createdAt: number;
    id: string;
    lastLocalMessageId: string | null;
    latestMessageAt: number | null;
    metadata: Record<string, unknown>;
    participants: unknown[];
    providerThreadRefs: Record<string, unknown>;
    subjectNormalized: string | null;
    updatedAt: number;
  };
};

/** Input shape for `media.send`. */
export type MediaSendInput = {
  account?: string;
  caption?: string;
  channel?: string;
  filePath: string;
  ptt?: boolean;
  threadId?: string;
  to?: string;
};

/** Return shape for `media.send`. */
export type MediaSendReturn = {
  delivery: Record<string, unknown>;
  media: {
    caption?: string;
    filePath: string;
    filename: string;
    mimeType: string;
    type: string;
    voiceNote: boolean;
    [k: string]: unknown;
  };
  success: true;
  target: {
    accountId: string;
    channel?: string;
    chatId: string;
    instanceId: string;
    threadId?: string;
    [k: string]: unknown;
  };
};

/** Input shape for `metrics.dates`. */
export type MetricsDatesInput = Record<string, never>;

/** Return shape for `metrics.dates`. */
export type MetricsDatesReturn = string[];

/** Input shape for `metrics.rollup`. */
export type MetricsRollupInput = {
  since?: string;
  through?: string;
};

/** Return shape for `metrics.rollup`. */
export type MetricsRollupReturn = {
  dates: string[];
  rowsWritten: number;
};

/** Input shape for `metrics.show`. */
export type MetricsShowInput = {
  agent?: string;
  by?: string;
  days?: string;
  since?: string;
  through?: string;
};

/** Return shape for `metrics.show`. */
export type MetricsShowReturn = Array<{
  agentId: string;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costEventCount: number;
  date: string;
  inputTokens: number;
  model: string;
  outputTokens: number;
  rolledUpAt: number;
  toolCalls: number;
  toolErrors: number;
  totalCostUsd: number;
  totalDurationMs: number;
  turnsComplete: number;
  turnsFailed: number;
  turnsInterrupted: number;
}>;

/** Input shape for `observers.list`. */
export type ObserversListInput = {
  agent?: string;
  limit?: string;
  offset?: string;
  session?: string;
};

/** Return shape for `observers.list`. */
export type ObserversListReturn = {
  bindings: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `observers.profiles.init`. */
export type ObserversProfilesInitInput = {
  overwrite?: boolean;
  profileId: string;
  source?: string;
};

/** Return shape for `observers.profiles.init`. */
export type ObserversProfilesInitReturn = {
  profileDir: string;
  profilePath: string;
  sourceKind: string;
  [k: string]: unknown;
};

/** Input shape for `observers.profiles.list`. */
export type ObserversProfilesListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `observers.profiles.list`. */
export type ObserversProfilesListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  profiles: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `observers.profiles.preview`. */
export type ObserversProfilesPreviewInput = {
  event?: string;
  profileId: string;
};

/** Return shape for `observers.profiles.preview`. */
export type ObserversProfilesPreviewReturn = {
  eventMarkdown: string;
  eventType: string;
  profile: Record<string, unknown>;
  prompt: string;
  [k: string]: unknown;
};

/** Input shape for `observers.profiles.show`. */
export type ObserversProfilesShowInput = {
  profileId: string;
};

/** Return shape for `observers.profiles.show`. */
export type ObserversProfilesShowReturn = {
  body: string;
  profile: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `observers.profiles.validate`. */
export type ObserversProfilesValidateInput = {
  profileId?: string;
};

/** Return shape for `observers.profiles.validate`. */
export type ObserversProfilesValidateReturn = {
  errors: Array<Record<string, unknown>>;
  ok: boolean;
  profiles: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `observers.refresh`. */
export type ObserversRefreshInput = {
  session: string;
};

/** Return shape for `observers.refresh`. */
export type ObserversRefreshReturn = {
  bindings: Array<Record<string, unknown>>;
  created: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  source: Record<string, unknown>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.disable`. */
export type ObserversRulesDisableInput = {
  id: string;
};

/** Return shape for `observers.rules.disable`. */
export type ObserversRulesDisableReturn = {
  rule: Record<string, unknown>;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.enable`. */
export type ObserversRulesEnableInput = {
  id: string;
};

/** Return shape for `observers.rules.enable`. */
export type ObserversRulesEnableReturn = {
  rule: Record<string, unknown>;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.explain`. */
export type ObserversRulesExplainInput = {
  session: string;
};

/** Return shape for `observers.rules.explain`. */
export type ObserversRulesExplainReturn = {
  bindings: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  source: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.list`. */
export type ObserversRulesListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `observers.rules.list`. */
export type ObserversRulesListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  rules: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.rm`. */
export type ObserversRulesRmInput = {
  id: string;
};

/** Return shape for `observers.rules.rm`. */
export type ObserversRulesRmReturn = {
  deleted: unknown;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.set`. */
export type ObserversRulesSetInput = {
  delivery?: string;
  disabled?: boolean;
  events?: string;
  id: string;
  meta?: string;
  mode?: string;
  model?: string;
  observerAgentId: string;
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
};

/** Return shape for `observers.rules.set`. */
export type ObserversRulesSetReturn = {
  rule: Record<string, unknown>;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.show`. */
export type ObserversRulesShowInput = {
  id: string;
};

/** Return shape for `observers.rules.show`. */
export type ObserversRulesShowReturn = {
  rule: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `observers.rules.validate`. */
export type ObserversRulesValidateInput = Record<string, never>;

/** Return shape for `observers.rules.validate`. */
export type ObserversRulesValidateReturn = {
  errors: Array<Record<string, unknown>>;
  ok: boolean;
  [k: string]: unknown;
};

/** Input shape for `observers.show`. */
export type ObserversShowInput = {
  bindingId: string;
};

/** Return shape for `observers.show`. */
export type ObserversShowReturn = {
  binding: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `pages.create`. */
export type PagesCreateInput = {
  console?: string;
  defaultSite?: boolean;
  project: string;
  slug: string;
  visibility?: string;
};

/** Return shape for `pages.create`. */
export type PagesCreateReturn = {
  consoleUrl: string;
  projectRef: string;
  site: Record<string, unknown>;
  success: true;
  url: string | null;
};

/** Input shape for `pages.domains`. */
export type PagesDomainsInput = {
  check?: boolean;
  console?: string;
  hostnames: string[];
  project: string;
  site: string;
};

/** Return shape for `pages.domains`. */
export type PagesDomainsReturn = {
  bindings: Array<Record<string, unknown>>;
  consoleUrl: string;
  hostnames: string[];
  projectRef: string;
  site: Record<string, unknown>;
  siteRef: string;
  success: true;
  total: number;
};

/** Input shape for `pages.list`. */
export type PagesListInput = {
  console?: string;
  limit?: string;
  offset?: string;
  project: string;
};

/** Return shape for `pages.list`. */
export type PagesListReturn = {
  consoleUrl: string;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  projectRef: string;
  sites: Array<Record<string, unknown>>;
  success: true;
  total: number;
};

/** Input shape for `pages.update`. */
export type PagesUpdateInput = {
  console?: string;
  project: string;
  site: string;
  visibility?: string;
};

/** Return shape for `pages.update`. */
export type PagesUpdateReturn = {
  consoleUrl: string;
  edgeManifestRepair: unknown;
  projectRef: string;
  site: Record<string, unknown>;
  siteRef: string;
  success: true;
  url: string | null;
};

/** Input shape for `pages.visibility`. */
export type PagesVisibilityInput = {
  console?: string;
  project: string;
  site: string;
  visibility: string;
};

/** Return shape for `pages.visibility`. */
export type PagesVisibilityReturn = {
  consoleUrl: string;
  edgeManifestRepair: unknown;
  projectRef: string;
  site: Record<string, unknown>;
  siteRef: string;
  success: true;
  url: string | null;
};

/** Input shape for `permissions.check`. */
export type PermissionsCheckInput = {
  object: string;
  permission: string;
  subject: string;
};

/** Return shape for `permissions.check`. */
export type PermissionsCheckReturn = {
  allowed: boolean;
  object: {
    id: string;
    raw: string;
    type: string;
  };
  permission: string;
  subject: {
    id: string;
    raw: string;
    type: string;
  };
};

/** Input shape for `permissions.clear`. */
export type PermissionsClearInput = {
  all?: boolean;
};

/** Return shape for `permissions.clear`. */
export type PermissionsClearReturn = {
  changedCount: number;
  status: "cleared";
  target: {
    type: string;
    [k: string]: unknown;
  };
};

/** Input shape for `permissions.explain`. */
export type PermissionsExplainInput = {
  actor?: string;
  agent?: string;
  broad?: boolean;
  chat?: string;
  denial?: string;
  object?: string;
  relation?: string;
  session?: string;
};

/** Return shape for `permissions.explain`. */
export type PermissionsExplainReturn = Record<string, unknown>;

/** Input shape for `permissions.grant`. */
export type PermissionsGrantInput = {
  expiresAt?: string;
  object: string;
  permanent?: boolean;
  reason?: string;
  relation: string;
  subject: string;
  ttl?: string;
};

/** Return shape for `permissions.grant`. */
export type PermissionsGrantReturn = {
  changedCount: number;
  relation: {
    active?: boolean;
    expiresAt?: number | null;
    grantMode?: "temporary" | "permanent";
    id?: string | number;
    issuedBy?: string | null;
    object: string;
    objectId: string;
    objectMembers?: string[];
    objectType: string;
    reason?: string | null;
    relation: string;
    revocationBatchId?: string | null;
    revokedAt?: number | null;
    source?: string;
    subject: string;
    subjectId: string;
    subjectType: string;
    [k: string]: unknown;
  };
  status: "granted";
  target: {
    type: string;
    [k: string]: unknown;
  };
  warnings: Array<Record<string, unknown>>;
};

/** Input shape for `permissions.init`. */
export type PermissionsInitInput = {
  expiresAt?: string;
  permanent?: boolean;
  reason?: string;
  subject: string;
  template: string;
  ttl?: string;
};

/** Return shape for `permissions.init`. */
export type PermissionsInitReturn = {
  changedCount: number;
  relations: Array<{
    active?: boolean;
    expiresAt?: number | null;
    grantMode?: "temporary" | "permanent";
    id?: string | number;
    issuedBy?: string | null;
    object: string;
    objectId: string;
    objectMembers?: string[];
    objectType: string;
    reason?: string | null;
    relation: string;
    revocationBatchId?: string | null;
    revokedAt?: number | null;
    source?: string;
    subject: string;
    subjectId: string;
    subjectType: string;
    [k: string]: unknown;
  }>;
  status: "applied";
  target: {
    type: string;
    [k: string]: unknown;
  };
};

/** Input shape for `permissions.legacy`. */
export type PermissionsLegacyInput = {
  apply?: boolean;
  breakGlass?: boolean;
  confirm?: string;
  includeSpecific?: boolean;
  limit?: string;
  maxZeroSubjects?: string;
  subject?: string;
};

/** Return shape for `permissions.legacy`. */
export type PermissionsLegacyReturn = Record<string, unknown>;

/** Input shape for `permissions.list`. */
export type PermissionsListInput = {
  all?: boolean;
  limit?: string;
  object?: string;
  offset?: string;
  relation?: string;
  source?: string;
  subject?: string;
};

/** Return shape for `permissions.list`. */
export type PermissionsListReturn = {
  filter: {
    includeInactive?: boolean;
    objectId?: string;
    objectType?: string;
    relation?: string;
    source?: string;
    subjectId?: string;
    subjectType?: string;
    [k: string]: unknown;
  };
  items: Array<{
    active?: boolean;
    expiresAt?: number | null;
    grantMode?: "temporary" | "permanent";
    id?: string | number;
    issuedBy?: string | null;
    object: string;
    objectId: string;
    objectMembers?: string[];
    objectType: string;
    reason?: string | null;
    relation: string;
    revocationBatchId?: string | null;
    revokedAt?: number | null;
    source?: string;
    subject: string;
    subjectId: string;
    subjectType: string;
    [k: string]: unknown;
  }>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  relations: Array<{
    active?: boolean;
    expiresAt?: number | null;
    grantMode?: "temporary" | "permanent";
    id?: string | number;
    issuedBy?: string | null;
    object: string;
    objectId: string;
    objectMembers?: string[];
    objectType: string;
    reason?: string | null;
    relation: string;
    revocationBatchId?: string | null;
    revokedAt?: number | null;
    source?: string;
    subject: string;
    subjectId: string;
    subjectType: string;
    [k: string]: unknown;
  }>;
  total: number;
};

/** Input shape for `permissions.policies.apply`. */
export type PermissionsPoliciesApplyInput = {
  dir?: string;
  policy?: string;
};

/** Return shape for `permissions.policies.apply`. */
export type PermissionsPoliciesApplyReturn = Record<string, unknown>;

/** Input shape for `permissions.policies.dry-run`. */
export type PermissionsPoliciesDryRunInput = {
  dir?: string;
  policy?: string;
};

/** Return shape for `permissions.policies.dry-run`. */
export type PermissionsPoliciesDryRunReturn = Record<string, unknown>;

/** Input shape for `permissions.policies.explain`. */
export type PermissionsPoliciesExplainInput = {
  asset: string;
  dir?: string;
};

/** Return shape for `permissions.policies.explain`. */
export type PermissionsPoliciesExplainReturn = Record<string, unknown>;

/** Input shape for `permissions.policies.list`. */
export type PermissionsPoliciesListInput = {
  dir?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `permissions.policies.list`. */
export type PermissionsPoliciesListReturn = Record<string, unknown>;

/** Input shape for `permissions.policies.reconcile`. */
export type PermissionsPoliciesReconcileInput = {
  dir?: string;
  policy?: string;
};

/** Return shape for `permissions.policies.reconcile`. */
export type PermissionsPoliciesReconcileReturn = Record<string, unknown>;

/** Input shape for `permissions.policies.show`. */
export type PermissionsPoliciesShowInput = {
  dir?: string;
  policy: string;
};

/** Return shape for `permissions.policies.show`. */
export type PermissionsPoliciesShowReturn = Record<string, unknown>;

/** Input shape for `permissions.policies.validate`. */
export type PermissionsPoliciesValidateInput = {
  dir?: string;
  policy?: string;
};

/** Return shape for `permissions.policies.validate`. */
export type PermissionsPoliciesValidateReturn = Record<string, unknown>;

/** Input shape for `permissions.prune-revoked`. */
export type PermissionsPruneRevokedInput = {
  apply?: boolean;
  confirm?: string;
  olderThanDays?: string;
};

/** Return shape for `permissions.prune-revoked`. */
export type PermissionsPruneRevokedReturn = Record<string, unknown>;

/** Input shape for `permissions.restore-batch`. */
export type PermissionsRestoreBatchInput = {
  apply?: boolean;
  batch: string;
  confirm?: string;
  revokedAt?: boolean;
  subject?: string;
};

/** Return shape for `permissions.restore-batch`. */
export type PermissionsRestoreBatchReturn = Record<string, unknown>;

/** Input shape for `permissions.revoke`. */
export type PermissionsRevokeInput = {
  object: string;
  relation: string;
  subject: string;
};

/** Return shape for `permissions.revoke`. */
export type PermissionsRevokeReturn = {
  changedCount: number;
  relation: {
    active?: boolean;
    expiresAt?: number | null;
    grantMode?: "temporary" | "permanent";
    id?: string | number;
    issuedBy?: string | null;
    object: string;
    objectId: string;
    objectMembers?: string[];
    objectType: string;
    reason?: string | null;
    relation: string;
    revocationBatchId?: string | null;
    revokedAt?: number | null;
    source?: string;
    subject: string;
    subjectId: string;
    subjectType: string;
    [k: string]: unknown;
  };
  remainingIndividualRelations: Array<{
    active?: boolean;
    expiresAt?: number | null;
    grantMode?: "temporary" | "permanent";
    id?: string | number;
    issuedBy?: string | null;
    object: string;
    objectId: string;
    objectMembers?: string[];
    objectType: string;
    reason?: string | null;
    relation: string;
    revocationBatchId?: string | null;
    revokedAt?: number | null;
    source?: string;
    subject: string;
    subjectId: string;
    subjectType: string;
    [k: string]: unknown;
  }>;
  status: "revoked";
  target: {
    type: string;
    [k: string]: unknown;
  };
};

/** Input shape for `permissions.sync`. */
export type PermissionsSyncInput = Record<string, never>;

/** Return shape for `permissions.sync`. */
export type PermissionsSyncReturn = {
  changedCount: number;
  relations: Array<{
    active?: boolean;
    expiresAt?: number | null;
    grantMode?: "temporary" | "permanent";
    id?: string | number;
    issuedBy?: string | null;
    object: string;
    objectId: string;
    objectMembers?: string[];
    objectType: string;
    reason?: string | null;
    relation: string;
    revocationBatchId?: string | null;
    revokedAt?: number | null;
    source?: string;
    subject: string;
    subjectId: string;
    subjectType: string;
    [k: string]: unknown;
  }>;
  status: "synced";
  target: {
    type: string;
    [k: string]: unknown;
  };
};

/** Input shape for `projects.create`. */
export type ProjectsCreateInput = {
  hypothesis?: string;
  lastSignalAt?: string;
  nextStep?: string;
  ownerAgent?: string;
  session?: string;
  slug?: string;
  status?: string;
  summary?: string;
  title: string;
};

/** Return shape for `projects.create`. */
export type ProjectsCreateReturn = Record<string, unknown>;

/** Input shape for `projects.fixtures.seed`. */
export type ProjectsFixturesSeedInput = {
  ownerAgent?: string;
};

/** Return shape for `projects.fixtures.seed`. */
export type ProjectsFixturesSeedReturn = {
  fixtures: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `projects.init`. */
export type ProjectsInitInput = {
  hypothesis?: string;
  lastSignalAt?: string;
  nextStep?: string;
  ownerAgent?: string;
  resource?: string[];
  session?: string;
  slug?: string;
  status?: string;
  summary?: string;
  title: string;
  workflowRun?: string[];
  workflowTemplate?: string[];
};

/** Return shape for `projects.init`. */
export type ProjectsInitReturn = {
  details: Record<string, unknown>;
  workflows: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `projects.link`. */
export type ProjectsLinkInput = {
  assetType: string;
  label?: string;
  meta?: string;
  project: string;
  resourceType?: string;
  role?: string;
  target: string;
};

/** Return shape for `projects.link`. */
export type ProjectsLinkReturn = Record<string, unknown>;

/** Input shape for `projects.list`. */
export type ProjectsListInput = {
  limit?: string;
  offset?: string;
  status?: string;
  tag?: string;
};

/** Return shape for `projects.list`. */
export type ProjectsListReturn = {
  filters: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  projects: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `projects.next`. */
export type ProjectsNextInput = {
  status?: string;
  tag?: string;
};

/** Return shape for `projects.next`. */
export type ProjectsNextReturn = {
  filters: Record<string, unknown>;
  projects: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `projects.resources.add`. */
export type ProjectsResourcesAddInput = {
  label?: string;
  meta?: string;
  project: string;
  role?: string;
  target: string;
  type?: string;
};

/** Return shape for `projects.resources.add`. */
export type ProjectsResourcesAddReturn = Record<string, unknown>;

/** Input shape for `projects.resources.import`. */
export type ProjectsResourcesImportInput = {
  group?: string[];
  meta?: string;
  project: string;
  repo?: string[];
  role?: string;
  url?: string[];
  worktree?: string[];
};

/** Return shape for `projects.resources.import`. */
export type ProjectsResourcesImportReturn = {
  resources: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `projects.resources.list`. */
export type ProjectsResourcesListInput = {
  limit?: string;
  offset?: string;
  project: string;
  type?: string;
};

/** Return shape for `projects.resources.list`. */
export type ProjectsResourcesListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  resources: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `projects.resources.show`. */
export type ProjectsResourcesShowInput = {
  project: string;
  resource: string;
};

/** Return shape for `projects.resources.show`. */
export type ProjectsResourcesShowReturn = Record<string, unknown>;

/** Input shape for `projects.show`. */
export type ProjectsShowInput = {
  project: string;
};

/** Return shape for `projects.show`. */
export type ProjectsShowReturn = Record<string, unknown>;

/** Input shape for `projects.status`. */
export type ProjectsStatusInput = {
  project: string;
};

/** Return shape for `projects.status`. */
export type ProjectsStatusReturn = Record<string, unknown>;

/** Input shape for `projects.tasks.attach`. */
export type ProjectsTasksAttachInput = {
  agent?: string;
  dispatch?: boolean;
  nodeKey: string;
  project: string;
  session?: string;
  taskId: string;
  workflow?: string;
};

/** Return shape for `projects.tasks.attach`. */
export type ProjectsTasksAttachReturn = {
  defaults: Record<string, unknown>;
  details: Record<string, unknown>;
  workflow: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `projects.tasks.create`. */
export type ProjectsTasksCreateInput = {
  agent?: string;
  dispatch?: boolean;
  instructions?: string;
  nodeKey: string;
  priority?: string;
  profile?: string;
  project: string;
  session?: string;
  title: string;
  workflow?: string;
};

/** Return shape for `projects.tasks.create`. */
export type ProjectsTasksCreateReturn = {
  defaults: Record<string, unknown>;
  details: Record<string, unknown>;
  workflow: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `projects.tasks.dispatch`. */
export type ProjectsTasksDispatchInput = {
  agent?: string;
  project: string;
  session?: string;
  taskId: string;
};

/** Return shape for `projects.tasks.dispatch`. */
export type ProjectsTasksDispatchReturn = {
  defaults: Record<string, unknown>;
  details: Record<string, unknown>;
  workflow: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `projects.update`. */
export type ProjectsUpdateInput = {
  hypothesis?: string;
  lastSignalAt?: string;
  nextStep?: string;
  ownerAgent?: string;
  project: string;
  session?: string;
  status?: string;
  summary?: string;
  title?: string;
  touchSignal?: boolean;
};

/** Return shape for `projects.update`. */
export type ProjectsUpdateReturn = Record<string, unknown>;

/** Input shape for `projects.workflows.attach`. */
export type ProjectsWorkflowsAttachInput = {
  project: string;
  role?: string;
  runId: string;
};

/** Return shape for `projects.workflows.attach`. */
export type ProjectsWorkflowsAttachReturn = {
  details: Record<string, unknown>;
  workflow: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `projects.workflows.start`. */
export type ProjectsWorkflowsStartInput = {
  project: string;
  role?: string;
  runId?: string;
  specId: string;
};

/** Return shape for `projects.workflows.start`. */
export type ProjectsWorkflowsStartReturn = {
  details: Record<string, unknown>;
  workflow: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.cancel`. */
export type ProxCallsCancelInput = {
  call_request_id: string;
  reason?: string;
};

/** Return shape for `prox.calls.cancel`. */
export type ProxCallsCancelReturn = {
  message: string;
  request_id: string;
  success: boolean;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.events`. */
export type ProxCallsEventsInput = {
  call_request_id: string;
};

/** Return shape for `prox.calls.events`. */
export type ProxCallsEventsReturn = {
  events: Array<Record<string, unknown>>;
  request_id: string;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.profiles.configure`. */
export type ProxCallsProfilesConfigureInput = {
  agentId?: string;
  dynamicPlaceholder?: string[];
  firstMessage?: string;
  language?: string;
  profile_id: string;
  prompt?: string;
  provider?: string;
  skipProviderSync?: boolean;
  systemPromptPath?: string;
  twilioNumberId?: string;
  voicemailPolicy?: string;
};

/** Return shape for `prox.calls.profiles.configure`. */
export type ProxCallsProfilesConfigureReturn = {
  profile: Record<string, unknown>;
  provider_sync: unknown | null;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.profiles.list`. */
export type ProxCallsProfilesListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `prox.calls.profiles.list`. */
export type ProxCallsProfilesListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.profiles.show`. */
export type ProxCallsProfilesShowInput = {
  profile_id: string;
};

/** Return shape for `prox.calls.profiles.show`. */
export type ProxCallsProfilesShowReturn = Record<string, unknown>;

/** Input shape for `prox.calls.request`. */
export type ProxCallsRequestInput = {
  force?: boolean;
  person?: string;
  phone?: string;
  priority?: string;
  profile?: string;
  reason?: string;
  skipOriginNotify?: boolean;
  var?: string[];
};

/** Return shape for `prox.calls.request`. */
export type ProxCallsRequestReturn = {
  block_reason?: string | null;
  blocked: boolean;
  hint: string;
  provider_mode: "stub" | "live";
  request: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.rules`. */
export type ProxCallsRulesInput = {
  scope?: string;
};

/** Return shape for `prox.calls.rules`. */
export type ProxCallsRulesReturn = (Record<string, unknown>) | ({
  message: string;
  rules: null;
  [k: string]: unknown;
});

/** Input shape for `prox.calls.show`. */
export type ProxCallsShowInput = {
  call_request_id: string;
};

/** Return shape for `prox.calls.show`. */
export type ProxCallsShowReturn = {
  request: Record<string, unknown>;
  result: (Record<string, unknown>) | null;
  runs: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.tools.bind`. */
export type ProxCallsToolsBindInput = {
  profile_id: string;
  providerToolName?: string;
  required?: boolean;
  toolPrompt?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.bind`. */
export type ProxCallsToolsBindReturn = Record<string, unknown>;

/** Input shape for `prox.calls.tools.configure`. */
export type ProxCallsToolsConfigureInput = {
  enabled?: string;
  timeoutMs?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.configure`. */
export type ProxCallsToolsConfigureReturn = Record<string, unknown>;

/** Input shape for `prox.calls.tools.create`. */
export type ProxCallsToolsCreateInput = {
  description?: string;
  executor?: string;
  inputSchema?: string;
  name?: string;
  outputSchema?: string;
  sideEffect?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.create`. */
export type ProxCallsToolsCreateReturn = Record<string, unknown>;

/** Input shape for `prox.calls.tools.list`. */
export type ProxCallsToolsListInput = {
  limit?: string;
  offset?: string;
  profile?: string;
  tag?: string;
};

/** Return shape for `prox.calls.tools.list`. */
export type ProxCallsToolsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.tools.run`. */
export type ProxCallsToolsRunInput = {
  dryRun?: boolean;
  input?: string;
  profile?: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.run`. */
export type ProxCallsToolsRunReturn = {
  ok: boolean;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.tools.runs`. */
export type ProxCallsToolsRunsInput = {
  call_request_id: string;
};

/** Return shape for `prox.calls.tools.runs`. */
export type ProxCallsToolsRunsReturn = {
  request_id: string;
  tool_runs: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.tools.show`. */
export type ProxCallsToolsShowInput = {
  tool_id: string;
};

/** Return shape for `prox.calls.tools.show`. */
export type ProxCallsToolsShowReturn = Record<string, unknown>;

/** Input shape for `prox.calls.tools.unbind`. */
export type ProxCallsToolsUnbindInput = {
  profile_id: string;
  tool_id: string;
};

/** Return shape for `prox.calls.tools.unbind`. */
export type ProxCallsToolsUnbindReturn = {
  success: true;
  tool_id: string;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.transcript`. */
export type ProxCallsTranscriptInput = {
  call_request_id: string;
  sync?: boolean;
};

/** Return shape for `prox.calls.transcript`. */
export type ProxCallsTranscriptReturn = {
  outcome: string;
  request_id: string;
  summary?: string | null;
  transcript: string;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.voice-agents.bind-tool`. */
export type ProxCallsVoiceAgentsBindToolInput = {
  providerToolName?: string;
  tool_id: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.bind-tool`. */
export type ProxCallsVoiceAgentsBindToolReturn = Record<string, unknown>;

/** Input shape for `prox.calls.voice-agents.configure`. */
export type ProxCallsVoiceAgentsConfigureInput = {
  firstMessage?: string;
  providerAgentId?: string;
  systemPromptPath?: string;
  voiceId?: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.configure`. */
export type ProxCallsVoiceAgentsConfigureReturn = Record<string, unknown>;

/** Input shape for `prox.calls.voice-agents.create`. */
export type ProxCallsVoiceAgentsCreateInput = {
  name?: string;
  provider?: string;
  systemPromptPath?: string;
  voiceId?: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.create`. */
export type ProxCallsVoiceAgentsCreateReturn = Record<string, unknown>;

/** Input shape for `prox.calls.voice-agents.list`. */
export type ProxCallsVoiceAgentsListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `prox.calls.voice-agents.list`. */
export type ProxCallsVoiceAgentsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.voice-agents.show`. */
export type ProxCallsVoiceAgentsShowInput = {
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.show`. */
export type ProxCallsVoiceAgentsShowReturn = Record<string, unknown>;

/** Input shape for `prox.calls.voice-agents.sync`. */
export type ProxCallsVoiceAgentsSyncInput = {
  dryRun?: boolean;
  provider?: boolean;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.sync`. */
export type ProxCallsVoiceAgentsSyncReturn = {
  dry_run: boolean;
  intended_changes: Record<string, unknown>;
  provider: string;
  provider_agent_id?: string | null;
  provider_sync: string;
  voice_agent_id: string;
  [k: string]: unknown;
};

/** Input shape for `prox.calls.voice-agents.unbind-tool`. */
export type ProxCallsVoiceAgentsUnbindToolInput = {
  tool_id: string;
  voice_agent_id: string;
};

/** Return shape for `prox.calls.voice-agents.unbind-tool`. */
export type ProxCallsVoiceAgentsUnbindToolReturn = {
  success: true;
  tool_id: string;
  [k: string]: unknown;
};

/** Input shape for `react.send`. */
export type ReactSendInput = {
  emoji: string;
  messageId: string;
};

/** Return shape for `react.send`. */
export type ReactSendReturn = {
  event: {
    accountId: string;
    channel: string;
    chatId: string;
    emoji: string;
    messageId: string;
    [k: string]: unknown;
  };
  reaction: {
    emoji: string;
    messageId: string;
  };
  success: true;
  target: {
    accountId: string;
    channel: string;
    chatId: string;
  };
  topic: "ravi.outbound.reaction";
};

/** Input shape for `routes.explain`. */
export type RoutesExplainInput = {
  channel?: string;
  name: string;
  pattern: string;
};

/** Return shape for `routes.explain`. */
export type RoutesExplainReturn = {
  channel: string | null;
  configuredRoute: (Record<string, unknown>) | null;
  instance: string;
  liveEffect: (Record<string, unknown>) | null;
  pattern: string | null;
  target: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `routes.list`. */
export type RoutesListInput = {
  limit?: string;
  name?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `routes.list`. */
export type RoutesListReturn = {
  filter: Record<string, unknown>;
  instance: string | null;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  routes: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `routes.show`. */
export type RoutesShowInput = {
  name: string;
  pattern: string;
};

/** Return shape for `routes.show`. */
export type RoutesShowReturn = {
  instance: string;
  pattern: string;
  route: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `rules.import`. */
export type RulesImportInput = {
  cwd?: string;
  force?: boolean;
  includeUser?: boolean;
  source?: string;
  write?: boolean;
};

/** Return shape for `rules.import`. */
export type RulesImportReturn = {
  candidates: Array<Record<string, unknown>>;
  counts: Record<string, unknown>;
  cwd: string;
  force: boolean;
  includeUser: boolean;
  rulesDir: string;
  sources: Array<Record<string, unknown>>;
  write: boolean;
  [k: string]: unknown;
};

/** Input shape for `rules.sources`. */
export type RulesSourcesInput = {
  cwd?: string;
  includeUser?: boolean;
  source?: string;
};

/** Return shape for `rules.sources`. */
export type RulesSourcesReturn = {
  counts: {
    existingSources: number;
    missingSources: number;
    sources: number;
  };
  cwd: string;
  includeUser: boolean;
  provider: "all" | "claude" | "agents";
  sources: Array<Record<string, unknown>>;
};

/** Input shape for `runtime.credentials.add`. */
export type RuntimeCredentialsAddInput = {
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
};

/** Return shape for `runtime.credentials.add`. */
export type RuntimeCredentialsAddReturn = {
  credential: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.classify`. */
export type RuntimeCredentialsClassifyInput = {
  credential?: string;
  headers?: string;
  message?: string;
  provider?: string;
  providerCode?: string;
  providerType?: string;
  record?: boolean;
  status?: string;
  upstream?: string;
};

/** Return shape for `runtime.credentials.classify`. */
export type RuntimeCredentialsClassifyReturn = {
  pressure: Record<string, unknown>;
  signal: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.disable`. */
export type RuntimeCredentialsDisableInput = {
  id: string;
};

/** Return shape for `runtime.credentials.disable`. */
export type RuntimeCredentialsDisableReturn = {
  credential: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.enable`. */
export type RuntimeCredentialsEnableInput = {
  id: string;
};

/** Return shape for `runtime.credentials.enable`. */
export type RuntimeCredentialsEnableReturn = {
  credential: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.import`. */
export type RuntimeCredentialsImportInput = {
  fromClaudeCode?: boolean;
  fromCodexHome?: string;
  label?: string;
  managedRefresh?: boolean;
  provider?: string;
};

/** Return shape for `runtime.credentials.import`. */
export type RuntimeCredentialsImportReturn = {
  credential: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.list`. */
export type RuntimeCredentialsListInput = {
  all?: boolean;
  limit?: string;
  offset?: string;
  provider?: string;
  status?: string;
  upstream?: string;
};

/** Return shape for `runtime.credentials.list`. */
export type RuntimeCredentialsListReturn = {
  credentials: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  providerHealth: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.refresh`. */
export type RuntimeCredentialsRefreshInput = {
  agent?: string;
  force?: boolean;
  id?: string;
  model?: string;
  provider?: string;
  taskProfile?: string;
  upstream?: string;
};

/** Return shape for `runtime.credentials.refresh`. */
export type RuntimeCredentialsRefreshReturn = {
  refreshed: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.reset-health`. */
export type RuntimeCredentialsResetHealthInput = {
  id: string;
};

/** Return shape for `runtime.credentials.reset-health`. */
export type RuntimeCredentialsResetHealthReturn = {
  credential: Record<string, unknown>;
  health: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.select`. */
export type RuntimeCredentialsSelectInput = {
  agent?: string;
  model?: string;
  provider?: string;
  taskProfile?: string;
  upstream?: string;
};

/** Return shape for `runtime.credentials.select`. */
export type RuntimeCredentialsSelectReturn = {
  candidates: Array<Record<string, unknown>>;
  rejected: Array<Record<string, unknown>>;
  selected: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `runtime.credentials.status`. */
export type RuntimeCredentialsStatusInput = {
  id?: string;
};

/** Return shape for `runtime.credentials.status`. */
export type RuntimeCredentialsStatusReturn = {
  credential: Record<string, unknown>;
  health: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `sdk.client.check`. */
export type SdkClientCheckInput = {
  out?: string;
  version?: string;
};

/** Return shape for `sdk.client.check`. */
export type SdkClientCheckReturn = {
  dir: string;
  drift: Array<{
    file: string;
    path: string;
    reason: string;
  }>;
  files: string[];
};

/** Input shape for `sdk.client.generate`. */
export type SdkClientGenerateInput = {
  out?: string;
  version?: string;
};

/** Return shape for `sdk.client.generate`. */
export type SdkClientGenerateReturn = {
  dir: string;
  files: Array<{
    bytes: number;
    file: string;
    path: string;
  }>;
  status: "written";
};

/** Input shape for `sdk.openapi.check`. */
export type SdkOpenapiCheckInput = {
  against?: string;
};

/** Return shape for `sdk.openapi.check`. */
export type SdkOpenapiCheckReturn = {
  drift: boolean;
  liveBytes: number;
  path: string;
  storedBytes: number;
};

/** Input shape for `sdk.openapi.emit`. */
export type SdkOpenapiEmitInput = {
  out?: string;
  stdout?: boolean;
};

/** Return shape for `sdk.openapi.emit`. */
export type SdkOpenapiEmitReturn = ({
  bytes: number;
  status: "stdout";
}) | ({
  bytes: number;
  path: string;
  status: "written";
});

/** Input shape for `sdk.swift.check`. */
export type SdkSwiftCheckInput = {
  out?: string;
  version?: string;
};

/** Return shape for `sdk.swift.check`. */
export type SdkSwiftCheckReturn = {
  dir: string;
  drift: Array<{
    file: string;
    path: string;
    reason: string;
  }>;
  files: string[];
};

/** Input shape for `sdk.swift.generate`. */
export type SdkSwiftGenerateInput = {
  out?: string;
  version?: string;
};

/** Return shape for `sdk.swift.generate`. */
export type SdkSwiftGenerateReturn = {
  dir: string;
  files: Array<{
    bytes: number;
    file: string;
    path: string;
  }>;
  status: "written";
};

/** Input shape for `self.chat`. */
export type SelfChatInput = {
  depth?: string;
};

/** Return shape for `self.chat`. */
export type SelfChatReturn = {
  data?: unknown;
  reason?: string;
  status: "ok" | "partial" | "missing" | "unavailable";
  [k: string]: unknown;
};

/** Input shape for `self.context`. */
export type SelfContextInput = {
  depth?: string;
  limit?: string;
};

/** Return shape for `self.context`. */
export type SelfContextReturn = {
  actor: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  chat: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  depth: string;
  explain: Array<Record<string, unknown>>;
  generatedAt: number;
  identity: Record<string, unknown>;
  knowledge: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  limit: number;
  nextReads: string[];
  permissions: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  recent: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  route: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  session: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `self.explain`. */
export type SelfExplainInput = Record<string, never>;

/** Return shape for `self.explain`. */
export type SelfExplainReturn = {
  explain: Array<Record<string, unknown>>;
  generatedAt: number;
  nextReads: string[];
  [k: string]: unknown;
};

/** Input shape for `self.knowledge`. */
export type SelfKnowledgeInput = Record<string, never>;

/** Return shape for `self.knowledge`. */
export type SelfKnowledgeReturn = {
  data?: unknown;
  reason?: string;
  status: "ok" | "partial" | "missing" | "unavailable";
  [k: string]: unknown;
};

/** Input shape for `self.permissions`. */
export type SelfPermissionsInput = Record<string, never>;

/** Return shape for `self.permissions`. */
export type SelfPermissionsReturn = {
  data?: unknown;
  reason?: string;
  status: "ok" | "partial" | "missing" | "unavailable";
  [k: string]: unknown;
};

/** Input shape for `self.recent`. */
export type SelfRecentInput = {
  limit?: string;
};

/** Return shape for `self.recent`. */
export type SelfRecentReturn = {
  data?: unknown;
  reason?: string;
  status: "ok" | "partial" | "missing" | "unavailable";
  [k: string]: unknown;
};

/** Input shape for `self.route`. */
export type SelfRouteInput = Record<string, never>;

/** Return shape for `self.route`. */
export type SelfRouteReturn = {
  data?: unknown;
  reason?: string;
  status: "ok" | "partial" | "missing" | "unavailable";
  [k: string]: unknown;
};

/** Input shape for `self.whoami`. */
export type SelfWhoamiInput = Record<string, never>;

/** Return shape for `self.whoami`. */
export type SelfWhoamiReturn = {
  actor: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  chat: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  generatedAt: number;
  identity: Record<string, unknown>;
  nextReads: string[];
  route: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  session: {
    data?: unknown;
    reason?: string;
    status: "ok" | "partial" | "missing" | "unavailable";
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `sessions.actions`. */
export type SessionsActionsInput = {
  limit?: string;
  nameOrKey?: string;
};

/** Return shape for `sessions.actions`. */
export type SessionsActionsReturn = Record<string, unknown>;

/** Input shape for `sessions.answer`. */
export type SessionsAnswerInput = {
  barrier?: string;
  channel?: string;
  immediate?: boolean;
  message: string;
  sender?: string;
  steer?: boolean;
  target: string;
  to?: string;
};

/** Return shape for `sessions.answer`. */
export type SessionsAnswerReturn = Record<string, unknown>;

/** Input shape for `sessions.ask`. */
export type SessionsAskInput = {
  barrier?: string;
  channel?: string;
  immediate?: boolean;
  message: string;
  sender?: string;
  steer?: boolean;
  target: string;
  to?: string;
};

/** Return shape for `sessions.ask`. */
export type SessionsAskReturn = Record<string, unknown>;

/** Input shape for `sessions.attach`. */
export type SessionsAttachInput = {
  chat?: string;
  nameOrKey: string;
  reason?: string;
};

/** Return shape for `sessions.attach`. */
export type SessionsAttachReturn = Record<string, unknown>;

/** Input shape for `sessions.delete`. */
export type SessionsDeleteInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.delete`. */
export type SessionsDeleteReturn = Record<string, unknown>;

/** Input shape for `sessions.delete-message`. */
export type SessionsDeleteMessageInput = {
  messageRef?: string;
  sessionOrMessage: string;
};

/** Return shape for `sessions.delete-message`. */
export type SessionsDeleteMessageReturn = Record<string, unknown>;

/** Input shape for `sessions.detach`. */
export type SessionsDetachInput = {
  chat?: string;
  nameOrKey: string;
};

/** Return shape for `sessions.detach`. */
export type SessionsDetachReturn = Record<string, unknown>;

/** Input shape for `sessions.edit-message`. */
export type SessionsEditMessageInput = {
  messageOrText?: string;
  sessionOrMessage: string;
  text?: string;
  textArg?: string;
};

/** Return shape for `sessions.edit-message`. */
export type SessionsEditMessageReturn = Record<string, unknown>;

/** Input shape for `sessions.execute`. */
export type SessionsExecuteInput = {
  barrier?: string;
  channel?: string;
  immediate?: boolean;
  message: string;
  steer?: boolean;
  target: string;
  to?: string;
};

/** Return shape for `sessions.execute`. */
export type SessionsExecuteReturn = Record<string, unknown>;

/** Input shape for `sessions.extend`. */
export type SessionsExtendInput = {
  duration?: string;
  nameOrKey: string;
};

/** Return shape for `sessions.extend`. */
export type SessionsExtendReturn = Record<string, unknown>;

/** Input shape for `sessions.followups.add`. */
export type SessionsFollowupsAddInput = {
  at?: string;
  barrier?: string;
  cron?: string;
  description?: string;
  disabled?: boolean;
  every?: string;
  message?: string;
  name: string;
  owner?: string;
  step?: string[];
  targetChat?: string;
  targetList?: string;
  targetSession?: string;
  timezone?: string;
};

/** Return shape for `sessions.followups.add`. */
export type SessionsFollowupsAddReturn = Record<string, unknown>;

/** Input shape for `sessions.followups.inspect`. */
export type SessionsFollowupsInspectInput = {
  id: string;
  runs?: string;
};

/** Return shape for `sessions.followups.inspect`. */
export type SessionsFollowupsInspectReturn = Record<string, unknown>;

/** Input shape for `sessions.followups.list`. */
export type SessionsFollowupsListInput = {
  includeDisabled?: boolean;
  limit?: string;
  offset?: string;
  targetType?: string;
};

/** Return shape for `sessions.followups.list`. */
export type SessionsFollowupsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `sessions.followups.pause`. */
export type SessionsFollowupsPauseInput = {
  id: string;
};

/** Return shape for `sessions.followups.pause`. */
export type SessionsFollowupsPauseReturn = Record<string, unknown>;

/** Input shape for `sessions.followups.resume`. */
export type SessionsFollowupsResumeInput = {
  id: string;
};

/** Return shape for `sessions.followups.resume`. */
export type SessionsFollowupsResumeReturn = Record<string, unknown>;

/** Input shape for `sessions.followups.retry`. */
export type SessionsFollowupsRetryInput = {
  cadence?: string;
  run?: string;
};

/** Return shape for `sessions.followups.retry`. */
export type SessionsFollowupsRetryReturn = Record<string, unknown>;

/** Input shape for `sessions.followups.run`. */
export type SessionsFollowupsRunInput = {
  id: string;
};

/** Return shape for `sessions.followups.run`. */
export type SessionsFollowupsRunReturn = Record<string, unknown>;

/** Input shape for `sessions.followups.runs`. */
export type SessionsFollowupsRunsInput = {
  cadence?: string;
  limit?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `sessions.followups.runs`. */
export type SessionsFollowupsRunsReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `sessions.followups.snooze`. */
export type SessionsFollowupsSnoozeInput = {
  id: string;
  until?: string;
};

/** Return shape for `sessions.followups.snooze`. */
export type SessionsFollowupsSnoozeReturn = Record<string, unknown>;

/** Input shape for `sessions.goal`. */
export type SessionsGoalInput = {
  action: string;
  budget?: string;
  nameOrKey: string;
  objective?: string;
  project?: string;
  seconds?: string;
  task?: string;
  tokens?: string;
};

/** Return shape for `sessions.goal`. */
export type SessionsGoalReturn = Record<string, unknown>;

/** Input shape for `sessions.info`. */
export type SessionsInfoInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.info`. */
export type SessionsInfoReturn = Record<string, unknown>;

/** Input shape for `sessions.inform`. */
export type SessionsInformInput = {
  barrier?: string;
  channel?: string;
  immediate?: boolean;
  message: string;
  steer?: boolean;
  target: string;
  to?: string;
};

/** Return shape for `sessions.inform`. */
export type SessionsInformReturn = Record<string, unknown>;

/** Input shape for `sessions.keep`. */
export type SessionsKeepInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.keep`. */
export type SessionsKeepReturn = Record<string, unknown>;

/** Input shape for `sessions.list`. */
export type SessionsListInput = {
  agent?: string;
  ephemeral?: boolean;
  limit?: string;
  live?: boolean;
  offset?: string;
  tag?: string;
};

/** Return shape for `sessions.list`. */
export type SessionsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `sessions.mute`. */
export type SessionsMuteInput = {
  chat?: string;
  nameOrKey: string;
};

/** Return shape for `sessions.mute`. */
export type SessionsMuteReturn = Record<string, unknown>;

/** Input shape for `sessions.prune`. */
export type SessionsPruneInput = {
  agent?: string;
  ephemeral?: boolean;
  execute?: boolean;
  inactiveFor?: string;
  namePrefix?: string;
};

/** Return shape for `sessions.prune`. */
export type SessionsPruneReturn = Record<string, unknown>;

/** Input shape for `sessions.read`. */
export type SessionsReadInput = {
  count?: string;
  messageId?: string;
  nameOrKey?: string;
  workspace?: boolean;
};

/** Return shape for `sessions.read`. */
export type SessionsReadReturn = Record<string, unknown>;

/** Input shape for `sessions.rename`. */
export type SessionsRenameInput = {
  nameOrKey: string;
  newName: string;
};

/** Return shape for `sessions.rename`. */
export type SessionsRenameReturn = Record<string, unknown>;

/** Input shape for `sessions.reset`. */
export type SessionsResetInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.reset`. */
export type SessionsResetReturn = Record<string, unknown>;

/** Input shape for `sessions.runtime.follow-up`. */
export type SessionsRuntimeFollowUpInput = {
  expectedTurn?: string;
  session: string;
  text: string;
  thread?: string;
  turn?: string;
};

/** Return shape for `sessions.runtime.follow-up`. */
export type SessionsRuntimeFollowUpReturn = {
  data?: unknown;
  error?: string;
  ok: boolean;
  operation?: string;
  [k: string]: unknown;
};

/** Input shape for `sessions.runtime.fork`. */
export type SessionsRuntimeForkInput = {
  cwd?: string;
  path?: string;
  session: string;
  threadId?: string;
};

/** Return shape for `sessions.runtime.fork`. */
export type SessionsRuntimeForkReturn = {
  data?: unknown;
  error?: string;
  ok: boolean;
  operation?: string;
  [k: string]: unknown;
};

/** Input shape for `sessions.runtime.interrupt`. */
export type SessionsRuntimeInterruptInput = {
  session: string;
  thread?: string;
  turn?: string;
};

/** Return shape for `sessions.runtime.interrupt`. */
export type SessionsRuntimeInterruptReturn = {
  data?: unknown;
  error?: string;
  ok: boolean;
  operation?: string;
  [k: string]: unknown;
};

/** Input shape for `sessions.runtime.list`. */
export type SessionsRuntimeListInput = {
  archived?: boolean;
  cursor?: string;
  cwd?: string;
  limit?: string;
  search?: string;
  session: string;
};

/** Return shape for `sessions.runtime.list`. */
export type SessionsRuntimeListReturn = {
  data?: unknown;
  error?: string;
  ok: boolean;
  operation?: string;
  [k: string]: unknown;
};

/** Input shape for `sessions.runtime.read`. */
export type SessionsRuntimeReadInput = {
  session: string;
  summaryOnly?: boolean;
  threadId?: string;
};

/** Return shape for `sessions.runtime.read`. */
export type SessionsRuntimeReadReturn = {
  data?: unknown;
  error?: string;
  ok: boolean;
  operation?: string;
  [k: string]: unknown;
};

/** Input shape for `sessions.runtime.rollback`. */
export type SessionsRuntimeRollbackInput = {
  session: string;
  thread?: string;
  turns?: string;
};

/** Return shape for `sessions.runtime.rollback`. */
export type SessionsRuntimeRollbackReturn = {
  data?: unknown;
  error?: string;
  ok: boolean;
  operation?: string;
  [k: string]: unknown;
};

/** Input shape for `sessions.runtime.steer`. */
export type SessionsRuntimeSteerInput = {
  expectedTurn?: string;
  session: string;
  text: string;
  thread?: string;
  turn?: string;
};

/** Return shape for `sessions.runtime.steer`. */
export type SessionsRuntimeSteerReturn = {
  data?: unknown;
  error?: string;
  ok: boolean;
  operation?: string;
  [k: string]: unknown;
};

/** Input shape for `sessions.send`. */
export type SessionsSendInput = {
  agent?: string;
  barrier?: string;
  channel?: string;
  immediate?: boolean;
  interactive?: boolean;
  nameOrKey: string;
  prompt?: string;
  steer?: boolean;
  thread?: string;
  threadOwner?: string;
  threadScope?: string;
  threadSummary?: string;
  threadTitle?: string;
  to?: string;
  wait?: boolean;
};

/** Return shape for `sessions.send`. */
export type SessionsSendReturn = Record<string, unknown>;

/** Input shape for `sessions.set-display`. */
export type SessionsSetDisplayInput = {
  displayName: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-display`. */
export type SessionsSetDisplayReturn = Record<string, unknown>;

/** Input shape for `sessions.set-model`. */
export type SessionsSetModelInput = {
  model: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-model`. */
export type SessionsSetModelReturn = Record<string, unknown>;

/** Input shape for `sessions.set-thinking`. */
export type SessionsSetThinkingInput = {
  level: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-thinking`. */
export type SessionsSetThinkingReturn = Record<string, unknown>;

/** Input shape for `sessions.set-ttl`. */
export type SessionsSetTtlInput = {
  duration: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-ttl`. */
export type SessionsSetTtlReturn = Record<string, unknown>;

/** Input shape for `sessions.subscriptions`. */
export type SessionsSubscriptionsInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.subscriptions`. */
export type SessionsSubscriptionsReturn = Record<string, unknown>;

/** Input shape for `sessions.trace`. */
export type SessionsTraceInput = {
  correlation?: string;
  explain?: boolean;
  includeStream?: boolean;
  limit?: string;
  message?: string;
  nameOrKey: string;
  only?: string;
  raw?: boolean;
  run?: string;
  showSystemPrompt?: boolean;
  showUserPrompt?: boolean;
  since?: string;
  turn?: string;
  until?: string;
};

/** Return shape for `sessions.trace`. */
export type SessionsTraceReturn = Record<string, unknown>;

/** Input shape for `sessions.unmute`. */
export type SessionsUnmuteInput = {
  chat?: string;
  nameOrKey: string;
};

/** Return shape for `sessions.unmute`. */
export type SessionsUnmuteReturn = Record<string, unknown>;

/** Input shape for `sessions.visibility`. */
export type SessionsVisibilityInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.visibility`. */
export type SessionsVisibilityReturn = Record<string, unknown>;

/** Input shape for `settings.delete`. */
export type SettingsDeleteInput = {
  key: string;
};

/** Return shape for `settings.delete`. */
export type SettingsDeleteReturn = {
  changedCount: number;
  setting: {
    defaultValue: string | null;
    description: string | null;
    hint: string | null;
    isSet: boolean;
    key: string;
    known: boolean;
    legacy: boolean;
    value: string | null;
  };
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
};

/** Input shape for `settings.get`. */
export type SettingsGetInput = {
  key: string;
};

/** Return shape for `settings.get`. */
export type SettingsGetReturn = {
  setting: {
    defaultValue: string | null;
    description: string | null;
    hint: string | null;
    isSet: boolean;
    key: string;
    known: boolean;
    legacy: boolean;
    value: string | null;
  };
};

/** Input shape for `settings.list`. */
export type SettingsListInput = {
  legacy?: boolean;
  limit?: string;
  offset?: string;
};

/** Return shape for `settings.list`. */
export type SettingsListReturn = {
  customSettings: Array<{
    defaultValue: string | null;
    description: string | null;
    hint: string | null;
    isSet: boolean;
    key: string;
    known: boolean;
    legacy: boolean;
    value: string | null;
  }>;
  items: Array<{
    defaultValue: string | null;
    description: string | null;
    hint: string | null;
    isSet: boolean;
    key: string;
    known: boolean;
    legacy: boolean;
    section: string;
    value: string | null;
  }>;
  knownSettings: Array<{
    defaultValue: string | null;
    description: string | null;
    hint: string | null;
    isSet: boolean;
    key: string;
    known: boolean;
    legacy: boolean;
    value: string | null;
  }>;
  legacySettings: {
    hidden: boolean;
    settings: Array<{
      defaultValue: string | null;
      description: string | null;
      hint: string | null;
      isSet: boolean;
      key: string;
      known: boolean;
      legacy: boolean;
      value: string | null;
    }>;
    total: number;
  };
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  showLegacy: boolean;
  total: number;
};

/** Input shape for `settings.set`. */
export type SettingsSetInput = {
  key: string;
  value: string;
};

/** Return shape for `settings.set`. */
export type SettingsSetReturn = {
  changedCount: number;
  setting: {
    defaultValue: string | null;
    description: string | null;
    hint: string | null;
    isSet: boolean;
    key: string;
    known: boolean;
    legacy: boolean;
    value: string | null;
  };
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
};

/** Input shape for `skill-gates.disable`. */
export type SkillGatesDisableInput = {
  id: string;
};

/** Return shape for `skill-gates.disable`. */
export type SkillGatesDisableReturn = {
  rule: {
    command?: string | null;
    commandPrefix?: string | null;
    commandRegex?: string | null;
    configured?: (Record<string, unknown>) | null;
    createdAt?: number;
    defaultRule?: (Record<string, unknown>) | null;
    disabled?: boolean;
    enabled: boolean;
    groupRegex?: string | null;
    id: string;
    pattern?: string | null;
    skill: string | null;
    source?: string;
    tool?: string | null;
    toolPrefix?: string | null;
    toolRegex?: string | null;
    updatedAt?: number;
    [k: string]: unknown;
  };
  success: true;
};

/** Input shape for `skill-gates.enable`. */
export type SkillGatesEnableInput = {
  id: string;
};

/** Return shape for `skill-gates.enable`. */
export type SkillGatesEnableReturn = {
  rule: {
    command?: string | null;
    commandPrefix?: string | null;
    commandRegex?: string | null;
    configured?: (Record<string, unknown>) | null;
    createdAt?: number;
    defaultRule?: (Record<string, unknown>) | null;
    disabled?: boolean;
    enabled: boolean;
    groupRegex?: string | null;
    id: string;
    pattern?: string | null;
    skill: string | null;
    source?: string;
    tool?: string | null;
    toolPrefix?: string | null;
    toolRegex?: string | null;
    updatedAt?: number;
    [k: string]: unknown;
  };
  success: true;
};

/** Input shape for `skill-gates.list`. */
export type SkillGatesListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `skill-gates.list`. */
export type SkillGatesListReturn = {
  configuredTotal: number;
  filters?: Record<string, unknown>;
  items: Array<{
    command?: string | null;
    commandPrefix?: string | null;
    commandRegex?: string | null;
    configured?: (Record<string, unknown>) | null;
    createdAt?: number;
    defaultRule?: (Record<string, unknown>) | null;
    disabled?: boolean;
    enabled: boolean;
    groupRegex?: string | null;
    id: string;
    pattern?: string | null;
    skill: string | null;
    source?: string;
    tool?: string | null;
    toolPrefix?: string | null;
    toolRegex?: string | null;
    updatedAt?: number;
    [k: string]: unknown;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  rules: Array<{
    command?: string | null;
    commandPrefix?: string | null;
    commandRegex?: string | null;
    configured?: (Record<string, unknown>) | null;
    createdAt?: number;
    defaultRule?: (Record<string, unknown>) | null;
    disabled?: boolean;
    enabled: boolean;
    groupRegex?: string | null;
    id: string;
    pattern?: string | null;
    skill: string | null;
    source?: string;
    tool?: string | null;
    toolPrefix?: string | null;
    toolRegex?: string | null;
    updatedAt?: number;
    [k: string]: unknown;
  }>;
  total: number;
};

/** Input shape for `skill-gates.reset`. */
export type SkillGatesResetInput = {
  id: string;
};

/** Return shape for `skill-gates.reset`. */
export type SkillGatesResetReturn = {
  deleted: boolean;
  success: true;
};

/** Input shape for `skill-gates.rm`. */
export type SkillGatesRmInput = {
  id: string;
};

/** Return shape for `skill-gates.rm`. */
export type SkillGatesRmReturn = {
  action: string;
  deleted?: boolean;
  rule?: {
    command?: string | null;
    commandPrefix?: string | null;
    commandRegex?: string | null;
    configured?: (Record<string, unknown>) | null;
    createdAt?: number;
    defaultRule?: (Record<string, unknown>) | null;
    disabled?: boolean;
    enabled: boolean;
    groupRegex?: string | null;
    id: string;
    pattern?: string | null;
    skill: string | null;
    source?: string;
    tool?: string | null;
    toolPrefix?: string | null;
    toolRegex?: string | null;
    updatedAt?: number;
    [k: string]: unknown;
  };
  success: true;
  [k: string]: unknown;
};

/** Input shape for `skill-gates.set`. */
export type SkillGatesSetInput = {
  command?: string;
  commandPrefix?: string;
  commandRegex?: string;
  groupRegex?: string;
  id: string;
  pattern?: string;
  skill: string;
  tool?: string;
  toolPrefix?: string;
  toolRegex?: string;
};

/** Return shape for `skill-gates.set`. */
export type SkillGatesSetReturn = {
  rule: {
    command?: string | null;
    commandPrefix?: string | null;
    commandRegex?: string | null;
    configured?: (Record<string, unknown>) | null;
    createdAt?: number;
    defaultRule?: (Record<string, unknown>) | null;
    disabled?: boolean;
    enabled: boolean;
    groupRegex?: string | null;
    id: string;
    pattern?: string | null;
    skill: string | null;
    source?: string;
    tool?: string | null;
    toolPrefix?: string | null;
    toolRegex?: string | null;
    updatedAt?: number;
    [k: string]: unknown;
  };
  success: true;
};

/** Input shape for `skill-gates.show`. */
export type SkillGatesShowInput = {
  id: string;
};

/** Return shape for `skill-gates.show`. */
export type SkillGatesShowReturn = {
  rule: {
    command?: string | null;
    commandPrefix?: string | null;
    commandRegex?: string | null;
    configured?: (Record<string, unknown>) | null;
    createdAt?: number;
    defaultRule?: (Record<string, unknown>) | null;
    disabled?: boolean;
    enabled: boolean;
    groupRegex?: string | null;
    id: string;
    pattern?: string | null;
    skill: string | null;
    source?: string;
    tool?: string | null;
    toolPrefix?: string | null;
    toolRegex?: string | null;
    updatedAt?: number;
    [k: string]: unknown;
  };
};

/** Input shape for `skills.install`. */
export type SkillsInstallInput = {
  all?: boolean;
  name?: string;
  overwrite?: boolean;
  plugin?: string;
  skill?: string;
  skipCodexSync?: boolean;
  source?: string;
};

/** Return shape for `skills.install`. */
export type SkillsInstallReturn = {
  codexSynced: string[];
  installed: Array<{
    description: string | null;
    name: string;
    path: string;
    pluginName: string | null;
    skillFilePath: string;
    source: string;
    [k: string]: unknown;
  }>;
  source: string;
  success: true;
  [k: string]: unknown;
};

/** Input shape for `skills.list`. */
export type SkillsListInput = {
  codex?: boolean;
  installed?: boolean;
  limit?: string;
  offset?: string;
  source?: string;
  tag?: string;
};

/** Return shape for `skills.list`. */
export type SkillsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  skills: Array<{
    description: string | null;
    name: string;
    path: string;
    pluginName: string | null;
    skillFilePath: string;
    source: string;
    [k: string]: unknown;
  }>;
  source: string;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `skills.show`. */
export type SkillsShowInput = {
  installed?: boolean;
  name: string;
  source?: string;
};

/** Return shape for `skills.show`. */
export type SkillsShowReturn = {
  skill: {
    content: string;
    description: string | null;
    name: string;
    path: string;
    pluginName: string | null;
    skillFilePath: string;
    source: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `skills.sync`. */
export type SkillsSyncInput = Record<string, never>;

/** Return shape for `skills.sync`. */
export type SkillsSyncReturn = {
  codexSynced: string[];
  success: true;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `specs.get`. */
export type SpecsGetInput = {
  id: string;
  mode?: string;
};

/** Return shape for `specs.get`. */
export type SpecsGetReturn = {
  context: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `specs.list`. */
export type SpecsListInput = {
  domain?: string;
  kind?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `specs.list`. */
export type SpecsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  specs: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `specs.new`. */
export type SpecsNewInput = {
  full?: boolean;
  id: string;
  kind?: string;
  title?: string;
};

/** Return shape for `specs.new`. */
export type SpecsNewReturn = {
  createdFiles: string[];
  missingAncestors: Array<Record<string, unknown>>;
  spec: Record<string, unknown>;
  status: "created";
  [k: string]: unknown;
};

/** Input shape for `specs.sync`. */
export type SpecsSyncInput = Record<string, never>;

/** Return shape for `specs.sync`. */
export type SpecsSyncReturn = {
  rootPath: string;
  status: "synced";
  total: number;
  [k: string]: unknown;
};

/** Input shape for `stickers.add`. */
export type StickersAddInput = {
  agents?: string;
  avoid?: string;
  channels?: string;
  description?: string;
  disabled?: boolean;
  id: string;
  label?: string;
  mediaPath: string;
  overwrite?: boolean;
};

/** Return shape for `stickers.add`. */
export type StickersAddReturn = {
  action: string;
  sticker: {
    agents: string[];
    avoid: string | null;
    channels: string[];
    createdAt: number | null;
    description: string;
    enabled: boolean;
    id: string;
    label: string;
    media: Record<string, unknown>;
    updatedAt: number | null;
    [k: string]: unknown;
  };
  success: boolean;
};

/** Input shape for `stickers.list`. */
export type StickersListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `stickers.list`. */
export type StickersListReturn = {
  items: Array<{
    agents: string[];
    avoid: string | null;
    channels: string[];
    createdAt: number | null;
    description: string;
    enabled: boolean;
    id: string;
    label: string;
    media: Record<string, unknown>;
    updatedAt: number | null;
    [k: string]: unknown;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  stickers: Array<{
    agents: string[];
    avoid: string | null;
    channels: string[];
    createdAt: number | null;
    description: string;
    enabled: boolean;
    id: string;
    label: string;
    media: Record<string, unknown>;
    updatedAt: number | null;
    [k: string]: unknown;
  }>;
  total: number;
};

/** Input shape for `stickers.remove`. */
export type StickersRemoveInput = {
  id: string;
};

/** Return shape for `stickers.remove`. */
export type StickersRemoveReturn = {
  action: "remove";
  stickerId: string;
  success: boolean;
};

/** Input shape for `stickers.send`. */
export type StickersSendInput = {
  account?: string;
  channel?: string;
  id: string;
  session?: string;
  to?: string;
};

/** Return shape for `stickers.send`. */
export type StickersSendReturn = {
  event: Record<string, unknown>;
  sticker: {
    id: string;
    label: string;
  };
  success: true;
  target: {
    accountId: string;
    channel: string;
    chatId: string;
  };
  topic: "ravi.stickers.send";
};

/** Input shape for `stickers.show`. */
export type StickersShowInput = {
  id: string;
};

/** Return shape for `stickers.show`. */
export type StickersShowReturn = {
  sticker: {
    agents: string[];
    avoid: string | null;
    channels: string[];
    createdAt: number | null;
    description: string;
    enabled: boolean;
    id: string;
    label: string;
    media: Record<string, unknown>;
    updatedAt: number | null;
    [k: string]: unknown;
  };
};

/** Input shape for `sync.inspect`. */
export type SyncInspectInput = {
  id: string;
};

/** Return shape for `sync.inspect`. */
export type SyncInspectReturn = ({
  found: false;
  id: string;
}) | ({
  found: true;
  kind: "outbox";
  record: {
    ackedAt: number | null;
    attemptCount: number;
    createdAt: number;
    domain: string;
    entityId: string;
    entityRevision: number | null;
    entityType: string;
    eventId: string;
    eventType: string;
    evidenceRefs: unknown[];
    id: string;
    idempotencyKey: string;
    lastErrorCode: string | null;
    leaseId: string | null;
    leasedUntil: number | null;
    nextAttemptAt: number;
    occurredAt: number;
    originInstallationId: string | null;
    payload: unknown;
    schemaVersion: number;
    sentAt: number | null;
    status: "pending" | "leased" | "sent" | "acked" | "failed" | "dead";
    updatedAt: number;
  };
}) | ({
  found: true;
  kind: "inbox";
  record: {
    appliedAt: number | null;
    attemptCount: number;
    createdAt: number;
    domain: string;
    entityId: string;
    entityType: string;
    eventType: string;
    id: string;
    lastErrorCode: string | null;
    payload: unknown;
    receivedAt: number;
    remoteEventId: string;
    remoteSequence: string | null;
    status: "pending" | "applied" | "skipped" | "failed" | "dead";
    updatedAt: number;
  };
});

/** Input shape for `sync.pull`. */
export type SyncPullInput = {
  domain?: string;
  limit?: string;
  project?: string;
  projectId?: string;
  projectRef?: string;
  scope?: string;
};

/** Return shape for `sync.pull`. */
export type SyncPullReturn = {
  applied: number;
  cursor: string | null;
  downloaded: number;
  enqueued: number;
  errorCode?: string;
  failed: number;
  linked: boolean;
  skipped: number;
  status: "unlinked" | "noop" | "downloaded" | "failed";
};

/** Input shape for `sync.push`. */
export type SyncPushInput = {
  domain?: string;
  limit?: string;
  maxBytes?: string;
  project?: string;
  projectId?: string;
  projectRef?: string;
  scope?: string;
  traces?: boolean;
};

/** Return shape for `sync.push`. */
export type SyncPushReturn = {
  acked: number;
  attempted: number;
  errorCode?: string;
  failed: number;
  linked: boolean;
  sent: number;
  status: "unlinked" | "noop" | "uploaded" | "failed";
  trace?: {
    acked: number;
    attempted: number;
    errorCode?: string;
    failed: number;
    linked: boolean;
    status: "unlinked" | "noop" | "uploaded" | "failed";
  };
};

/** Input shape for `sync.retry`. */
export type SyncRetryInput = {
  dead?: boolean;
  id?: string;
};

/** Return shape for `sync.retry`. */
export type SyncRetryReturn = {
  retried: number;
  success: true;
};

/** Input shape for `sync.status`. */
export type SyncStatusInput = Record<string, never>;

/** Return shape for `sync.status`. */
export type SyncStatusReturn = {
  consoleUrl: string | null;
  cursors: Array<{
    cursorKey: string;
    cursorValue: string | null;
    domain: string;
    meta: unknown | null;
    updatedAt: number;
  }>;
  inbox: {
    acked?: number;
    applied?: number;
    dead: number;
    failed: number;
    leased?: number;
    pending: number;
    sent?: number;
    skipped?: number;
  };
  installationId: string | null;
  lastDownload: string | null;
  lastError: string | null;
  lastUpload: string | null;
  linked: boolean;
  outbox: {
    acked?: number;
    applied?: number;
    dead: number;
    failed: number;
    leased?: number;
    pending: number;
    sent?: number;
    skipped?: number;
  };
  runner: {
    enabled: boolean;
    env: string;
    pullDomains: string[];
  };
};

/** Input shape for `tag-rules.evaluate`. */
export type TagRulesEvaluateInput = {
  apply?: boolean;
  file?: string;
  ruleId: string;
  target?: string;
};

/** Return shape for `tag-rules.evaluate`. */
export type TagRulesEvaluateReturn = {
  apply: boolean;
  outcomes: Array<Record<string, unknown>>;
  ruleId: string;
  target: Record<string, unknown>;
  traces: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `tag-rules.explain`. */
export type TagRulesExplainInput = {
  target?: string;
};

/** Return shape for `tag-rules.explain`. */
export type TagRulesExplainReturn = {
  loaded: Record<string, unknown>;
  outcomes: Array<Record<string, unknown>>;
  rules: Record<string, unknown>;
  target: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tag-rules.list`. */
export type TagRulesListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `tag-rules.list`. */
export type TagRulesListReturn = {
  errors: Array<Record<string, unknown>>;
  pagination: {
    limit: number;
    offset: number;
    returned?: number;
    total: number;
    [k: string]: unknown;
  };
  rules: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `tag-rules.show`. */
export type TagRulesShowInput = {
  id: string;
};

/** Return shape for `tag-rules.show`. */
export type TagRulesShowReturn = {
  rule: Record<string, unknown>;
  source?: string;
  [k: string]: unknown;
};

/** Input shape for `tag-rules.tick`. */
export type TagRulesTickInput = {
  apply?: boolean;
  limit?: string;
};

/** Return shape for `tag-rules.tick`. */
export type TagRulesTickReturn = {
  appliedActions: number;
  contacts: Array<Record<string, unknown>>;
  contactsProcessed: number;
  loadErrors: Array<Record<string, unknown>>;
  matched: number;
  rulesLoaded: number;
  [k: string]: unknown;
};

/** Input shape for `tag-rules.validate`. */
export type TagRulesValidateInput = Record<string, never>;

/** Return shape for `tag-rules.validate`. */
export type TagRulesValidateReturn = {
  errors: Array<Record<string, unknown>>;
  ruleCount: number;
  status: "ok" | "error";
  [k: string]: unknown;
};

/** Input shape for `tags.attach`. */
export type TagsAttachInput = {
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
  slug: string;
  source?: string;
  target?: string;
  task?: string;
  taskAutomation?: string;
  trigger?: string;
  workflowNode?: string;
  workflowRun?: string;
  workflowSpec?: string;
};

/** Return shape for `tags.attach`. */
export type TagsAttachReturn = {
  behaviorConsumers?: Array<Record<string, unknown>>;
  binding?: Record<string, unknown>;
  changedCount: number;
  status: string;
  tag?: Record<string, unknown>;
  target: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tags.create`. */
export type TagsCreateInput = {
  description?: string;
  kind?: string;
  label?: string;
  meta?: string;
  slug: string;
  source?: string;
};

/** Return shape for `tags.create`. */
export type TagsCreateReturn = {
  behaviorConsumers?: Array<Record<string, unknown>>;
  binding?: Record<string, unknown>;
  changedCount: number;
  status: string;
  tag?: Record<string, unknown>;
  target: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tags.detach`. */
export type TagsDetachInput = {
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
  slug: string;
  source?: string;
  target?: string;
  task?: string;
  taskAutomation?: string;
  trigger?: string;
  workflowNode?: string;
  workflowRun?: string;
  workflowSpec?: string;
};

/** Return shape for `tags.detach`. */
export type TagsDetachReturn = {
  changedCount: number;
  status: "detached";
  target: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tags.list`. */
export type TagsListInput = {
  cursor?: string;
  kind?: string;
  limit?: string;
  order?: string;
  query?: string;
  sort?: string;
  source?: string;
};

/** Return shape for `tags.list`. */
export type TagsListReturn = {
  filters: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  page: {
    count: number;
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextCursor: string | null;
    order: string;
    sort: string;
    [k: string]: unknown;
  };
  tags: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tags.search`. */
export type TagsSearchInput = {
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
};

/** Return shape for `tags.search`. */
export type TagsSearchReturn = {
  behaviorConsumers: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
  filters: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  page: {
    count: number;
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextCursor: string | null;
    order: string;
    sort: string;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tags.set`. */
export type TagsSetInput = {
  key: string;
  slug: string;
  value: string;
};

/** Return shape for `tags.set`. */
export type TagsSetReturn = {
  behaviorConsumers?: Array<Record<string, unknown>>;
  binding?: Record<string, unknown>;
  changedCount: number;
  status: string;
  tag?: Record<string, unknown>;
  target: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tags.show`. */
export type TagsShowInput = {
  slug: string;
};

/** Return shape for `tags.show`. */
export type TagsShowReturn = {
  behaviorConsumers: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
  tag: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.archive`. */
export type TasksArchiveInput = {
  reason?: string;
  taskId: string;
};

/** Return shape for `tasks.archive`. */
export type TasksArchiveReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.automations.add`. */
export type TasksAutomationsAddInput = {
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
  name: string;
  on?: string;
  priority?: string;
  profile?: string;
  reportEvents?: string;
  reportTo?: string;
  session?: string;
  title?: string;
};

/** Return shape for `tasks.automations.add`. */
export type TasksAutomationsAddReturn = {
  automation: Record<string, unknown>;
  changedCount: number;
  status: string;
  target: {
    id: string;
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `tasks.automations.disable`. */
export type TasksAutomationsDisableInput = {
  id: string;
};

/** Return shape for `tasks.automations.disable`. */
export type TasksAutomationsDisableReturn = {
  automation: Record<string, unknown>;
  changedCount: number;
  status: string;
  target: {
    id: string;
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `tasks.automations.enable`. */
export type TasksAutomationsEnableInput = {
  id: string;
};

/** Return shape for `tasks.automations.enable`. */
export type TasksAutomationsEnableReturn = {
  automation: Record<string, unknown>;
  changedCount: number;
  status: string;
  target: {
    id: string;
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `tasks.automations.list`. */
export type TasksAutomationsListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `tasks.automations.list`. */
export type TasksAutomationsListReturn = {
  automations: Array<Record<string, unknown>>;
  filters: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tasks.automations.rm`. */
export type TasksAutomationsRmInput = {
  id: string;
};

/** Return shape for `tasks.automations.rm`. */
export type TasksAutomationsRmReturn = {
  automation: Record<string, unknown>;
  changedCount: number;
  status: string;
  target: {
    id: string;
    type: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `tasks.automations.show`. */
export type TasksAutomationsShowInput = {
  id: string;
};

/** Return shape for `tasks.automations.show`. */
export type TasksAutomationsShowReturn = {
  automation: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `tasks.block`. */
export type TasksBlockInput = {
  reason?: string;
  taskId: string;
};

/** Return shape for `tasks.block`. */
export type TasksBlockReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.comment`. */
export type TasksCommentInput = {
  body: string;
  taskId: string;
};

/** Return shape for `tasks.comment`. */
export type TasksCommentReturn = {
  comment: Record<string, unknown>;
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.create`. */
export type TasksCreateInput = {
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
  title: string;
  worktreeBranch?: string;
  worktreeMode?: string;
  worktreePath?: string;
};

/** Return shape for `tasks.create`. */
export type TasksCreateReturn = {
  dependencies: Array<Record<string, unknown>>;
  dependents: Array<Record<string, unknown>>;
  event: Record<string, unknown>;
  launchPlan: (Record<string, unknown>) | null;
  parentTaskId: string | null;
  readiness: Record<string, unknown>;
  relatedEvents: Array<Record<string, unknown>>;
  task: Record<string, unknown>;
  taskProfile: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.deps.add`. */
export type TasksDepsAddInput = {
  dependencyTaskId: string;
  taskId: string;
};

/** Return shape for `tasks.deps.add`. */
export type TasksDepsAddReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.deps.ls`. */
export type TasksDepsLsInput = {
  limit?: string;
  offset?: string;
  taskId: string;
};

/** Return shape for `tasks.deps.ls`. */
export type TasksDepsLsReturn = {
  dependencies: Array<Record<string, unknown>>;
  dependents: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  launchPlan: (Record<string, unknown>) | null;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  readiness: Record<string, unknown>;
  taskId: string;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tasks.deps.rm`. */
export type TasksDepsRmInput = {
  dependencyTaskId: string;
  taskId: string;
};

/** Return shape for `tasks.deps.rm`. */
export type TasksDepsRmReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.dispatch`. */
export type TasksDispatchInput = {
  actorSession?: string;
  agent?: string;
  checkpoint?: string;
  effort?: string;
  model?: string;
  reportEvents?: string;
  reportTo?: string;
  session?: string;
  taskId: string;
  thinking?: string;
};

/** Return shape for `tasks.dispatch`. */
export type TasksDispatchReturn = {
  event: Record<string, unknown>;
  mode: string;
  readiness?: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.done`. */
export type TasksDoneInput = {
  summary?: string;
  taskId: string;
};

/** Return shape for `tasks.done`. */
export type TasksDoneReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.fail`. */
export type TasksFailInput = {
  reason?: string;
  taskId: string;
};

/** Return shape for `tasks.fail`. */
export type TasksFailReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.list`. */
export type TasksListInput = {
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
};

/** Return shape for `tasks.list`. */
export type TasksListReturn = {
  archiveMode: string;
  filters: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  limit: number | null;
  page: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tasks.profiles.init`. */
export type TasksProfilesInitInput = {
  preset?: string;
  profileId: string;
  source?: string;
};

/** Return shape for `tasks.profiles.init`. */
export type TasksProfilesInitReturn = {
  manifestPath: string;
  profileDir: string;
  sourceKind: string;
  [k: string]: unknown;
};

/** Input shape for `tasks.profiles.list`. */
export type TasksProfilesListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `tasks.profiles.list`. */
export type TasksProfilesListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  profiles: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tasks.profiles.preview`. */
export type TasksProfilesPreviewInput = {
  agent?: string;
  input?: string[];
  instructions?: string;
  profileId: string;
  session?: string;
  title?: string;
  worktreeBranch?: string;
  worktreeMode?: string;
  worktreePath?: string;
};

/** Return shape for `tasks.profiles.preview`. */
export type TasksProfilesPreviewReturn = {
  profile: Record<string, unknown>;
  rendered: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.profiles.show`. */
export type TasksProfilesShowInput = {
  profileId: string;
};

/** Return shape for `tasks.profiles.show`. */
export type TasksProfilesShowReturn = Record<string, unknown>;

/** Input shape for `tasks.profiles.validate`. */
export type TasksProfilesValidateInput = {
  profileId?: string;
};

/** Return shape for `tasks.profiles.validate`. */
export type TasksProfilesValidateReturn = {
  results: Array<Record<string, unknown>>;
  valid: boolean;
  [k: string]: unknown;
};

/** Input shape for `tasks.report`. */
export type TasksReportInput = {
  message?: string;
  progress?: string;
  taskId: string;
};

/** Return shape for `tasks.report`. */
export type TasksReportReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.show`. */
export type TasksShowInput = {
  last?: string;
  taskId: string;
};

/** Return shape for `tasks.show`. */
export type TasksShowReturn = {
  comments: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
  dependents: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  historyLimit: number | null;
  launchPlan: (Record<string, unknown>) | null;
  readiness: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tasks.unarchive`. */
export type TasksUnarchiveInput = {
  taskId: string;
};

/** Return shape for `tasks.unarchive`. */
export type TasksUnarchiveReturn = {
  event: Record<string, unknown>;
  task: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.brief`. */
export type ThreadsBriefInput = {
  scope?: string;
  thread: string;
};

/** Return shape for `threads.brief`. */
export type ThreadsBriefReturn = {
  action: string;
  brief: Record<string, unknown>;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.close`. */
export type ThreadsCloseInput = {
  reason?: string;
  scope?: string;
  thread: string;
};

/** Return shape for `threads.close`. */
export type ThreadsCloseReturn = {
  action: string;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.comment`. */
export type ThreadsCommentInput = {
  body: string;
  scope?: string;
  thread: string;
  visibility?: string;
};

/** Return shape for `threads.comment`. */
export type ThreadsCommentReturn = {
  action: string;
  entry: Record<string, unknown>;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.create`. */
export type ThreadsCreateInput = {
  defaultAgent?: string;
  owner?: string;
  scope?: string;
  slug: string;
  status?: string;
  summary?: string;
  title?: string;
};

/** Return shape for `threads.create`. */
export type ThreadsCreateReturn = {
  action: string;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.entries`. */
export type ThreadsEntriesInput = {
  limit?: string;
  offset?: string;
  scope?: string;
  thread: string;
};

/** Return shape for `threads.entries`. */
export type ThreadsEntriesReturn = {
  action: string;
  entries: Array<Record<string, unknown>>;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.link`. */
export type ThreadsLinkInput = {
  label?: string;
  role?: string;
  scope?: string;
  target: string;
  thread: string;
  visibility?: string;
};

/** Return shape for `threads.link`. */
export type ThreadsLinkReturn = {
  action: string;
  link: Record<string, unknown>;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.list`. */
export type ThreadsListInput = {
  limit?: string;
  offset?: string;
  owner?: string;
  scope?: string;
  search?: string;
  status?: string;
};

/** Return shape for `threads.list`. */
export type ThreadsListReturn = {
  action: "list";
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `threads.note`. */
export type ThreadsNoteInput = {
  body: string;
  scope?: string;
  thread: string;
  visibility?: string;
};

/** Return shape for `threads.note`. */
export type ThreadsNoteReturn = {
  action: string;
  entry: Record<string, unknown>;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `threads.show`. */
export type ThreadsShowInput = {
  entries?: string;
  scope?: string;
  thread: string;
};

/** Return shape for `threads.show`. */
export type ThreadsShowReturn = {
  action: string;
  entries: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  thread: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tools.list`. */
export type ToolsListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `tools.list`. */
export type ToolsListReturn = {
  groups: Array<{
    name: string;
    tools: Array<Record<string, unknown>>;
    [k: string]: unknown;
  }>;
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  tools: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tools.manifest`. */
export type ToolsManifestInput = Record<string, never>;

/** Return shape for `tools.manifest`. */
export type ToolsManifestReturn = {
  tools: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `tools.schema`. */
export type ToolsSchemaInput = Record<string, never>;

/** Return shape for `tools.schema`. */
export type ToolsSchemaReturn = {
  schema: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tools.show`. */
export type ToolsShowInput = {
  name: string;
};

/** Return shape for `tools.show`. */
export type ToolsShowReturn = {
  tool: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `tools.test`. */
export type ToolsTestInput = {
  args?: string;
  name: string;
};

/** Return shape for `tools.test`. */
export type ToolsTestReturn = {
  args: Record<string, unknown>;
  result: {
    content: unknown[];
    isError: boolean;
    [k: string]: unknown;
  };
  tool: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `transcribe.file`. */
export type TranscribeFileInput = {
  lang?: string;
  path: string;
};

/** Return shape for `transcribe.file`. */
export type TranscribeFileReturn = {
  options: {
    lang: string;
  };
  source: {
    filePath: string;
    mimeType: string;
    sizeBytes: number;
    sizeMB: number;
  };
  success: true;
  transcription: {
    chunks?: number;
    duration?: number;
    text: string;
    [k: string]: unknown;
  };
};

/** Input shape for `triggers.add`. */
export type TriggersAddInput = {
  account?: string;
  agent?: string;
  cooldown?: string;
  filter?: string;
  message?: string;
  name: string;
  session?: string;
  topic?: string;
};

/** Return shape for `triggers.add`. */
export type TriggersAddReturn = {
  changedCount: number;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  trigger: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `triggers.disable`. */
export type TriggersDisableInput = {
  id: string;
};

/** Return shape for `triggers.disable`. */
export type TriggersDisableReturn = {
  changedCount: number;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  trigger: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `triggers.enable`. */
export type TriggersEnableInput = {
  id: string;
};

/** Return shape for `triggers.enable`. */
export type TriggersEnableReturn = {
  changedCount: number;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  trigger: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `triggers.list`. */
export type TriggersListInput = {
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `triggers.list`. */
export type TriggersListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  triggers: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `triggers.rm`. */
export type TriggersRmInput = {
  id: string;
};

/** Return shape for `triggers.rm`. */
export type TriggersRmReturn = {
  changedCount: number;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  trigger: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `triggers.set`. */
export type TriggersSetInput = {
  id: string;
  key: string;
  value: string;
};

/** Return shape for `triggers.set`. */
export type TriggersSetReturn = {
  changedCount: number;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  trigger: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `triggers.show`. */
export type TriggersShowInput = {
  id: string;
};

/** Return shape for `triggers.show`. */
export type TriggersShowReturn = {
  trigger: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `triggers.test`. */
export type TriggersTestInput = {
  id: string;
};

/** Return shape for `triggers.test`. */
export type TriggersTestReturn = {
  changedCount: number;
  status: string;
  target: {
    type: string;
    [k: string]: unknown;
  };
  trigger: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `triggers.topics`. */
export type TriggersTopicsInput = Record<string, never>;

/** Return shape for `triggers.topics`. */
export type TriggersTopicsReturn = {
  topics: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `video.analyze`. */
export type VideoAnalyzeInput = {
  forceAnalyze?: boolean;
  output?: string;
  prompt?: string;
  strategy?: string;
  url: string;
};

/** Return shape for `video.analyze`. */
export type VideoAnalyzeReturn = {
  artifact: Record<string, unknown>;
  options: Record<string, unknown>;
  success: true;
  video: {
    chapters?: Array<Record<string, unknown>>;
    duration: string;
    source: string;
    strategy: "gemini" | "subtitles";
    subtitleLanguage?: string | null;
    summary: string;
    title: string;
    topics: string[];
    transcript: string;
    visualDescription: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `watch.connectors`. */
export type WatchConnectorsInput = {
  provider?: string;
};

/** Return shape for `watch.connectors`. */
export type WatchConnectorsReturn = {
  connectors: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `watch.create`. */
export type WatchCreateInput = {
  event?: string;
  installation?: string;
  name?: string;
  placement?: string;
  project?: string;
  provider: string;
  resource: string;
  resourceId?: string;
};

/** Return shape for `watch.create`. */
export type WatchCreateReturn = {
  capabilities: Record<string, unknown>;
  next: Record<string, unknown>;
  status: string;
  watch: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `watch.disable`. */
export type WatchDisableInput = {
  id: string;
};

/** Return shape for `watch.disable`. */
export type WatchDisableReturn = {
  status: string;
  watch: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `watch.enable`. */
export type WatchEnableInput = {
  id: string;
};

/** Return shape for `watch.enable`. */
export type WatchEnableReturn = {
  status: string;
  watch: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `watch.events`. */
export type WatchEventsInput = {
  id: string;
};

/** Return shape for `watch.events`. */
export type WatchEventsReturn = {
  eventTypes: string[];
  subjects: string[];
  watchId: string;
  [k: string]: unknown;
};

/** Input shape for `watch.list`. */
export type WatchListInput = {
  limit?: string;
  offset?: string;
  provider?: string;
  status?: string;
};

/** Return shape for `watch.list`. */
export type WatchListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  total: number;
  watches: Array<Record<string, unknown>>;
  [k: string]: unknown;
};

/** Input shape for `watch.rm`. */
export type WatchRmInput = {
  id: string;
};

/** Return shape for `watch.rm`. */
export type WatchRmReturn = {
  deleted: boolean;
  id: string;
  [k: string]: unknown;
};

/** Input shape for `watch.show`. */
export type WatchShowInput = {
  id: string;
};

/** Return shape for `watch.show`. */
export type WatchShowReturn = {
  watch: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `watch.trigger`. */
export type WatchTriggerInput = {
  account?: string;
  agent?: string;
  cooldown?: string;
  event?: string;
  id: string;
  message?: string;
  session?: string;
};

/** Return shape for `watch.trigger`. */
export type WatchTriggerReturn = {
  status: string;
  trigger: Record<string, unknown>;
  watch: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `whatsapp.dm.ack`. */
export type WhatsappDmAckInput = {
  account?: string;
  contact: string;
  messageId: string;
};

/** Return shape for `whatsapp.dm.ack`. */
export type WhatsappDmAckReturn = Record<string, unknown>;

/** Input shape for `whatsapp.dm.read`. */
export type WhatsappDmReadInput = {
  account?: string;
  contact: string;
  last?: string;
  noAck?: boolean;
};

/** Return shape for `whatsapp.dm.read`. */
export type WhatsappDmReadReturn = Record<string, unknown>;

/** Input shape for `whatsapp.dm.send`. */
export type WhatsappDmSendInput = {
  account?: string;
  contact: string;
  message: string;
};

/** Return shape for `whatsapp.dm.send`. */
export type WhatsappDmSendReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.add`. */
export type WhatsappGroupAddInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.add`. */
export type WhatsappGroupAddReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.create`. */
export type WhatsappGroupCreateInput = {
  account?: string;
  admin?: string[];
  admins?: string[];
  agent?: string;
  agentCwd?: string;
  agentModel?: string;
  agentProvider?: string;
  createAgent?: boolean;
  name: string;
  participants?: string;
  skipTaggedAdmins?: boolean;
};

/** Return shape for `whatsapp.group.create`. */
export type WhatsappGroupCreateReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.demote`. */
export type WhatsappGroupDemoteInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.demote`. */
export type WhatsappGroupDemoteReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.description`. */
export type WhatsappGroupDescriptionInput = {
  account?: string;
  groupId: string;
  text: string;
};

/** Return shape for `whatsapp.group.description`. */
export type WhatsappGroupDescriptionReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.info`. */
export type WhatsappGroupInfoInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.info`. */
export type WhatsappGroupInfoReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.invite`. */
export type WhatsappGroupInviteInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.invite`. */
export type WhatsappGroupInviteReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.join`. */
export type WhatsappGroupJoinInput = {
  account?: string;
  code: string;
};

/** Return shape for `whatsapp.group.join`. */
export type WhatsappGroupJoinReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.leave`. */
export type WhatsappGroupLeaveInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.leave`. */
export type WhatsappGroupLeaveReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.list`. */
export type WhatsappGroupListInput = {
  account?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `whatsapp.group.list`. */
export type WhatsappGroupListReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.promote`. */
export type WhatsappGroupPromoteInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.promote`. */
export type WhatsappGroupPromoteReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.remove`. */
export type WhatsappGroupRemoveInput = {
  account?: string;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.remove`. */
export type WhatsappGroupRemoveReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.rename`. */
export type WhatsappGroupRenameInput = {
  account?: string;
  groupId: string;
  name: string;
};

/** Return shape for `whatsapp.group.rename`. */
export type WhatsappGroupRenameReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.revoke-invite`. */
export type WhatsappGroupRevokeInviteInput = {
  account?: string;
  groupId: string;
};

/** Return shape for `whatsapp.group.revoke-invite`. */
export type WhatsappGroupRevokeInviteReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.send`. */
export type WhatsappGroupSendInput = {
  account?: string;
  groupId: string;
  mention?: string[];
  message: string;
};

/** Return shape for `whatsapp.group.send`. */
export type WhatsappGroupSendReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.settings`. */
export type WhatsappGroupSettingsInput = {
  account?: string;
  groupId: string;
  setting: string;
};

/** Return shape for `whatsapp.group.settings`. */
export type WhatsappGroupSettingsReturn = Record<string, unknown>;

/** Input shape for `workflows.runs.archive-node`. */
export type WorkflowsRunsArchiveNodeInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.archive-node`. */
export type WorkflowsRunsArchiveNodeReturn = {
  details: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `workflows.runs.cancel`. */
export type WorkflowsRunsCancelInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.cancel`. */
export type WorkflowsRunsCancelReturn = {
  details: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `workflows.runs.list`. */
export type WorkflowsRunsListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `workflows.runs.list`. */
export type WorkflowsRunsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  runs: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `workflows.runs.release`. */
export type WorkflowsRunsReleaseInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.release`. */
export type WorkflowsRunsReleaseReturn = {
  details: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `workflows.runs.show`. */
export type WorkflowsRunsShowInput = {
  runId: string;
};

/** Return shape for `workflows.runs.show`. */
export type WorkflowsRunsShowReturn = Record<string, unknown>;

/** Input shape for `workflows.runs.skip`. */
export type WorkflowsRunsSkipInput = {
  nodeKey: string;
  runId: string;
};

/** Return shape for `workflows.runs.skip`. */
export type WorkflowsRunsSkipReturn = {
  details: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `workflows.runs.start`. */
export type WorkflowsRunsStartInput = {
  runId?: string;
  specId: string;
};

/** Return shape for `workflows.runs.start`. */
export type WorkflowsRunsStartReturn = Record<string, unknown>;

/** Input shape for `workflows.runs.task-attach`. */
export type WorkflowsRunsTaskAttachInput = {
  nodeKey: string;
  runId: string;
  taskId: string;
};

/** Return shape for `workflows.runs.task-attach`. */
export type WorkflowsRunsTaskAttachReturn = {
  details: Record<string, unknown>;
  [k: string]: unknown;
};

/** Input shape for `workflows.runs.task-create`. */
export type WorkflowsRunsTaskCreateInput = {
  agent?: string;
  instructions?: string;
  nodeKey: string;
  priority?: string;
  profile?: string;
  runId: string;
  session?: string;
  title?: string;
};

/** Return shape for `workflows.runs.task-create`. */
export type WorkflowsRunsTaskCreateReturn = {
  task: Record<string, unknown>;
  workflow: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `workflows.specs.create`. */
export type WorkflowsSpecsCreateInput = {
  definition?: string;
  file?: string;
  specId: string;
};

/** Return shape for `workflows.specs.create`. */
export type WorkflowsSpecsCreateReturn = Record<string, unknown>;

/** Input shape for `workflows.specs.list`. */
export type WorkflowsSpecsListInput = {
  limit?: string;
  offset?: string;
};

/** Return shape for `workflows.specs.list`. */
export type WorkflowsSpecsListReturn = {
  items: Array<Record<string, unknown>>;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
    [k: string]: unknown;
  };
  specs: Array<Record<string, unknown>>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `workflows.specs.show`. */
export type WorkflowsSpecsShowInput = {
  specId: string;
};

/** Return shape for `workflows.specs.show`. */
export type WorkflowsSpecsShowReturn = Record<string, unknown>;
