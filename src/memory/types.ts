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
  | "cnpj"
  | "hardcoded-secret";

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

/**
 * READ cap — the prompt-injection budget. The MEMORY.md head injected into the
 * system prompt is truncated-with-marker at this size, bounding the per-turn
 * token cost. This is the constraint that actually matters (prompt cost).
 */
export const DEFAULT_MEMORY_CAP_CHARS = 8192;
/**
 * WRITE cap — the MEMORY.md FILE size (learning-loop/memory-lifecycle L1). The
 * file may grow well past the read budget so the index never BLOCKS a write just
 * because it's "full"; disk is cheap. The fill-triggered lifecycle (graduate /
 * keep / evict) keeps the file HEALTHY, and the read cap keeps the injection
 * bounded — the two are decoupled. Read cap ≤ write cap always holds, so the
 * read side can never bypass the write side.
 */
export const DEFAULT_MEMORY_FILE_CAP_CHARS = 65536;
export const DEFAULT_USER_CAP_CHARS = 4096;
export const DEFAULT_CONSOLIDATION_MAX_ATTEMPTS = 3;

export type MemoryStoreKind = "memory" | "user";
