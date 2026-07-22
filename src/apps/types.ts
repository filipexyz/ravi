export type RaviAppErrorCode = "already_exists" | "not_found";

export interface RaviAppErrorEvidence {
  kind: string;
  detail: string;
}

export class RaviAppError extends Error {
  readonly code: RaviAppErrorCode;
  readonly status: number;
  readonly evidence: RaviAppErrorEvidence[];

  constructor(code: RaviAppErrorCode, message: string, evidence: RaviAppErrorEvidence[] = []) {
    super(message);
    this.name = "RaviAppError";
    this.code = code;
    this.status = code === "already_exists" ? 409 : 404;
    this.evidence = evidence;
  }

  toJSON(): { code: string; message: string; status: number; evidence: RaviAppErrorEvidence[] } {
    return { code: this.code, message: this.message, status: this.status, evidence: this.evidence };
  }
}

export type RaviAppManifestSource = "repo" | "plugin" | "state";

export type RaviAppPermissionProviderInterface = "builtin" | "cli";

export interface RaviAppPermissionProviderDeclaration {
  id: string;
  version: string;
  interface: RaviAppPermissionProviderInterface;
  operation: string;
  decisionSchema: unknown;
  requestSchema: unknown;
  timeoutMs?: number;
  cacheTtlSec?: number;
  failClosed: true;
  scope?: string[];
  [key: string]: unknown;
}

export interface RaviAppPermissions {
  required: string[];
  optional: string[];
  mutating: string[];
  provider: RaviAppPermissionProviderDeclaration | null;
}

export interface RaviAppManifest {
  schema: string;
  id: string;
  name: string;
  version: string;
  description: string;
  interfaces: Record<string, unknown>;
  operations?: unknown;
  permissions?: Partial<RaviAppPermissions>;
  storage?: unknown;
  artifacts?: unknown;
  events?: unknown;
  skills?: unknown;
  health?: RaviAppHealthDeclaration;
  versioning?: unknown;
  [key: string]: unknown;
}

export interface RaviAppHealthCheckDeclaration {
  id: string;
  type: "builtin" | "cli";
  required: boolean;
  sideEffectFree: true;
  timeoutMs?: number;
  handler?: string;
  command?: string;
}

export interface RaviAppHealthDeclaration {
  checks: RaviAppHealthCheckDeclaration[];
}

export type RaviAppOperationInterface = "builtin" | "cli" | "sdk" | "tool" | "stream";

export type RaviAppOperationAuthorizationOwner = "actor" | "surface" | "executorAgent";

export type RaviAppOperationRisk = "low" | "medium" | "high" | "destructive";

export interface RaviAppOperationSafetyDeclaration {
  idempotent: boolean;
  dryRunSupported: boolean;
  confirmationRequired: boolean;
  hitlRequired?: boolean;
  liveExecution?: boolean;
  risk?: RaviAppOperationRisk;
}

