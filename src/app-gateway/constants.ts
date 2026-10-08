/**
 * Public constants of the Pages App Gateway wire contract.
 *
 * Source of truth: Console `.ravi/specs/console/pages/app-gateway/relay/SPEC.md`
 * (Shared Constants, Frames, Errors). The OSS installation executor keeps its
 * own copy of the public values and never imports Console code.
 */

export const APP_GATEWAY_ENABLED_ENV = "RAVI_APP_GATEWAY_ENABLED";
export const APP_GATEWAY_RELAY_SCOPE = "console.apps.relay";
export const APP_GATEWAY_RELAY_TICKET_PATH = "/api/cli/apps/relay-ticket";

/** In-process audit label only. Never an agent; `ravi agents create` refuses it. */
export const PAGES_APP_GATEWAY_AGENT_LABEL = "pages-app-gateway";
export const PAGES_APP_GATEWAY_CONTEXT_KIND = "pages-app-gateway";

export const VIEWER_ASSERTION_TYP = "JWT";
export const VIEWER_ASSERTION_KID_PREFIX = "pages-viewer-assertion-";
export const VIEWER_ASSERTION_ACTOR = "human_viewer";
export const VIEWER_ASSERTION_TTL_SECONDS = 60;

export const TARGET_GRANT_TYP = "ravi-app-target+jwt";
export const TARGET_GRANT_KID_PREFIX = "pages-app-target-";
export const TARGET_GRANT_MAX_LIFETIME_SECONDS = 21_600;
export const TARGET_GRANT_MAX_CHARS = 16_384;

export const RELAY_SUBPROTOCOL = "ravi.executor-relay.v1";
export const DEFAULT_RELAY_URL = "wss://ravi.page/_ravi/executor-relay/v1/connect";

export const CLOCK_TOLERANCE_SECONDS = 5;

export const APP_ID_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;
export const APP_ID_MAX_CHARS = 128;
export const OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const OPERATION_ID_MAX_CHARS = 96;
/** Viewer-assertion audience grammar: exact string, no spaces, no `*`. */
export const AUDIENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_GRANT_OPERATIONS = 16;
export const MAX_GRANT_ORIGINS = 8;

export const RESULT_BODY_MAX_BYTES = 1_048_576;
export const INVOKE_FRAME_MAX_BYTES = 1_179_648;
export const CONTROL_FRAME_MAX_BYTES = 4_096;

export const EXECUTOR_RUN_TIMEOUT_MS = 28_000;
export const EXECUTOR_MAX_OUTPUT_BYTES = 1_179_648;
export const EXECUTOR_MAX_CONCURRENCY = 8;
export const PARENT_CONTEXT_TTL_MS = 35_000;

export const MAX_ARGS = 64;
export const MAX_ARG_CHARS = 8_192;
export const MAX_ARGS_TOTAL_BYTES = 65_536;

export const REQUEST_ID_RETENTION_MS = 120_000;
export const REQUEST_ID_MAX_ENTRIES = 10_000;

export const PING_INTERVAL_MS = 25_000;
export const PONG_DEADLINE_MS = 10_000;
export const RELAY_READY_TIMEOUT_MS = 10_000;

export const JWKS_REFRESH_AFTER_MS = 300_000;
export const JWKS_UNKNOWN_KID_COOLDOWN_MS = 30_000;
export const JWKS_FETCH_TIMEOUT_MS = 5_000;
export const JWKS_STALE_IF_ERROR_MS = 3_600_000;
export const JWKS_MAX_BYTES = 65_536;

export const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
export const RECONNECT_BACKOFF_MAX_MS = 60_000;
export const RECONNECT_BACKOFF_RESET_AFTER_MS = 60_000;
export const RECONNECT_JITTER_RATIO = 0.2;
export const TICKET_ERROR_BACKOFF_INITIAL_MS = 5_000;
export const TICKET_ERROR_BACKOFF_MAX_MS = 300_000;
export const PARKED_RECHECK_MS = 60_000;
export const SCOPE_MISSING_PARK_MS = 300_000;
export const REPLACED_ELSEWHERE_BACKOFF_MS = 60_000;

export const RELAY_LEASE_TTL_MS = 60_000;
export const RELAY_LEASE_RENEW_MS = 20_000;

export const CLOSE_NORMAL = 1000;
export const CLOSE_REPLACED = 4000;
export const CLOSE_TICKET_EXPIRED = 4001;
export const CLOSE_NO_PING = 4002;
export const CLOSE_PROTOCOL_ERROR = 4003;

/** Codes an `apps.error` frame from the executor may carry. */
export const EXECUTOR_ERROR_CODES = [
  "payload_invalid",
  "app_gateway_assertion_invalid",
  "app_gateway_grant_invalid",
  "app_gateway_app_forbidden",
  "app_gateway_operation_forbidden",
  "app_gateway_permission_denied",
  "app_gateway_request_replayed",
  "app_gateway_payload_too_large",
  "app_gateway_rate_limited",
  "app_gateway_operation_failed",
  "app_gateway_unavailable",
] as const;

export type ExecutorErrorCode = (typeof EXECUTOR_ERROR_CODES)[number];

export function isAppId(value: unknown): value is string {
  return typeof value === "string" && value.length <= APP_ID_MAX_CHARS && APP_ID_PATTERN.test(value);
}

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= OPERATION_ID_MAX_CHARS && OPERATION_ID_PATTERN.test(value);
}

export function isAudience(value: unknown): value is string {
  return typeof value === "string" && AUDIENCE_PATTERN.test(value) && !value.includes("*");
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
