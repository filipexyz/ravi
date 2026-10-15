// Sandbox gateway contract constants and grammar, the daemon's copy of
// Console's `src/shared/sandbox/contract.ts` (ravi-console). Pure constants
// and functions only. Normative source: Console
// `.ravi/specs/console/sandbox-gateway` (SPEC.md §Identifiers,
// grants/SPEC.md, gate/SPEC.md, listener/SPEC.md); the OSS mirror is
// `.ravi/specs/sandbox/grant-verify`. Change the spec before changing this
// file. Parity rule: constants byte-equal, functions equivalent. Every
// `shared-constants:begin` … `shared-constants:end` block below is hashed by
// `contract-parity.test.ts` against the value recorded in the spec's
// CHECKS.md; a Console change and that value move in lockstep (RUNBOOK).

// shared-constants:begin

export const SANDBOX_GRANT_ALG = "ES256";
export const SANDBOX_GRANT_TYP = "ravi-sandbox-grant+jwt";
export const SANDBOX_GRANT_KID_PREFIX = "sandbox-grant-";
export const SANDBOX_GRANT_KID_RE = /^sandbox-grant-[a-z0-9][a-z0-9-]{0,62}$/;
export const SANDBOX_GRANT_DEFAULT_ISSUER = "https://console.ravi.bot";
export const SANDBOX_GRANT_JWKS_PATH = "/api/public/sandbox/jwks";

// Gate request assertion: a separate key family that never shares keys with
// grants. Console publishes only the public half.
export const SANDBOX_GATE_ALG = "ES256";
export const SANDBOX_GATE_TYP = "ravi-gate-assertion+jwt";
export const SANDBOX_GATE_KID_PREFIX = "sandbox-gate-";
export const SANDBOX_GATE_KID_RE = /^sandbox-gate-[a-z0-9][a-z0-9-]{0,62}$/;
export const SANDBOX_GATE_JWKS_PATH = "/api/public/sandbox/gate-jwks";
export const SANDBOX_GATE_ISSUER = "https://gw.ravi.bot";
export const SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS = 60;

export const SANDBOX_GRANT_HEADER = "X-Ravi-Sandbox-Grant";
export const SANDBOX_REQUEST_ID_HEADER = "X-Ravi-Request-Id";
export const SANDBOX_GATE_MARKER_HEADER = "X-Ravi-Gate";
export const SANDBOX_GATE_ASSERTION_HEADER = "X-Ravi-Gate-Assertion";
export const SANDBOX_LISTENER_MARKER_HEADER = "X-Ravi-Listener";
export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

// Lifetimes, in seconds. Mint caps the TTL at one hour; verifiers allow a
// 65-minute lifetime so a mint at the cap survives clock skew, and tolerate
// 60 s of skew on `nbf` and `exp`.
export const SANDBOX_GRANT_MAX_TTL_SECONDS = 3600;
export const SANDBOX_GRANT_MAX_LIFETIME_SECONDS = 3900;
export const SANDBOX_GRANT_CLOCK_SKEW_SECONDS = 60;
export const SANDBOX_JWKS_CACHE_SECONDS = 300;
export const SANDBOX_JWKS_UNKNOWN_KID_REFETCH_SECONDS = 30;

// Identifiers.
export const INSTALLATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const INSTALLATION_AUDIENCE_PREFIX = "ravi-installation:";
export const SANDBOX_RUN_ID_RE = /^sbr_[a-z2-7]{26}$/;
export const SANDBOX_RUN_SUBJECT_PREFIX = "sandbox-run:";
export const SANDBOX_GRANT_JTI_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SANDBOX_TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SANDBOX_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SANDBOX_RESERVED_AGENT_IDS: readonly string[] = ["operator", "root", "system", "*"];
export const ORG_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// shared-constants:end

export function installationAudience(installationId: string) {
  return `${INSTALLATION_AUDIENCE_PREFIX}${installationId}`;
}

export function installationIdFromAudience(aud: unknown): string | null {
  if (typeof aud !== "string" || !aud.startsWith(INSTALLATION_AUDIENCE_PREFIX)) return null;
  const id = aud.slice(INSTALLATION_AUDIENCE_PREFIX.length);
  return INSTALLATION_ID_RE.test(id) ? id : null;
}

export function runSubject(runId: string) {
  return `${SANDBOX_RUN_SUBJECT_PREFIX}${runId}`;
}

export function runIdFromSubject(sub: unknown): string | null {
  if (typeof sub !== "string" || !sub.startsWith(SANDBOX_RUN_SUBJECT_PREFIX)) return null;
  const id = sub.slice(SANDBOX_RUN_SUBJECT_PREFIX.length);
  return SANDBOX_RUN_ID_RE.test(id) ? id : null;
}

export function isSandboxAgentId(value: unknown): value is string {
  return typeof value === "string" && SANDBOX_AGENT_ID_RE.test(value) && !SANDBOX_RESERVED_AGENT_IDS.includes(value);
}

// Command ids: the route `POST /api/v1/<seg1>/…/<segN>` is the command
// `<seg1>.….<segN>`. 2 to 8 segments, each `[a-z][a-z0-9-]{0,63}`; a segment
// starting with `_` (`_stream`, `_meta`), an empty segment or any uppercase
// letter is never a command id.
// shared-constants:begin
export const SANDBOX_COMMAND_SEGMENT_RE = /^[a-z][a-z0-9-]{0,63}$/;
export const SANDBOX_COMMAND_MIN_SEGMENTS = 2;
export const SANDBOX_COMMAND_MAX_SEGMENTS = 8;
export const SANDBOX_COMMAND_ID_RE = /^[a-z][a-z0-9-]{0,63}(?:\.[a-z][a-z0-9-]{0,63}){1,7}$/;
export const SANDBOX_GRANT_MAX_CMDS = 32;
// shared-constants:end

