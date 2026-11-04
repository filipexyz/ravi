import {
  redactDiagnosticText,
  projectProviderDiagnosticText,
  safeDiagnosticField,
  type DiagnosticRedactionOptions,
} from "../../packages/ravi-os-sdk/src/diagnostic-redactor.js";
export { redactDiagnosticText } from "../../packages/ravi-os-sdk/src/diagnostic-redactor.js";

/** The diagnostic wire allowlist. Exception/request objects never cross it. */
export interface ErrorDiagnosticContext {
  operation?: string;
  provider?: string;
  model?: string;
  actor?: { type: string; id: string };
  file?: string;
  status?: number;
  code?: string;
  syscall?: string;
}
export type ErrorDiagnostic = {
  cause: string;
  context: ErrorDiagnosticContext;
};
type DiagnosticOptions = DiagnosticRedactionOptions;
const normalizedErrors = new WeakMap<
  Error,
  { error: unknown; context: ErrorDiagnosticContext; options: DiagnosticOptions }
>();
const CONTEXT_FIELDS = ["operation", "provider", "model", "code", "syscall"] as const;
const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.:/ -]{0,159}$/;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.includes("://")) return undefined;
  if (/\b(?:rctx_|sk-|gsk_|gh[pousr]_|github_pat_|xox[baprs]-)/i.test(value)) return undefined;
  return value;
}

export function projectDiagnosticContext(value: unknown, options: DiagnosticOptions = {}): ErrorDiagnosticContext {
  const source = record(value);
  const result: ErrorDiagnosticContext = {};
  if (!source) return result;
  for (const field of CONTEXT_FIELDS) {
    const raw = safeDiagnosticField(source, field);
    const identifier = safeIdentifier(typeof raw === "string" ? redactDiagnosticText(raw, options) : raw);
    if (identifier) result[field] = identifier;
  }
  const file = safeDiagnosticField(source, "file");
  if (typeof file === "string") {
    result.file = redactDiagnosticText(file, options).replace(/\/(Users|home)\/[^/\s]+/g, "/$1/[redacted:user]");
  }
  const status = safeDiagnosticField(source, "status");
  if (Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599) result.status = Number(status);
  const actor = record(safeDiagnosticField(source, "actor"));
  const actorType = safeDiagnosticField(actor, "type");
  const actorId = safeDiagnosticField(actor, "id");
  const type = safeIdentifier(typeof actorType === "string" ? redactDiagnosticText(actorType, options) : undefined);
  const id = safeIdentifier(typeof actorId === "string" ? redactDiagnosticText(actorId, options) : undefined);
  if (type && id && !/\s/.test(type + id)) result.actor = { type, id };
  return result;
}

export function errorDiagnostic(
  error: unknown,
  context: ErrorDiagnosticContext = {},
  options: DiagnosticOptions = {},
): ErrorDiagnostic {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const collected: ErrorDiagnosticContext = {};
  let current = error;
  while (current !== undefined && current !== null) {
    if (seen.has(current)) {
      messages.push("[circular cause]");
      break;
    }
    if (seen.size >= 16) {
      messages.push("[cause chain truncated]");
      break;
    }
    seen.add(current);
    const normalized = current instanceof Error ? normalizedErrors.get(current) : undefined;
    if (normalized) {
      Object.assign(collected, { ...normalized.context, ...collected });
      options = { secrets: [...(options.secrets ?? []), ...(normalized.options.secrets ?? [])] };
      current = normalized.error;
      continue;
    }
    const item = record(current);
    if (!item) {
      messages.push(redactDiagnosticText(String(current), options));
      break;
    }
    const fields = projectDiagnosticContext(item);
    const path = safeDiagnosticField(item, "path");
    if (typeof path === "string") fields.file = projectDiagnosticContext({ file: path }).file;
    Object.assign(collected, {
      ...fields,
      ...projectDiagnosticContext(safeDiagnosticField(item, "context")),
      ...collected,
    });
    // SDK APIError.message can already contain its entire JSON body. Project
    // the structured provider payload instead, before any string conversion.
    const providerError = safeDiagnosticField(item, "error");
    const providerBody = record(providerError);
    const message = safeDiagnosticField(item, "message");
    const text =
      providerBody && fields.status !== undefined
        ? `HTTP ${fields.status}: ${projectProviderDiagnosticText(providerBody, options, 0)}`
        : typeof message === "string"
          ? redactDiagnosticText(message, options)
          : undefined;
    if (text && messages.at(-1) !== text) messages.push(text);
    current =
      safeDiagnosticField(item, "cause") ?? (providerBody && fields.status !== undefined ? undefined : providerError);
    if (!text && current === undefined) messages.push("Error object has no message or cause");
  }
  return {
    cause: redactDiagnosticText(messages.join("\nCaused by: ") || "No error cause was supplied", options),
    context: projectDiagnosticContext({ ...collected, ...context }, options),
  };
}

/** Keep the raw exception internal while all diagnostic consumers use its normalized projection. */
export function diagnosticError(
  error: unknown,
  context: ErrorDiagnosticContext,
  options: DiagnosticOptions = {},
): Error {
  const wrapped = Object.assign(new Error("Provider operation failed", { cause: error }), { context });
  normalizedErrors.set(wrapped, { error, context, options });
  return wrapped;
}

/** Re-project a failure at a persistence/transport boundary; never persist its raw payload. */
export function projectFailureDiagnostic(value: unknown): Record<string, unknown> {
  const outer = record(value);
  const source =
    safeDiagnosticField(outer, "success") === false ? (record(safeDiagnosticField(outer, "error")) ?? outer) : outer;
  const diagnostic = errorDiagnostic(
    safeDiagnosticField(source, "cause") ?? value,
    projectDiagnosticContext(safeDiagnosticField(source, "context")),
  );
  const code = safeIdentifier(safeDiagnosticField(source, "code"));
  const message = safeDiagnosticField(source, "message");
  const retryable = safeDiagnosticField(source, "retryable");
  return {
    ...(code ? { code } : {}),
    message: typeof message === "string" ? redactDiagnosticText(message) : diagnostic.cause,
    ...diagnostic,
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  };
}
