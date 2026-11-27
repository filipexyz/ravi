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

export interface RaviAppContext {
  allow: string[];
}

/**
 * A service an app offers to other apps. The manifest key is `<app-id>/<service>`; the operations are ids from the
 * same manifest's `operations`, the only ones another app may call through this service (spec apps/manifest,
 * "Composition").
 */
export interface RaviAppProvidedService {
  /** Exact `major.minor.patch`. */
  version: string;
  operations: string[];
}

export interface RaviAppManifest {
  schema: string;
  id: string;
  name: string;
  version: string;
  description: string;
  interfaces: Record<string, unknown>;
  context: RaviAppContext;
  operations?: unknown;
  /** Services this app offers to other apps, keyed `<app-id>/<service>`. */
  provides?: Record<string, RaviAppProvidedService>;
  /** Services this app needs from other apps: `<app-id>/<service>` -> semver range. */
  requires?: Record<string, string>;
  permissions: Partial<RaviAppPermissions>;
  storage?: unknown;
  artifacts?: unknown;
  events?: unknown;
  skills?: unknown;
  health?: unknown;
  versioning?: unknown;
  /** Asks that turns held below the agent may call this app (spec apps/manifest, "Restricted Turn Calls"). */
  sandbox?: RaviAppSandboxDeclaration;
  [key: string]: unknown;
}

export interface RaviAppSandboxDeclaration {
  /**
   * True asks that a restricted turn may call this app: only the `ravi apps run|show <id>` command leaves the
   * provider's sandbox, and only after the operator trusts this exact manifest (`ravi apps trust`). Grants nothing.
   */
  callableFromRestrictedTurns?: boolean;
}

export type RaviAppOperationInterface = "builtin" | "cli" | "script";

/**
 * A script operation (spec apps/router, "Script Operations"): `script` is a JavaScript file in the app package run in
 * the QuickJS sandbox. `input.dir` names the flag whose folder (inside the caller's working directory) becomes the
 * script's input files. `handoff` runs one declared command with the script's files in a fresh folder passed through
 * `handoff.outputFlag`; the script may add only `handoff.flags`, each with one value.
 */
export interface RaviAppScriptHandoffDeclaration {
  command: string;
  outputFlag: string;
  flags?: string[];
}

export interface RaviAppScriptInputDeclaration {
  dir?: string;
}

export type RaviAppOperationAuthorizationOwner = "actor" | "surface" | "executorAgent";

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

