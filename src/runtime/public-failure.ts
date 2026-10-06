const MAX_TURN_FAILURE_RESPONSE = 320;
const INTERNAL_RUNTIME_FAILURE_MESSAGE =
  "The agent could not complete this request because of an internal runtime error. Please try again.";
const RUNTIME_CREDENTIAL_UNAVAILABLE_MESSAGE =
  "The agent could not start because no model credential is available for it. Please contact the operator.";
const PROVIDER_TEMPORARILY_UNAVAILABLE_MESSAGE = "The agent is temporarily unavailable. Please try again later.";
const PROVIDER_MODEL_UNAVAILABLE_MESSAGE =
  "The agent's model is not available for its credential or region. Please contact the operator.";

// Managed credential pool rejections (runtime-request-builder) name internal
// credential labels and policy reasons. Operators keep the full text in logs
// and traces; chat only learns that no credential was usable.
const RUNTIME_CREDENTIAL_RESOLUTION_PATTERNS = [
  /\bNo managed runtime credential could be resolved\b/i,
  /\bRejected credentials:/i,
];

// Provider account, quota and availability failures (Claude SDK error frames
// surfaced by claude-provider as `Claude provider error (<code>)`) describe the
// operator's subscription, billing or organization state, not the user's request.
const PROVIDER_ACCOUNT_FAILURE_PATTERNS = [
  /^Claude provider error \((?:rate_limit|authentication_failed|oauth_org_not_allowed|account_on_hold|billing_error|overloaded|server_error|http_(?:401|402|403|429|5\d\d))\)/i,
  /\bout of extra usage\b/i,
  /\b(?:authentication_failed|oauth_org_not_allowed|account_on_hold|billing_error)\b/i,
  /\b(?:invalid|expired|revoked)\s+(?:api[ _-]?key|oauth token|credentials?)\b/i,
];

// A 403 that names the model or region is request-scoped (credential-classifier
// `inferPermissionScope`), so credential failover will not fix it and "try again
// later" would be misleading. The operator has to change the model or credential.
const PROVIDER_REQUEST_SCOPED_DENIAL_PATTERN = /^Claude provider error \(http_403\)/i;
const PROVIDER_REQUEST_SCOPED_DENIAL_DETAIL_PATTERN = /\b(?:models?|regions?)\b/i;

