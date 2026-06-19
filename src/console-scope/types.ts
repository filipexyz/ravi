export const CONSOLE_SCOPE_KINDS = ["session", "agent", "workspace", "global"] as const;

export type ConsoleScopeKind = (typeof CONSOLE_SCOPE_KINDS)[number];

export type ConsoleScopeSource =
  | "explicit"
  | "runtime_context"
  | "local_project_mapping"
  | "session_default"
  | "agent_default"
  | "workspace_default"
  | "global_default"
  | "cloud_credentials"
  | "env_compat"
  | "single_remote_project";

export interface ConsoleScopeOrganization {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
}

export interface ConsoleScopeProject {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  ref: string;
}

export interface ConsoleScopeDefault {
  scopeKind: ConsoleScopeKind;
  scopeKey: string;
  consoleUrl: string;
  organization?: ConsoleScopeOrganization | null;
  project?: ConsoleScopeProject | null;
  sourceNote?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedConsoleScope {
  consoleUrl: string;
  organization?: ConsoleScopeOrganization | null;
  project?: ConsoleScopeProject | null;
  source: ConsoleScopeSource;
}

export interface ConsoleScopeCandidate {
  source: ConsoleScopeSource;
  label: string;
  scopeKind?: ConsoleScopeKind;
  scopeKey?: string;
  consoleUrl?: string;
  organization?: ConsoleScopeOrganization | null;
  project?: ConsoleScopeProject | null;
  selected: boolean;
  available: boolean;
  reason?: string;
}

export interface ConsoleScopeExplanation {
  success: true;
  consoleUrl: string;
  organization?: ConsoleScopeOrganization | null;
  resolved: ResolvedConsoleScope | null;
  candidates: ConsoleScopeCandidate[];
  missingProjectCommand?: string | null;
}

export interface ConsoleScopeTarget {
  scopeKind: ConsoleScopeKind;
  scopeKey: string;
}