export function isSandboxCommandId(value: unknown): value is string {
  return typeof value === "string" && SANDBOX_COMMAND_ID_RE.test(value);
}

export function commandIdFromSegments(segments: readonly string[]): string | null {
  if (segments.length < SANDBOX_COMMAND_MIN_SEGMENTS || segments.length > SANDBOX_COMMAND_MAX_SEGMENTS) return null;
  if (!segments.every((segment) => SANDBOX_COMMAND_SEGMENT_RE.test(segment))) return null;
  return segments.join(".");
}

// The Gate's static allowlist (milestone 1), equal to Console's
// `SANDBOX_COMMAND_ALLOWLIST`. Canonical (sorted) order. `tasks.comment` is
// excluded until the OSS command declares its task as `resourceId`.
// shared-constants:begin
export const SANDBOX_COMMAND_ALLOWLIST = Object.freeze([
  "tasks.block",
  "tasks.done",
  "tasks.fail",
  "tasks.report",
  "tasks.show",
] as const);
// shared-constants:end

export type SandboxCommandId = (typeof SANDBOX_COMMAND_ALLOWLIST)[number];

export function isAllowlistedSandboxCommand(value: unknown): value is SandboxCommandId {
  return typeof value === "string" && (SANDBOX_COMMAND_ALLOWLIST as readonly string[]).includes(value);
}

// Capabilities (milestone 1): exactly `read:task:<taskId>` and/or
// `mutate:task:<taskId>` where `<taskId>` equals `grant.task`.
// shared-constants:begin
export const SANDBOX_CAP_KINDS = ["read", "mutate"] as const;
export type SandboxCapKind = (typeof SANDBOX_CAP_KINDS)[number];
export const SANDBOX_CAP_RE = /^(read|mutate):task:([A-Za-z0-9_-]{1,64})$/;
// shared-constants:end

export function parseSandboxCap(value: unknown): { kind: SandboxCapKind; taskId: string } | null {
  if (typeof value !== "string") return null;
  const match = SANDBOX_CAP_RE.exec(value);
  if (!match) return null;
  return { kind: match[1] as SandboxCapKind, taskId: match[2]! };
}

// Canonical form for `caps` and `cmds`: sorted by code point, deduplicated.
export function canonicalizeStringList(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

export function isCanonicalStringList(values: readonly string[]) {
  for (let index = 1; index < values.length; index += 1) {
    if (!(values[index - 1]! < values[index]!)) return false;
  }
  return true;
}

export type SandboxGrantLlmPolicy = { models: string[]; budgetUsd: number };

export function isSandboxGrantLlmPolicy(value: unknown): value is SandboxGrantLlmPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > 32) return false;
  if (!record.models.every((model) => typeof model === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(model)))
    return false;
  return typeof record.budgetUsd === "number" && Number.isFinite(record.budgetUsd) && record.budgetUsd >= 0;
}

export type SandboxGrantClaims = {
  iss: string;
  aud: string;
  sub: string;
  org: string;
  inst: string;
  agent: string;
  task?: string;
  caps: string[];
  cmds: string[];
  llm?: SandboxGrantLlmPolicy;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
};

// The full `task`/`caps`/`cmds` rule, beyond the grammar.
export type SandboxGrantPolicyRejection =
  | "cmds_empty"
  | "cmds_too_many"
  | "cmds_malformed"
  | "cmds_not_canonical"
  | "cmds_not_allowlisted"
  | "task_required"
  | "task_malformed"
  | "caps_empty"
  | "caps_malformed"
  | "caps_not_canonical"
  | "caps_task_mismatch";

export function checkSandboxGrantPolicy(input: {
  cmds: unknown;
  caps: unknown;
  task: unknown;
}): SandboxGrantPolicyRejection | null {
  const { cmds, caps, task } = input;
  if (!Array.isArray(cmds) || cmds.length === 0) return "cmds_empty";
  if (cmds.length > SANDBOX_GRANT_MAX_CMDS) return "cmds_too_many";
  if (!cmds.every(isSandboxCommandId)) return "cmds_malformed";
  if (!isCanonicalStringList(cmds)) return "cmds_not_canonical";
  if (!cmds.every(isAllowlistedSandboxCommand)) return "cmds_not_allowlisted";

  const needsTask = cmds.some((cmd) => cmd.startsWith("tasks."));
  if (task === undefined || task === null) {
    if (needsTask) return "task_required";
  } else if (typeof task !== "string" || !SANDBOX_TASK_ID_RE.test(task)) {
    return "task_malformed";
  }

  if (!Array.isArray(caps) || caps.length === 0) return "caps_empty";
  if (caps.length > SANDBOX_CAP_KINDS.length) return "caps_malformed";
  if (!isCanonicalStringList(caps)) return "caps_not_canonical";
  for (const cap of caps) {
    const parsed = parseSandboxCap(cap);
    if (!parsed) return "caps_malformed";
    if (typeof task !== "string" || parsed.taskId !== task) return "caps_task_mismatch";
  }
  return null;
}