const INTERNAL_ERROR_PATTERNS = [
  /\b(?:ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|EMFILE|ENFILE|scandir|ERR_[A-Z0-9_]+)\b/i,
  // Local SQLite storage failures (bun:sqlite `SQLiteError`, SQLITE_* codes,
  // "out of memory", lock/disk/corruption messages) are operator problems and
  // are never actionable in chat.
  /\bSQLiteError\b/i,
  /\bSQLITE_[A-Z][A-Z0-9_]*\b/,
  /\bout of memory\b/i,
  /\b(?:database (?:is locked|table is locked|or disk is full|disk image is malformed)|disk I\/O error|unable to open database file|no such (?:table|column)|(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY) constraint failed)\b/i,
  /\b(?:Type|Reference|Range|Syntax|Aggregate|URI|Eval|Internal|Invariant|Assertion)Error(?:\s+\[[^\]]+\])?:/i,
  /^(?:Cannot (?:read|set) properties of (?:undefined|null)|Cannot access [A-Za-z_$][\w$]* before initialization|(?:[A-Za-z_$][\w$]*|\([^)]+\)) is not (?:defined|a function)|Maximum call stack size exceeded|Cannot find (?:module|package)|Unexpected token|Invalid or unexpected token|require\(\) of ES Module|Cannot use import statement)\b/i,
  /\bfile:\/\/[^\s'"`]+/i,
  /['"`](?:~\/|[A-Za-z]:[\\/]|\\\\|\/(?!(?:docs?|v\d+|api|oauth|auth)(?:\/|$)))[^'"`\r\n]+['"`]/i,
  /\b(?:path|cwd|directory|file)\s*(?:[=:]\s*|\s+)(?:~\/|[A-Za-z]:[\\/]|\\\\|\/(?!(?:docs?|v\d+|api|oauth|auth)(?:\/|$)|\/))\S+/i,
  /(?:^|[\s"=:(])(?:~\/[^\s'"`]+|[A-Za-z]:[\\/][^\s'"`]+|\\\\[^\\\s'"`]+\\[^\s'"`]+|\/(?:Users|home|private|tmp|var|opt|etc|Applications|Volumes|workspace|root|srv|usr|mnt|data|app|code|Library|nix|run|System|builds)(?:\/[^\s'"`]*)?(?=$|[\s'"`),:;.]))/i,
  /\bInternal plugins?\b/i,
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[oprsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+\S+)/i,
  /(?:^|[\s'"?&])(?:(?:[A-Z0-9]+[_-])*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|CLIENTSECRET|ACCESSTOKEN|REFRESHTOKEN|SESSIONTOKEN|SECRETACCESSKEY)(?:[_-][A-Z0-9]+)*)\s*[=:]\s*[^\s&'"]+/i,
  /["'](?:(?:[A-Z0-9]+[_-])*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|CLIENTSECRET|ACCESSTOKEN|REFRESHTOKEN|SESSIONTOKEN|SECRETACCESSKEY)(?:[_-][A-Z0-9]+)*)["']\s*:\s*["'][^"']+["']/i,
  /\b(?:Proxy-)?Authorization\s*:\s*Basic\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/\S+/i,
];

export function publicRuntimeFailureDetail(error: unknown): string {
  const raw = runtimeFailureText(error);
  if (raw === null) {
    return INTERNAL_RUNTIME_FAILURE_MESSAGE;
  }

  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const detail = (firstLine ?? raw.trim()).replace(/^(?:Error:\s*)+/i, "").trim();

  if (RUNTIME_CREDENTIAL_RESOLUTION_PATTERNS.some((pattern) => pattern.test(detail))) {
    return RUNTIME_CREDENTIAL_UNAVAILABLE_MESSAGE;
  }

  if (!detail || INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return INTERNAL_RUNTIME_FAILURE_MESSAGE;
  }

  if (
    PROVIDER_REQUEST_SCOPED_DENIAL_PATTERN.test(detail) &&
    PROVIDER_REQUEST_SCOPED_DENIAL_DETAIL_PATTERN.test(detail)
  ) {
    return PROVIDER_MODEL_UNAVAILABLE_MESSAGE;
  }

  if (PROVIDER_ACCOUNT_FAILURE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return PROVIDER_TEMPORARILY_UNAVAILABLE_MESSAGE;
  }

  return detail.length > MAX_TURN_FAILURE_RESPONSE
    ? `${detail.slice(0, MAX_TURN_FAILURE_RESPONSE - 15)}... [truncated]`
    : detail;
}

export const PROVIDER_ENDED_AFTER_TOOLS_USER_MESSAGE =
  "The model stopped after finishing tools. Send another message to continue.";

export const PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE =
  "The model stopped while a tool was still running. The command may not have finished. Send another message to continue.";

export function formatUserFacingTurnFailure(error: unknown): string {
  return `Error: ${publicRuntimeFailureDetail(error)}`;
}

export function isOpenToolsTurnFailure(error: unknown): boolean {
  return publicRuntimeFailureDetail(error) === PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE;
}

/**
 * Recoverable open-tools / interrupt-class failures belong on the existing
 * `suppressedRecoverable` path: no chat `Error:`, stash pending inbound, and
 * restart the session. Fatal (`recoverable: false`) stays user-visible.
 */
export function isRecoverableOpenToolsOrInterruptFailure(input: {
  error: unknown;
  recoverable?: boolean;
  interrupted?: boolean;
  internalAbortReason?: string | null;
}): boolean {
  if (input.recoverable === false) {
    return false;
  }
  return isOpenToolsTurnFailure(input.error) || Boolean(input.interrupted) || Boolean(input.internalAbortReason);
}

/**
 * Classic WhatsApp/omni chat delivery policy for `turn.failed`.
 * Recoverable open-tools / interrupt-class failures must not emit a
 * user-facing `Error: …` line. The host folds those into
 * `suppressedRecoverable` so this is defense in depth at the emit site.
 */
export function shouldEmitUserFacingTurnFailure(input: {
  error: unknown;
  recoverable?: boolean;
  suppressedRecoverable?: boolean;
  interrupted?: boolean;
  internalAbortReason?: string | null;
}): boolean {
  if (input.suppressedRecoverable) {
    return false;
  }
  return !isRecoverableOpenToolsOrInterruptFailure(input);
}

function runtimeFailureText(error: unknown): string | null {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  }
  return null;
}