export interface RaviAppOperationReliabilityDeclaration {
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface RaviAppOperationAuthorizationDeclaration {
  resource?: {
    type?: string;
    id?: string;
    idFromArg?: number;
    idFromOption?: string;
    ownerFrom?: RaviAppOperationAuthorizationOwner;
  };
  input?: {
    includeArgs?: boolean;
    includeOptions?: string[];
  };
}

export interface RaviAppOperationDeclaration {
  interface: RaviAppOperationInterface;
  handler?: string;
  command?: string;
  namespace?: string;
  method?: string;
  name?: string;
  channel?: string;
  aliases?: string[];
  mutating?: boolean;
  permission?: string;
  permissions?: string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  authorization?: RaviAppOperationAuthorizationDeclaration;
  safety?: RaviAppOperationSafetyDeclaration;
  reliability?: RaviAppOperationReliabilityDeclaration;
  help?: unknown;
  json?: boolean;
  [key: string]: unknown;
}

export interface RaviAppManifestRecord {
  id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  schema: string | null;
  source: RaviAppManifestSource;
  path: string;
  relativePath: string;
  rootPath: string;
  interfaceNames: string[];
  permissions: RaviAppPermissions;
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: RaviAppManifest | null;
}

export interface RaviAppDiscoveryRoot {
  source: RaviAppManifestSource;
  rootPath: string;
}

export interface RaviAppDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RaviAppListOptions extends RaviAppDiscoveryOptions {
  source?: RaviAppManifestSource;
}

export interface RaviAppCheckResult {
  id: string;
  path: string;
  source: RaviAppManifestSource;
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export type RaviAppScaffoldFileKind = "manifest" | "spec" | "skill";
export type RaviAppScaffoldFileAction = "planned" | "created" | "overwritten";

export interface RaviAppScaffoldOptions {
  id: string;
  name?: string;
  description?: string;
  command?: string;
  manifest?: RaviAppManifest;
  cwd?: string;
  dryRun?: boolean;
  force?: boolean;
  includeUi?: boolean;
  includeSkill?: boolean;
  includeSpec?: boolean;
}

export interface RaviAppScaffoldFileResult {
  kind: RaviAppScaffoldFileKind;
  path: string;
  action: RaviAppScaffoldFileAction;
}

export interface RaviAppScaffoldResult {
  id: string;
  name: string;
  description: string;
  command: string;
  dryRun: boolean;
  force: boolean;
  manifestPath: string;
  specPath: string | null;
  skillPath: string | null;
  skill: string | null;
  files: RaviAppScaffoldFileResult[];
  manifest: RaviAppManifest;
  nextCommands: string[];
}

export type RaviAppDeleteFileAction = "planned" | "deleted" | "not_found";

export interface RaviAppDeleteFileResult {
  kind: RaviAppScaffoldFileKind;
  path: string;
  action: RaviAppDeleteFileAction;
}

export interface RaviAppDeleteOptions {
  id: string;
  cwd?: string;
  dryRun?: boolean;
}

export interface RaviAppDeleteResult {
  id: string;
  dryRun: boolean;
  files: RaviAppDeleteFileResult[];
  removedDirs: string[];
  nextCommands: string[];
}

export type RaviAppImportCliSource = "auto" | "manifest" | "registry" | "help";
export type RaviAppImportCliResolvedSource = "manifest" | "registry" | "help";
export type RaviAppImportCliConfidence = "high" | "medium" | "low";

export interface RaviAppImportCliOptions extends Omit<RaviAppScaffoldOptions, "command" | "manifest"> {
  command: string;
  source?: RaviAppImportCliSource;
}

export interface RaviAppImportCliOperationCandidate {
  id: string;
  name: string;
  command: string;
  description: string | null;
  json: boolean;
  mutating: boolean;
  destructive: boolean;
  streaming: boolean;
  interactive: boolean;
  confidence: RaviAppImportCliConfidence;
  reviewRequired: string[];
}

export interface RaviAppImportCliResult extends RaviAppScaffoldResult {
  sourceCommand: string;
  source: RaviAppImportCliResolvedSource;
  confidence: RaviAppImportCliConfidence;
  operationCandidates: RaviAppImportCliOperationCandidate[];
  debugCandidates: RaviAppImportCliOperationCandidate[];
  warnings: string[];
  reviewRequired: string[];
}

export interface RaviAppsGuidePrompt {
  id: string;
  title: string;
  prompt: string;
  commands: string[];
}

export interface RaviAppsGuideResult {
  appId: string | null;
  app: RaviAppManifestRecord | null;
  skill: string;
  skillGate: {
    group: string;
    skill: string;
  };
  prompts: RaviAppsGuidePrompt[];
  nextCommands: string[];
}

export interface RaviAppRunOptions extends RaviAppDiscoveryOptions {
  appId: string;
  operation?: string;
  args?: string[];
  json?: boolean;
  confirmed?: boolean;
  dryRun?: boolean;
  fields?: string[];
  forceVirtualHelp?: boolean;
  staticRootCommands?: Set<string>;
}

export type RaviAppOperationErrorCode =
  | "APP_OPERATION_FAILED"
  | "APP_MANIFEST_INVALID"
  | "APP_OPERATION_NOT_FOUND"
  | "APP_MUTATION_CLASSIFICATION_REQUIRED"
  | "APP_MUTATION_SAFETY_UNDECLARED"
  | "APP_CONFIRMATION_REQUIRED"
  | "APP_DRY_RUN_UNSUPPORTED"
  | "APP_LIVE_EXECUTION_DISABLED"
  | "APP_TIMEOUT"
  | "APP_OUTPUT_TRUNCATED"
  | "APP_INVALID_JSON"
  | "APP_CHILD_EXIT"
  | "APP_FIELDS_INVALID"
  | "APP_READINESS_UNDECLARED"
  | "APP_READINESS_INVALID_RESULT"
  | "APP_PERMISSION_PROVIDER_DENIED"
  | "APP_NOT_READY";

export type RaviAppOperationErrorCategory =
  | "input"
  | "authorization"
  | "safety"
  | "timeout"
  | "dependency"
  | "adapter"
  | "readiness"
  | "internal";

export const RAVI_APP_OPERATION_RESULT_SCHEMA = "ravi.app.operation-result/v1" as const;

export type RaviAppFailureCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "upstream"
  | "protocol"
  | "timeout"
  | "execution"
  | "not_found";

export interface RaviAppFailureDetails {
  source: "router" | "app" | "tiny";
  httpStatus?: number;
  retryAfterSeconds?: number;
}

export interface RaviAppFailure {
  version: "ravi.app.failure/v1";
  code: string;
  category: RaviAppFailureCategory;
  message: string;
  retryable: boolean;
  exitCode: number;
  details?: RaviAppFailureDetails;
}

export interface RaviAppOperationErrorDetails {
  code: RaviAppOperationErrorCode | string;
  message: string;
  retryable: boolean;
  category?: RaviAppOperationErrorCategory;
  httpStatus?: number;
  vendorCode?: string;
  retryAfterMs?: number;
  requestId?: string;
  details?: unknown;
}

export class RaviAppOperationError extends Error {
  readonly details: RaviAppOperationErrorDetails;

