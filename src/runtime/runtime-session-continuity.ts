import { getSession } from "../router/index.js";
import { resolveStoredRuntimeProvider } from "./host-session.js";
import type { RuntimeProviderId } from "./types.js";

export interface RuntimeSessionContinuityOptions {
  dbSessionKey: string;
  runtimeProviderId: RuntimeProviderId;
  supportsSessionFork: boolean;
  supportsSessionResume: boolean;
  storedProviderSessionId?: string;
  canResumeStoredSession: boolean;
  defaultRuntimeProviderId: RuntimeProviderId;
}

export interface RuntimeSessionContinuity {
  forkFromProviderSessionId?: string;
  resumeProviderSessionId?: string;
}

export function resolveRuntimeSessionContinuity(options: RuntimeSessionContinuityOptions): RuntimeSessionContinuity {
  const resumableStoredProviderSessionId = options.canResumeStoredSession ? options.storedProviderSessionId : undefined;
  const forkFromProviderSessionId = resolveRuntimeForkSession(options, resumableStoredProviderSessionId);
  const resumeProviderSessionId = options.supportsSessionResume
    ? (forkFromProviderSessionId ?? resumableStoredProviderSessionId)
    : undefined;

  return {
    ...(forkFromProviderSessionId ? { forkFromProviderSessionId } : {}),
    ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
  };
}

function resolveRuntimeForkSession(
  options: RuntimeSessionContinuityOptions,
  resumableStoredProviderSessionId: string | undefined,
): string | undefined {
  if (resumableStoredProviderSessionId || !options.supportsSessionFork || !options.dbSessionKey.includes(":thread:")) {
    return undefined;
  }

  const parentKey = options.dbSessionKey.replace(/:thread:.*$/, "");
  const parentSession = getSession(parentKey);
  const parentProviderSessionId =
    parentSession?.runtimeSessionDisplayId ?? parentSession?.providerSessionId ?? parentSession?.sdkSessionId;
  const parentRuntimeProvider = parentSession
    ? resolveStoredRuntimeProvider(parentSession, options.defaultRuntimeProviderId)
    : undefined;

  return parentProviderSessionId && parentRuntimeProvider === options.runtimeProviderId
    ? parentProviderSessionId
    : undefined;
}
