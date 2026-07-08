/**
 * Deterministic memory curation types (spec memory/curation/deterministic-loop).
 *
 * Runtime guard around whatever an LLM curator proposes to persist: hard cap
 * (R3), injection scan with keep-visible policy (R9), secret scan with
 * redact-at-source (R9b), atomic writes with drift detection (R10).
 */

export type InjectionCategory = "prompt-override" | "exfil" | "tool-hijack";

export interface InjectionMatch {
  category: InjectionCategory;
  pattern: string;
  startIndex: number;
  endIndex: number;
  excerpt: string;
}

export interface InjectionScanResult {
  matches: readonly InjectionMatch[];
  hasInjection: boolean;
  wrapped: string;
}

export type SecretKind =
  | "github-token"
  | "openai-key"
  | "slack-token"
  | "aws-access-key"
  | "bearer-token"
  | "private-key"
  | "oauth-token"
  | "cpf"
  | "cnpj";

export interface SecretMatch {
  kind: SecretKind;
  startIndex: number;
  endIndex: number;
  excerpt: string;
}

export interface SecretScanResult {
  matches: readonly SecretMatch[];
  hasSecret: boolean;
  isCredentialOnly: boolean;
  redacted: string;
}

export interface CapCheckResult {
  ok: boolean;
  currentChars: number;
  proposedChars: number;
  cap: number;
  overflowChars: number;
  reason?: string;
}

export interface AtomicWriteInput {
  targetPath: string;
  newContent: string;
  expectedPriorContent?: string;
}

export interface AtomicWriteResult {
  written: boolean;
  driftDetected: boolean;
  backupPath?: string;
  finalChars: number;
  reason?: string;
}

export const DEFAULT_MEMORY_CAP_CHARS = 8192;
export const DEFAULT_USER_CAP_CHARS = 4096;
export const DEFAULT_CONSOLIDATION_MAX_ATTEMPTS = 3;