  constructor(details: RaviAppOperationErrorDetails) {
    super(details.message);
    this.name = "RaviAppOperationError";
    this.details = details;
  }
}

export interface RaviAppRunResult {
  schema?: typeof RAVI_APP_OPERATION_RESULT_SCHEMA;
  ok: boolean;
  appId: string | null;
  operation: string | null;
  operationId: string | null;
  interface: RaviAppOperationInterface | null;
  mutating: boolean;
  mutationClass?: "read" | "write" | "unknown";
  status: "completed" | "failed";
  durationMs: number;
  attempts?: number;
  timedOut?: boolean;
  truncated?: boolean;
  selectedFields?: string[];
  result?: unknown;
  error?: string;
  failure?: RaviAppFailure;
  errorDetails?: RaviAppOperationErrorDetails;
  command?: string;
  handler?: string;
  channel?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  permissionProvider?: RaviAppPermissionProviderAudit;
}

export interface RaviAppAliasInvocation {
  appId: string;
  operation?: string;
  args: string[];
  json: boolean;
  confirmed: boolean;
  dryRun: boolean;
  fields: string[];
  virtualHelp: boolean;
}

export type RaviAppPermissionDecision = "allow" | "deny" | "needs_grant" | "not_applicable";

export interface RaviAppPermissionProviderAudit {
  providerId: string;
  providerVersion: string;
  providerOperationId: string;
  interface: RaviAppPermissionProviderInterface;
  requestId: string;
  decision: RaviAppPermissionDecision | "error" | "invalid";
  reasonCode: string | null;
  reason?: string;
  durationMs: number;
  cache: {
    hit: boolean;
    ttlSec?: number;
  };
  grantSuggestion?: unknown;
  audit?: unknown;
  error?: string;
}
