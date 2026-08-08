import { isExplicitConnect, nats } from "../nats.js";
import {
  ContractError,
  contractFailureOutcome,
  expectedErrorToContractError,
  renderContractError,
  unexpectedErrorToContractError,
} from "./agent-contract.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { cloudErrorToContractError, commandOperation, renderCloudContractError } from "./cloud-error-contract.js";
import { buildCliInvocationMetadata } from "./provenance.js";
import { sanitizePublicValue } from "./redaction.js";

const MAX_INPUT_LENGTH = 500;
const auditedContractErrors = new WeakSet<ContractError>();

export function wasContractErrorAudited(error: ContractError): boolean {
  return auditedContractErrors.has(error);
}

export type CliAuditOutcome = "succeeded" | "blocked" | "usage_error" | "denied" | "failed";

export interface CliAuditEventOptions {
  group: string;
  name: string;
  tool?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  outcome?: CliAuditOutcome;
  exitCode?: number;
  errorCode?: string;
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
  if (process.env.RAVI_SUPPRESS_AUDIT_EVENTS === "1") return;

  const tool = options.tool ?? `${options.group}_${options.name}`;
  const payload = buildCliAuditPayload(options, tool);

  await nats.emit(`ravi._cli.cli.${options.group}.${options.name}`, payload).catch(() => {});

  if (options.closeLazyConnection && !isExplicitConnect()) {
    await nats.close().catch(() => {});
  }
}

export function buildCliAuditPayload(options: CliAuditEventOptions, explicitTool?: string): Record<string, unknown> {
  const tool = explicitTool ?? options.tool ?? `${options.group}_${options.name}`;
  const outcome = options.outcome ?? (options.isError ? "failed" : "succeeded");
  const isError = options.isError ?? (outcome !== "succeeded" && outcome !== "blocked");
  const cliInvocation = safeBuildCliInvocationMetadata({
    group: options.group,
    name: options.name,
    tool,
  });

  return {
    tool,
    input: truncate(sanitizeCliAuditValue(options.input ?? {})),
    isError,
    outcome,
    ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
    ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    ...(options.contextId !== undefined ? { contextId: options.contextId } : {}),
    ...(options.parentContextId !== undefined ? { parentContextId: options.parentContextId } : {}),
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    timestamp: new Date().toISOString(),
    sessionKey: "_cli",
    cliInvocation,
  };
}

function safeBuildCliInvocationMetadata(input: { group: string; name: string; tool: string }) {
  try {
    return buildCliInvocationMetadata(input);
  } catch {
    return {
      group: input.group,
      name: input.name,
      tool: input.tool,
    };
  }
}

export async function runWithCliAudit<T>(
  options: Omit<CliAuditEventOptions, "isError" | "outcome" | "durationMs" | "status">,
  fn: () => T | Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  let outcome: CliAuditOutcome = "succeeded";
  let exitCode = options.exitCode;
  let errorCode = options.errorCode;
  let caughtContractError: ContractError | null = null;

  try {
    return await fn();
  } catch (error) {
    const op = commandOperation(options.group, options.name);
    const contractError =
      error instanceof ContractError
        ? error
        : isCloudAuthError(error)
          ? cloudErrorToContractError(op, error)
          : (expectedErrorToContractError(op, error) ?? unexpectedErrorToContractError(op));
    if (!(error instanceof ContractError)) {
      const asJson = options.input?.json === true;
      if (isCloudAuthError(error)) renderCloudContractError(contractError, asJson);
      else renderContractError(contractError, asJson);
    }
    outcome = contractFailureOutcome(contractError);
    exitCode = contractError.exitCode;
    errorCode = contractError.code;
    caughtContractError = contractError;
    throw contractError;
  } finally {
    await emitCliAuditEvent({
      ...options,
      status: "completed",
      outcome,
      exitCode,
      errorCode,
      durationMs: Date.now() - startTime,
    });
    if (caughtContractError) auditedContractErrors.add(caughtContractError);
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

export function sanitizeCliAuditValue(value: unknown, key?: string): unknown {
  return sanitizePublicValue(value, key);
}
