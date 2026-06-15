import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getContext } from "../cli/context.js";
import {
  RAVI_APP_BUILTIN_OPERATION_HANDLERS,
  RAVI_APP_PERMISSION_PROVIDER_MAX_CACHE_TTL_SEC,
  RAVI_APP_PERMISSION_PROVIDER_MAX_TIMEOUT_MS,
} from "../apps/service.js";
import type {
  RaviAppManifestRecord,
  RaviAppOperationAuthorizationDeclaration,
  RaviAppOperationAuthorizationOwner,
  RaviAppOperationDeclaration,
  RaviAppPermissionDecision,
  RaviAppPermissionProviderAudit,
  RaviAppPermissionProviderDeclaration,
} from "../apps/types.js";

export interface AppPermissionProviderRuntimeOperation {
  id: string;
  operation: RaviAppOperationDeclaration;
}

export class AppPermissionProviderDeniedError extends Error {
  constructor(
    message: string,
    readonly audit: RaviAppPermissionProviderAudit,
  ) {
    super(message);
    this.name = "AppPermissionProviderDeniedError";
  }
}

const APP_PERMISSION_REQUEST_SCHEMA = "ravi.app.permission.request/v1";
const APP_PERMISSION_DECISION_SCHEMA = "ravi.app.permission.decision/v1";
const APP_PERMISSION_PROVIDER_MAX_OUTPUT_BYTES = 64 * 1024;
const REDACTED_VALUE = "[redacted]";
const RAVI_CONTEXT_ENV_KEYS = new Set([
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_CHAT_ID",
  "RAVI_SOURCE_CHAT_ID",
]);

