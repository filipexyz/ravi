import { isExplicitConnect, nats } from "../nats.js";
import { buildCliInvocationMetadata } from "./provenance.js";

const MAX_INPUT_LENGTH = 500;
const RCTX_TOKEN_PATTERN = /rctx_[A-Za-z0-9_-]+/g;

export interface CliAuditEventOptions {
  group: string;
  name: string;
  tool?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  status?: "started" | "completed";
  durationMs?: number;
  closeLazyConnection?: boolean;
  /** Public context id (`ctx_*`). Never pass the secret context key. */
  contextId?: string | null;
  /** Public parent context id (`ctx_*`) when this context was issued by another. */
  parentContextId?: string | null;
  /** Agent bound to the context. */
  agentId?: string | null;
}

export async function emitCliAuditEvent(options: CliAuditEventOptions): Promise<void> {
  const tool = options.tool ?? `${options.group}_${options.name}`;

  await nats
    .emit(`ravi._cli.cli.${options.group}.${options.name}`, {
      tool,
      input: scrubSecrets(truncate(options.input ?? {})),
      isError: Boolean(options.isError),
      ...(options.status ? { status: options.status } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      ...(options.contextId !== undefined ? { contextId: options.contextId } : {}),
      ...(options.parentContextId !== undefined ? { parentContextId: options.parentContextId } : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      timestamp: new Date().toISOString(),
      sessionKey: "_cli",
      cliInvocation: buildCliInvocationMetadata({
        group: options.group,
        name: options.name,
        tool,
      }),
    })
    .catch(() => {});

  if (options.closeLazyConnection && !isExplicitConnect()) {
    await nats.close().catch(() => {});
  }
}

export async function runWithCliAudit<T>(
  options: Omit<CliAuditEventOptions, "isError" | "durationMs" | "status">,
  fn: () => T | Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  let isError = false;

  try {
    return await fn();
  } catch (error) {
    isError = true;
    throw error;
  } finally {
    await emitCliAuditEvent({
      ...options,
      status: "completed",
      isError,
      durationMs: Date.now() - startTime,
    });
  }
}

function truncate(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_INPUT_LENGTH ? `${value.slice(0, MAX_INPUT_LENGTH)}...` : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncate(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = truncate(nested);
    return out;
  }
  return value;
}

function scrubSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(RCTX_TOKEN_PATTERN, "[REDACTED:rctx]");
  }
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = scrubSecrets(nested);
    return out;
  }
  return value;
}
