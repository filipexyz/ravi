import * as Sentry from "@sentry/nextjs";

type Severity = "fatal" | "error" | "warning" | "log" | "info" | "debug";

export interface ChannelApiErrorContext {
  requestId: string;
  method: string;
  operation: string;
  path?: string;
  instanceId?: string;
  status?: number;
  code?: string;
  details?: unknown;
}

const capturedErrors = new WeakSet<object>();

export async function captureChannelApiError(error: unknown, context: ChannelApiErrorContext): Promise<void> {
  if (isCaptured(error) || !shouldCapture(context)) return;
  markCaptured(error);
  ensureSentryServerClient();

  const normalized = normalizeError(error, context);
  Sentry.captureException(normalized.error, {
    level: normalized.level,
    tags: {
      component: "console-channels-api",
      operation: context.operation,
      "error.code": normalized.code,
      ...(context.status ? { "http.status_code": String(context.status) } : {}),
    },
    contexts: {
      ravi_channels: compact({
        requestId: context.requestId,
        method: context.method,
        path: context.path,
        operation: context.operation,
        instanceId: context.instanceId,
        errorCode: normalized.code,
        errorStatus: context.status,
        workerRequestId: workerRequestId(context.details),
      }),
    },
  });
  await Sentry.flush(2000);
}

function shouldCapture(context: ChannelApiErrorContext): boolean {
  if ((context.status ?? 500) >= 500) return true;
  return new Set([
    "channel_host_unavailable",
    "channel_instance_not_found",
    "channel_instance_unavailable",
    "channel_provider_error",
    "channel_rate_limited",
    "server_not_configured",
  ]).has(context.code ?? "");
}

function normalizeError(error: unknown, context: ChannelApiErrorContext): { error: Error; code: string; level: Severity } {
  const code = context.code ?? "internal_error";
  const level: Severity = (context.status ?? 500) >= 500 ? "error" : "warning";
  if (error instanceof Error) return { error, code, level };
  return { error: new Error(String(error)), code, level };
}

function ensureSentryServerClient(): void {
  if (Sentry.getClient()) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    enableLogs: true,
  });
}

function workerRequestId(details: unknown): string | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const value = (details as Record<string, unknown>).requestId;
  return typeof value === "string" ? value : undefined;
}

function isCaptured(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && capturedErrors.has(error));
}

function markCaptured(error: unknown): void {
  if (error && typeof error === "object") capturedErrors.add(error);
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}