export async function evaluateAppPermissionProvider(
  app: RaviAppManifestRecord,
  resolved: AppPermissionProviderRuntimeOperation,
  options: {
    args: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<RaviAppPermissionProviderAudit | null> {
  const provider = app.permissions.provider;
  if (!provider) return null;
  if (provider.operation === resolved.id) return null;

  const startedAt = Date.now();
  const providerOperationRaw = manifestOperations(app)[provider.operation];
  if (!isOperationDeclaration(providerOperationRaw)) {
    throw providerDenied(
      provider,
      "Provider operation is not declared.",
      buildProviderAudit(provider, startedAt, {
        decision: "invalid",
        reasonCode: "provider_operation_missing",
        error: `Provider operation ${provider.operation} is not declared.`,
      }),
    );
  }

  if (providerOperationRaw.mutating === true || hasDeclaredOperationPermission(providerOperationRaw)) {
    throw providerDenied(
      provider,
      "Provider operation is not safe to call.",
      buildProviderAudit(provider, startedAt, {
        decision: "invalid",
        reasonCode: "provider_operation_protected",
        error: `Provider operation ${provider.operation} is mutating or declares permission.`,
      }),
    );
  }

  const request = buildPermissionProviderRequest(app, provider, resolved, options.args);

  if (provider.interface === "builtin") {
    const handler = providerOperationRaw.handler?.trim();
    if (!handler || !RAVI_APP_BUILTIN_OPERATION_HANDLERS.has(handler)) {
      throw providerDenied(
        provider,
        "Provider builtin operation has an unsupported handler.",
        buildProviderAudit(provider, startedAt, {
          decision: "invalid",
          reasonCode: "provider_builtin_handler_unsupported",
          error: `Unsupported provider builtin handler: ${handler ?? "(missing)"}.`,
          requestId: String(request.requestId),
        }),
      );
    }
    return finishPermissionProviderDecision(provider, request, runBuiltinHandler(handler, app), startedAt);
  }

  if (provider.interface === "cli") {
    const command = providerOperationRaw.command?.trim();
    if (!command) {
      throw providerDenied(
        provider,
        "Provider CLI operation is missing command.",
        buildProviderAudit(provider, startedAt, {
          decision: "invalid",
          reasonCode: "provider_command_missing",
          error: `Provider operation ${provider.operation} is missing command.`,
          requestId: String(request.requestId),
        }),
      );
    }

    const renderedCommand = renderCliCommand(command, {
      appId: app.manifest?.id ?? app.id,
      operationId: provider.operation,
      args: [],
    });
    const run = await spawnShellCommand(renderedCommand, {
      cwd: options.cwd,
      env: buildPermissionProviderEnv(options.env),
      mergeProcessEnv: false,
      capture: true,
      stdin: `${JSON.stringify(request)}\n`,
      timeoutMs: provider.timeoutMs ?? RAVI_APP_PERMISSION_PROVIDER_MAX_TIMEOUT_MS,
      maxOutputBytes: APP_PERMISSION_PROVIDER_MAX_OUTPUT_BYTES,
    });

    if (run.timedOut) {
      throw providerDenied(
        provider,
        "Permission provider timed out.",
        buildProviderAudit(provider, startedAt, {
          decision: "error",
          reasonCode: "provider_timeout",
          error: `Provider timed out after ${provider.timeoutMs ?? RAVI_APP_PERMISSION_PROVIDER_MAX_TIMEOUT_MS}ms.`,
          requestId: String(request.requestId),
        }),
      );
    }
    if (run.truncated) {
      throw providerDenied(
        provider,
        "Permission provider output exceeded the size limit.",
        buildProviderAudit(provider, startedAt, {
          decision: "error",
          reasonCode: "provider_output_too_large",
          error: `Provider output exceeded ${APP_PERMISSION_PROVIDER_MAX_OUTPUT_BYTES} bytes.`,
          requestId: String(request.requestId),
        }),
      );
    }
    if (run.exitCode !== 0) {
      throw providerDenied(
        provider,
        "Permission provider failed.",
        buildProviderAudit(provider, startedAt, {
          decision: "error",
          reasonCode: "provider_exit_nonzero",
          error: run.stderr.trim() || `Provider exited with code ${run.exitCode}`,
          requestId: String(request.requestId),
        }),
      );
    }

    return finishPermissionProviderDecision(provider, request, parseJsonOutput(run.stdout), startedAt);
  }

  throw providerDenied(
    provider,
    `Permission provider interface is not supported yet: ${provider.interface}`,
    buildProviderAudit(provider, startedAt, {
      decision: "error",
      reasonCode: "provider_interface_unsupported",
      error: `Unsupported provider interface: ${provider.interface}`,
      requestId: String(request.requestId),
    }),
  );
}

function finishPermissionProviderDecision(
  provider: RaviAppPermissionProviderDeclaration,
  request: Record<string, unknown>,
  parsed: unknown,
  startedAt: number,
): RaviAppPermissionProviderAudit {
  if (!isObject(parsed)) {
    throw providerDenied(
      provider,
      "Permission provider returned invalid JSON.",
      buildProviderAudit(provider, startedAt, {
        decision: "invalid",
        reasonCode: "provider_invalid_json",
        error: "Provider stdout was not a JSON object.",
        requestId: String(request.requestId),
      }),
    );
  }

  const decision = parsed.decision;
  const reasonCode = parsed.reasonCode;
  if (parsed.schema !== APP_PERMISSION_DECISION_SCHEMA) {
    throw providerDenied(
      provider,
      "Permission provider returned an unsupported decision schema.",
      buildProviderAudit(provider, startedAt, {
        decision: "invalid",
        reasonCode: "provider_decision_schema_mismatch",
        error: `Expected ${APP_PERMISSION_DECISION_SCHEMA}.`,
        requestId: String(request.requestId),
      }),
    );
  }
  if (!isPermissionDecision(decision)) {
    throw providerDenied(
      provider,
      "Permission provider returned an unknown decision.",
      buildProviderAudit(provider, startedAt, {
        decision: "invalid",
        reasonCode: "provider_unknown_decision",
        error: `Unknown decision: ${String(decision)}`,
        requestId: String(request.requestId),
      }),
    );
  }
  if (typeof reasonCode !== "string" || !reasonCode.trim()) {
    throw providerDenied(
      provider,
      "Permission provider decision is missing reasonCode.",
      buildProviderAudit(provider, startedAt, {
        decision: "invalid",
        reasonCode: "provider_reason_code_missing",
        error: "Provider decision reasonCode is required.",
        requestId: String(request.requestId),
      }),
    );
  }

  const audit = buildProviderAudit(provider, startedAt, {
    requestId: String(request.requestId),
    decision,
    reasonCode: reasonCode.trim(),
    reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    cacheTtlSec: resolveDecisionCacheTtl(provider, parsed.cache),
    grantSuggestion: parsed.grantSuggestion ?? undefined,
    audit: isObject(parsed.audit) ? parsed.audit : undefined,
  });

  if (decision !== "allow") {
    const message =
      decision === "needs_grant"
        ? "Permission provider requires a grant before this operation can run."
        : decision === "not_applicable"
          ? "Permission provider returned not_applicable for a provider-required operation."
          : typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason.trim()
            : "Permission provider denied this operation.";
    throw providerDenied(provider, message, audit);
  }

  return audit;
}

function providerDenied(
  provider: RaviAppPermissionProviderDeclaration,
  message: string,
  audit: RaviAppPermissionProviderAudit,
): AppPermissionProviderDeniedError {
  return new AppPermissionProviderDeniedError(
    `Permission denied by app permission provider ${provider.id}: ${message}`,
    audit,
  );
}

function buildProviderAudit(
  provider: RaviAppPermissionProviderDeclaration,
  startedAt: number,
  input: {
    requestId?: string;
    decision: RaviAppPermissionProviderAudit["decision"];
    reasonCode: string | null;
    reason?: string;
    error?: string;
    cacheTtlSec?: number;
    grantSuggestion?: unknown;
    audit?: unknown;
  },
): RaviAppPermissionProviderAudit {
  return {
    providerId: provider.id,
    providerVersion: provider.version,
    providerOperationId: provider.operation,
    interface: provider.interface,
    requestId: input.requestId ?? "",
    decision: input.decision,
    reasonCode: input.reasonCode,
    durationMs: Date.now() - startedAt,
    cache: {
      hit: false,
      ...(input.cacheTtlSec !== undefined ? { ttlSec: input.cacheTtlSec } : {}),
    },
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.grantSuggestion !== undefined ? { grantSuggestion: input.grantSuggestion } : {}),
    ...(input.audit !== undefined ? { audit: input.audit } : {}),
  };
}

function buildPermissionProviderRequest(
  app: RaviAppManifestRecord,
  provider: RaviAppPermissionProviderDeclaration,
  resolved: AppPermissionProviderRuntimeOperation,
  args: string[],
): Record<string, unknown> {
  const appId = app.manifest?.id ?? app.id;
  const ctx = getContext();
  const metadata = isObject(ctx?.context?.metadata) ? ctx.context.metadata : {};
  const context = buildPermissionProviderContext(ctx, metadata);
  const parsedInput = parseAuthorizationArgs(args);
  const input = buildPermissionProviderInput(resolved.operation.authorization, parsedInput, args.length);
  const resource = buildPermissionProviderResource(appId, resolved, parsedInput, context);

  return {
    schema: APP_PERMISSION_REQUEST_SCHEMA,
    requestId: randomUUID(),
    appId,
    providerId: provider.id,
    providerVersion: provider.version,
    operation: {
      id: resolved.id,
      mutating: resolved.operation.mutating === true,
      action: operationAction(appId, resolved.id),
      declaredPermissions: declaredOperationPermissions(resolved.operation),
    },
    resource,
    input,
    context,
    core: {
      appBoundary: "allow",
      agentCeiling: "allow",
      surfaceConstraint: "allow",
    },
  };
}

type PermissionProviderPrincipal = { type: string; id: string };

interface PermissionProviderContext {
  contextId: string | null;
  authorityMode: string | null;
  session: {
    id: string | null;
    name: string | null;
  };
  actor: PermissionProviderPrincipal | null;
  surface: PermissionProviderPrincipal | null;
  executorAgent: {
    id: string | null;
  };
}

interface ParsedAuthorizationInput {
  positional: string[];
  options: Record<string, string | boolean | string[]>;
  redacted: boolean;
}

function buildPermissionProviderContext(
  ctx: ReturnType<typeof getContext>,
  metadata: Record<string, unknown>,
): PermissionProviderContext {
  return {
    contextId: ctx?.contextId ?? ctx?.context?.contextId ?? null,
    authorityMode: stringOrNull(metadata.authorityMode),
    session: {
      id: ctx?.sessionKey ?? ctx?.context?.sessionKey ?? null,
      name: ctx?.sessionName ?? ctx?.context?.sessionName ?? null,
    },
    actor: principalFromMetadata(metadata.actorPrincipal),
    surface: principalFromMetadata(metadata.surfacePrincipal) ?? surfacePrincipalFromContext(ctx?.source),
    executorAgent: {
      id: ctx?.agentId ?? ctx?.context?.agentId ?? null,
    },
  };
}

function buildPermissionProviderInput(
  authorization: RaviAppOperationAuthorizationDeclaration | undefined,
  parsed: ParsedAuthorizationInput,
  rawArgCount: number,
): Record<string, unknown> {
  const input = authorization?.input;
  const includeOptions = new Set((input?.includeOptions ?? []).map(normalizeOptionName).filter(Boolean));
  const options: Record<string, unknown> = {};
  for (const option of includeOptions) {
    const value = parsed.options[option];
    if (value !== undefined) options[option] = value;
  }

  return {
    args: input?.includeArgs === true ? parsed.positional : [],
    options,
    rawArgCount,
    redacted: parsed.redacted,
  };
}

function buildPermissionProviderResource(
  appId: string,
  resolved: AppPermissionProviderRuntimeOperation,
  parsed: ParsedAuthorizationInput,
  context: PermissionProviderContext,
): Record<string, unknown> {
  const resource = resolved.operation.authorization?.resource;
  if (!resource) {
    return {
      type: "app-operation",
      id: resolved.id,
    };
  }

  const type = stringOrNull(resource.type)?.trim() || "app-resource";
  const id =
    safeResourceId(resource.id) ??
    safeResourceId(
      typeof resource.idFromArg === "number" && resource.idFromArg >= 0 ? parsed.positional[resource.idFromArg] : null,
    ) ??
    safeResourceId(optionFirstValue(parsed.options[normalizeOptionName(resource.idFromOption)])) ??
    `${appId}:${resolved.id}`;
  const owner = permissionProviderOwnerPrincipal(resource.ownerFrom, context);

  return {
    type,
    id,
    ...(owner ? { owner } : {}),
  };
}

function parseAuthorizationArgs(args: string[]): ParsedAuthorizationInput {
  const positional: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};
  let redacted = false;
  let positionalOnly = false;

  const pushOption = (name: string, rawValue: string | boolean) => {
    const normalizedName = normalizeOptionName(name);
    if (!normalizedName) return;
    const value =
      typeof rawValue === "string"
        ? sanitizeProviderValue(rawValue, normalizedName)
        : sanitizeProviderBoolean(rawValue);
    if (value === REDACTED_VALUE) redacted = true;
    appendOptionValue(options, normalizedName, value);
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (positionalOnly || !arg.startsWith("--") || arg === "--") {
      if (arg === "--" && !positionalOnly) {
        positionalOnly = true;
        continue;
      }
      const sanitized = sanitizeProviderValue(arg);
      if (sanitized === REDACTED_VALUE) redacted = true;
      positional.push(sanitized);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq > 2) {
      pushOption(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }

    if (arg.startsWith("--no-")) {
      pushOption(arg.slice(5), false);
      continue;
    }

    const name = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      pushOption(name, next);
      index += 1;
    } else {
      pushOption(name, true);
    }
  }

  return { positional, options, redacted };
}

