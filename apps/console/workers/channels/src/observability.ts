import * as Sentry from "@sentry/cloudflare";

import { ChannelCryptoError } from "./crypto";
import { ChannelHttpError } from "./errors";
import { OmniClientError } from "./omni";

type Severity = "fatal" | "error" | "warning" | "log" | "info" | "debug";

export interface ChannelsWorkerErrorContext {
  requestId: string;
  method?: string;
  path?: string;
  operation: string;
  organizationId?: string;
  channelInstanceId?: string;
  hostId?: string;
  provider?: string;
  status?: string;
}

const capturedErrors = new WeakSet<object>();

export function captureChannelsWorkerError(error: unknown, context: ChannelsWorkerErrorContext): void {
  if (isCaptured(error) || !shouldCapture(error)) return;
  markCaptured(error);

  const normalized = normalizeError(error);
  Sentry.withScope((scope) => {
    scope.setLevel(normalized.level);
    scope.setTag("component", "channel-control-worker");
    scope.setTag("operation", context.operation);
    scope.setTag("error.code", normalized.code);
    if (context.provider) scope.setTag("provider", context.provider);
    if (context.status) scope.setTag("channel.status", context.status);

    scope.setContext("ravi_channels", compact({
      requestId: context.requestId,
      method: context.method,
      path: context.path,
      operation: context.operation,
      organizationId: context.organizationId,
      channelInstanceId: context.channelInstanceId,
      hostId: context.hostId,
      provider: context.provider,
      status: context.status,
      errorName: normalized.name,
      errorCode: normalized.code,
      errorStatus: normalized.status,
    }));

    Sentry.captureException(normalized.error);
  });
}

function shouldCapture(error: unknown): boolean {
  if (error instanceof OmniClientError || error instanceof ChannelCryptoError) return true;
  if (error instanceof ChannelHttpError) {
    return error.status >= 500 || error.code === "channel_unauthorized";
  }
  return true;
}

function normalizeError(error: unknown): {
  error: Error;
  name: string;
  code: string;
  status?: number;
  level: Severity;
} {
  if (error instanceof OmniClientError) {
    return {
      error,
      name: error.name,
      code: error.code,
      status: error.status,
      level: error.status >= 500 ? "error" : "warning",
    };
  }
  if (error instanceof ChannelHttpError) {
    return {
      error,
      name: error.name,
      code: error.code,
      status: error.status,
      level: error.status >= 500 ? "error" : "warning",
    };
  }
  if (error instanceof ChannelCryptoError) {
    return { error, name: error.name, code: error.code, level: "error" };
  }
  if (error instanceof Error) {
    return { error, name: error.name, code: "unexpected_worker_error", level: "error" };
  }
  return {
    error: new Error(String(error)),
    name: "NonErrorThrown",
    code: "unexpected_worker_error",
    level: "error",
  };
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
