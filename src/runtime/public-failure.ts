const MAX_TURN_FAILURE_RESPONSE = 320;
const INTERNAL_RUNTIME_FAILURE_MESSAGE =
  "The agent could not complete this request because of an internal runtime error. Please try again.";

const INTERNAL_ERROR_PATTERNS = [
  /\b(?:ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|EMFILE|ENFILE|scandir|ERR_[A-Z0-9_]+)\b/i,
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

  if (!detail || INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(detail))) {
    return INTERNAL_RUNTIME_FAILURE_MESSAGE;
  }

  return detail.length > MAX_TURN_FAILURE_RESPONSE
    ? `${detail.slice(0, MAX_TURN_FAILURE_RESPONSE - 15)}... [truncated]`
    : detail;
}

export function formatUserFacingTurnFailure(error: unknown): string {
  return `Error: ${publicRuntimeFailureDetail(error)}`;
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
