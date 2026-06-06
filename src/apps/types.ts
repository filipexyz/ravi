export type RaviAppManifestSource = "repo" | "plugin" | "state";

export interface RaviAppPermissions {
  required: string[];
  optional: string[];
  mutating: string[];
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
  health?: unknown;
  versioning?: unknown;
  [key: string]: unknown;
}

export type RaviAppOperationInterface = "builtin" | "cli" | "sdk" | "tool" | "stream";

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
  staticRootCommands?: Set<string>;
}

export interface RaviAppRunResult {
  ok: boolean;
  appId: string | null;
  operation: string | null;
  operationId: string | null;
  interface: RaviAppOperationInterface | null;
  mutating: boolean;
  status: "completed" | "failed";
  durationMs: number;
  result?: unknown;
  error?: string;
  command?: string;
  handler?: string;
  channel?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface RaviAppAliasInvocation {
  appId: string;
  operation?: string;
  args: string[];
  json: boolean;
}
