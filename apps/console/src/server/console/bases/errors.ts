// ConsoleApiError helpers for Bases. Bodies follow `BaseApiErrorBody`.

import type { z } from "zod";

import { ConsoleApiError, type ConsoleApiErrorPayload } from "@/server/console/api-error";
import type { BaseApiErrorBody } from "@/shared/bases/types";

export function basesError(status: number, body: BaseApiErrorBody): ConsoleApiError {
  return new ConsoleApiError(status, body as ConsoleApiErrorPayload);
}

export function notFound(): never {
  throw basesError(404, { error: "not_found" });
}

export function forbidden(reason?: string): never {
  throw basesError(403, reason ? { error: "base_forbidden", reason } : { error: "base_forbidden" });
}

export function validationFailed(fieldErrors: Record<string, string>, reason?: string): never {
  throw basesError(400, { error: "validation_failed", fieldErrors, ...(reason ? { reason } : {}) });
}

export function payloadInvalid(reason: string, fieldErrors?: Record<string, string>): never {
  throw basesError(400, { error: "payload_invalid", reason, ...(fieldErrors ? { fieldErrors } : {}) });
}

export function conflict(error: string, extra: Omit<BaseApiErrorBody, "error"> = {}): never {
  throw basesError(409, { error, ...extra });
}

export function baseArchived(): never {
  throw basesError(409, { error: "base_archived", reason: "This base is read-only." });
}

export function limitExceeded(reason: string): never {
  throw basesError(409, { error: "limit_exceeded", reason });
}

/** Parses a body with a zod schema; structural failures are `400 payload_invalid` with dotted-path `fieldErrors`. */
export function parseBasesBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join(".") || "_";
    if (!fieldErrors[path]) fieldErrors[path] = issue.message;
  }
  const first = result.error.issues[0];
  const reason = first ? `${first.path.map(String).join(".") || "body"}: ${first.message}` : "Invalid request body.";
  return payloadInvalid(reason, fieldErrors);
}

export function isConsoleApiError(error: unknown, code?: string): error is ConsoleApiError {
  return error instanceof ConsoleApiError && (code === undefined || error.payload.error === code);
}

/** SQLSTATE of a Postgres error, also when wrapped (drizzle rethrows driver errors as `cause`). */
export function postgresErrorCode(error: unknown): string | null {
  for (let current = error, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Input Postgres cannot store (U+0000, invalid encodings): `400 payload_invalid` instead of a server error. */
export function mapBasesInputError(error: unknown): unknown {
  const code = postgresErrorCode(error);
  if (code === "22P05" || code === "22021") {
    return basesError(400, { error: "payload_invalid", reason: "The request contains characters that cannot be stored (such as U+0000)." });
  }
  return error;
}