function appendOptionValue(
  options: Record<string, string | boolean | string[]>,
  name: string,
  value: string | boolean,
): void {
  const existing = options[name];
  if (existing === undefined) {
    options[name] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(String(value));
    return;
  }
  options[name] = [String(existing), String(value)];
}

function buildPermissionProviderEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...(extraEnv ?? {}) };
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (!isPermissionProviderEnvKeyAllowed(key)) continue;
    env[key] = value;
  }
  return env;
}

function isPermissionProviderEnvKeyAllowed(key: string): boolean {
  if (RAVI_CONTEXT_ENV_KEYS.has(key)) return false;
  if (isSensitiveProviderKey(key)) return false;
  return true;
}

function isSensitiveProviderKey(key: string): boolean {
  return /(^|_|\b)(token|secret|password|credential|credentials|context[_-]?key|api[_-]?key|auth|bearer|cookie)(_|$|\b)/i.test(
    key,
  );
}

function sanitizeProviderBoolean(value: boolean): boolean {
  return value;
}

function sanitizeProviderValue(value: string, key?: string): string {
  if (key && isSensitiveProviderKey(key)) return REDACTED_VALUE;
  if (/^rctx_[a-z0-9_-]+/i.test(value.trim())) return REDACTED_VALUE;
  if (/^bearer\s+/i.test(value.trim())) return REDACTED_VALUE;
  return value;
}

function safeResourceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeProviderValue(value);
  if (!sanitized.trim() || sanitized === REDACTED_VALUE) return null;
  return sanitized.trim();
}

function optionFirstValue(value: string | boolean | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.find((entry) => entry !== REDACTED_VALUE && entry.trim()) ?? null;
  return null;
}

function permissionProviderOwnerPrincipal(
  ownerFrom: RaviAppOperationAuthorizationOwner | undefined,
  context: PermissionProviderContext,
): PermissionProviderPrincipal | null {
  if (ownerFrom === "actor") return context.actor;
  if (ownerFrom === "surface") return context.surface;
  if (ownerFrom === "executorAgent") {
    return context.executorAgent.id ? { type: "agent", id: context.executorAgent.id } : null;
  }
  return null;
}

function normalizeOptionName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^--?/, "") : "";
}

function runBuiltinHandler(handler: string, app: RaviAppManifestRecord): unknown {
  if (handler === "apps.help") {
    const operationIds = Object.keys(manifestOperations(app))
      .filter((id) => app.permissions.provider?.operation !== id)
      .sort();
    return {
      app: toDetail(app),
      operations: operationIds,
      nextCommands: [
        `ravi apps show ${app.id} --json`,
        `ravi apps check ${app.id} --json`,
        `ravi apps run ${app.id} check --json`,
      ],
    };
  }
  if (handler === "apps.manifest.show") {
    return { app: toDetail(app) };
  }
  if (handler === "apps.manifest.check") {
    return {
      ok: app.valid,
      checked: 1,
      results: [
        {
          id: app.id,
          path: app.path,
          source: app.source,
          ok: app.valid,
          errors: app.errors,
          warnings: app.warnings,
        },
      ],
    };
  }
  if (handler === "apps.stub.list") {
    return {
      app: toSummary(app),
      total: 0,
      items: [],
      message: "This scaffolded app does not have a domain list implementation yet.",
    };
  }
  throw new Error(`Unsupported builtin app operation handler: ${handler}`);
}

