export type SpecKind = "domain" | "capability" | "feature";

export type SpecStatus = "draft" | "active" | "deprecated" | "archived";

export type SpecContextMode = "rules" | "full" | "checks" | "why" | "runbook";

export interface SpecRecord {
  id: string;
  title: string;
  kind: SpecKind;
  domain: string;
  capability?: string;
  feature?: string;
  capabilities: string[];
  tags: string[];
  appliesTo: string[];
  owners: string[];
  status: SpecStatus;
  normative: boolean;
  rootPath: string;
  path: string;
  relativePath: string;
  mtime: number;
  updatedAt: number;
}

export interface SpecChainEntry {
  id: string;
  kind: SpecKind;
  path: string;
  relativePath: string;
  exists: boolean;
  spec?: SpecRecord;
}

export interface SpecContextFile {
  specId: string;
  kind: SpecKind;
  fileName: "SPEC.md" | "WHY.md" | "RUNBOOK.md" | "CHECKS.md";
  path: string;
  relativePath: string;
  exists: boolean;
  content?: string;
}

export interface SpecRequirement {
  level: "MUST" | "MUST NOT" | "SHOULD" | "SHOULD NOT" | "MAY";
  text: string;
  source: string;
  fileName: string;
}

export interface SpecContext {
  id: string;
  mode: SpecContextMode;
  rootPath: string;
  chain: SpecChainEntry[];
  files: SpecContextFile[];
  requirements: SpecRequirement[];
  content: string;
}

export interface ListSpecsOptions {
  cwd?: string;
  domain?: string;
  kind?: SpecKind;
}

export interface GetSpecOptions {
  cwd?: string;
}

export interface GetSpecContextOptions {
  cwd?: string;
  mode?: SpecContextMode;
}

export interface NewSpecInput {
  cwd?: string;
  id: string;
  title: string;
  kind: SpecKind;
  full?: boolean;
}

export interface NewSpecResult {
  spec: SpecRecord;
  createdFiles: string[];
  missingAncestors: SpecChainEntry[];
}

export type SpecVerifyIssueCode =
  | "missing-checks-file"
  | "normative-without-invariants"
  | "invariant-without-ac"
  | "ac-orphan-row"
  | "ac-missing-method"
  | "dangling-check-ref"
  | "adaptation-unresolved";

export interface SpecVerifyIssue {
  code: SpecVerifyIssueCode;
  severity: "error" | "warning";
  invariant?: string;
  message: string;
}

export interface SpecVerifyResult {
  id: string;
  normative: boolean;
  ok: boolean;
  issues: SpecVerifyIssue[];
  summary: {
    invariants: number;
    acRows: number;
    checks: number;
    adaptationItems: number;
  };
}

export interface VerifySpecOptions {
  cwd?: string;
}

export interface SyncSpecsOptions {
  cwd?: string;
}

export interface SyncSpecsResult {
  rootPath: string;
  total: number;
  specs: SpecRecord[];
}