export interface RaviAppOperationHelpArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface RaviAppOperationHelpOption {
  flag: string;
  description?: string;
  value?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface RaviAppOperationHelpSection {
  title: string;
  body?: string;
  lines?: string[];
}

/**
 * Per-operation help an app may declare in its manifest. `ravi <app> help <op>`
 * prints it. When an operation declares no help, the CLI says so and, for a CLI
 * passthrough operation, points at the app command that owns the real flags —
 * it never prints empty lists as if that were the help.
 */
export interface RaviAppOperationHelp {
  usage?: string;
  routedUsage?: string;
  summary?: string;
  arguments?: RaviAppOperationHelpArgument[];
  options?: RaviAppOperationHelpOption[];
  examples?: string[];
  sections?: RaviAppOperationHelpSection[];
  backingRequest?: string;
}

export interface RaviAppOperationDeclaration {
  interface: RaviAppOperationInterface;
  handler?: string;
  command?: string;
  script?: string;
  input?: RaviAppScriptInputDeclaration;
  handoff?: RaviAppScriptHandoffDeclaration;
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
  json?: boolean;
  help?: RaviAppOperationHelp;
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

export type RaviAppScaffoldFileKind = "cli" | "manifest" | "spec" | "skill";
export type RaviAppScaffoldFileAction = "planned" | "created" | "overwritten" | "preserved";

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

export interface RaviAppBuilderGuidance {
  skill: string;
  command: string;
  spec: string;
  reviewChecklist: string[];
}

export interface RaviAppScaffoldResult {
  id: string;
  name: string;
  description: string;
  command: string;
  dryRun: boolean;
  force: boolean;
  cliPath: string | null;
  manifestPath: string;
  specPath: string | null;
  skillPath: string | null;
  skill: string | null;
  files: RaviAppScaffoldFileResult[];
  manifest: RaviAppManifest;
  builder: RaviAppBuilderGuidance;
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
  builder: RaviAppBuilderGuidance;
  prompts: RaviAppsGuidePrompt[];
  nextCommands: string[];
}

export interface RaviAppRunOptions extends RaviAppDiscoveryOptions {
  appId: string;
  operation?: string;
  args?: string[];
  json?: boolean;
  execute?: boolean;
  staticRootCommands?: Set<string>;
  runtime?: {
    execPath?: string;
    entrypoint?: string;
  };
}

export type RaviAppDependencyUnavailableReason =
  | "not_installed"
  | "invalid"
  | "not_provided"
  | "version_mismatch"
  | "insufficient_authority";

/**
 * A `requires` entry the router could not satisfy when it was about to run an app. Every field is a validated
 * identifier, version or range from the manifests, never free text from an app.
 */
export interface RaviAppUnavailableDependency {
  /** The `<app-id>/<service>` that is required. */
  requires: string;
  range: string;
  /** The app whose manifest declares the requirement; not always the one that was run (a provider may need more). */
  requiredBy: string;
  reason: RaviAppDependencyUnavailableReason;
  /** The version the provider offers, when it is installed and the range rejects it. */
  installedVersion?: string;
  /** For `insufficient_authority`: the provider's `context.allow` entries that the requiring app does not declare. */
  missing?: string[];
}

/**
 * What the router keeps of a CLI operation that exited non-zero. Every string is
 * already redacted and bounded (`src/apps/failure.ts`): this is a projection of
 * the app's output, never the output itself, so a failed result still carries no
 * `stdout`, `stderr` or `command`.
 */
export interface RaviAppCliFailure {
  /** The child's exit status; null when a signal ended it. */
  exitCode: number | null;
  /** Where the explanation came from: the app's JSON error, its stderr, or nowhere. */
  source: "json" | "stderr" | "none";
  /** The app's own error code, when its JSON error named one as an identifier. */
  code?: string;
  /** One-line, bounded: the app's message (or the first line of its stderr), reported as `appReported.message`. */
  message?: string;
  /** Multi-line, bounded: the diagnostic `cause`. It starts with "The app reported: " when it carries the app's words. */
  cause: string;
  retryable?: boolean;
  /** One-line, bounded: the app's own next step, when its JSON error offered one, reported as `appReported.suggestedAction`. */
  suggestedAction?: string;
}

export interface RaviAppRunResult {
  ok: boolean;
  appId: string | null;
  operation: string | null;
  operationId: string | null;
  interface: RaviAppOperationInterface | null;
  mutating: boolean;
  status: "completed" | "blocked" | "failed";
  durationMs: number;
  result?: unknown;
  error?: string;
  errorCode?: string;
  /** Set only when a CLI operation failed after it ran. */
  failure?: RaviAppCliFailure;
  /** Set only for `APP_DEPENDENCY_UNAVAILABLE`: what was required and could not be satisfied. No process was started. */
  unavailableDependencies?: RaviAppUnavailableDependency[];
  /** Set only when a trusted builtin refused the input itself (its own usage error), never from an app process. */
  usageError?: true;
  dryRun?: true;
  plan?: {
    appId: string;
    operationId: string;
    interface: RaviAppOperationInterface;
    mutating: true;
    argumentCount: number;
  };
  command?: string;
  handler?: string;
  channel?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  callerContextId?: string;
  childContextId?: string;
  permissionProvider?: RaviAppPermissionProviderAudit;
}

export interface RaviAppAliasInvocation {
  appId: string;
  operation?: string;
  args: string[];
  json: boolean;
  execute?: boolean;
}

export type RaviAppPermissionDecision = "allow" | "deny" | "needs_grant" | "not_applicable";

export interface RaviAppPermissionGrantPrincipal {
  type: string;
  id: string;
}

export interface RaviAppPermissionGrantSuggestion {
  subject: RaviAppPermissionGrantPrincipal;
  relation: string;
  object: RaviAppPermissionGrantPrincipal;
  ttlSec?: number;
  reasonPresent?: boolean;
}

export interface RaviAppPermissionProviderAuditSummary {
  policyVersion?: string;
  evidenceCount: number;
}

export interface RaviAppPermissionProviderAudit {
  providerId: string;
  providerVersion: string;
  providerOperationId: string;
  interface: RaviAppPermissionProviderInterface;
  requestId: string;
  decision: RaviAppPermissionDecision | "error" | "invalid";
  reasonCode: string | null;
  /** Deprecated compatibility marker. Provider-supplied reason text is never exposed. */
  reason?: string;
  reasonPresent?: boolean;
  durationMs: number;
  cache: {
    hit: boolean;
    ttlSec?: number;
  };
  grantSuggestion?: RaviAppPermissionGrantSuggestion;
  audit?: RaviAppPermissionProviderAuditSummary;
  error?: string;
}