function manifestOperations(app: RaviAppManifestRecord): Record<string, unknown> {
  const operations = app.manifest?.operations;
  return operations && typeof operations === "object" && !Array.isArray(operations)
    ? (operations as Record<string, unknown>)
    : {};
}

function isOperationDeclaration(value: unknown): value is RaviAppOperationDeclaration {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).interface === "string"
  );
}

function hasDeclaredOperationPermission(operation: RaviAppOperationDeclaration): boolean {
  return (
    (typeof operation.permission === "string" && operation.permission.trim().length > 0) ||
    (Array.isArray(operation.permissions) && operation.permissions.length > 0)
  );
}

function declaredOperationPermissions(operation: RaviAppOperationDeclaration): string[] {
  const permissions = new Set<string>();
  if (typeof operation.permission === "string" && operation.permission.trim()) {
    permissions.add(operation.permission.trim());
  }
  if (Array.isArray(operation.permissions)) {
    for (const permission of operation.permissions) {
      if (typeof permission === "string" && permission.trim()) permissions.add(permission.trim());
    }
  }
  return Array.from(permissions).sort();
}

function isPermissionDecision(value: unknown): value is RaviAppPermissionDecision {
  return value === "allow" || value === "deny" || value === "needs_grant" || value === "not_applicable";
}

