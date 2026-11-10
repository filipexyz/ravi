import { classifyRuntimeCredentialFailure, isRuntimeProviderCapacityFailure } from "./credential-classifier.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function string(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/** Called only for native error envelopes, never assistant text or tool results. */
export function normalizeCodexProviderError(value: unknown): RecordValue {
  const envelope = record(value) ?? {};
  const data = record(envelope.data);
  const error = record(data?.error) ?? record(envelope.error) ?? envelope;
  const info = error.codexErrorInfo ?? data?.codexErrorInfo ?? envelope.codexErrorInfo;
  const infoRecord = record(info);
  const infoKey = infoRecord ? Object.keys(infoRecord)[0] : undefined;
  const details = infoKey ? record(infoRecord?.[infoKey]) : undefined;
  const status = [
    error.status,
    error.statusCode,
    error.httpStatusCode,
    data?.status,
    data?.statusCode,
    data?.httpStatusCode,
    envelope.status,
    envelope.statusCode,
    details?.httpStatusCode,
  ].find(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599,
  );
  let code = string(error.code, data?.code, typeof info === "string" ? info : infoKey);
  const message = string(error.message, data?.message, envelope.message) ?? "Codex app-server request failed";
  // Older app-servers expose this stable admission error only as a message.
  // Exact allowlist at this error boundary; arbitrary mentions never qualify.
  if (
    (!code || code === "other") &&
    (status === undefined || [429, 503, 529].includes(status)) &&
    message.trim() === "Selected model is at capacity. Please try a different model."
  ) {
    code = "model_capacity_exceeded";
  }
  const headersSource = record(error.headers) ?? record(data?.headers) ?? record(envelope.headers);
  const headers: Record<string, string | number> = {};
  // Retry metadata only: never forward arbitrary native authorization/cookie headers.
  for (const [key, val] of Object.entries(headersSource ?? {})) {
    if (
      /^(retry-after|x-request-id|request-id|x-ratelimit-[a-z-]+)$/i.test(key) &&
      (typeof val === "string" || typeof val === "number")
    )
      headers[key.toLowerCase()] = val;
  }
  const providerType = string(error.type, data?.type);
  return {
    error: {
      message,
      ...(code ? { code } : {}),
      ...(providerType ? { type: providerType } : {}),
      ...(info !== undefined ? { codexErrorInfo: info } : {}),
    },
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    ...(providerType ? { providerType } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
}

export function isCodexCapacityError(failure: RecordValue): boolean {
  return isRuntimeProviderCapacityFailure(
    classifyRuntimeCredentialFailure({
      runtimeProvider: "codex",
      httpStatus: typeof failure.status === "number" ? failure.status : undefined,
      providerCode: string(failure.code),
      providerType: string(failure.providerType),
      source: "rpc-error",
    }),
  );
}

export class CodexAppServerRequestError extends Error {
  readonly failure: RecordValue;
  constructor(
    value: unknown,
    readonly method: string,
  ) {
    const failure = normalizeCodexProviderError(value);
    super(String(record(failure.error)?.message));
    this.name = "CodexAppServerRequestError";
    this.failure = failure;
  }
}
