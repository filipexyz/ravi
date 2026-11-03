// `RaviError`: every failure the runtime surfaces, from the exec endpoint or
// refused locally. `code` is the server's `error` field (or a local code such
// as `not_declared` and `network_error`); `kind` groups codes so a page built
// today keeps working when the server adds a code (pages-dados/detalhes.md,
// "De código de erro para kind").

import type { BaseRow } from "@/shared/bases/types";

export type RaviErrorKind = "session" | "denied" | "consent" | "paused" | "conflict" | "invalid" | "gone" | "busy" | "link" | "unsupported";

/**
 * Codes whose kind is not the one their HTTP status gives (or that have no
 * status). Every other code follows the status: 401 session
 * (`connector_session_required`, `connector_unauthorized`), 403 denied
 * (`connector_permission_required`, `base_forbidden`,
 * `connector_not_allowlisted`), 404 gone (`not_found`), 409 conflict
 * (`version_conflict`), 429/503/504 busy (`connector_rate_limited`,
 * `query_timeout`), anything else invalid (`payload_invalid`,
 * `validation_failed`, `unknown_property`, `invalid_filter`, `cursor_invalid`).
 */
const CODE_KINDS: Record<string, RaviErrorKind> = {
  not_declared: "denied",
  consent_required: "consent",
  data_paused: "paused",
  data_read_only: "paused",
  base_archived: "paused",
  idempotency_conflict: "invalid",
  limit_exceeded: "invalid",
  write_escapes_view: "invalid",
  view_invalid: "gone",
  connector_unavailable: "busy",
  network_error: "busy",
  app_gateway_link_required: "link",
  connector_capability_unsupported: "unsupported",
};

const STATUS_KINDS: Record<number, RaviErrorKind> = { 401: "session", 403: "denied", 404: "gone", 409: "conflict", 429: "busy", 503: "busy", 504: "busy" };

export function errorKind(code: string, status: number): RaviErrorKind {
  return CODE_KINDS[code] ?? STATUS_KINDS[status] ?? "invalid";
}

export type RaviErrorInit = {
  status?: number;
  requestId?: string | null;
  fieldErrors?: Record<string, string>;
  current?: BaseRow;
};

export class RaviError extends Error {
  readonly code: string;
  readonly kind: RaviErrorKind;
  /** True for `busy`: the runtime already retried 2, 4 and 8 s before throwing. */
  readonly retryable: boolean;
  /** HTTP status; 0 for local refusals and network failures. */
  readonly status: number;
  readonly requestId: string | null;
  /** `validation_failed`: message per column key. */
  readonly fieldErrors?: Record<string, string>;
  /** `version_conflict`: the row as it is now (only `rowId` and `version` without row reads). */
  readonly current?: BaseRow;

  constructor(code: string, init: RaviErrorInit = {}) {
    super(code);
    this.name = "RaviError";
    this.code = code;
    this.status = init.status ?? 0;
    this.kind = errorKind(code, this.status);
    this.retryable = this.kind === "busy";
    this.requestId = init.requestId ?? null;
    if (init.fieldErrors && typeof init.fieldErrors === "object") this.fieldErrors = init.fieldErrors;
    if (typeof init.current?.rowId === "string") this.current = init.current;
  }
}

/** Any thrown value as a RaviError; unexpected exceptions become the local `runtime_error` (kind `invalid`). */
export function asRaviError(error: unknown): RaviError {
  return error instanceof RaviError ? error : new RaviError("runtime_error");
}