function resolveDecisionCacheTtl(provider: RaviAppPermissionProviderDeclaration, cache: unknown): number | undefined {
  if (!isObject(cache) || !Number.isInteger(cache.ttlSec) || typeof cache.ttlSec !== "number" || cache.ttlSec <= 0) {
    return undefined;
  }
  return Math.min(
    cache.ttlSec,
    provider.cacheTtlSec ?? RAVI_APP_PERMISSION_PROVIDER_MAX_CACHE_TTL_SEC,
    RAVI_APP_PERMISSION_PROVIDER_MAX_CACHE_TTL_SEC,
  );
}

function operationAction(appId: string, operationId: string): string {
  const local = localOperationName(appId, operationId);
  return local.split(".").filter(Boolean).pop() ?? local;
}

function principalFromMetadata(value: unknown): { type: string; id: string } | null {
  if (typeof value !== "string") return null;
  const [type, ...rest] = value.split(":");
  const id = rest.join(":");
  if (!type || !id || type === "unknown") return null;
  return { type, id };
}

function surfacePrincipalFromContext(source: { chatId?: string } | undefined): { type: string; id: string } | null {
  if (!source?.chatId) return null;
  return { type: "chat", id: source.chatId };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderCliCommand(template: string, input: { appId: string; operationId: string; args: string[] }): string {
  let usedArgsPlaceholder = false;
  const rendered = template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, name: string) => {
    if (name === "id" || name === "appId") return quoteShellArg(input.appId);
    if (name === "operation" || name === "operationId") return quoteShellArg(input.operationId);
    if (name === "args") {
      usedArgsPlaceholder = true;
      return input.args.map(quoteShellArg).join(" ");
    }
    return match;
  });
  if (usedArgsPlaceholder || input.args.length === 0) return rendered;
  return `${rendered} ${input.args.map(quoteShellArg).join(" ")}`;
}

function spawnShellCommand(
  command: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    mergeProcessEnv?: boolean;
    capture: boolean;
    stdin?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd ?? process.cwd(),
      env: options.mergeProcessEnv === false ? options.env : { ...process.env, ...(options.env ?? {}) },
      shell: true,
      stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    const maxOutputBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, options.timeoutMs);
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        const next = appendOutputChunk(stdout, String(chunk), maxOutputBytes);
        stdout = next.value;
        if (next.truncated) {
          truncated = true;
          child.kill();
          return;
        }
      });
      child.stderr?.on("data", (chunk) => {
        const next = appendOutputChunk(stderr, String(chunk), maxOutputBytes);
        stderr = next.value;
        if (next.truncated) {
          truncated = true;
          child.kill();
          return;
        }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin ?? "");
    }
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    });
  });
}

function appendOutputChunk(
  current: string,
  chunk: string,
  maxOutputBytes: number,
): { value: string; truncated: boolean } {
  const next = current + chunk;
  if (!Number.isFinite(maxOutputBytes) || Buffer.byteLength(next, "utf8") <= maxOutputBytes) {
    return { value: next, truncated: false };
  }
  return { value: Buffer.from(next, "utf8").subarray(0, maxOutputBytes).toString("utf8"), truncated: true };
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function localOperationName(appId: string, operationId: string): string {
  const prefix = `${appId.replace(/\//g, ".")}.`;
  return operationId.startsWith(prefix) ? operationId.slice(prefix.length) : operationId;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toSummary(record: RaviAppManifestRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description,
    schema: record.schema,
    source: record.source,
    path: record.path,
    relativePath: record.relativePath,
    rootPath: record.rootPath,
    interfaceNames: record.interfaceNames,
    permissions: record.permissions,
    valid: record.valid,
    errors: record.errors,
    warnings: record.warnings,
  };
}

function toDetail(record: RaviAppManifestRecord): Record<string, unknown> {
  return {
    ...toSummary(record),
    manifest: record.manifest,
  };
}
