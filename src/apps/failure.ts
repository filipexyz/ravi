import type { RaviAppFailure, RaviAppFailureCategory, RaviAppFailureDetails } from "./types.js";

export const RAVI_APP_FAILURE_VERSION = "ravi.app.failure/v1" as const;

const FAILURE_CATEGORIES = new Set<RaviAppFailureCategory>([
  "validation",
  "authentication",
  "authorization",
  "rate_limit",
  "upstream",
  "protocol",
  "timeout",
  "execution",
  "not_found",
]);
const FAILURE_SOURCES = new Set<RaviAppFailureDetails["source"]>(["router", "app", "tiny"]);

const CATEGORY_EXIT_CODES: Record<RaviAppFailureCategory, number> = {
  execution: 1,
  validation: 2,
  not_found: 2,
  authentication: 3,
  authorization: 4,
  rate_limit: 5,
  upstream: 6,
  protocol: 7,
  timeout: 8,
};

export class RaviAppFailureError extends Error {
  readonly code: string;
  readonly category: RaviAppFailureCategory;
  readonly retryable: boolean;
  readonly exitCode: number;
  readonly details?: RaviAppFailureDetails;

  constructor(options: {
    code: string;
    category: RaviAppFailureCategory;
    message: string;
    retryable: boolean;
    exitCode?: number;
    details?: RaviAppFailureDetails;
  }) {
    super(options.message);
    this.name = "RaviAppFailureError";
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable;
    this.exitCode = options.exitCode ?? CATEGORY_EXIT_CODES[options.category];
    this.details = options.details;
  }
}

export function toRaviAppFailure(
  error: unknown,
  fallback: { code: string; message: string; source: RaviAppFailureDetails["source"] },
): RaviAppFailure {
  if (error instanceof RaviAppFailureError) {
    return {
      version: RAVI_APP_FAILURE_VERSION,
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      exitCode: error.exitCode,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    version: RAVI_APP_FAILURE_VERSION,
    code: fallback.code,
    category: "execution",
    message: fallback.message,
    retryable: false,
    exitCode: CATEGORY_EXIT_CODES.execution,
    details: { source: fallback.source },
  };
}

export function parseRaviAppFailure(value: unknown): RaviAppFailure | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== RAVI_APP_FAILURE_VERSION ||
    typeof value.code !== "string" ||
    !FAILURE_CATEGORIES.has(value.category as RaviAppFailureCategory) ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean" ||
    typeof value.exitCode !== "number" ||
    !Number.isInteger(value.exitCode) ||
    value.exitCode < 1
  ) {
    return null;
  }
  const details = sanitizeDetails(value.details);
  return {
    version: RAVI_APP_FAILURE_VERSION,
    code: value.code,
    category: value.category as RaviAppFailureCategory,
    message: value.message,
    retryable: value.retryable,
    exitCode: value.exitCode,
    ...(details ? { details } : {}),
  };
}

function sanitizeDetails(value: unknown): RaviAppFailureDetails | null {
  if (!isRecord(value) || !FAILURE_SOURCES.has(value.source as RaviAppFailureDetails["source"])) return null;
  return {
    source: value.source as RaviAppFailureDetails["source"],
    ...(typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus)
      ? { httpStatus: value.httpStatus }
      : {}),
    ...(typeof value.retryAfterSeconds === "number" && Number.isFinite(value.retryAfterSeconds)
      ? { retryAfterSeconds: value.retryAfterSeconds }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
