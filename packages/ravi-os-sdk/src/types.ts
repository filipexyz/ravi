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
  modelPreset?: string;
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
  execute?: boolean;
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
  fields?: string;
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `agents.list`. */
export type AgentsListReturn = {
  agents: Array<{
    allowedSessions?: string[];
    contactScope?: string;
    cwd: string;
    debounceMs?: number;
    defaults?: (Record<string, unknown>) | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    effectiveModel: string | null;
    effectiveProvider: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    groupDebounceMs?: number;
    heartbeat?: {
      accountId?: string;
      activeEnd?: string;
      activeStart?: string;
      enabled: boolean;
      intervalMs: number;
      lastRunAt?: number;
      model?: string;
    };
    id: string;
    isDefault: boolean;
    matrixAccount?: string;
    memoryModel?: string;
    mode?: "active" | "sentinel";
    model?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: ("agent_preset" | "agent_default" | "global_default") | null;
    name?: string;
    provider?: string;
    remote?: string;
    remoteUser?: string;
    settingSources?: Array<"user" | "project">;
    specMode?: boolean;
    systemPromptAppend?: string;
    tags: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  }>;
  defaultAgent: string;
  filters: {
    tag: string | null;
  };
  items: Array<{
    allowedSessions?: string[];
    contactScope?: string;
    cwd: string;
    debounceMs?: number;
    defaults?: (Record<string, unknown>) | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    effectiveModel: string | null;
    effectiveProvider: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    groupDebounceMs?: number;
    heartbeat?: {
      accountId?: string;
      activeEnd?: string;
      activeStart?: string;
      enabled: boolean;
      intervalMs: number;
      lastRunAt?: number;
      model?: string;
    };
    id: string;
    isDefault: boolean;
    matrixAccount?: string;
    memoryModel?: string;
    mode?: "active" | "sentinel";
    model?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: ("agent_preset" | "agent_default" | "global_default") | null;
    name?: string;
    provider?: string;
    remote?: string;
    remoteUser?: string;
    settingSources?: Array<"user" | "project">;
    specMode?: boolean;
    systemPromptAppend?: string;
    tags: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  total: number;
};

/** Input shape for `agents.model-broker`. */
export type AgentsModelBrokerInput = {
  broker?: string;
  clear?: boolean;
  execute?: boolean;
  id: string;
  profile?: string;
  required?: string;
};

/** Return shape for `agents.model-broker`. */
export type AgentsModelBrokerReturn = {
  action: "model-broker";
  agent?: {
    allowedSessions?: string[];
    contactScope?: string;
    cwd: string;
    debounceMs?: number;
    defaults?: (Record<string, unknown>) | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    effectiveModel: string | null;
    effectiveProvider: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    groupDebounceMs?: number;
    heartbeat?: {
      accountId?: string;
      activeEnd?: string;
      activeStart?: string;
      enabled: boolean;
      intervalMs: number;
      lastRunAt?: number;
      model?: string;
    };
    id: string;
    isDefault: boolean;
    matrixAccount?: string;
    memoryModel?: string;
    mode?: "active" | "sentinel";
    model?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: ("agent_preset" | "agent_default" | "global_default") | null;
    name?: string;
    provider?: string;
    remote?: string;
    remoteUser?: string;
    settingSources?: Array<"user" | "project">;
    specMode?: boolean;
    systemPromptAppend?: string;
    tags: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  };
  agentId: string;
  changed: boolean;
  defaults?: (Record<string, unknown>) | null;
  modelBroker: ({
    brokerId: string;
    profileRef: string;
    required?: boolean;
  }) | null;
};

/** Input shape for `agents.permissions`. */
export type AgentsPermissionsInput = {
  capabilities?: string;
  clearCapabilities?: boolean;
  execute?: boolean;
  id: string;
  profile?: string;
};

/** Return shape for `agents.permissions`. */
export type AgentsPermissionsReturn = {
  action: "permissions";
  after?: ({
    capabilities?: Array<string | ({
      objectId?: string;
      objectType?: string;
      permission?: string;
      source?: string;
    })>;
    profile?: "bootstrap" | "full-access";
  }) | null;
  agent?: {
    allowedSessions?: string[];
    contactScope?: string;
    cwd: string;
    debounceMs?: number;
    defaults?: (Record<string, unknown>) | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    effectiveModel: string | null;
    effectiveProvider: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    groupDebounceMs?: number;
    heartbeat?: {
      accountId?: string;
      activeEnd?: string;
      activeStart?: string;
      enabled: boolean;
      intervalMs: number;
      lastRunAt?: number;
      model?: string;
    };
    id: string;
    isDefault: boolean;
    matrixAccount?: string;
    memoryModel?: string;
    mode?: "active" | "sentinel";
    model?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: ("agent_preset" | "agent_default" | "global_default") | null;
    name?: string;
    provider?: string;
    remote?: string;
    remoteUser?: string;
    settingSources?: Array<"user" | "project">;
    specMode?: boolean;
    systemPromptAppend?: string;
    tags: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  };
  agentId: string;
  before?: ({
    capabilities?: Array<string | ({
      objectId?: string;
      objectType?: string;
      permission?: string;
      source?: string;
    })>;
    profile?: "bootstrap" | "full-access";
  }) | null;
  changed: boolean;
  command?: string;
  defaults?: (Record<string, unknown>) | null;
  profile?: string;
  runtimePermissions?: ({
    capabilities?: Array<string | ({
      objectId?: string;
      objectType?: string;
      permission?: string;
      source?: string;
    })>;
    profile?: "bootstrap" | "full-access";
  }) | null;
};

/** Input shape for `agents.reset`. */
export type AgentsResetInput = {
  execute?: boolean;
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
  sessionOverrides: Array<{
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    model?: string;
    sessionName: string;
    thinking?: "off" | "normal" | "verbose";
  }>;
  value: unknown;
  [k: string]: unknown;
};

/** Input shape for `agents.show`. */
export type AgentsShowInput = {
  id: string;
};

/** Return shape for `agents.show`. */
export type AgentsShowReturn = {
  agent: {
    allowedSessions?: string[];
    contactScope?: string;
    cwd: string;
    debounceMs?: number;
    defaults?: (Record<string, unknown>) | null;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    effectiveModel: string | null;
    effectiveProvider: string;
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    groupDebounceMs?: number;
    heartbeat?: {
      accountId?: string;
      activeEnd?: string;
      activeStart?: string;
      enabled: boolean;
      intervalMs: number;
      lastRunAt?: number;
      model?: string;
    };
    id: string;
    isDefault: boolean;
    matrixAccount?: string;
    memoryModel?: string;
    mode?: "active" | "sentinel";
    model?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: ("agent_preset" | "agent_default" | "global_default") | null;
    name?: string;
    provider?: string;
    remote?: string;
    remoteUser?: string;
    settingSources?: Array<"user" | "project">;
    specMode?: boolean;
    systemPromptAppend?: string;
    tags: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  };
  permissionsCommand: string;
  runtimePermissions: ({
    capabilities?: Array<string | ({
      objectId?: string;
      objectType?: string;
      permission?: string;
      source?: string;
    })>;
    profile?: "bootstrap" | "full-access";
  }) | null;
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

/** Input shape for `apps.delete`. */
export type AppsDeleteInput = {
  dryRun?: boolean;
  id: string;
};

/** Return shape for `apps.delete`. */
export type AppsDeleteReturn = {
  dryRun: boolean;
  files: Array<{
    action: "planned" | "deleted" | "not_found";
    kind: "manifest" | "spec" | "skill";
    path: string;
  }>;
  id: string;
  nextCommands: string[];
  removedDirs: string[];
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
        interface: "builtin" | "cli";
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
  builder: {
    command: string;
    reviewChecklist: string[];
    skill: string;
    spec: string;
  };
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
  builder: {
    command: string;
    reviewChecklist: string[];
    skill: string;
    spec: string;
  };
  cliPath: string | null;
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
    action: "planned" | "created" | "overwritten" | "preserved";
    kind: "cli" | "manifest" | "spec" | "skill";
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
        interface: "builtin" | "cli";
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
        interface: "builtin" | "cli";
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
        interface: "builtin" | "cli";
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
  builder: {
    command: string;
    reviewChecklist: string[];
    skill: string;
    spec: string;
  };
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
  execute?: boolean;
  id: string;
  operation?: string;
};

/** Return shape for `apps.run`. */
export type AppsRunReturn = {
  appId: string | null;
  callerContextId?: string;
  channel?: string;
  childContextId?: string;
  command?: string;
  dryRun?: true;
  durationMs: number;
  error?: string;
  errorCode?: string;
  exitCode?: number | null;
  handler?: string;
  interface: ("builtin" | "cli") | null;
  mutating: boolean;
  ok: boolean;
  operation: string | null;
  operationId: string | null;
  permissionProvider?: {
    audit?: {
      evidenceCount: number;
      policyVersion?: string;
    };
    cache: {
      hit: boolean;
      ttlSec?: number;
    };
    decision: "allow" | "deny" | "needs_grant" | "not_applicable" | "error" | "invalid";
    durationMs: number;
    error?: string;
    grantSuggestion?: {
      object: {
        id: string;
        type: string;
      };
      reasonPresent?: boolean;
      relation: string;
      subject: {
        id: string;
        type: string;
      };
      ttlSec?: number;
    };
    interface: "builtin" | "cli";
    providerId: string;
    providerOperationId: string;
    providerVersion: string;
    reason?: string;
    reasonCode: string | null;
    reasonPresent?: boolean;
    requestId: string;
  };
  plan?: {
    appId: string;
    argumentCount: number;
    interface: "builtin" | "cli";
    mutating: true;
    operationId: string;
  };
  result?: unknown;
  status: "completed" | "blocked" | "failed";
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
  builder: {
    command: string;
    reviewChecklist: string[];
    skill: string;
    spec: string;
  };
  cliPath: string | null;
  command: string;
  description: string;
  dryRun: boolean;
  files: Array<{
    action: "planned" | "created" | "overwritten" | "preserved";
    kind: "cli" | "manifest" | "spec" | "skill";
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
        interface: "builtin" | "cli";
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
  fields?: string;
  includeDeleted?: boolean;
  kind?: string;
  lifecycle?: string;
  limit?: string;
  offset?: string;
  orderBy?: string;
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
  execute?: boolean;
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
  authenticated: true;
  consoleUrl: string;
  localSync: ({
    reason: "package_source";
    status: "skipped";
  }) | ({
    artifactId: string;
    eventType: "published";
    status: "recorded";
    versionId: string;
    versionNumber: number;
  }) | ({
    artifactId: string;
    error: string;
    status: "failed";
    versionId: string;
    versionNumber: number;
  });
  publish: unknown;
  release: unknown;
  routes: Array<Record<string, unknown>>;
  site: unknown;
  success: true;
  upload: {
    attempted: number;
    skipped: number;
  };
  uploadSession: (Record<string, unknown>) | null;
  url: string | null;
};

/** Input shape for `artifacts.release.activate`. */
export type ArtifactsReleaseActivateInput = {
  console?: string;
  execute?: boolean;
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
  execute?: boolean;
  format?: string;
  lang?: string;
  model?: string;
  output?: string;
  send?: boolean;
  speed?: string;
  text?: string;
  textFile?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
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

/** Input shape for `calendars.availability`. */
export type CalendarsAvailabilityInput = {
  calendar?: string;
  fields?: string;
  from?: string;
  limit?: string;
  to?: string;
};

/** Return shape for `calendars.availability`. */
export type CalendarsAvailabilityReturn = {
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

/** Input shape for `calendars.create`. */
export type CalendarsCreateInput = {
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

/** Return shape for `calendars.create`. */
export type CalendarsCreateReturn = {
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

/** Input shape for `calendars.disable`. */
export type CalendarsDisableInput = {
  calendar: string;
};

/** Return shape for `calendars.disable`. */
export type CalendarsDisableReturn = {
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

/** Input shape for `calendars.events.cancel`. */
export type CalendarsEventsCancelInput = {
  event: string;
  execute?: boolean;
  idempotencyKey?: string;
};

/** Return shape for `calendars.events.cancel`. */
export type CalendarsEventsCancelReturn = {
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

/** Input shape for `calendars.events.create`. */
export type CalendarsEventsCreateInput = {
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

/** Return shape for `calendars.events.create`. */
export type CalendarsEventsCreateReturn = {
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

/** Input shape for `calendars.events.list`. */
export type CalendarsEventsListInput = {
  calendar?: string;
  fields?: string;
  from?: string;
  includeCancelled?: boolean;
  limit?: string;
  offset?: string;
  query?: string;
  status?: string;
  to?: string;
};

/** Return shape for `calendars.events.list`. */
export type CalendarsEventsListReturn = {
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

/** Input shape for `calendars.events.read`. */
export type CalendarsEventsReadInput = {
  event: string;
};

/** Return shape for `calendars.events.read`. */
export type CalendarsEventsReadReturn = {
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

/** Input shape for `calendars.events.respond`. */
export type CalendarsEventsRespondInput = {
  attendeeAgent?: string;
  attendeeEmail?: string;
  event: string;
  execute?: boolean;
  idempotencyKey?: string;
  status?: string;
};

/** Return shape for `calendars.events.respond`. */
export type CalendarsEventsRespondReturn = {
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

/** Input shape for `calendars.events.update`. */
export type CalendarsEventsUpdateInput = {
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

/** Return shape for `calendars.events.update`. */
export type CalendarsEventsUpdateReturn = {
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

/** Input shape for `calendars.list`. */
export type CalendarsListInput = {
  account?: string;
  fields?: string;
  limit?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `calendars.list`. */
export type CalendarsListReturn = {
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

/** Input shape for `calendars.share`. */
export type CalendarsShareInput = {
  calendar: string;
  execute?: boolean;
  expiresAt?: string;
  relation?: string;
  with?: string;
};

/** Return shape for `calendars.share`. */
export type CalendarsShareReturn = {
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

/** Input shape for `calendars.show`. */
export type CalendarsShowInput = {
  calendar: string;
  members?: boolean;
};

/** Return shape for `calendars.show`. */
export type CalendarsShowReturn = {
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

/** Input shape for `channels.backend.ingress`. */
export type ChannelsBackendIngressInput = {
  agentId: string;
  request: {
    agentId: string;
    channelInstanceId: string;
    content: Array<({
      text: string;
      type: "text";
    }) | ({
      artifactId: string;
      mediaType?: string;
      name?: string;
      sizeBytes?: number;
      type: "artifact";
    })>;
    external: {
      channelKind: string;
      connectionId: string;
      conversationId: string;
      messageId: string;
      senderId: string;
    };
    idempotencyKey: string;
    localActorId: string;
    protocol: "ravi.channel.backend";
    receivedAt: string;
    requestId: string;
    schemaVersion: 1;
  };
};

/** Return shape for `channels.backend.ingress`. */
export type ChannelsBackendIngressReturn = {
  acceptedAt: string;
  binding?: {
    agentId: string;
    channelInstanceId: string;
    chatId: string;
    messageId: string;
    sessionId: string;
    turnId: string;
  };
  disposition: "accepted" | "duplicate" | "rejected";
  error?: {
    category: "validation" | "authentication" | "authorization" | "capacity" | "availability" | "internal";
    code: "INVALID_REQUEST" | "IDEMPOTENCY_CONFLICT" | "UNAUTHENTICATED" | "PERMISSION_DENIED" | "LOCAL_PERMISSION_DENIED" | "NOT_FOUND" | "RATE_LIMITED" | "OVERLOADED" | "UNAVAILABLE" | "INTERNAL";
    correlationId?: string;
    retryAfterMs?: number;
    retryable: boolean;
  };
  protocol: "ravi.channel.backend";
  requestId: string;
  schemaVersion: 1;
};

/** Input shape for `channels.backend.runtime.interrupt`. */
export type ChannelsBackendRuntimeInterruptInput = {
  agentId: string;
  request: {
    binding: {
      agentId: string;
      channelInstanceId: string;
      chatId: string;
      messageId: string;
      sessionId: string;
      turnId: string;
    };
    idempotencyKey: string;
    protocol: "ravi.channel.runtime-events";
    requestId: string;
    requestedAt: string;
    schemaVersion: 1;
  };
};

/** Return shape for `channels.backend.runtime.interrupt`. */
export type ChannelsBackendRuntimeInterruptReturn = {
  acceptedAt: string;
  disposition: "requested" | "duplicate" | "rejected";
  error?: {
    category: "validation" | "authentication" | "authorization" | "capacity" | "availability" | "internal";
    code: "INVALID_REQUEST" | "IDEMPOTENCY_CONFLICT" | "UNAUTHENTICATED" | "PERMISSION_DENIED" | "LOCAL_PERMISSION_DENIED" | "NOT_FOUND" | "RATE_LIMITED" | "OVERLOADED" | "UNAVAILABLE" | "INTERNAL";
    correlationId?: string;
    retryAfterMs?: number;
    retryable: boolean;
  };
  protocol: "ravi.channel.runtime-events";
  requestId: string;
  schemaVersion: 1;
};

/** Input shape for `channels.backend.runtime.readback`. */
export type ChannelsBackendRuntimeReadbackInput = {
  agentId: string;
  request: {
    binding: {
      agentId: string;
      channelInstanceId: string;
      chatId: string;
      messageId: string;
      sessionId: string;
      turnId: string;
    };
    protocol: "ravi.channel.runtime-events";
    requestId: string;
    schemaVersion: 1;
  };
};

/** Return shape for `channels.backend.runtime.readback`. */
export type ChannelsBackendRuntimeReadbackReturn = {
  assistantMessageId?: string;
  binding: {
    agentId: string;
    channelInstanceId: string;
    chatId: string;
    messageId: string;
    sessionId: string;
    turnId: string;
  };
  lastEventRuntimeGenerationId?: string;
  lastSequence: number;
  observedAt: string;
  protocol: "ravi.channel.runtime-events";
  requestId: string;
  runtimeGenerationId?: string;
  schemaVersion: 1;
  state: "accepted" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";
  terminalEvent?: {
    correlation: {
      binding: {
        agentId: string;
        channelInstanceId: string;
        chatId: string;
        messageId: string;
        sessionId: string;
        turnId: string;
      };
      causationId?: string;
      correlationId: string;
      ingressRequestId: string;
    };
    eventId: string;
    kind: "turn.terminal_output";
    occurredAt: string;
    payload: {
      assistantMessageId?: string;
      content?: Array<({
        text: string;
        type: "text";
      }) | ({
        artifactId: string;
        mediaType?: string;
        name?: string;
        sizeBytes?: number;
        type: "artifact";
      })>;
      error?: {
        category: "validation" | "authentication" | "authorization" | "capacity" | "availability" | "internal";
        code: "INVALID_REQUEST" | "IDEMPOTENCY_CONFLICT" | "UNAUTHENTICATED" | "PERMISSION_DENIED" | "LOCAL_PERMISSION_DENIED" | "NOT_FOUND" | "RATE_LIMITED" | "OVERLOADED" | "UNAVAILABLE" | "INTERNAL";
        correlationId?: string;
        retryAfterMs?: number;
        retryable: boolean;
      };
      state: "completed" | "failed" | "interrupted";
    };
    protocol: "ravi.channel.runtime-events";
    schemaVersion: 1;
    sequence: number;
  };
};

/** Input shape for `channels.create`. */
export type ChannelsCreateInput = {
  credentialConnection?: string;
  name: string;
  provider?: string;
};

/** Return shape for `channels.create`. */
export type ChannelsCreateReturn = {
  changedCount: number;
  channel: {
    createdAt: number;
    credentialConnection?: string;
    defaults?: Record<string, unknown>;
    deletedAt?: number;
    enabled?: boolean;
    name: string;
    provider: string;
    updatedAt: number;
  };
  status: string;
};

/** Input shape for `channels.list`. */
export type ChannelsListInput = {
  fields?: string;
  limit?: string;
  offset?: string;
  provider?: string;
};

/** Return shape for `channels.list`. */
export type ChannelsListReturn = {
  channels: Array<{
    createdAt: number;
    credentialConnection?: string;
    defaults?: Record<string, unknown>;
    deletedAt?: number;
    enabled?: boolean;
    name: string;
    provider: string;
    updatedAt: number;
  }>;
  items: Array<{
    createdAt: number;
    credentialConnection?: string;
    defaults?: Record<string, unknown>;
    deletedAt?: number;
    enabled?: boolean;
    name: string;
    provider: string;
    updatedAt: number;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  total: number;
};

/** Input shape for `channels.probe`. */
export type ChannelsProbeInput = Record<string, never>;

/** Return shape for `channels.probe`. */
export type ChannelsProbeReturn = {
  adapters: Array<Record<string, unknown>>;
  outbound: Record<string, unknown>;
  pid: number;
  running: boolean;
  startedAt: number | null;
};

/** Input shape for `channels.restart`. */
export type ChannelsRestartInput = {
  build?: boolean;
};

/** Return shape for `channels.restart`. */
export type ChannelsRestartReturn = {
  action: string;
  changed: boolean;
  pm2Status?: number | null;
  reason?: string;
  runnerEnv?: {
    consumeOutbound: string;
    slackSocketMode: boolean;
  };
  status?: {
    channels: {
      cpu: number | null;
      managed: boolean;
      memoryBytes: number | null;
      memoryMb: number | null;
      name: string;
      pid: number | null;
      pmId: number | null;
      running: boolean;
      status: string;
    };
    health?: {
      checkedAt: number;
      reachable: boolean;
      reason?: string;
      status: "ready" | "starting" | "degraded" | "unreachable" | "stopped";
    };
    pm2Available: boolean;
    processName: string;
    processes: Array<{
      cpu: number | null;
      managed: boolean;
      memoryBytes: number | null;
      memoryMb: number | null;
      name: string;
      pid: number | null;
      pmId: number | null;
      running: boolean;
      status: string;
    }>;
    runner?: ({
      adapters: Array<{
        channelId: string;
        connectedAt?: number;
        id: string;
        lastPongAt?: number;
        reason?: string;
        reconnectCount?: number;
        status: "disabled" | "starting" | "connected" | "degraded" | "reconnecting" | "disconnected" | "failed";
      }>;
      observedAt: number;
      outbound: {
        consumer: string;
        consuming: boolean;
        enabled: boolean;
        infrastructureReady: boolean;
        lastError?: {
          at: number;
          message: string;
          phase: "consume_loop";
        };
        lastMessageAt?: number;
        publishOutbox?: {
          lastError?: {
            at: number;
            message: string;
          };
          lastPublishedAt?: number;
          nextAttemptAt?: number;
          oldestPendingAt?: number;
          pendingCount: number;
        };
        stream: string;
      };
      pid: number;
      running: boolean;
      schemaVersion: 1;
      startedAt: number | null;
    }) | null;
  };
  target?: {
    bundlePath: string;
    cwd: string;
    sourceProjectRoot?: string;
  };
};

/** Input shape for `channels.set`. */
export type ChannelsSetInput = {
  key: string;
  name: string;
  value: string;
};

/** Return shape for `channels.set`. */
export type ChannelsSetReturn = {
  changedCount: number;
  channel: {
    createdAt: number;
    credentialConnection?: string;
    defaults?: Record<string, unknown>;
    deletedAt?: number;
    enabled?: boolean;
    name: string;
    provider: string;
    updatedAt: number;
  };
  status: string;
};

/** Input shape for `channels.show`. */
export type ChannelsShowInput = {
  name: string;
};

/** Return shape for `channels.show`. */
export type ChannelsShowReturn = {
  createdAt: number;
  credentialConnection?: string;
  defaults?: Record<string, unknown>;
  deletedAt?: number;
  enabled?: boolean;
  name: string;
  provider: string;
  updatedAt: number;
};

/** Input shape for `channels.start`. */
export type ChannelsStartInput = {
  build?: boolean;
};

/** Return shape for `channels.start`. */
export type ChannelsStartReturn = {
  action: string;
  changed: boolean;
  pm2Status?: number | null;
  reason?: string;
  runnerEnv?: {
    consumeOutbound: string;
    slackSocketMode: boolean;
  };
  status?: {
    channels: {
      cpu: number | null;
      managed: boolean;
      memoryBytes: number | null;
      memoryMb: number | null;
      name: string;
      pid: number | null;
      pmId: number | null;
      running: boolean;
      status: string;
    };
    health?: {
      checkedAt: number;
      reachable: boolean;
      reason?: string;
      status: "ready" | "starting" | "degraded" | "unreachable" | "stopped";
    };
    pm2Available: boolean;
    processName: string;
    processes: Array<{
      cpu: number | null;
      managed: boolean;
      memoryBytes: number | null;
      memoryMb: number | null;
      name: string;
      pid: number | null;
      pmId: number | null;
      running: boolean;
      status: string;
    }>;
    runner?: ({
      adapters: Array<{
        channelId: string;
        connectedAt?: number;
        id: string;
        lastPongAt?: number;
        reason?: string;
        reconnectCount?: number;
        status: "disabled" | "starting" | "connected" | "degraded" | "reconnecting" | "disconnected" | "failed";
      }>;
      observedAt: number;
      outbound: {
        consumer: string;
        consuming: boolean;
        enabled: boolean;
        infrastructureReady: boolean;
        lastError?: {
          at: number;
          message: string;
          phase: "consume_loop";
        };
        lastMessageAt?: number;
        publishOutbox?: {
          lastError?: {
            at: number;
            message: string;
          };
          lastPublishedAt?: number;
          nextAttemptAt?: number;
          oldestPendingAt?: number;
          pendingCount: number;
        };
        stream: string;
      };
      pid: number;
      running: boolean;
      schemaVersion: 1;
      startedAt: number | null;
    }) | null;
  };
  target?: {
    bundlePath: string;
    cwd: string;
    sourceProjectRoot?: string;
  };
};

/** Input shape for `channels.status`. */
export type ChannelsStatusInput = Record<string, never>;

/** Return shape for `channels.status`. */
export type ChannelsStatusReturn = {
  channels: {
    cpu: number | null;
    managed: boolean;
    memoryBytes: number | null;
    memoryMb: number | null;
    name: string;
    pid: number | null;
    pmId: number | null;
    running: boolean;
    status: string;
  };
  health?: {
    checkedAt: number;
    reachable: boolean;
    reason?: string;
    status: "ready" | "starting" | "degraded" | "unreachable" | "stopped";
  };
  pm2Available: boolean;
  processName: string;
  processes: Array<{
    cpu: number | null;
    managed: boolean;
    memoryBytes: number | null;
    memoryMb: number | null;
    name: string;
    pid: number | null;
    pmId: number | null;
    running: boolean;
    status: string;
  }>;
  runner?: ({
    adapters: Array<{
      channelId: string;
      connectedAt?: number;
      id: string;
      lastPongAt?: number;
      reason?: string;
      reconnectCount?: number;
      status: "disabled" | "starting" | "connected" | "degraded" | "reconnecting" | "disconnected" | "failed";
    }>;
    observedAt: number;
    outbound: {
      consumer: string;
      consuming: boolean;
      enabled: boolean;
      infrastructureReady: boolean;
      lastError?: {
        at: number;
        message: string;
        phase: "consume_loop";
      };
      lastMessageAt?: number;
      publishOutbox?: {
        lastError?: {
          at: number;
          message: string;
        };
        lastPublishedAt?: number;
        nextAttemptAt?: number;
        oldestPendingAt?: number;
        pendingCount: number;
      };
      stream: string;
    };
    pid: number;
    running: boolean;
    schemaVersion: 1;
    startedAt: number | null;
  }) | null;
};

/** Input shape for `channels.stop`. */
export type ChannelsStopInput = Record<string, never>;

/** Return shape for `channels.stop`. */
export type ChannelsStopReturn = {
  action: string;
  changed: boolean;
  pm2Status?: number | null;
  reason?: string;
  runnerEnv?: {
    consumeOutbound: string;
    slackSocketMode: boolean;
  };
  status?: {
    channels: {
      cpu: number | null;
      managed: boolean;
      memoryBytes: number | null;
      memoryMb: number | null;
      name: string;
      pid: number | null;
      pmId: number | null;
      running: boolean;
      status: string;
    };
    health?: {
      checkedAt: number;
      reachable: boolean;
      reason?: string;
      status: "ready" | "starting" | "degraded" | "unreachable" | "stopped";
    };
    pm2Available: boolean;
    processName: string;
    processes: Array<{
      cpu: number | null;
      managed: boolean;
      memoryBytes: number | null;
      memoryMb: number | null;
      name: string;
      pid: number | null;
      pmId: number | null;
      running: boolean;
      status: string;
    }>;
    runner?: ({
      adapters: Array<{
        channelId: string;
        connectedAt?: number;
        id: string;
        lastPongAt?: number;
        reason?: string;
        reconnectCount?: number;
        status: "disabled" | "starting" | "connected" | "degraded" | "reconnecting" | "disconnected" | "failed";
      }>;
      observedAt: number;
      outbound: {
        consumer: string;
        consuming: boolean;
        enabled: boolean;
        infrastructureReady: boolean;
        lastError?: {
          at: number;
          message: string;
          phase: "consume_loop";
        };
        lastMessageAt?: number;
        publishOutbox?: {
          lastError?: {
            at: number;
            message: string;
          };
          lastPublishedAt?: number;
          nextAttemptAt?: number;
          oldestPendingAt?: number;
          pendingCount: number;
        };
        stream: string;
      };
      pid: number;
      running: boolean;
      schemaVersion: 1;
      startedAt: number | null;
    }) | null;
  };
  target?: {
    bundlePath: string;
    cwd: string;
    sourceProjectRoot?: string;
  };
};

/** Input shape for `chats.backfill-provider-timestamps`. */
export type ChatsBackfillProviderTimestampsInput = {
  apply?: boolean;
  dryRun?: boolean;
  limit?: string;
};

/** Return shape for `chats.backfill-provider-timestamps`. */
export type ChatsBackfillProviderTimestampsReturn = Record<string, unknown>;

/** Input shape for `chats.ensure`. */
export type ChatsEnsureInput = {
  actorId: string;
  agentId: string;
  clientRequestId: string;
};

/** Return shape for `chats.ensure`. */
export type ChatsEnsureReturn = {
  chat: {
    actorId: string;
    agentId: string;
    avatarUrl?: string;
    channel: string;
    chatType: "dm" | "group" | "room" | "thread" | "channel" | "unknown";
    createdAt: number;
    firstSeenAt: number;
    id: string;
    instanceId: string;
    lastSeenAt: number;
    metadata?: Record<string, unknown>;
    normalizedChatId?: string;
    platformChatId?: string;
    rawProvenance?: Record<string, unknown>;
    title?: string;
    updatedAt: number;
  };
  clientRequestId: string;
  disposition: "created" | "existing";
};

/** Input shape for `chats.list`. */
export type ChatsListInput = {
  agent?: string;
  channel?: string;
  contact?: string;
  fields?: string;
  includeRaw?: boolean;
  instance?: string;
  limit?: string;
  offset?: string;
  query?: string;
  type?: string;
};

/** Return shape for `chats.list`. */
export type ChatsListReturn = {
  chats: Array<{
    chat: {
      actorId?: string;
      agentId?: string;
      avatarUrl?: string;
      channel: string;
      chatType: "dm" | "group" | "room" | "thread" | "channel" | "unknown";
      createdAt: number;
      firstSeenAt: number;
      id: string;
      instanceId: string;
      lastSeenAt: number;
      metadata?: Record<string, unknown>;
      normalizedChatId?: string;
      platformChatId?: string;
      rawProvenance?: Record<string, unknown>;
      title?: string;
      updatedAt: number;
    };
    lastMessage: ({
      actorId?: string;
      actorType: string;
      agentId?: string;
      channel?: string;
      chatId: string;
      clientMessageId?: string;
      contactId?: string;
      content?: Record<string, unknown>;
      createdAt: number;
      id: string;
      ingestedAt: number;
      instanceId?: string;
      messageType?: string;
      normalizedSenderId?: string;
      platformIdentityId?: string;
      providerMessageId?: string;
      providerTimestamp?: number;
      rawChatId?: string;
      rawProvenance?: Record<string, unknown>;
      rawSenderId?: string;
      revision?: number;
      sortKey: string;
      state?: string;
      updatedAt: number;
    }) | null;
    messageCount: number;
    participantCount: number;
  }>;
  items: Array<{
    chat: {
      actorId?: string;
      agentId?: string;
      avatarUrl?: string;
      channel: string;
      chatType: "dm" | "group" | "room" | "thread" | "channel" | "unknown";
      createdAt: number;
      firstSeenAt: number;
      id: string;
      instanceId: string;
      lastSeenAt: number;
      metadata?: Record<string, unknown>;
      normalizedChatId?: string;
      platformChatId?: string;
      rawProvenance?: Record<string, unknown>;
      title?: string;
      updatedAt: number;
    };
    lastMessage: ({
      actorId?: string;
      actorType: string;
      agentId?: string;
      channel?: string;
      chatId: string;
      clientMessageId?: string;
      contactId?: string;
      content?: Record<string, unknown>;
      createdAt: number;
      id: string;
      ingestedAt: number;
      instanceId?: string;
      messageType?: string;
      normalizedSenderId?: string;
      platformIdentityId?: string;
      providerMessageId?: string;
      providerTimestamp?: number;
      rawChatId?: string;
      rawProvenance?: Record<string, unknown>;
      rawSenderId?: string;
      revision?: number;
      sortKey: string;
      state?: string;
      updatedAt: number;
    }) | null;
    messageCount: number;
    participantCount: number;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  total: number;
};

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
  fields?: string;
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
  fields?: string;
  includeRaw?: boolean;
  limit?: string;
  list: string;
  offset?: string;
  owner?: string;
  reader?: string;
};

/** Return shape for `chats.lists.members`. */
export type ChatsListsMembersReturn = Record<string, unknown>;

/** Input shape for `chats.lists.preview`. */
export type ChatsListsPreviewInput = {
  listId: string;
  owner?: string;
};

/** Return shape for `chats.lists.preview`. */
export type ChatsListsPreviewReturn = {
  list: {
    archivedAt?: number;
    createdAt: number;
    description?: string;
    id: string;
    mode: string;
    name: string;
    ownerId: string;
    ownerType: string;
    updatedAt: number;
    visibility: string;
  };
  preview: {
    current: {
      preserved: number;
      selector: number;
      total: number;
    };
    diff: ({
      added: number;
      eligible: number;
      kept: number;
      preserved: number;
      removed: number;
    }) | null;
    dryRun: true;
    list: {
      archivedAt?: number;
      createdAt: number;
      description?: string;
      id: string;
      mode: string;
      name: string;
      ownerId: string;
      ownerType: string;
      updatedAt: number;
      visibility: string;
    };
    validation: {
      canApply: boolean;
      conditions: {
        negative: number;
        positive: number;
        supported: number;
        total: number;
      };
      issues: Array<{
        code: string;
        message: string;
        path?: string;
        severity: "error" | "warning";
      }>;
      match: "all" | "any";
      riskLevel: "low" | "high";
      scope: "contact" | "chat";
      valid: boolean;
    };
  };
};

/** Input shape for `chats.lists.recompute`. */
export type ChatsListsRecomputeInput = {
  listId: string;
  owner?: string;
};

/** Return shape for `chats.lists.recompute`. */
export type ChatsListsRecomputeReturn = {
  list: {
    archivedAt?: number;
    createdAt: number;
    description?: string;
    id: string;
    mode: string;
    name: string;
    ownerId: string;
    ownerType: string;
    updatedAt: number;
    visibility: string;
  };
  recompute: {
    added: number;
    eligible: number;
    kept: number;
    list: {
      archivedAt?: number;
      createdAt: number;
      description?: string;
      id: string;
      mode: string;
      name: string;
      ownerId: string;
      ownerType: string;
      updatedAt: number;
      visibility: string;
    };
    preserved: number;
    removed: number;
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

/** Input shape for `chats.lists.show`. */
export type ChatsListsShowInput = {
  listId: string;
  owner?: string;
};

/** Return shape for `chats.lists.show`. */
export type ChatsListsShowReturn = {
  current: {
    preserved: number;
    selector: number;
    total: number;
  };
  list: {
    archivedAt?: number;
    createdAt: number;
    description?: string;
    id: string;
    mode: string;
    name: string;
    ownerId: string;
    ownerType: string;
    updatedAt: number;
    visibility: string;
  };
  validation: {
    canApply: boolean;
    conditions: {
      negative: number;
      positive: number;
      supported: number;
      total: number;
    };
    issues: Array<{
      code: string;
      message: string;
      path?: string;
      severity: "error" | "warning";
    }>;
    match: "all" | "any";
    riskLevel: "low" | "high";
    scope: "contact" | "chat";
    valid: boolean;
  };
};

/** Input shape for `chats.messages.create`. */
export type ChatsMessagesCreateInput = {
  actorId: string;
  chatId: string;
  clientMessageId: string;
  content: string;
};

/** Return shape for `chats.messages.create`. */
export type ChatsMessagesCreateReturn = {
  clientMessageId: string;
  disposition: "created" | "duplicate";
  message: {
    actorId: string;
    actorType: "actor";
    agentId?: string;
    channel?: string;
    chatId: string;
    clientMessageId: string;
    contactId?: string;
    content: Record<string, unknown>;
    createdAt: number;
    id: string;
    ingestedAt: number;
    instanceId?: string;
    messageType?: string;
    normalizedSenderId?: string;
    platformIdentityId?: string;
    providerMessageId?: string;
    providerTimestamp?: number;
    rawChatId?: string;
    rawProvenance?: Record<string, unknown>;
    rawSenderId?: string;
    revision: 1;
    sortKey: string;
    state: "created";
    updatedAt: number;
  };
  messageId: string;
};

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
export type ChatsReadReturn = {
  chat: {
    actorId?: string;
    agentId?: string;
    avatarUrl?: string;
    channel: string;
    chatType: "dm" | "group" | "room" | "thread" | "channel" | "unknown";
    createdAt: number;
    firstSeenAt: number;
    id: string;
    instanceId: string;
    lastSeenAt: number;
    metadata?: Record<string, unknown>;
    normalizedChatId?: string;
    platformChatId?: string;
    rawProvenance?: Record<string, unknown>;
    title?: string;
    updatedAt: number;
  };
  messages: Array<{
    actorId?: string;
    actorType: string;
    agentId?: string;
    channel?: string;
    chatId: string;
    clientMessageId?: string;
    contactId?: string;
    content?: Record<string, unknown>;
    createdAt: number;
    id: string;
    ingestedAt: number;
    instanceId?: string;
    messageType?: string;
    normalizedSenderId?: string;
    platformIdentityId?: string;
    providerMessageId?: string;
    providerTimestamp?: number;
    rawChatId?: string;
    rawProvenance?: Record<string, unknown>;
    rawSenderId?: string;
    revision?: number;
    sortKey: string;
    state?: string;
    updatedAt: number;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  total: number;
};

/** Input shape for `cloud.projects.create`. */
export type CloudProjectsCreateInput = {
  console?: string;
  defaultPageSite?: string;
  description?: string;
  execute?: boolean;
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
  fields?: string;
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

/** Input shape for `cloud.scope.clear`. */
export type CloudScopeClearInput = {
  agent?: string;
  console?: string;
  global?: boolean;
  session?: string;
  workspace?: string;
};

/** Return shape for `cloud.scope.clear`. */
export type CloudScopeClearReturn = {
  action: "clear";
  cleared: boolean;
  success: true;
  target: {
    scopeKey: string;
    scopeKind: "session" | "agent" | "workspace" | "global";
  };
};

/** Input shape for `cloud.scope.explain`. */
export type CloudScopeExplainInput = {
  console?: string;
  project?: string;
};

/** Return shape for `cloud.scope.explain`. */
export type CloudScopeExplainReturn = {
  candidates: Array<{
    available: boolean;
    consoleUrl?: string;
    label: string;
    organization?: ({
      id?: string | null;
      name?: string | null;
      slug?: string | null;
    }) | null;
    project?: ({
      id?: string | null;
      name?: string | null;
      ref: string;
      slug?: string | null;
    }) | null;
    reason?: string;
    scopeKey?: string;
    scopeKind?: "session" | "agent" | "workspace" | "global";
    selected: boolean;
    source: "explicit" | "runtime_context" | "local_project_mapping" | "session_default" | "agent_default" | "workspace_default" | "global_default" | "cloud_credentials" | "env_compat" | "single_remote_project";
  }>;
  consoleUrl: string;
  missingProjectCommand?: string | null;
  organization?: ({
    id?: string | null;
    name?: string | null;
    slug?: string | null;
  }) | null;
  resolved: ({
    consoleUrl: string;
    organization?: ({
      id?: string | null;
      name?: string | null;
      slug?: string | null;
    }) | null;
    project?: ({
      id?: string | null;
      name?: string | null;
      ref: string;
      slug?: string | null;
    }) | null;
    source: "explicit" | "runtime_context" | "local_project_mapping" | "session_default" | "agent_default" | "workspace_default" | "global_default" | "cloud_credentials" | "env_compat" | "single_remote_project";
  }) | null;
  success: true;
};

/** Input shape for `cloud.scope.set`. */
export type CloudScopeSetInput = {
  agent?: string;
  console?: string;
  global?: boolean;
  project?: string;
  session?: string;
  workspace?: string;
};

/** Return shape for `cloud.scope.set`. */
export type CloudScopeSetReturn = {
  action: "set";
  scope: {
    consoleUrl: string;
    organization?: ({
      id?: string | null;
      name?: string | null;
      slug?: string | null;
    }) | null;
    project?: ({
      id?: string | null;
      name?: string | null;
      ref: string;
      slug?: string | null;
    }) | null;
    source: "explicit" | "runtime_context" | "local_project_mapping" | "session_default" | "agent_default" | "workspace_default" | "global_default" | "cloud_credentials" | "env_compat" | "single_remote_project";
  };
  success: true;
  target: {
    scopeKey: string;
    scopeKind: "session" | "agent" | "workspace" | "global";
  };
};

/** Input shape for `cloud.scope.show`. */
export type CloudScopeShowInput = {
  console?: string;
};

/** Return shape for `cloud.scope.show`. */
export type CloudScopeShowReturn = {
  scope: {
    consoleUrl: string;
    organization?: ({
      id?: string | null;
      name?: string | null;
      slug?: string | null;
    }) | null;
    project?: ({
      id?: string | null;
      name?: string | null;
      ref: string;
      slug?: string | null;
    }) | null;
    source: "explicit" | "runtime_context" | "local_project_mapping" | "session_default" | "agent_default" | "workspace_default" | "global_default" | "cloud_credentials" | "env_compat" | "single_remote_project";
  };
  success: true;
};

/** Input shape for `commands.list`. */
export type CommandsListInput = {
  agent?: string;
  fields?: string;
  limit?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `commands.list`. */
export type CommandsListReturn = {
  agent: {
    cwd: string;
    id: string;
  };
  commands: Array<({
    argumentHint?: string | null;
    arguments?: string[];
    description?: string | null;
    disabled?: boolean;
    id?: string;
    issues?: Array<{
      code: string;
      id: string | null;
      level: "error" | "warning";
      message: string;
      path: string | null;
      scope: string | null;
    }>;
    path?: string;
    relativePath?: string;
    scope?: string;
    shadowedBy?: string | null;
    shadows?: string[];
    title?: string | null;
    token?: string;
  }) & (({
    id: string;
  }) | ({
    token: string;
  }) | ({
    title: string | null;
  }) | ({
    description: string | null;
  }) | ({
    argumentHint: string | null;
  }) | ({
    arguments: string[];
  }) | ({
    disabled: boolean;
  }) | ({
    scope: string;
  }) | ({
    path: string;
  }) | ({
    relativePath: string;
  }) | ({
    shadowedBy: string | null;
  }) | ({
    shadows: string[];
  }) | ({
    issues: Array<{
      code: string;
      id: string | null;
      level: "error" | "warning";
      message: string;
      path: string | null;
      scope: string | null;
    }>;
  }))>;
  filters?: {
    tag: string;
  };
  issues: Array<{
    code: string;
    id: string | null;
    level: "error" | "warning";
    message: string;
    path: string | null;
    scope: string | null;
  }>;
  items: Array<({
    argumentHint?: string | null;
    arguments?: string[];
    description?: string | null;
    disabled?: boolean;
    id?: string;
    issues?: Array<{
      code: string;
      id: string | null;
      level: "error" | "warning";
      message: string;
      path: string | null;
      scope: string | null;
    }>;
    path?: string;
    relativePath?: string;
    scope?: string;
    shadowedBy?: string | null;
    shadows?: string[];
    title?: string | null;
    token?: string;
  }) & (({
    id: string;
  }) | ({
    token: string;
  }) | ({
    title: string | null;
  }) | ({
    description: string | null;
  }) | ({
    argumentHint: string | null;
  }) | ({
    arguments: string[];
  }) | ({
    disabled: boolean;
  }) | ({
    scope: string;
  }) | ({
    path: string;
  }) | ({
    relativePath: string;
  }) | ({
    shadowedBy: string | null;
  }) | ({
    shadows: string[];
  }) | ({
    issues: Array<{
      code: string;
      id: string | null;
      level: "error" | "warning";
      message: string;
      path: string | null;
      scope: string | null;
    }>;
  }))>;
  locations: {
    agent: string | null;
    global: string;
  };
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  total: number;
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
  fields?: string;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
  limit?: string;
  offset?: string;
  status?: string;
};

/** Return shape for `contacts.list`. */
export type ContactsListReturn = Record<string, unknown>;

/** Input shape for `contacts.merge`. */
export type ContactsMergeInput = {
  execute?: boolean;
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
  execute?: boolean;
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
export type ContextAuthorizeReturn = {
  agentId: string | null;
  allowed: boolean;
  approved: boolean;
  capabilitiesCount: number;
  contextId: string;
  inherited: boolean;
  objectId: string;
  objectType: string;
  permission: string;
  reason: string | null;
};

/** Input shape for `context.capabilities`. */
export type ContextCapabilitiesInput = Record<string, never>;

/** Return shape for `context.capabilities`. */
export type ContextCapabilitiesReturn = {
  agentId: string | null;
  capabilities: Array<{
    objectId: string;
    objectType: string;
    permission: string;
    source?: string;
  }>;
  contextId: string;
  kind: string;
  sessionKey: string | null;
  sessionName: string | null;
};

/** Input shape for `context.check`. */
export type ContextCheckInput = {
  objectId: string;
  objectType: string;
  permission: string;
};

/** Return shape for `context.check`. */
export type ContextCheckReturn = {
  agentId: string | null;
  allowed: boolean;
  capabilitiesCount: number;
  contextId: string;
  objectId: string;
  objectType: string;
  permission: string;
};

/** Input shape for `context.cleanup-agent-runtime`. */
export type ContextCleanupAgentRuntimeInput = {
  agent?: string;
  olderThan?: string;
  reason?: string;
  revoke?: boolean;
  session?: string;
};

/** Return shape for `context.cleanup-agent-runtime`. */
export type ContextCleanupAgentRuntimeReturn = {
  candidates: Array<{
    context: {
      agentId: string | null;
      capabilitiesCount: number;
      contextId: string;
      createdAt: number;
      expiresAt: number | null;
      issuanceMode: string | null;
      issuedFor: string | null;
      kind: string;
      lastUsedAt: number | null;
      parentContextId: string | null;
      revokedAt: number | null;
      sessionKey: string | null;
      sessionName: string | null;
      status: "active" | "expired" | "revoked";
    };
    lastSeenAt: number;
    sessionExists: boolean;
  }>;
  candidatesCount: number;
  cutoffAt: number;
  dryRun: boolean;
  olderThan: string;
  olderThanMs: number;
  reason: string | null;
  revoked: Array<{
    cascaded: Array<{
      agentId: string | null;
      capabilitiesCount: number;
      contextId: string;
      createdAt: number;
      expiresAt: number | null;
      issuanceMode: string | null;
      issuedFor: string | null;
      kind: string;
      lastUsedAt: number | null;
      parentContextId: string | null;
      revokedAt: number | null;
      sessionKey: string | null;
      sessionName: string | null;
      status: "active" | "expired" | "revoked";
    }>;
    context: {
      agentId: string | null;
      capabilities: Array<{
        objectId: string;
        objectType: string;
        permission: string;
        source?: string;
      }>;
      capabilitiesCount: number;
      contextId: string;
      createdAt: number;
      expiresAt: number | null;
      issuanceMode: string | null;
      issuedFor: string | null;
      kind: string;
      lastUsedAt: number | null;
      lineage: {
        approvalSource: unknown | null;
        issuanceMode: string | null;
        issuedAt: number | null;
        issuedFor: string | null;
        parentContextId: string | null;
        parentContextKind: string | null;
      };
      metadata: (Record<string, unknown>) | null;
      parentContextId: string | null;
      revokedAt: number | null;
      sessionKey: string | null;
      sessionName: string | null;
      source: ({
        accountId: string;
        channel: string;
        chatId: string;
        threadId?: string;
      }) | null;
      status: "active" | "expired" | "revoked";
    };
    revokedAt: number;
  }>;
  revokedCount: number;
  scanned: {
    agentId: string | null;
    kind: "agent-runtime";
    sessionKey: string | null;
  };
};

/** Input shape for `context.codex-bash-hook`. */
export type ContextCodexBashHookInput = Record<string, never>;

/** Return shape for `context.codex-bash-hook`. */
export type ContextCodexBashHookReturn = {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
};

/** Input shape for `context.credentials.add`. */
export type ContextCredentialsAddInput = {
  contextKey: string;
  label?: string;
  setDefault?: boolean;
};

/** Return shape for `context.credentials.add`. */
export type ContextCredentialsAddReturn = {
  added: string;
  default: string | null;
  path: string;
};

/** Input shape for `context.credentials.list`. */
export type ContextCredentialsListInput = {
  fields?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `context.credentials.list`. */
export type ContextCredentialsListReturn = {
  default: string | null;
  entries: Array<{
    agentId: string | null;
    contextId: string;
    contextKey: string;
    expiresAt: number | null;
    isDefault: boolean;
    issuedAt: number;
    kind: string | null;
    label: string | null;
  }>;
  exists: boolean;
  items: Array<{
    agentId: string | null;
    contextId: string;
    contextKey: string;
    expiresAt: number | null;
    isDefault: boolean;
    issuedAt: number;
    kind: string | null;
    label: string | null;
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
  path: string;
  total: number;
};

/** Input shape for `context.credentials.remove`. */
export type ContextCredentialsRemoveInput = {
  contextKey: string;
  execute?: boolean;
};

/** Return shape for `context.credentials.remove`. */
export type ContextCredentialsRemoveReturn = {
  default: string | null;
  path: string;
  removed: string;
};

/** Input shape for `context.credentials.set-default`. */
export type ContextCredentialsSetDefaultInput = {
  contextKey: string;
};

/** Return shape for `context.credentials.set-default`. */
export type ContextCredentialsSetDefaultReturn = {
  default: string | null;
  path: string;
};

/** Input shape for `context.info`. */
export type ContextInfoInput = {
  contextId: string;
};

/** Return shape for `context.info`. */
export type ContextInfoReturn = {
  agentId: string | null;
  capabilities: Array<{
    objectId: string;
    objectType: string;
    permission: string;
    source?: string;
  }>;
  capabilitiesCount: number;
  contextId: string;
  createdAt: number;
  expiresAt: number | null;
  issuanceMode: string | null;
  issuedFor: string | null;
  kind: string;
  lastUsedAt: number | null;
  lineage: {
    approvalSource: unknown | null;
    issuanceMode: string | null;
    issuedAt: number | null;
    issuedFor: string | null;
    parentContextId: string | null;
    parentContextKind: string | null;
  };
  metadata: (Record<string, unknown>) | null;
  parentContextId: string | null;
  revokedAt: number | null;
  sessionKey: string | null;
  sessionName: string | null;
  source: ({
    accountId: string;
    channel: string;
    chatId: string;
    threadId?: string;
  }) | null;
  status: "active" | "expired" | "revoked";
};

/** Input shape for `context.issue`. */
export type ContextIssueInput = {
  allow?: string;
  cliName: string;
  inherit?: boolean;
  ttl?: string;
};

/** Return shape for `context.issue`. */
export type ContextIssueReturn = {
  agentId: string | null;
  capabilities: Array<{
    objectId: string;
    objectType: string;
    permission: string;
    source?: string;
  }>;
  capabilitiesCount: number;
  cliName: string;
  contextId: string;
  contextKey: string;
  createdAt: number;
  env: Record<string, string>;
  expiresAt: number | null;
  kind: string;
  metadata: (Record<string, unknown>) | null;
  parentContextId: string;
  sessionKey: string | null;
  sessionName: string | null;
  source: ({
    accountId: string;
    channel: string;
    chatId: string;
    threadId?: string;
  }) | null;
};

/** Input shape for `context.lineage`. */
export type ContextLineageInput = {
  contextId: string;
};

/** Return shape for `context.lineage`. */
export type ContextLineageReturn = {
  ancestors: Array<{
    agentId: string | null;
    capabilitiesCount: number;
    contextId: string;
    createdAt: number;
    expiresAt: number | null;
    issuanceMode: string | null;
    issuedFor: string | null;
    kind: string;
    lastUsedAt: number | null;
    parentContextId: string | null;
    revokedAt: number | null;
    sessionKey: string | null;
    sessionName: string | null;
    status: "active" | "expired" | "revoked";
  }>;
  context: {
    agentId: string | null;
    capabilities: Array<{
      objectId: string;
      objectType: string;
      permission: string;
      source?: string;
    }>;
    capabilitiesCount: number;
    contextId: string;
    createdAt: number;
    expiresAt: number | null;
    issuanceMode: string | null;
    issuedFor: string | null;
    kind: string;
    lastUsedAt: number | null;
    lineage: {
      approvalSource: unknown | null;
      issuanceMode: string | null;
      issuedAt: number | null;
      issuedFor: string | null;
      parentContextId: string | null;
      parentContextKind: string | null;
    };
    metadata: (Record<string, unknown>) | null;
    parentContextId: string | null;
    revokedAt: number | null;
    sessionKey: string | null;
    sessionName: string | null;
    source: ({
      accountId: string;
      channel: string;
      chatId: string;
      threadId?: string;
    }) | null;
    status: "active" | "expired" | "revoked";
  };
  descendants: Array<{
    agentId: string | null;
    capabilitiesCount: number;
    contextId: string;
    createdAt: number;
    expiresAt: number | null;
    issuanceMode: string | null;
    issuedFor: string | null;
    kind: string;
    lastUsedAt: number | null;
    parentContextId: string | null;
    revokedAt: number | null;
    sessionKey: string | null;
    sessionName: string | null;
    status: "active" | "expired" | "revoked";
  }>;
};

/** Input shape for `context.list`. */
export type ContextListInput = {
  agent?: string;
  all?: boolean;
  fields?: string;
  kind?: string;
  limit?: string;
  offset?: string;
  session?: string;
};

/** Return shape for `context.list`. */
export type ContextListReturn = {
  contexts: Array<{
    agentId: string | null;
    capabilitiesCount: number;
    contextId: string;
    createdAt: number;
    expiresAt: number | null;
    issuanceMode: string | null;
    issuedFor: string | null;
    kind: string;
    lastUsedAt: number | null;
    parentContextId: string | null;
    revokedAt: number | null;
    sessionKey: string | null;
    sessionName: string | null;
    status: "active" | "expired" | "revoked";
  }>;
  count: number;
  items: Array<{
    agentId: string | null;
    capabilitiesCount: number;
    contextId: string;
    createdAt: number;
    expiresAt: number | null;
    issuanceMode: string | null;
    issuedFor: string | null;
    kind: string;
    lastUsedAt: number | null;
    parentContextId: string | null;
    revokedAt: number | null;
    sessionKey: string | null;
    sessionName: string | null;
    status: "active" | "expired" | "revoked";
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

/** Input shape for `context.prune`. */
export type ContextPruneInput = {
  apply?: boolean;
  confirm?: string;
  olderThan?: string;
};

/** Return shape for `context.prune`. */
export type ContextPruneReturn = {
  changedCount: number;
  dryRun: boolean;
  matchedCount: number;
  olderThan: string;
  status: "pruned" | "planned";
};

/** Input shape for `context.revoke`. */
export type ContextRevokeInput = {
  contextId: string;
  noCascade?: boolean;
  reason?: string;
};

/** Return shape for `context.revoke`. */
export type ContextRevokeReturn = {
  cascaded: Array<{
    agentId: string | null;
    capabilitiesCount: number;
    contextId: string;
    createdAt: number;
    expiresAt: number | null;
    issuanceMode: string | null;
    issuedFor: string | null;
    kind: string;
    lastUsedAt: number | null;
    parentContextId: string | null;
    revokedAt: number | null;
    sessionKey: string | null;
    sessionName: string | null;
    status: "active" | "expired" | "revoked";
  }>;
  context: {
    agentId: string | null;
    capabilities: Array<{
      objectId: string;
      objectType: string;
      permission: string;
      source?: string;
    }>;
    capabilitiesCount: number;
    contextId: string;
    createdAt: number;
    expiresAt: number | null;
    issuanceMode: string | null;
    issuedFor: string | null;
    kind: string;
    lastUsedAt: number | null;
    lineage: {
      approvalSource: unknown | null;
      issuanceMode: string | null;
      issuedAt: number | null;
      issuedFor: string | null;
      parentContextId: string | null;
      parentContextKind: string | null;
    };
    metadata: (Record<string, unknown>) | null;
    parentContextId: string | null;
    revokedAt: number | null;
    sessionKey: string | null;
    sessionName: string | null;
    source: ({
      accountId: string;
      channel: string;
      chatId: string;
      threadId?: string;
    }) | null;
    status: "active" | "expired" | "revoked";
  };
  revokedAt: number;
};

/** Input shape for `context.visibility`. */
export type ContextVisibilityInput = Record<string, never>;

/** Return shape for `context.visibility`. */
export type ContextVisibilityReturn = {
  agentId: string;
  compact: {
    count: number;
    lastCompactedAt: number | null;
    threshold: number | null;
    willCompactAt: number | null;
  };
  lastUpdatedAt: number;
  loadedSkills: string[];
  provider: string | null;
  sessionKey: string;
  skills: Array<{
    confidence: string;
    evidence?: Array<{
      detail?: string;
      itemId?: string;
      kind: string;
    }>;
    id: string;
    lastSeenAt: number;
    loadedAt?: number | null;
    provider: string;
    source?: string;
    state: string;
  }>;
  tokens: {
    limit: number | null;
    remaining: number | null;
    used: number | null;
  };
};

/** Input shape for `context.whoami`. */
export type ContextWhoamiInput = Record<string, never>;

/** Return shape for `context.whoami`. */
export type ContextWhoamiReturn = {
  agentId: string | null;
  capabilities: Array<{
    objectId: string;
    objectType: string;
    permission: string;
    source?: string;
  }>;
  capabilitiesCount: number;
  contextId: string;
  createdAt: number;
  expiresAt: number | null;
  issuanceMode: string | null;
  issuedFor: string | null;
  kind: string;
  lastUsedAt: number | null;
  lineage: {
    approvalSource: unknown | null;
    issuanceMode: string | null;
    issuedAt: number | null;
    issuedFor: string | null;
    parentContextId: string | null;
    parentContextKind: string | null;
  };
  metadata: (Record<string, unknown>) | null;
  parentContextId: string | null;
  revokedAt: number | null;
  sessionKey: string | null;
  sessionName: string | null;
  source: ({
    accountId: string;
    channel: string;
    chatId: string;
    threadId?: string;
  }) | null;
  status: "active" | "expired" | "revoked";
};

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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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

/** Input shape for `credentials.connections.disable`. */
export type CredentialsConnectionsDisableInput = {
  connection?: string;
  provider?: string;
};

/** Return shape for `credentials.connections.disable`. */
export type CredentialsConnectionsDisableReturn = {
  connection: ({
    backend: "keychain" | "vault";
    connection: string;
    createdAt: number;
    id: string;
    label: string | null;
    provider: string;
    scopes: string[];
    secretRef: string;
    status: "active" | "disabled";
    updatedAt: number;
  }) | null;
};

/** Input shape for `credentials.connections.enable`. */
export type CredentialsConnectionsEnableInput = {
  connection?: string;
  provider?: string;
};

/** Return shape for `credentials.connections.enable`. */
export type CredentialsConnectionsEnableReturn = {
  connection: ({
    backend: "keychain" | "vault";
    connection: string;
    createdAt: number;
    id: string;
    label: string | null;
    provider: string;
    scopes: string[];
    secretRef: string;
    status: "active" | "disabled";
    updatedAt: number;
  }) | null;
};

/** Input shape for `credentials.connections.list`. */
export type CredentialsConnectionsListInput = {
  all?: boolean;
  fields?: string;
  limit?: string;
  offset?: string;
  provider?: string;
  status?: string;
};

/** Return shape for `credentials.connections.list`. */
export type CredentialsConnectionsListReturn = {
  items: Array<{
    backend: "keychain" | "vault";
    connection: string;
    createdAt: number;
    id: string;
    label: string | null;
    provider: string;
    scopes: string[];
    secretRef: string;
    status: "active" | "disabled";
    updatedAt: number;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  total: number;
};

/** Input shape for `credentials.connections.show`. */
export type CredentialsConnectionsShowInput = {
  connection?: string;
  provider?: string;
};

/** Return shape for `credentials.connections.show`. */
export type CredentialsConnectionsShowReturn = {
  connection: {
    backend: "keychain" | "vault";
    connection: string;
    createdAt: number;
    id: string;
    label: string | null;
    provider: string;
    scopes: string[];
    secretRef: string;
    status: "active" | "disabled";
    updatedAt: number;
  };
};

/** Input shape for `credentials.policies.explain`. */
export type CredentialsPoliciesExplainInput = {
  action?: string;
  connection?: string;
  provider?: string;
};

/** Return shape for `credentials.policies.explain`. */
export type CredentialsPoliciesExplainReturn = {
  action: string;
  approval: {
    reason: string;
    required: boolean;
  };
  connection: string;
  provider: string;
  requiredCapabilities: string[];
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  analystAvoid?: string;
  analystMentions?: string;
  analystTone?: string;
  consumer?: string;
  default?: boolean;
  entityType?: string;
  hitlRequiredWhen?: string;
  idempotencyKey?: string;
  messagePrefix?: string;
  messageSuffix?: string;
  metadata?: string;
  name: string;
  objetivo?: string;
  priorityGlobal?: string;
  producer?: string;
  readingListId?: string;
  reguaTag?: string[];
  relatedCron?: string;
  relatedTrigger?: string;
  sendWindow?: string;
  versao?: string;
  vipGuardAction?: string;
  vipGuardLtv?: string;
  vipGuardTag?: string;
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
  fields?: string;
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

/** Input shape for `crm.pipeline.policy.hitl-check`. */
export type CrmPipelinePolicyHitlCheckInput = {
  context?: string;
  pipeline: string;
};

/** Return shape for `crm.pipeline.policy.hitl-check`. */
export type CrmPipelinePolicyHitlCheckReturn = {
  decision: {
    hitlRequired: boolean;
    matchedConditions: number;
    reasons: string[];
  };
  errors: Array<{
    code?: string;
    message: string;
    path: string;
    severity: "warning" | "error";
  }>;
  ok: boolean;
  pipelineId: string;
  warnings: Array<{
    code?: string;
    message: string;
    path: string;
    severity: "warning" | "error";
  }>;
};

/** Input shape for `crm.pipeline.policy.send-window-check`. */
export type CrmPipelinePolicySendWindowCheckInput = {
  at?: string;
  pipeline: string;
};

/** Return shape for `crm.pipeline.policy.send-window-check`. */
export type CrmPipelinePolicySendWindowCheckReturn = {
  decision: {
    allowed: boolean;
    evaluatedAtIso: string;
    reason: string;
    releaseAtIso?: string;
    timezone: string;
  };
  errors: Array<{
    code?: string;
    message: string;
    path: string;
    severity: "warning" | "error";
  }>;
  ok: boolean;
  pipelineId: string;
  warnings: Array<{
    code?: string;
    message: string;
    path: string;
    severity: "warning" | "error";
  }>;
};

/** Input shape for `crm.pipeline.review`. */
export type CrmPipelineReviewInput = {
  pipeline: string;
};

/** Return shape for `crm.pipeline.review`. */
export type CrmPipelineReviewReturn = {
  fields: Array<{
    detail: string;
    field: string;
    group: "identidade" | "estrutura" | "politicas" | "tags" | "comunicacao" | "integracoes";
    present: "present" | "absent" | "partial";
    suggestion?: string;
  }>;
  highSeverityGaps: number;
  pipelineId: string;
  pipelineName: string;
  totalGaps: number;
};

/** Input shape for `crm.pipeline.set`. */
export type CrmPipelineSetInput = {
  analystAvoid?: string;
  analystMentions?: string;
  analystTone?: string;
  consumer?: string;
  field: string;
  hitlRequiredWhen?: string;
  messagePrefix?: string;
  messageSuffix?: string;
  objetivo?: string;
  pipeline: string;
  priorityGlobal?: string;
  producer?: string;
  readingListId?: string;
  reguaTag?: string[];
  relatedCron?: string;
  relatedTrigger?: string;
  sendWindow?: string;
  value: string;
  versao?: string;
  vipGuardAction?: string;
  vipGuardLtv?: string;
  vipGuardTag?: string;
};

/** Return shape for `crm.pipeline.set`. */
export type CrmPipelineSetReturn = {
  changedCount: number;
  status: string;
  [k: string]: unknown;
};

/** Input shape for `crm.pipeline.show`. */
export type CrmPipelineShowInput = {
  explain?: boolean;
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

/** Input shape for `crm.pipeline.validate`. */
export type CrmPipelineValidateInput = {
  pipeline?: string;
  schemaJson?: boolean;
};

/** Return shape for `crm.pipeline.validate`. */
export type CrmPipelineValidateReturn = {
  errors: Array<{
    code?: string;
    message: string;
    path: string;
    severity: "warning" | "error";
  }>;
  ok: boolean;
  pipelineId: string;
  schema?: Record<string, unknown>;
  warnings: Array<{
    code?: string;
    message: string;
    path: string;
    severity: "warning" | "error";
  }>;
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
  idempotencyKey?: string;
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
  agent?: string;
  allAgents?: boolean;
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  runtime: {
    alignment: "aligned" | "drifted" | "unknown" | "not_running";
    channels: {
      bundlePath: string | null;
      cwd: string | null;
      managed: boolean;
      matchesCli: boolean | null;
      name: string;
      online: boolean;
      pid: number | null;
      status: string;
      version: string | null;
    };
    cli: {
      bundlePath: string | null;
      cwd: string | null;
      version: string | null;
    };
    daemon: {
      bundlePath: string | null;
      cwd: string | null;
      managed: boolean;
      matchesCli: boolean | null;
      name: string;
      online: boolean;
      pid: number | null;
      status: string;
      version: string | null;
    };
  };
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
  self: {
    org_id?: string;
    principal_type?: string;
    service_user_id?: string;
    service_user_name?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.archive`. */
export type DevinSessionsArchiveInput = {
  execute?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.archive`. */
export type DevinSessionsArchiveReturn = {
  session: {
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  };
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
  attachments: Array<{
    attachmentId: string;
    contentType?: string | null;
    name: string;
    source: string;
    url: string;
    [k: string]: unknown;
  }>;
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
  devinId?: string;
  devinMode?: string;
  execute?: boolean;
  knowledge?: string[];
  maxAcu?: string;
  noMaxAcuLimit?: boolean;
  noResumable?: boolean;
  platform?: string;
  playbook?: string;
  project?: string;
  prompt?: string;
  promptFile?: string;
  proxRun?: string;
  repo?: string[];
  resumable?: boolean;
  secret?: string[];
  sessionLink?: string[];
  sessionSecret?: string[];
  structuredOutputRequired?: boolean;
  structuredOutputSchema?: string;
  tag?: string[];
  task?: string;
  title?: string;
};

/** Return shape for `devin.sessions.create`. */
export type DevinSessionsCreateReturn = {
  devinMode?: string | null;
  maxAcuLimit: number | null;
  maxAcuLimitSource: string;
  platform?: string | null;
  resumable?: boolean | null;
  session: {
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  };
  status: "created";
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.insights`. */
export type DevinSessionsInsightsInput = {
  execute?: boolean;
  generate?: boolean;
  session: string;
};

/** Return shape for `devin.sessions.insights`. */
export type DevinSessionsInsightsReturn = {
  insights: {
    analysis?: (Record<string, unknown>) | null;
    numDevinMessages?: number;
    numUserMessages?: number;
    sessionSize?: string | null;
    [k: string]: unknown;
  };
  session: {
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  };
  summary: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.list`. */
export type DevinSessionsListInput = {
  fields?: string;
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
  sessions: Array<{
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  }>;
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
  messages: Array<{
    createdAt: number;
    eventId: string;
    message: string;
    source: string;
    [k: string]: unknown;
  }>;
  total: number;
  [k: string]: unknown;
};

/** Input shape for `devin.sessions.send`. */
export type DevinSessionsSendInput = {
  asUser?: string;
  execute?: boolean;
  message: string;
  session: string;
};

/** Return shape for `devin.sessions.send`. */
export type DevinSessionsSendReturn = {
  session: {
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  };
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
  session: {
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  };
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
  session: {
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  };
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
  session: {
    acusConsumed?: number;
    devinId: string;
    devinMode?: string | null;
    effectiveCreateAsUserId?: string | null;
    id?: string;
    isArchived?: boolean;
    lastSyncedAt?: number | null;
    maxAcuLimit?: number | null;
    maxAcuLimitSource?: string | null;
    origin?: string | null;
    originId?: string | null;
    originType?: string | null;
    platform?: string | null;
    projectId?: string | null;
    proxRunId?: string | null;
    resumable?: boolean | null;
    serviceUserId?: string | null;
    status: string;
    statusDetail: string | null;
    tags: string[];
    taskId?: string | null;
    title: string | null;
    updatedAt: number;
    url: string;
    userId?: string | null;
    [k: string]: unknown;
  };
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

/** Input shape for `feedback.send`. */
export type FeedbackSendInput = {
  console?: string;
  execute?: boolean;
  kind?: string;
  message: string[];
  metadataJson?: string;
  project?: string;
  severity?: string;
  surface?: string;
  tag?: string;
  title?: string;
  url?: string;
};

/** Return shape for `feedback.send`. */
export type FeedbackSendReturn = {
  consoleUrl: string;
  feedback: Record<string, unknown>;
  success: true;
  url: string;
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
export type HeartbeatStatusInput = {
  fields?: string;
};

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
  execute?: boolean;
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
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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

/** Input shape for `meetings.finalize`. */
export type MeetingsFinalizeInput = {
  noPostTranscribe?: boolean;
  runDir?: string;
  title?: string;
};

/** Return shape for `meetings.finalize`. */
export type MeetingsFinalizeReturn = {
  artifactId: string;
  artifactPath: string;
  diagnosticCount: number;
  handoffMessage: string;
  mediaRefCount: number;
  session: {
    endedAt: string | null;
    id: string;
    provider: string;
    providerMeetingId: string | null;
    startedAt: string | null;
    title: string | null;
  };
  transcriptSegmentCount: number;
};

/** Input shape for `meetings.profiles.init`. */
export type MeetingsProfilesInitInput = {
  profileId: string;
  source?: string;
};

/** Return shape for `meetings.profiles.init`. */
export type MeetingsProfilesInitReturn = {
  profileDir: string;
  profilePath: string;
  sourceKind: string;
};

/** Input shape for `meetings.profiles.list`. */
export type MeetingsProfilesListInput = {
  fields?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `meetings.profiles.list`. */
export type MeetingsProfilesListReturn = {
  items: Array<{
    chrome: {
      browserChannel: string | null;
      profileDir: string | null;
    };
    defaults: {
      capture?: string;
      duration?: string;
      emptyGrace?: string;
      maxDuration?: string;
      name?: string;
      out?: string;
    };
    id: string;
    label: string;
    live: {
      agentId: string | null;
      contextChars: number;
      enabled: boolean;
      includeSessionContext: boolean;
      initialPromptChars: number;
      initialPromptDelay: string | null;
      tools: string[];
    };
    provider: string;
    source: string;
    sourceKind: string;
    version: string;
    voice: {
      runtime: string;
    };
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
  profiles: Array<{
    chrome: {
      browserChannel: string | null;
      profileDir: string | null;
    };
    defaults: {
      capture?: string;
      duration?: string;
      emptyGrace?: string;
      maxDuration?: string;
      name?: string;
      out?: string;
    };
    id: string;
    label: string;
    live: {
      agentId: string | null;
      contextChars: number;
      enabled: boolean;
      includeSessionContext: boolean;
      initialPromptChars: number;
      initialPromptDelay: string | null;
      tools: string[];
    };
    provider: string;
    source: string;
    sourceKind: string;
    version: string;
    voice: {
      runtime: string;
    };
  }>;
  total: number;
};

/** Input shape for `meetings.profiles.show`. */
export type MeetingsProfilesShowInput = {
  profileId: string;
};

/** Return shape for `meetings.profiles.show`. */
export type MeetingsProfilesShowReturn = {
  chrome: {
    browserChannel: string | null;
    profileDir: string | null;
  };
  defaults: {
    capture?: string;
    duration?: string;
    emptyGrace?: string;
    maxDuration?: string;
    name?: string;
    out?: string;
  };
  id: string;
  label: string;
  live: {
    agentId: string | null;
    contextChars: number;
    enabled: boolean;
    includeSessionContext: boolean;
    initialPromptChars: number;
    initialPromptDelay: string | null;
    tools: string[];
  };
  provider: string;
  source: string;
  sourceKind: string;
  version: string;
  voice: {
    runtime: string;
  };
};

/** Input shape for `meetings.profiles.validate`. */
export type MeetingsProfilesValidateInput = {
  profileId?: string;
};

/** Return shape for `meetings.profiles.validate`. */
export type MeetingsProfilesValidateReturn = {
  results: Array<{
    error?: string;
    id: string;
    source: string;
    sourceKind: string;
    valid: boolean;
  }>;
  valid: boolean;
};

/** Input shape for `meetings.voice-runtimes`. */
export type MeetingsVoiceRuntimesInput = Record<string, never>;

/** Return shape for `meetings.voice-runtimes`. */
export type MeetingsVoiceRuntimesReturn = {
  candidates: Array<{
    availability: string;
    constraints: string[];
    defaultModel?: string;
    docsUrl: string;
    id: string;
    kind: string;
    label: string;
    providerRuntime?: string;
    strengths: string[];
  }>;
  defaultRuntimeId: string;
  recommendation: string;
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  reconcile?: string;
  session: string;
};

/** Return shape for `observers.refresh`. */
export type ObserversRefreshReturn = {
  bindings: Array<Record<string, unknown>>;
  created: Array<Record<string, unknown>>;
  disabled: Array<Record<string, unknown>>;
  mode: "attach-missing" | "detach-disabled" | "refresh-profile" | "full-reconcile";
  refreshedProfiles: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  source: (Record<string, unknown>) | null;
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
  fields?: string;
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
  execute?: boolean;
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
  selector?: string;
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
  args: string[];
  console?: string;
  defaultSite?: boolean;
  execute?: boolean;
  project?: string;
  visibility?: string;
};

/** Return shape for `pages.create`. */
export type PagesCreateReturn = {
  consoleUrl: string;
  contentPublishCommand: string | null;
  projectRef: string;
  site: Record<string, unknown>;
  success: true;
  url: string | null;
};

/** Input shape for `pages.domains`. */
export type PagesDomainsInput = {
  args: string[];
  check?: boolean;
  console?: string;
  execute?: boolean;
  project?: string;
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
  fields?: string;
  limit?: string;
  offset?: string;
  project?: string;
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

/** Input shape for `pages.password.remove`. */
export type PagesPasswordRemoveInput = {
  args: string[];
  console?: string;
  execute?: boolean;
  project?: string;
  route?: string;
  visibility?: string;
};

/** Return shape for `pages.password.remove`. */
export type PagesPasswordRemoveReturn = {
  action: "remove" | "set" | "status";
  configured: boolean;
  consoleUrl: string;
  path: string;
  policy: (Record<string, unknown>) | null;
  projectRef: string;
  release: Record<string, unknown>;
  route: Record<string, unknown>;
  scope: "route";
  site: Record<string, unknown>;
  siteRef: string;
  success: true;
  url: string;
};

/** Input shape for `pages.password.status`. */
export type PagesPasswordStatusInput = {
  args: string[];
  console?: string;
  project?: string;
  route?: string;
};

/** Return shape for `pages.password.status`. */
export type PagesPasswordStatusReturn = {
  action: "remove" | "set" | "status";
  configured: boolean;
  consoleUrl: string;
  path: string;
  policy: (Record<string, unknown>) | null;
  projectRef: string;
  release: Record<string, unknown>;
  route: Record<string, unknown>;
  scope: "route";
  site: Record<string, unknown>;
  siteRef: string;
  success: true;
  url: string;
};

/** Input shape for `pages.publish`. */
export type PagesPublishInput = {
  args: string[];
  artifactSlug?: string;
  artifactVersion?: string;
  assetBase?: string;
  basePath?: string;
  console?: string;
  description?: string;
  entrypoint?: string;
  execute?: boolean;
  idempotencyKey?: string;
  noActivate?: boolean;
  project?: string;
  reason?: string;
  replaceRelease?: boolean;
  route?: string;
  site?: string;
  title?: string;
  uploadSession?: string;
  visibility?: string;
};

/** Return shape for `pages.publish`. */
export type PagesPublishReturn = {
  artifact: unknown;
  artifactVersion: unknown;
  authenticated: true;
  consoleUrl: string;
  localSync: ({
    reason: "package_source";
    status: "skipped";
  }) | ({
    artifactId: string;
    eventType: "published";
    status: "recorded";
    versionId: string;
    versionNumber: number;
  }) | ({
    artifactId: string;
    error: string;
    status: "failed";
    versionId: string;
    versionNumber: number;
  });
  publish: unknown;
  release: unknown;
  routes: Array<Record<string, unknown>>;
  site: unknown;
  success: true;
  upload: {
    attempted: number;
    skipped: number;
  };
  uploadSession: (Record<string, unknown>) | null;
  url: string | null;
};

/** Input shape for `pages.published`. */
export type PagesPublishedInput = {
  console?: string;
  fields?: string;
  limit?: string;
  offset?: string;
  project?: string;
};

/** Return shape for `pages.published`. */
export type PagesPublishedReturn = {
  consoleUrl: string;
  items: Array<Record<string, unknown>>;
  pages: Array<Record<string, unknown>>;
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

/** Input shape for `pages.update`. */
export type PagesUpdateInput = {
  args: string[];
  console?: string;
  execute?: boolean;
  project?: string;
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
  args: string[];
  console?: string;
  execute?: boolean;
  project?: string;
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

/** Input shape for `permissions.allow`. */
export type PermissionsAllowInput = {
  agent?: string;
  apply?: boolean;
  capabilities?: string;
  description?: string;
  label?: string;
  profile: string;
  to?: string;
};

/** Return shape for `permissions.allow`. */
export type PermissionsAllowReturn = {
  agentCeilings: string[];
  capabilities: Array<{
    objectId: string;
    objectType: string;
    permission: string;
  }>;
  changedCount: number;
  description?: string;
  dryRun: boolean;
  label: string;
  nextCommand?: string;
  operations: Array<{
    capability?: string;
    kind: string;
    message: string;
    status: "planned" | "applied" | "unchanged";
    target?: string;
  }>;
  profile: string;
  tagSlug: string;
  targets: Array<{
    id: string;
    type: string;
  }>;
};

/** Input shape for `permissions.check`. */
export type PermissionsCheckInput = {
  localOperator?: boolean;
  objectId?: string;
  objectType?: string;
  permission?: string;
};

/** Return shape for `permissions.check`. */
export type PermissionsCheckReturn = {
  allowed: boolean;
  decision: {
    allowed: boolean;
    contextId?: string;
    decision: "allow" | "deny" | "needs_approval" | "not_applicable";
    durationMs?: number;
    evidence?: Array<{
      kind?: string;
      message?: string;
      objectId?: string;
      objectType?: string;
      permission?: string;
      providerId?: string;
      source?: string;
    }>;
    objectId: string;
    objectType: string;
    permission: string;
    providerId: string;
    providerVersion: string;
    reasonCode: string;
    requestId?: string;
    subject?: {
      id: string;
      type: string;
    };
  };
  guidance?: {
    breakGlass: string;
    canonicalCapability: string;
    inspectCommands: string[];
    nextSteps: string[];
    preferredPath: {
      kind: string;
      message: string;
      suggestedTags: Array<{
        capabilities: string[];
        description?: string;
        label: string;
        slug: string;
      }>;
    };
    rawCapabilityFallback: string;
    requestShape: {
      profileOrTag: string;
      reason: string;
      scope: string;
      subject?: string;
      ttl: string;
    };
    scope: string;
  };
};

/** Input shape for `permissions.materialize`. */
export type PermissionsMaterializeInput = {
  subjectId?: string;
  subjectType?: string;
};

/** Return shape for `permissions.materialize`. */
export type PermissionsMaterializeReturn = {
  capabilities: Array<{
    objectId: string;
    objectType: string;
    permission: string;
    source?: string;
  }>;
  guidance: {
    breakGlass: string;
    recurringAccess: string;
  };
  subject: {
    id: string;
    type: string;
  };
};

/** Input shape for `permissions.resolve`. */
export type PermissionsResolveInput = {
  apply?: boolean;
  capabilities?: string;
  denialId: string;
  profile?: string;
};

/** Return shape for `permissions.resolve`. */
export type PermissionsResolveReturn = {
  agentCeilings: string[];
  capabilities: Array<{
    objectId: string;
    objectType: string;
    permission: string;
  }>;
  changedCount: number;
  denial: {
    agentId: string | null;
    contextId: string | null;
    id: number;
    missingCapability: string;
    sessionName: string | null;
    subject: string;
  };
  description?: string;
  dryRun: boolean;
  guidance?: {
    breakGlass: string;
    canonicalCapability: string;
    inspectCommands: string[];
    nextSteps: string[];
    preferredPath: {
      kind: string;
      message: string;
      suggestedTags: Array<{
        capabilities: string[];
        description?: string;
        label: string;
        slug: string;
      }>;
    };
    rawCapabilityFallback: string;
    requestShape: {
      profileOrTag: string;
      reason: string;
      scope: string;
      subject?: string;
      ttl: string;
    };
    scope: string;
  };
  label: string;
  nextCommand?: string;
  operations: Array<{
    capability?: string;
    kind: string;
    message: string;
    status: "planned" | "applied" | "unchanged";
    target?: string;
  }>;
  profile: string;
  tagSlug: string;
  targets: Array<{
    id: string;
    type: string;
  }>;
};

/** Input shape for `permissions.status`. */
export type PermissionsStatusInput = Record<string, never>;

/** Return shape for `permissions.status`. */
export type PermissionsStatusReturn = {
  authorizationProviders: Array<{
    id: string;
    required: boolean;
    version: string;
  }>;
  capabilityMaterializers: Array<{
    id: string;
    required: boolean;
    version: string;
  }>;
  guidance: {
    breakGlass: string;
    inspect: string[];
    recurringAccess: string;
  };
  mutationCommands: {
    enabled: boolean;
    message: string;
  };
  status: "provider-runtime";
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  fields?: string;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  executionMode: "durable" | "legacy";
  idempotencyKey?: string;
  nextAttemptAt?: number;
  publishPending?: boolean;
  publishedNow?: boolean;
  queued: boolean;
  reaction: {
    emoji: string;
    messageId: string;
  };
  requestId?: string;
  status: "queued" | "accepted";
  target: {
    accountId: string;
    channel: string;
    chatId: string;
  };
  topic: string;
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
  configuredRoute: ({
    accountId: string;
    agent: string;
    channel?: string;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    id: number;
    pattern: string;
    policy?: string;
    priority: number;
    session?: string;
  }) | null;
  instance: string;
  liveEffect: ({
    canonicalPattern: string | null;
    reason: string;
    status: "verified" | "different_winner" | "matched" | "unresolved" | "skipped_broad_pattern";
    targetKind: "group" | "phone" | "lid" | "thread" | "literal" | "glob";
    verified: boolean;
    winningAgent: string | null;
    winningPattern: string | null;
  }) | null;
  origin: {
    daemonObserved: false;
    freshness: "persisted-at-read-time";
    kind: "config_simulation";
    limitation: string;
    source: "router-config-db";
  };
  pattern: string | null;
  resolution: ({
    canonicalPattern: string | null;
    matchedBy: ("exact" | "equivalent") | null;
    targetKind: "group" | "phone" | "lid" | "thread" | "literal" | "glob";
  }) | null;
  target: {
    cliBundlePath: string | null;
    cliExecPath: string | null;
    daemon: {
      cwd: string | null;
      execPath: string | null;
      matchesCli: boolean | null;
      online: boolean;
    };
    dbPath: string;
    instance: ({
      affectsLiveMain: boolean;
      channel: string | null;
      enabled: boolean;
      exists: boolean;
      instanceId: string | null;
      name: string;
    }) | null;
  };
};

/** Input shape for `routes.list`. */
export type RoutesListInput = {
  fields?: string;
  limit?: string;
  name?: string;
  offset?: string;
  tag?: string;
};

/** Return shape for `routes.list`. */
export type RoutesListReturn = {
  filter: {
    tagSlug: string | null;
  };
  instance: string | null;
  items: Array<{
    accountId?: string;
    agent?: string;
    channel?: string;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    id?: number;
    pattern?: string;
    policy?: string;
    priority?: number;
    session?: string;
    tags?: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  }>;
  pagination: {
    hasMore?: boolean;
    limit: number;
    nextCommand?: string | null;
    nextOffset?: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  routes: Array<{
    accountId?: string;
    agent?: string;
    channel?: string;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    id?: number;
    pattern?: string;
    policy?: string;
    priority?: number;
    session?: string;
    tags?: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  }>;
  total: number;
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
  route: {
    accountId: string;
    agent: string;
    channel?: string;
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    id: number;
    pattern: string;
    policy?: string;
    priority: number;
    session?: string;
    tags: Array<{
      assetId: string;
      assetType: "agent" | "automation" | "app" | "session" | "task" | "project" | "profile" | "contact" | "chat" | "route" | "instance" | "artifact" | "insight" | "workflow_spec" | "workflow_run" | "workflow_node" | "cron_job" | "trigger" | "hook" | "task_automation" | "observer_rule" | "observer_binding" | "observer_profile" | "command" | "skill" | "skill_gate_rule" | "context" | "call_profile" | "call_request" | "call_voice_agent" | "call_tool" | "outbound_queue" | "outbound_entry" | "spec" | "devin_session";
      createdAt: number;
      createdBy?: string;
      id: string;
      metadata?: Record<string, unknown>;
      source: string;
      tagId: string;
      tagSlug: string;
      updatedAt: number;
      updatedBy?: string;
    }>;
  };
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
  fields?: string;
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
  fields?: string;
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

/** Input shape for `runtime.presets.create`. */
export type RuntimePresetsCreateInput = {
  description?: string;
  disabled?: boolean;
  id: string;
  model?: string;
  provider?: string;
};

/** Return shape for `runtime.presets.create`. */
export type RuntimePresetsCreateReturn = {
  action: "create" | "set-model" | "enable" | "disable" | "delete";
  changed: boolean;
  dryRun: boolean;
  preset: {
    createdAt: number;
    description: string | null;
    enabled: boolean;
    id: string;
    model: string;
    provider: string;
    updatedAt: number;
    version: number;
  };
};

/** Input shape for `runtime.presets.delete`. */
export type RuntimePresetsDeleteInput = {
  dryRun?: boolean;
  id: string;
};

/** Return shape for `runtime.presets.delete`. */
export type RuntimePresetsDeleteReturn = {
  action: "create" | "set-model" | "enable" | "disable" | "delete";
  changed: boolean;
  dryRun: boolean;
  preset: {
    createdAt: number;
    description: string | null;
    enabled: boolean;
    id: string;
    model: string;
    provider: string;
    updatedAt: number;
    version: number;
  };
};

/** Input shape for `runtime.presets.disable`. */
export type RuntimePresetsDisableInput = {
  dryRun?: boolean;
  id: string;
};

/** Return shape for `runtime.presets.disable`. */
export type RuntimePresetsDisableReturn = {
  action: "create" | "set-model" | "enable" | "disable" | "delete";
  changed: boolean;
  dryRun: boolean;
  preset: {
    createdAt: number;
    description: string | null;
    enabled: boolean;
    id: string;
    model: string;
    provider: string;
    updatedAt: number;
    version: number;
  };
};

/** Input shape for `runtime.presets.enable`. */
export type RuntimePresetsEnableInput = {
  dryRun?: boolean;
  id: string;
};

/** Return shape for `runtime.presets.enable`. */
export type RuntimePresetsEnableReturn = {
  action: "create" | "set-model" | "enable" | "disable" | "delete";
  changed: boolean;
  dryRun: boolean;
  preset: {
    createdAt: number;
    description: string | null;
    enabled: boolean;
    id: string;
    model: string;
    provider: string;
    updatedAt: number;
    version: number;
  };
};

/** Input shape for `runtime.presets.impact`. */
export type RuntimePresetsImpactInput = {
  id: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `runtime.presets.impact`. */
export type RuntimePresetsImpactReturn = {
  agents: Array<{
    agentId: string;
    effectiveModel: string;
    modelSource: "agent_preset";
    name: string | null;
    provider: string;
    shadowingSessions: number;
  }>;
  correctionCommand: string | null;
  enabled: boolean;
  limit: number;
  model: string;
  offset: number;
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  presetId: string;
  provider: string;
  referenced: boolean;
  referencingAgentsTotal: number;
  shadowingSessionsTotal: number;
  version: number;
};

/** Input shape for `runtime.presets.list`. */
export type RuntimePresetsListInput = {
  disabled?: boolean;
  enabled?: boolean;
  fields?: string;
  limit?: string;
  offset?: string;
  provider?: string;
};

/** Return shape for `runtime.presets.list`. */
export type RuntimePresetsListReturn = {
  pagination: {
    hasMore: boolean;
    limit: number;
    nextCommand: string | null;
    nextOffset: number | null;
    offset: number;
    returned: number;
    total: number;
  };
  presets: Array<{
    createdAt: number;
    description: string | null;
    enabled: boolean;
    id: string;
    model: string;
    provider: string;
    updatedAt: number;
    version: number;
  }>;
  total: number;
};

/** Input shape for `runtime.presets.set`. */
export type RuntimePresetsSetInput = {
  dryRun?: boolean;
  field: string;
  id: string;
  value: string;
};

/** Return shape for `runtime.presets.set`. */
export type RuntimePresetsSetReturn = {
  action: "create" | "set-model" | "enable" | "disable" | "delete";
  changed: boolean;
  dryRun: boolean;
  preset: {
    createdAt: number;
    description: string | null;
    enabled: boolean;
    id: string;
    model: string;
    provider: string;
    updatedAt: number;
    version: number;
  };
};

/** Input shape for `runtime.presets.show`. */
export type RuntimePresetsShowInput = {
  id: string;
};

/** Return shape for `runtime.presets.show`. */
export type RuntimePresetsShowReturn = {
  preset: {
    createdAt: number;
    description: string | null;
    enabled: boolean;
    id: string;
    model: string;
    provider: string;
    updatedAt: number;
    version: number;
  };
  referencingAgentsTotal: number;
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
  fields?: string;
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

/** Input shape for `sessions.close-thread`. */
export type SessionsCloseThreadInput = {
  return?: string;
  session?: string;
};

/** Return shape for `sessions.close-thread`. */
export type SessionsCloseThreadReturn = {
  actionId: "thread.close";
  changed: boolean;
  childSession: {
    sessionKey: string;
    sessionName: string | null;
  };
  closeSequence: number;
  closed: true;
  parentReturn: {
    delivered: boolean;
    pending: boolean;
    requested: boolean;
  };
  parentSession: {
    sessionKey: string;
    sessionName: string;
  };
  requestId: string;
  slack: {
    channelId: string;
    threadTs: string | null;
  };
  status: "closed";
};

/** Input shape for `sessions.create-thread`. */
export type SessionsCreateThreadInput = {
  message: string;
  model?: string;
  session?: string;
};

/** Return shape for `sessions.create-thread`. */
export type SessionsCreateThreadReturn = {
  actionId: "thread.create";
  child: {
    modelOverride: string | null;
    status: "pending_root_delivery";
  };
  executionMode: "durable";
  idempotencyKey: string;
  initiatorSession: {
    sessionKey: string;
    sessionName: string | null;
  };
  nextAttemptAt?: number;
  parentSession: {
    sessionKey: string;
    sessionName: string | null;
  };
  publishPending: boolean;
  publishedNow: boolean;
  queued: true;
  requestId: string;
  slack: {
    accountId: string;
    canonicalChatId: string;
    channelId: string;
    instanceId: string;
  };
  status: "queued";
};

/** Input shape for `sessions.delete`. */
export type SessionsDeleteInput = {
  execute?: boolean;
  nameOrKey: string;
};

/** Return shape for `sessions.delete`. */
export type SessionsDeleteReturn = Record<string, unknown>;

/** Input shape for `sessions.delete-message`. */
export type SessionsDeleteMessageInput = {
  execute?: boolean;
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
  execute?: boolean;
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

/** Input shape for `sessions.followups.update`. */
export type SessionsFollowupsUpdateInput = {
  barrier?: string;
  description?: string;
  id: string;
  message?: string;
  name?: string;
  recalculateNext?: boolean;
  step?: string[];
};

/** Return shape for `sessions.followups.update`. */
export type SessionsFollowupsUpdateReturn = {
  followup: {
    createdAt: number;
    deliveryBarrier: "immediate_interrupt" | "after_tool" | "after_response" | "after_task";
    description?: string;
    enabled: boolean;
    id: string;
    lastError?: string;
    lastRunAt?: number;
    lastRunAtIso: string | null;
    lastStatus?: "ok" | "skipped" | "failed";
    messageTemplate: string;
    metadata?: Record<string, unknown>;
    name: string;
    nextRunAt?: number;
    nextRunAtIso: string | null;
    ownerId: string;
    ownerType: string;
    schedule: {
      at?: number;
      cron?: string;
      every?: number;
      steps?: Array<{
        afterMs: number;
        label?: string;
        messageTemplate: string;
      }>;
      timezone?: string;
      type: "every" | "at" | "cron";
    };
    scheduleDescription: string;
    steps?: Array<{
      afterMs: number;
      label?: string;
      messageTemplate: string;
    }>;
    targetRef: string;
    targetType: "session" | "chat" | "reading_list";
    updatedAt: number;
  };
};

/** Input shape for `sessions.goal`. */
export type SessionsGoalInput = {
  action: string;
  budget?: string;
  nameOrKey: string;
  objective?: string;
  project?: string;
  reason?: string;
  seconds?: string;
  task?: string;
  tokens?: string;
};

/** Return shape for `sessions.goal`. */
export type SessionsGoalReturn = {
  action: string;
  changed: boolean;
  goal: ({
    blockedReason: string | null;
    createdAt: number;
    goalId: string;
    objective: string;
    projectId: string | null;
    sessionKey: string;
    status: "active" | "paused" | "budget_limited" | "blocked" | "complete";
    taskId: string | null;
    timeUsedSeconds: number;
    tokenBudget: number | null;
    tokensUsed: number;
    updatedAt: number;
  }) | null;
  session: {
    agentId: string;
    label: string;
    sessionKey: string;
  };
};

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
  fields?: string;
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
export type SessionsReadReturn = ({
  count?: number;
  messages: Array<({
    role: "user" | "assistant";
    text: string;
    time: string;
    [k: string]: unknown;
  }) | ({
    content: string;
    createdAt: number;
    id: string;
    role: string;
    source: string;
    [k: string]: unknown;
  })>;
  session: {
    agentId: string;
    label: string;
    name?: string;
    sessionKey: string;
    [k: string]: unknown;
  };
  totalMessages?: number;
  transcript: {
    available: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}) | ({
  error?: string;
  messageId?: string;
  meta?: unknown;
  ok: boolean;
  [k: string]: unknown;
});

/** Input shape for `sessions.rename`. */
export type SessionsRenameInput = {
  nameOrKey: string;
  newName: string;
};

/** Return shape for `sessions.rename`. */
export type SessionsRenameReturn = Record<string, unknown>;

/** Input shape for `sessions.reset`. */
export type SessionsResetInput = {
  execute?: boolean;
  nameOrKey: string;
};

/** Return shape for `sessions.reset`. */
export type SessionsResetReturn = Record<string, unknown>;

/** Input shape for `sessions.runtime.follow-up`. */
export type SessionsRuntimeFollowUpInput = {
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
export type SessionsSendReturn = {
  action: "send";
  createdSession: boolean;
  delivery: Record<string, unknown>;
  mode: "fire-and-forget" | "wait";
  promptLength: number;
  published: boolean;
  response?: {
    length: number;
    text: string;
  };
  session: {
    agentId: string;
    label: string;
    name?: string;
    sessionKey: string;
    [k: string]: unknown;
  };
  thread: (Record<string, unknown>) | null;
  [k: string]: unknown;
};

/** Input shape for `sessions.set-display`. */
export type SessionsSetDisplayInput = {
  displayName: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-display`. */
export type SessionsSetDisplayReturn = Record<string, unknown>;

/** Input shape for `sessions.set-effort`. */
export type SessionsSetEffortInput = {
  level: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-effort`. */
export type SessionsSetEffortReturn = {
  action: "set-effort";
  after: ({
    agentId: string;
    effectiveModel: string;
    effectiveProvider: string;
    effortOverride?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    ephemeral: boolean;
    expiresAt: number | null;
    label: string;
    modelOverride?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: string;
    name?: string;
    runtimeOptions: {
      effort: {
        source: "session_override" | "agent_default" | "runtime_default";
        value: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
      };
      model: {
        source: string;
        value: string;
      };
      thinking: {
        source: string | null;
        value: string | null;
      };
    };
    sessionKey: string;
  }) | null;
  appliesOn: "next-turn-runtime-restart";
  before: {
    agentId: string;
    effectiveModel: string;
    effectiveProvider: string;
    effortOverride?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    ephemeral: boolean;
    expiresAt: number | null;
    label: string;
    modelOverride?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: string;
    name?: string;
    runtimeOptions: {
      effort: {
        source: "session_override" | "agent_default" | "runtime_default";
        value: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
      };
      model: {
        source: string;
        value: string;
      };
      thinking: {
        source: string | null;
        value: string | null;
      };
    };
    sessionKey: string;
  };
  changed: boolean;
  effectiveEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  effectiveEffortSource: "session_override" | "agent_default" | "runtime_default";
  effortOverride: ("none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra") | null;
  sessionKey: string;
  sessionName: string | null;
};

/** Input shape for `sessions.set-model`. */
export type SessionsSetModelInput = {
  model: string;
  nameOrKey: string;
};

/** Return shape for `sessions.set-model`. */
export type SessionsSetModelReturn = Record<string, unknown>;

/** Input shape for `sessions.set-provider`. */
export type SessionsSetProviderInput = {
  nameOrKey: string;
  provider: string;
};

/** Return shape for `sessions.set-provider`. */
export type SessionsSetProviderReturn = {
  action: "set-provider";
  after: ({
    agentId: string;
    effectiveModel: string;
    effectiveProvider: string;
    effortOverride?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    ephemeral: boolean;
    expiresAt: number | null;
    label: string;
    modelOverride?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: string;
    name?: string;
    runtimeOptions: {
      effort: {
        source: "session_override" | "agent_default" | "runtime_default";
        value: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
      };
      model: {
        source: string;
        value: string;
      };
      thinking: {
        source: string | null;
        value: string | null;
      };
    };
    sessionKey: string;
  }) | null;
  appliesOn: "next-turn-runtime-restart";
  before: {
    agentId: string;
    effectiveModel: string;
    effectiveProvider: string;
    effortOverride?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    ephemeral: boolean;
    expiresAt: number | null;
    label: string;
    modelOverride?: string;
    modelPresetId: string | null;
    modelPresetVersion: number | null;
    modelSource: string;
    name?: string;
    runtimeOptions: {
      effort: {
        source: "session_override" | "agent_default" | "runtime_default";
        value: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
      };
      model: {
        source: string;
        value: string;
      };
      thinking: {
        source: string | null;
        value: string | null;
      };
    };
    sessionKey: string;
  };
  changed: boolean;
  effectiveProvider: string;
  runtimeProviderOverride: string | null;
  sessionKey: string;
  sessionName: string | null;
};

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

/** Input shape for `sessions.visibility`. */
export type SessionsVisibilityInput = {
  nameOrKey: string;
};

/** Return shape for `sessions.visibility`. */
export type SessionsVisibilityReturn = Record<string, unknown>;

/** Input shape for `settings.delete`. */
export type SettingsDeleteInput = {
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
  id: string;
};

/** Return shape for `skill-gates.reset`. */
export type SkillGatesResetReturn = {
  deleted: boolean;
  success: true;
};

/** Input shape for `skill-gates.rm`. */
export type SkillGatesRmInput = {
  execute?: boolean;
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

/** Input shape for `skills.grant`. */
export type SkillsGrantInput = {
  agent: string;
  note?: string;
  skill: string;
};

/** Return shape for `skills.grant`. */
export type SkillsGrantReturn = {
  agentId: string;
  grant?: {
    agentId: string;
    grantedAt: number;
    note?: string;
    skillName: string;
  };
  skillName: string;
  success: boolean;
};

/** Input shape for `skills.grant-batch`. */
export type SkillsGrantBatchInput = {
  agent?: string;
  allAgents?: boolean;
  allSkills?: boolean;
  dryRun?: boolean;
  note?: string;
  skill?: string;
};

/** Return shape for `skills.grant-batch`. */
export type SkillsGrantBatchReturn = {
  agentsTargeted: number;
  dryRun: boolean;
  errors: Array<{
    agentId: string;
    error: string;
    skillName: string;
  }>;
  op: "grant" | "revoke";
  pairsAffected: number;
  pairsSkipped: number;
  sampleAgents: string[];
  sampleSkills: string[];
  skillsTargeted: number;
};

/** Input shape for `skills.inspect`. */
export type SkillsInspectInput = {
  agent: string;
};

/** Return shape for `skills.inspect`. */
export type SkillsInspectReturn = {
  agentId: string;
  allowlist: string[];
  hasConfiguration: boolean;
  provenance: {
    baseline: string[];
    fromCapabilities: string[];
    fromGrants: string[];
  };
};

/** Input shape for `skills.install`. */
export type SkillsInstallInput = {
  all?: boolean;
  execute?: boolean;
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
  fields?: string;
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

/** Input shape for `skills.revoke`. */
export type SkillsRevokeInput = {
  agent: string;
  skill: string;
};

/** Return shape for `skills.revoke`. */
export type SkillsRevokeReturn = {
  agentId: string;
  grant?: {
    agentId: string;
    grantedAt: number;
    note?: string;
    skillName: string;
  };
  skillName: string;
  success: boolean;
};

/** Input shape for `skills.revoke-batch`. */
export type SkillsRevokeBatchInput = {
  agent?: string;
  allAgents?: boolean;
  allSkills?: boolean;
  dryRun?: boolean;
  skill?: string;
};

/** Return shape for `skills.revoke-batch`. */
export type SkillsRevokeBatchReturn = {
  agentsTargeted: number;
  dryRun: boolean;
  errors: Array<{
    agentId: string;
    error: string;
    skillName: string;
  }>;
  op: "grant" | "revoke";
  pairsAffected: number;
  pairsSkipped: number;
  sampleAgents: string[];
  sampleSkills: string[];
  skillsTargeted: number;
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

/** Input shape for `skills.who`. */
export type SkillsWhoInput = {
  agent?: string;
  fields?: string;
  skill?: string;
};

/** Return shape for `skills.who`. */
export type SkillsWhoReturn = {
  grants: Array<{
    agentId: string;
    grantedAt: number;
    note?: string;
    skillName: string;
  }>;
  skillName?: string;
  total: number;
};

/** Input shape for `slack.blocks-send`. */
export type SlackBlocksSendInput = {
  channel: string;
  connection?: string;
  ephemeralUser?: string;
  execute?: boolean;
  file: string;
  text?: string;
  threadTs?: string;
};

/** Return shape for `slack.blocks-send`. */
export type SlackBlocksSendReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.blocks-showcase`. */
export type SlackBlocksShowcaseInput = {
  channel: string;
  execute?: boolean;
  threadTs?: string;
};

/** Return shape for `slack.blocks-showcase`. */
export type SlackBlocksShowcaseReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.blocks-update`. */
export type SlackBlocksUpdateInput = {
  channel: string;
  execute?: boolean;
  file: string;
  text?: string;
  ts: string;
};

/** Return shape for `slack.blocks-update`. */
export type SlackBlocksUpdateReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.blocks-validate`. */
export type SlackBlocksValidateInput = {
  channel?: string;
  file: string;
  target?: string;
};

/** Return shape for `slack.blocks-validate`. */
export type SlackBlocksValidateReturn = {
  connection: string;
  item?: unknown;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-access-delete`. */
export type SlackCanvasAccessDeleteInput = {
  canvas: string;
  channel?: string;
  channels?: string;
  execute?: boolean;
  users?: string;
};

/** Return shape for `slack.canvas-access-delete`. */
export type SlackCanvasAccessDeleteReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-access-set`. */
export type SlackCanvasAccessSetInput = {
  access: string;
  canvas: string;
  channel?: string;
  channels?: string;
  execute?: boolean;
  users?: string;
};

/** Return shape for `slack.canvas-access-set`. */
export type SlackCanvasAccessSetReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-artifact-publish`. */
export type SlackCanvasArtifactPublishInput = {
  artifactOrFile: string;
  canvas?: string;
  channel?: string;
  execute?: boolean;
  skipRefresh?: boolean;
  slackChannel?: string;
  title?: string;
};

/** Return shape for `slack.canvas-artifact-publish`. */
export type SlackCanvasArtifactPublishReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-artifact-status`. */
export type SlackCanvasArtifactStatusInput = {
  artifact: string;
};

/** Return shape for `slack.canvas-artifact-status`. */
export type SlackCanvasArtifactStatusReturn = {
  item: Record<string, unknown>;
  ok: true;
  provider: "slack";
};

/** Input shape for `slack.canvas-channel-create`. */
export type SlackCanvasChannelCreateInput = {
  artifact?: string;
  channel: string;
  ensure?: boolean;
  execute?: boolean;
  markdown?: string;
  markdownFile?: string;
  skipRefresh?: boolean;
  title?: string;
};

/** Return shape for `slack.canvas-channel-create`. */
export type SlackCanvasChannelCreateReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-channel-showcase`. */
export type SlackCanvasChannelShowcaseInput = {
  channel: string;
  execute?: boolean;
  title?: string;
};

/** Return shape for `slack.canvas-channel-showcase`. */
export type SlackCanvasChannelShowcaseReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-create`. */
export type SlackCanvasCreateInput = {
  artifact?: string;
  channel?: string;
  execute?: boolean;
  markdown?: string;
  markdownFile?: string;
  skipRefresh?: boolean;
  slackChannel?: string;
  title?: string;
};

/** Return shape for `slack.canvas-create`. */
export type SlackCanvasCreateReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-delete`. */
export type SlackCanvasDeleteInput = {
  canvas: string;
  channel?: string;
  execute?: boolean;
};

/** Return shape for `slack.canvas-delete`. */
export type SlackCanvasDeleteReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-edit`. */
export type SlackCanvasEditInput = {
  artifact?: string;
  canvas: string;
  channel?: string;
  execute?: boolean;
  markdown?: string;
  markdownFile?: string;
  operation: string;
  sectionId?: string;
  skipRefresh?: boolean;
  title?: string;
};

/** Return shape for `slack.canvas-edit`. */
export type SlackCanvasEditReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-sections-lookup`. */
export type SlackCanvasSectionsLookupInput = {
  canvas: string;
  channel?: string;
  containsText?: string;
  fields?: string;
  sectionTypes?: string;
};

/** Return shape for `slack.canvas-sections-lookup`. */
export type SlackCanvasSectionsLookupReturn = {
  connection: string;
  items: unknown[];
  ok: boolean;
  pagination: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.canvas-showcase`. */
export type SlackCanvasShowcaseInput = {
  canvas: string;
  channel?: string;
  execute?: boolean;
  slackChannel?: string;
  title?: string;
};

/** Return shape for `slack.canvas-showcase`. */
export type SlackCanvasShowcaseReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.channels-create`. */
export type SlackChannelsCreateInput = {
  channel?: string;
  execute?: boolean;
  name: string;
  private?: boolean;
};

/** Return shape for `slack.channels-create`. */
export type SlackChannelsCreateReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.channels-history`. */
export type SlackChannelsHistoryInput = {
  channel: string;
  cursor?: string;
  fields?: string;
  inclusive?: boolean;
  latest?: string;
  limit?: string;
  oldest?: string;
};

/** Return shape for `slack.channels-history`. */
export type SlackChannelsHistoryReturn = {
  connection: string;
  items: unknown[];
  ok: boolean;
  pagination: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.channels-info`. */
export type SlackChannelsInfoInput = {
  channel: string;
};

/** Return shape for `slack.channels-info`. */
export type SlackChannelsInfoReturn = {
  connection: string;
  item?: unknown;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.channels-invite`. */
export type SlackChannelsInviteInput = {
  channel: string;
  connection?: string;
  execute?: boolean;
  users: string;
};

/** Return shape for `slack.channels-invite`. */
export type SlackChannelsInviteReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.channels-list`. */
export type SlackChannelsListInput = {
  channel?: string;
  cursor?: string;
  fields?: string;
  includeArchived?: boolean;
  limit?: string;
  types?: string;
};

/** Return shape for `slack.channels-list`. */
export type SlackChannelsListReturn = {
  connection: string;
  items: unknown[];
  ok: boolean;
  pagination: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.channels-rename`. */
export type SlackChannelsRenameInput = {
  channel: string;
  execute?: boolean;
  name: string;
};

/** Return shape for `slack.channels-rename`. */
export type SlackChannelsRenameReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.files-list`. */
export type SlackFilesListInput = {
  channel?: string;
  cursor?: string;
  fields?: string;
  limit?: string;
  slackChannel?: string;
  user?: string;
};

/** Return shape for `slack.files-list`. */
export type SlackFilesListReturn = {
  connection: string;
  items: unknown[];
  ok: boolean;
  pagination: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.interactions-respond`. */
export type SlackInteractionsRespondInput = {
  channel?: string;
  execute?: boolean;
  file: string;
  responseUrlId: string;
};

/** Return shape for `slack.interactions-respond`. */
export type SlackInteractionsRespondReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.members-list`. */
export type SlackMembersListInput = {
  channel: string;
  cursor?: string;
  limit?: string;
};

/** Return shape for `slack.members-list`. */
export type SlackMembersListReturn = {
  connection: string;
  items: unknown[];
  ok: boolean;
  pagination: {
    cursor: string | null;
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
  };
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.messages-inspect`. */
export type SlackMessagesInspectInput = {
  channel: string;
  ts: string;
};

/** Return shape for `slack.messages-inspect`. */
export type SlackMessagesInspectReturn = {
  connection: string;
  item?: unknown;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.messages-replay`. */
export type SlackMessagesReplayInput = {
  channel: string;
  execute?: boolean;
  force?: boolean;
  ts: string;
};

/** Return shape for `slack.messages-replay`. */
export type SlackMessagesReplayReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.messages-send`. */
export type SlackMessagesSendInput = {
  channel: string;
  ephemeralUser?: string;
  execute?: boolean;
  text: string;
  threadTs?: string;
};

/** Return shape for `slack.messages-send`. */
export type SlackMessagesSendReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.modals-open`. */
export type SlackModalsOpenInput = {
  channel?: string;
  execute?: boolean;
  file: string;
  triggerId: string;
};

/** Return shape for `slack.modals-open`. */
export type SlackModalsOpenReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.modals-push`. */
export type SlackModalsPushInput = {
  channel?: string;
  execute?: boolean;
  file: string;
  triggerId: string;
};

/** Return shape for `slack.modals-push`. */
export type SlackModalsPushReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.modals-update`. */
export type SlackModalsUpdateInput = {
  channel?: string;
  execute?: boolean;
  externalId?: boolean;
  file: string;
  hash?: string;
  view: string;
};

/** Return shape for `slack.modals-update`. */
export type SlackModalsUpdateReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.permissions-list`. */
export type SlackPermissionsListInput = {
  channel?: string;
};

/** Return shape for `slack.permissions-list`. */
export type SlackPermissionsListReturn = {
  connection: string;
  item?: unknown;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.topology`. */
export type SlackTopologyInput = {
  channel?: string;
  cursor?: string;
  includeArchived?: boolean;
  limit?: string;
  types?: string;
};

/** Return shape for `slack.topology`. */
export type SlackTopologyReturn = {
  accountId: string;
  capabilities: Record<string, unknown>;
  channels: unknown[];
  connection: string;
  ok: true;
  provider: "slack";
  source: string;
  ungroupedChannelIds: string[];
};

/** Input shape for `slack.work-objects-present-details`. */
export type SlackWorkObjectsPresentDetailsInput = {
  channel?: string;
  connection?: string;
  execute?: boolean;
  file: string;
  triggerId: string;
};

/** Return shape for `slack.work-objects-present-details`. */
export type SlackWorkObjectsPresentDetailsReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.work-objects-send`. */
export type SlackWorkObjectsSendInput = {
  channel: string;
  connection?: string;
  execute?: boolean;
  file: string;
  text?: string;
  threadTs?: string;
};

/** Return shape for `slack.work-objects-send`. */
export type SlackWorkObjectsSendReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.work-objects-unfurl`. */
export type SlackWorkObjectsUnfurlInput = {
  channel: string;
  connection?: string;
  execute?: boolean;
  file: string;
  ts: string;
  url: string;
};

/** Return shape for `slack.work-objects-unfurl`. */
export type SlackWorkObjectsUnfurlReturn = {
  connection: string;
  dryRun: boolean;
  item?: unknown;
  method: string;
  ok: boolean;
  provider: "slack";
  raw?: Record<string, unknown>;
  request: Record<string, unknown>;
  source: string;
};

/** Input shape for `slack.work-objects-validate`. */
export type SlackWorkObjectsValidateInput = {
  file: string;
  target?: string;
};

/** Return shape for `slack.work-objects-validate`. */
export type SlackWorkObjectsValidateReturn = {
  dryRun?: boolean;
  item?: unknown;
  ok: true;
  outputFile?: string;
  provider: "slack";
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  fields?: string;
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
  fields?: string;
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

/** Input shape for `tools.invoke`. */
export type ToolsInvokeInput = {
  args?: string;
  name: string;
};

/** Return shape for `tools.invoke`. */
export type ToolsInvokeReturn = {
  args: Record<string, unknown>;
  executed: true;
  mode: "executed";
  result: {
    content: Array<{
      text: string;
      type: "text";
    }>;
    isError: boolean;
  };
  tool: {
    description: string;
    metadata: {
      access?: {
        action: string;
        kind: string;
        resource: string;
        risk: string;
      };
      args: Array<Record<string, unknown>>;
      command: string;
      group: string;
      method: string;
      options: Array<Record<string, unknown>>;
      scope?: string;
      skillGate?: {
        skill: string;
        source: string;
      };
    };
    name: string;
  };
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

/** Input shape for `tools.search`. */
export type ToolsSearchInput = {
  limit?: string;
  query: string;
};

/** Return shape for `tools.search`. */
export type ToolsSearchReturn = {
  items: Array<{
    command: string;
    description: string;
    group: string;
    matchedFields: string[];
    name: string;
    rank: number;
    score: number;
  }>;
  limit: number;
  query: string;
  returned: number;
  total: number;
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
  access: ({
    action: string;
    kind: string;
    resource: string;
    risk: string;
  }) | null;
  args: Record<string, unknown>;
  executed: false;
  invokeCommand: string;
  mode: "dry_run";
  schema: (Record<string, unknown>) | null;
  tool: {
    description: string;
    metadata: {
      access?: {
        action: string;
        kind: string;
        resource: string;
        risk: string;
      };
      args: Array<Record<string, unknown>>;
      command: string;
      group: string;
      method: string;
      options: Array<Record<string, unknown>>;
      scope?: string;
      skillGate?: {
        skill: string;
        source: string;
      };
    };
    name: string;
  };
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
    model?: string;
    provider?: string;
    segments?: Array<Record<string, unknown>>;
    text: string;
    [k: string]: unknown;
  };
};

/** Input shape for `triggers.add`. */
export type TriggersAddInput = {
  account?: string;
  agent?: string;
  cooldown?: string;
  envFile?: string;
  exec?: string;
  filter?: string;
  message?: string;
  name: string;
  onError?: string;
  replySession?: string;
  session?: string;
  shell?: string;
  timeout?: string;
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
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  fields?: string;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
  messageId: string;
};

/** Return shape for `whatsapp.dm.ack`. */
export type WhatsappDmAckReturn = Record<string, unknown>;

/** Input shape for `whatsapp.dm.read`. */
export type WhatsappDmReadInput = {
  account?: string;
  contact: string;
  fields?: string;
  last?: string;
  noAck?: boolean;
};

/** Return shape for `whatsapp.dm.read`. */
export type WhatsappDmReadReturn = Record<string, unknown>;

/** Input shape for `whatsapp.dm.send`. */
export type WhatsappDmSendInput = {
  account?: string;
  contact: string;
  execute?: boolean;
  message: string;
};

/** Return shape for `whatsapp.dm.send`. */
export type WhatsappDmSendReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.add`. */
export type WhatsappGroupAddInput = {
  account?: string;
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
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
  execute?: boolean;
};

/** Return shape for `whatsapp.group.join`. */
export type WhatsappGroupJoinReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.leave`. */
export type WhatsappGroupLeaveInput = {
  account?: string;
  execute?: boolean;
  groupId: string;
};

/** Return shape for `whatsapp.group.leave`. */
export type WhatsappGroupLeaveReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.list`. */
export type WhatsappGroupListInput = {
  account?: string;
  fields?: string;
  limit?: string;
  offset?: string;
};

/** Return shape for `whatsapp.group.list`. */
export type WhatsappGroupListReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.promote`. */
export type WhatsappGroupPromoteInput = {
  account?: string;
  execute?: boolean;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.promote`. */
export type WhatsappGroupPromoteReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.remove`. */
export type WhatsappGroupRemoveInput = {
  account?: string;
  execute?: boolean;
  groupId: string;
  participants: string;
};

/** Return shape for `whatsapp.group.remove`. */
export type WhatsappGroupRemoveReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.rename`. */
export type WhatsappGroupRenameInput = {
  account?: string;
  execute?: boolean;
  groupId: string;
  name: string;
};

/** Return shape for `whatsapp.group.rename`. */
export type WhatsappGroupRenameReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.revoke-invite`. */
export type WhatsappGroupRevokeInviteInput = {
  account?: string;
  execute?: boolean;
  groupId: string;
};

/** Return shape for `whatsapp.group.revoke-invite`. */
export type WhatsappGroupRevokeInviteReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.send`. */
export type WhatsappGroupSendInput = {
  account?: string;
  execute?: boolean;
  groupId: string;
  mention?: string[];
  message: string;
};

/** Return shape for `whatsapp.group.send`. */
export type WhatsappGroupSendReturn = Record<string, unknown>;

/** Input shape for `whatsapp.group.settings`. */
export type WhatsappGroupSettingsInput = {
  account?: string;
  execute?: boolean;
  groupId: string;
  setting: string;
};

/** Return shape for `whatsapp.group.settings`. */
export type WhatsappGroupSettingsReturn = Record<string, unknown>;

/** Input shape for `work-objects.action`. */
export type WorkObjectsActionInput = {
  actionId: string;
  execute?: boolean;
  id: string;
  type: string;
  value?: string;
};

/** Return shape for `work-objects.action`. */
export type WorkObjectsActionReturn = {
  providerId: string;
  result: {
    error?: string;
    message?: string;
    object?: {
      actions?: {
        overflowActions?: Array<{
          accessibilityLabel?: string;
          actionId?: string;
          processingState?: {
            enabled: boolean;
            interstitialText?: string;
          };
          style?: "primary" | "danger";
          text: string;
          url?: string;
          value?: string;
        }>;
        primaryActions?: Array<{
          accessibilityLabel?: string;
          actionId?: string;
          processingState?: {
            enabled: boolean;
            interstitialText?: string;
          };
          style?: "primary" | "danger";
          text: string;
          url?: string;
          value?: string;
        }>;
      };
      attributes?: Record<string, unknown>;
      customFields?: Array<{
        edit?: Record<string, unknown>;
        key: string;
        label: string;
        long?: boolean;
        type?: string;
        value: string | number | boolean;
      }>;
      description?: string;
      displayId?: string;
      displayOrder?: string[];
      displayType?: string;
      entityType?: string;
      externalRef: {
        id: string;
        type?: string;
      };
      fields?: Record<string, {
        edit?: Record<string, unknown>;
        label?: string;
        long?: boolean;
        type?: string;
        value?: unknown;
      }>;
      kind?: string;
      metadataLastModified?: number;
      productIconUrl?: string;
      productName?: string;
      revision?: string;
      status?: string;
      title: string;
      url: string;
    };
  };
};

/** Input shape for `work-objects.resolve`. */
export type WorkObjectsResolveInput = {
  id?: string;
  target?: string;
  type?: string;
  url?: string;
};

/** Return shape for `work-objects.resolve`. */
export type WorkObjectsResolveReturn = {
  providerId: string;
  result: {
    actions?: {
      overflowActions?: Array<{
        accessibilityLabel?: string;
        actionId?: string;
        processingState?: {
          enabled: boolean;
          interstitialText?: string;
        };
        style?: "primary" | "danger";
        text: string;
        url?: string;
        value?: string;
      }>;
      primaryActions?: Array<{
        accessibilityLabel?: string;
        actionId?: string;
        processingState?: {
          enabled: boolean;
          interstitialText?: string;
        };
        style?: "primary" | "danger";
        text: string;
        url?: string;
        value?: string;
      }>;
    };
    attributes?: Record<string, unknown>;
    customFields?: Array<{
      edit?: Record<string, unknown>;
      key: string;
      label: string;
      long?: boolean;
      type?: string;
      value: string | number | boolean;
    }>;
    description?: string;
    displayId?: string;
    displayOrder?: string[];
    displayType?: string;
    entityType?: string;
    externalRef: {
      id: string;
      type?: string;
    };
    fields?: Record<string, {
      edit?: Record<string, unknown>;
      label?: string;
      long?: boolean;
      type?: string;
      value?: unknown;
    }>;
    kind?: string;
    metadataLastModified?: number;
    productIconUrl?: string;
    productName?: string;
    revision?: string;
    status?: string;
    title: string;
    url: string;
  };
};

/** Input shape for `work-objects.suggest`. */
export type WorkObjectsSuggestInput = {
  fieldId: string;
  id: string;
  query?: string;
  type: string;
};

/** Return shape for `work-objects.suggest`. */
export type WorkObjectsSuggestReturn = {
  providerId: string;
  result: Array<{
    text: string;
    value: string;
  }>;
};

/** Input shape for `work-objects.update`. */
export type WorkObjectsUpdateInput = {
  id: string;
  revision?: string;
  type: string;
  values?: string;
};

/** Return shape for `work-objects.update`. */
export type WorkObjectsUpdateReturn = {
  providerId: string;
  result: {
    fieldErrors?: Record<string, string>;
    formError?: string;
    object?: {
      actions?: {
        overflowActions?: Array<{
          accessibilityLabel?: string;
          actionId?: string;
          processingState?: {
            enabled: boolean;
            interstitialText?: string;
          };
          style?: "primary" | "danger";
          text: string;
          url?: string;
          value?: string;
        }>;
        primaryActions?: Array<{
          accessibilityLabel?: string;
          actionId?: string;
          processingState?: {
            enabled: boolean;
            interstitialText?: string;
          };
          style?: "primary" | "danger";
          text: string;
          url?: string;
          value?: string;
        }>;
      };
      attributes?: Record<string, unknown>;
      customFields?: Array<{
        edit?: Record<string, unknown>;
        key: string;
        label: string;
        long?: boolean;
        type?: string;
        value: string | number | boolean;
      }>;
      description?: string;
      displayId?: string;
      displayOrder?: string[];
      displayType?: string;
      entityType?: string;
      externalRef: {
        id: string;
        type?: string;
      };
      fields?: Record<string, {
        edit?: Record<string, unknown>;
        label?: string;
        long?: boolean;
        type?: string;
        value?: unknown;
      }>;
      kind?: string;
      metadataLastModified?: number;
      productIconUrl?: string;
      productName?: string;
      revision?: string;
      status?: string;
      title: string;
      url: string;
    };
    revision?: string;
  };
};

/** Input shape for `workflows.runs.archive-node`. */
export type WorkflowsRunsArchiveNodeInput = {
  execute?: boolean;
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
  fields?: string;
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
  execute?: boolean;
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
  fields?: string;
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

/** Input shape for `yt.analytics-countries`. */
export type YtAnalyticsCountriesInput = {
  connection?: string;
  days?: string;
  limit?: string;
};

/** Return shape for `yt.analytics-countries`. */
export type YtAnalyticsCountriesReturn = {
  countries: Array<{
    country: string;
    subscribersGained: number;
    views: number;
    watchTimeMinutes: number;
  }>;
  period: string;
  success: true;
};

/** Input shape for `yt.analytics-demographics`. */
export type YtAnalyticsDemographicsInput = {
  connection?: string;
  days?: string;
};

/** Return shape for `yt.analytics-demographics`. */
export type YtAnalyticsDemographicsReturn = {
  demographics: Array<{
    ageGroup: string;
    gender: string;
    viewerPercentage: number;
  }>;
  period: string;
  success: true;
};

/** Input shape for `yt.analytics-devices`. */
export type YtAnalyticsDevicesInput = {
  connection?: string;
  days?: string;
};

/** Return shape for `yt.analytics-devices`. */
export type YtAnalyticsDevicesReturn = {
  devices: Array<{
    device: string;
    views: number;
    watchTimeMinutes: number;
  }>;
  period: string;
  success: true;
};

/** Input shape for `yt.analytics-overview`. */
export type YtAnalyticsOverviewInput = {
  connection?: string;
  days?: string;
};

/** Return shape for `yt.analytics-overview`. */
export type YtAnalyticsOverviewReturn = {
  overview: {
    avgViewDurationSec: number;
    comments: number;
    dislikes: number;
    likes: number;
    netSubscribers: number;
    shares: number;
    subscribersGained: number;
    subscribersLost: number;
    views: number;
    watchTimeMinutes: number;
  };
  period: string;
  success: true;
};

/** Input shape for `yt.analytics-series`. */
export type YtAnalyticsSeriesInput = {
  connection?: string;
  days?: string;
  metric?: "views" | "estimatedMinutesWatched" | "averageViewDuration" | "subscribersGained" | "likes" | "comments" | "shares";
};

/** Return shape for `yt.analytics-series`. */
export type YtAnalyticsSeriesReturn = {
  data: Array<Record<string, string | number | boolean | null>>;
  metric: string;
  period: string;
  success: true;
};

/** Input shape for `yt.analytics-top`. */
export type YtAnalyticsTopInput = {
  connection?: string;
  days?: string;
  limit?: string;
};

/** Return shape for `yt.analytics-top`. */
export type YtAnalyticsTopReturn = {
  period: string;
  success: true;
  videos: Array<{
    avgViewDurationSec: number;
    comments: number;
    likes: number;
    title: string;
    videoId: string;
    views: number;
    watchTimeMinutes: number;
  }>;
};

/** Input shape for `yt.analytics-traffic`. */
export type YtAnalyticsTrafficInput = {
  connection?: string;
  days?: string;
};

/** Return shape for `yt.analytics-traffic`. */
export type YtAnalyticsTrafficReturn = {
  period: string;
  sources: Array<{
    source: string;
    views: number;
    watchTimeMinutes: number;
  }>;
  success: true;
};

/** Input shape for `yt.caption-download`. */
export type YtCaptionDownloadInput = {
  captionId: string;
  connection?: string;
  format?: "srt" | "vtt" | "ttml";
  language?: string;
};

/** Return shape for `yt.caption-download`. */
export type YtCaptionDownloadReturn = {
  captionId: string;
  content: string;
  format: string;
  success: true;
};

/** Input shape for `yt.captions`. */
export type YtCaptionsInput = {
  connection?: string;
  videoId: string;
};

/** Return shape for `yt.captions`. */
export type YtCaptionsReturn = {
  captions: Array<{
    captionId: string;
    isAutoSynced: boolean;
    isDraft: boolean;
    language: string;
    lastUpdated: string;
    name: string;
    status: string;
    trackKind: string;
  }>;
  success: true;
  totalResults: number;
  videoId: string;
};

/** Input shape for `yt.comments`. */
export type YtCommentsInput = {
  connection?: string;
  fields?: string;
  limit?: string;
  page?: string;
  videoId: string;
};

/** Return shape for `yt.comments`. */
export type YtCommentsReturn = {
  comments: Array<{
    author: string;
    authorChannelUrl: string;
    commentId: string;
    likeCount: number;
    publishedAt: string;
    replyCount: number;
    text: string;
    threadId: string;
  }>;
  nextPageToken?: string;
  success: true;
  totalResults: number;
  videoId: string;
};

/** Input shape for `yt.health`. */
export type YtHealthInput = {
  connection?: string;
};

/** Return shape for `yt.health`. */
export type YtHealthReturn = {
  app: "youtube";
  authenticated: false;
  connection: string;
  credentialConfigured: boolean;
  credentialStatus: string;
  externalCheckPerformed: false;
  message: string;
  ready: boolean;
  success: true;
};

/** Input shape for `yt.info`. */
export type YtInfoInput = {
  connection?: string;
};

/** Return shape for `yt.info`. */
export type YtInfoReturn = {
  channel: {
    channelId: string;
    description: string;
    subscriberCount: number;
    thumbnail: string;
    title: string;
    uploadsPlaylistId: string;
    url: string;
    videoCount: number;
    viewCount: number;
  };
  success: true;
};

/** Input shape for `yt.playlist`. */
export type YtPlaylistInput = {
  connection?: string;
  fields?: string;
  limit?: string;
  page?: string;
  playlistId: string;
};

/** Return shape for `yt.playlist`. */
export type YtPlaylistReturn = {
  nextPageToken?: string;
  playlistId: string;
  success: true;
  totalResults: number;
  videos: Array<{
    commentCount: number;
    description: string;
    duration: string;
    likeCount: number;
    playlistItemId?: string;
    privacyStatus: string;
    publishedAt: string;
    thumbnail: string;
    title: string;
    url: string;
    videoId: string;
    viewCount: number;
  }>;
};

/** Input shape for `yt.playlist-add`. */
export type YtPlaylistAddInput = {
  connection?: string;
  execute?: boolean;
  playlistId: string;
  videoId: string;
};

/** Return shape for `yt.playlist-add`. */
export type YtPlaylistAddReturn = {
  item: {
    playlistId: string;
    playlistItemId: string;
    title: string;
    videoId: string;
  };
  success: true;
};

/** Input shape for `yt.playlist-create`. */
export type YtPlaylistCreateInput = {
  connection?: string;
  description?: string;
  execute?: boolean;
  privacy?: "public" | "private" | "unlisted";
  title: string;
};

/** Return shape for `yt.playlist-create`. */
export type YtPlaylistCreateReturn = {
  playlist: {
    description: string;
    itemCount: number;
    playlistId: string;
    privacyStatus: string;
    publishedAt: string;
    thumbnail: string;
    title: string;
    url: string;
  };
  success: true;
};

/** Input shape for `yt.playlist-delete`. */
export type YtPlaylistDeleteInput = {
  connection?: string;
  execute?: boolean;
  playlistId: string;
};

/** Return shape for `yt.playlist-delete`. */
export type YtPlaylistDeleteReturn = {
  deleted: string;
  success: true;
};

/** Input shape for `yt.playlist-remove`. */
export type YtPlaylistRemoveInput = {
  connection?: string;
  execute?: boolean;
  playlistItemId: string;
};

/** Return shape for `yt.playlist-remove`. */
export type YtPlaylistRemoveReturn = {
  removed: string;
  success: true;
};

/** Input shape for `yt.playlists`. */
export type YtPlaylistsInput = {
  connection?: string;
  fields?: string;
  limit?: string;
  page?: string;
};

/** Return shape for `yt.playlists`. */
export type YtPlaylistsReturn = {
  nextPageToken?: string;
  playlists: Array<{
    description: string;
    itemCount: number;
    playlistId: string;
    privacyStatus: string;
    publishedAt: string;
    thumbnail: string;
    title: string;
    url: string;
  }>;
  success: true;
  totalResults: number;
};

/** Input shape for `yt.reply`. */
export type YtReplyInput = {
  commentId: string;
  connection?: string;
  execute?: boolean;
  text: string;
};

/** Return shape for `yt.reply`. */
export type YtReplyReturn = {
  replyId: string;
  success: true;
};

/** Input shape for `yt.search`. */
export type YtSearchInput = {
  connection?: string;
  fields?: string;
  limit?: string;
  page?: string;
  query: string;
};

/** Return shape for `yt.search`. */
export type YtSearchReturn = {
  nextPageToken?: string;
  query: string;
  success: true;
  totalResults: number;
  videos: Array<{
    commentCount: number;
    description: string;
    duration: string;
    likeCount: number;
    playlistItemId?: string;
    privacyStatus: string;
    publishedAt: string;
    thumbnail: string;
    title: string;
    url: string;
    videoId: string;
    viewCount: number;
  }>;
};

/** Input shape for `yt.stats`. */
export type YtStatsInput = {
  connection?: string;
  id: string;
};

/** Return shape for `yt.stats`. */
export type YtStatsReturn = {
  stats: {
    commentCount: number;
    daysSincePublish: number;
    likeCount: number;
    publishedAt: string;
    title: string;
    videoId: string;
    viewCount: number;
    viewsPerDay: number;
  };
  success: true;
};

/** Input shape for `yt.subscriptions`. */
export type YtSubscriptionsInput = {
  connection?: string;
  fields?: string;
  limit?: string;
  page?: string;
};

/** Return shape for `yt.subscriptions`. */
export type YtSubscriptionsReturn = {
  nextPageToken?: string;
  subscriptions: Array<{
    channelId: string;
    description: string;
    publishedAt: string;
    subscriptionId: string;
    thumbnail: string;
    title: string;
    totalItemCount: number;
    url: string;
  }>;
  success: true;
  totalResults: number;
};

/** Input shape for `yt.unanswered`. */
export type YtUnansweredInput = {
  connection?: string;
  fields?: string;
  limit?: string;
  page?: string;
  videoId: string;
};

/** Return shape for `yt.unanswered`. */
export type YtUnansweredReturn = {
  comments: Array<{
    author: string;
    authorChannelUrl: string;
    commentId: string;
    likeCount: number;
    publishedAt: string;
    replyCount: number;
    text: string;
    threadId: string;
  }>;
  nextPageToken?: string;
  success: true;
  totalUnanswered: number;
  videoId: string;
};

/** Input shape for `yt.video`. */
export type YtVideoInput = {
  connection?: string;
  id: string;
};

/** Return shape for `yt.video`. */
export type YtVideoReturn = {
  success: true;
  video: {
    commentCount: number;
    description: string;
    duration: string;
    likeCount: number;
    playlistItemId?: string;
    privacyStatus: string;
    publishedAt: string;
    thumbnail: string;
    title: string;
    url: string;
    videoId: string;
    viewCount: number;
  };
};

/** Input shape for `yt.video-categories`. */
export type YtVideoCategoriesInput = {
  connection?: string;
  region?: string;
};

/** Return shape for `yt.video-categories`. */
export type YtVideoCategoriesReturn = {
  categories: Array<{
    assignable: boolean;
    categoryId: string;
    title: string;
  }>;
  region: string;
  success: true;
  totalResults: number;
};

/** Input shape for `yt.video-delete`. */
export type YtVideoDeleteInput = {
  connection?: string;
  execute?: boolean;
  id: string;
};

/** Return shape for `yt.video-delete`. */
export type YtVideoDeleteReturn = {
  deleted: string;
  success: true;
};

/** Input shape for `yt.video-update`. */
export type YtVideoUpdateInput = {
  category?: string;
  connection?: string;
  description?: string;
  execute?: boolean;
  id: string;
  privacy?: "public" | "private" | "unlisted";
  tags?: string;
  title?: string;
};

/** Return shape for `yt.video-update`. */
export type YtVideoUpdateReturn = {
  success: true;
  video: {
    commentCount: number;
    description: string;
    duration: string;
    likeCount: number;
    playlistItemId?: string;
    privacyStatus: string;
    publishedAt: string;
    thumbnail: string;
    title: string;
    url: string;
    videoId: string;
    viewCount: number;
  };
};

/** Input shape for `yt.videos`. */
export type YtVideosInput = {
  connection?: string;
  fields?: string;
  limit?: string;
  page?: string;
};

/** Return shape for `yt.videos`. */
export type YtVideosReturn = {
  nextPageToken?: string;
  success: true;
  totalResults: number;
  videos: Array<{
    commentCount: number;
    description: string;
    duration: string;
    likeCount: number;
    playlistItemId?: string;
    privacyStatus: string;
    publishedAt: string;
    thumbnail: string;
    title: string;
    url: string;
    videoId: string;
    viewCount: number;
  }>;
};
