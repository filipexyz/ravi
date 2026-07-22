import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import {
  discoverAppManifests,
  getAppManifest,
  RAVI_APP_BUILTIN_OPERATION_HANDLERS,
  RAVI_APP_OPERATION_MAX_ATTEMPTS,
} from "./service.js";
import type {
  RaviAppAliasInvocation,
  RaviAppFailure,
  RaviAppFailureCategory,
  RaviAppManifestRecord,
  RaviAppOperationDeclaration,
  RaviAppOperationErrorDetails,
  RaviAppOperationSafetyDeclaration,
  RaviAppPermissionProviderAudit,
  RaviAppRunOptions,
  RaviAppRunResult,
} from "./types.js";
import { RAVI_APP_OPERATION_RESULT_SCHEMA, RaviAppOperationError } from "./types.js";
import { parseRaviAppFailure, RaviAppFailureError, toRaviAppFailure } from "./failure.js";
import { emitCliAuditEvent } from "../cli/audit.js";
import { writeJsonToStdout } from "../cli/stdout.js";
import { AppPermissionProviderDeniedError, evaluateAppPermissionProvider } from "../permissions/provider-runtime.js";
import { assertCanRunAppOperation, assertCanUseApp, filterVisibleAppManifests } from "./permissions.js";

interface ResolvedOperation {
  id: string;
  operation: RaviAppOperationDeclaration;
}

interface ResolvedOperationInvocation {
  resolved: ResolvedOperation;
  args: string[];
}

const DEFAULT_STATIC_ROOT_COMMANDS = new Set(["apps"]);
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const addFormats = (addFormatsModule.default ?? addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

interface OperationControls {
  args: string[];
  confirmed: boolean;
  dryRun: boolean;
  fields: string[];
}

export async function runAppOperation(options: RaviAppRunOptions): Promise<RaviAppRunResult> {
  const startedAt = Date.now();
  const operationName = options.operation?.trim() || null;
  let resolvedContext: ResolvedOperation | null = null;
  let result: RaviAppRunResult;

  try {
    assertCanUseApp(options.appId);
    const app = getAppManifest(options.appId, options);
    if (!app.valid) {
      throw operationError("APP_MANIFEST_INVALID", `App manifest is invalid: ${app.errors.join("; ")}`, false, "input");
    }
    if (!app.manifest) {
      throw new Error(`App manifest is missing for ${app.id}`);
    }

    const invocation = options.forceVirtualHelp
      ? { resolved: virtualBuiltin(`${app.id.replace(/\//g, ".")}.help`, "apps.help"), args: options.args ?? [] }
      : resolveOperationInvocation(app, operationName, options.args ?? []);
    resolvedContext = invocation.resolved;
    result = await dispatchResolvedOperation(app, invocation.resolved, {
      args: invocation.args,
      json: options.json === true,
      confirmed: options.confirmed === true,
      dryRun: options.dryRun === true,
      fields: options.fields ?? [],
      cwd: options.cwd,
      env: options.env,
      staticRootCommands: mergeStaticRootCommands(options.staticRootCommands),
      startedAt,
    });
  } catch (error) {
    const errorDetails = toOperationErrorDetails(error);
    const failure = operationDetailsToFailure(errorDetails, "router");
    result = {
      ok: false,
      appId: options.appId,
      operation: operationName,
      operationId: resolvedContext?.id ?? null,
      interface: resolvedContext?.operation.interface ?? null,
      mutating: resolvedContext?.operation.mutating === true,
      mutationClass:
        resolvedContext?.operation.mutating === true
          ? "write"
          : resolvedContext?.operation.mutating === false
            ? "read"
            : "unknown",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: failure.message,
      failure,
      errorDetails,
      exitCode: failure.exitCode,
      ...(error instanceof AppPermissionProviderDeniedError ? { permissionProvider: error.audit } : {}),
    };
  }

  result = { schema: RAVI_APP_OPERATION_RESULT_SCHEMA, ...result };

  await emitCliAuditEvent({
    group: "apps",
    name: "run",
    tool: "apps_run",
    input: {
      appId: result.appId,
      operation: result.operation,
      operationId: result.operationId,
      interface: result.interface,
      mutating: result.mutating,
      permissionProvider: result.permissionProvider
        ? {
            providerId: result.permissionProvider.providerId,
            providerVersion: result.permissionProvider.providerVersion,
            providerOperationId: result.permissionProvider.providerOperationId,
            decision: result.permissionProvider.decision,
            reasonCode: result.permissionProvider.reasonCode,
            cache: result.permissionProvider.cache,
            durationMs: result.permissionProvider.durationMs,
          }
        : undefined,
    },
    isError: !result.ok,
    status: "completed",
    durationMs: result.durationMs,
    closeLazyConnection: true,
  });

  return result;
}

export function resolveAppAliasInvocation(
  argv: string[],
  options: {
    staticRootCommands?: Set<string>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): RaviAppAliasInvocation | null {
  if (argv.length === 0) return null;
  const first = argv[0];
  if (!first || first.startsWith("-")) return null;
  if (mergeStaticRootCommands(options.staticRootCommands).has(first)) return null;

  const appIds = new Set(
    filterVisibleAppManifests(discoverAppManifests({ cwd: options.cwd, env: options.env }))
      .map((record) => record.manifest?.id ?? record.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const maxSegments = Math.min(argv.length, Math.max(1, ...Array.from(appIds, (id) => id.split("/").length)));

  for (let segmentCount = maxSegments; segmentCount >= 1; segmentCount--) {
    const candidate = argv.slice(0, segmentCount).join("/");
    if (!appIds.has(candidate)) continue;
    const rest = argv.slice(segmentCount);
    const { json, help, confirmed, dryRun, fields, args } = stripRouterFlags(rest);
    const operation = help ? "help" : args[0];
    return {
      appId: candidate,
      operation,
      args: help ? args : operation ? args.slice(1) : args,
      json,
      confirmed,
      dryRun,
      fields,
      virtualHelp: help,
    };
  }

  return null;
}

export async function maybeRunAppAliasRoute(
  argv: string[],
  options: {
    staticRootCommands?: Set<string>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  const invocation = resolveAppAliasInvocation(argv, options);
  if (!invocation) return false;

  const result = await runAppOperation({
    appId: invocation.appId,
    operation: invocation.operation,
    args: invocation.args,
    json: invocation.json,
    confirmed: invocation.confirmed,
    dryRun: invocation.dryRun,
    fields: invocation.fields,
    forceVirtualHelp: invocation.virtualHelp,
    cwd: options.cwd,
    env: options.env,
    staticRootCommands: options.staticRootCommands,
  });
  await printAppRunResult(result, { json: invocation.json });
  if (!result.ok) process.exitCode = result.failure?.exitCode ?? result.exitCode ?? 1;
  return true;
}

export async function printAppRunResult(result: RaviAppRunResult, options: { json?: boolean } = {}): Promise<void> {
  if (options.json) {
    await writeJsonToStdout(result);
    return;
  }

  if (!result.ok) {
    console.error(result.error ?? "App operation failed.");
    return;
  }

  if (result.interface === "cli") {
    if (result.stdout?.trim())
      process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
    return;
  }

  if (result.handler === "apps.help" && printStructuredAppHelp(result.result)) return;

  if (result.operationId) {
    console.log(`${result.appId} ${result.operation ?? "help"} :: ${result.operationId}`);
  }
  if (result.result !== undefined) {
    console.log(JSON.stringify(result.result, null, 2));
  }
}

function resolveOperation(app: RaviAppManifestRecord, operationName: string | null): ResolvedOperation {
  const resolved = tryResolveOperation(app, operationName);
  if (resolved) return resolved;

  const appId = app.manifest?.id ?? app.id;
  throw operationError(
    "APP_OPERATION_NOT_FOUND",
    `Operation not found for app ${appId}: ${operationName}`,
    false,
    "input",
  );
}

function resolveOperationInvocation(
  app: RaviAppManifestRecord,
  operationName: string | null,
  args: string[],
): ResolvedOperationInvocation {
  if (!operationName) {
    return { resolved: resolveOperation(app, operationName), args };
  }

  const tokens = [operationName, ...args];
  const maxSegments = Math.min(tokens.length, maxOperationTokenSegments(app));

  for (let segmentCount = maxSegments; segmentCount >= 1; segmentCount--) {
    const candidate = tokens.slice(0, segmentCount).join(".");
    const resolved = tryResolveOperation(app, candidate);
    if (resolved) {
      return { resolved, args: tokens.slice(segmentCount) };
    }
  }

  return { resolved: resolveOperation(app, operationName), args };
}

function tryResolveOperation(app: RaviAppManifestRecord, operationName: string | null): ResolvedOperation | null {
  const appId = app.manifest?.id ?? app.id;
  const operationPrefix = appId.replace(/\//g, ".");
  const operations = manifestOperations(app);

  if (!operationName) {
    return virtualBuiltin(`${operationPrefix}.help`, "apps.help");
  }

  const direct = operations[operationName];
  if (isOperationDeclaration(direct)) return { id: operationName, operation: direct };

  const prefixedId = `${operationPrefix}.${operationName}`;
  const prefixed = operations[prefixedId];
  if (isOperationDeclaration(prefixed)) return { id: prefixedId, operation: prefixed };

  for (const [id, operation] of Object.entries(operations)) {
    if (!isOperationDeclaration(operation)) continue;
    if (Array.isArray(operation.aliases) && operation.aliases.includes(operationName)) {
      return { id, operation };
    }
  }

  if (operationName === "help") {
    return virtualBuiltin(`${operationPrefix}.help`, "apps.help");
  }
  if (operationName === "show") {
    return virtualBuiltin(`${operationPrefix}.show`, "apps.manifest.show");
  }
  if (operationName === "check") {
    return virtualBuiltin(`${operationPrefix}.check`, "apps.manifest.check");
  }
  if (operationName === "readiness") {
    return virtualBuiltin(`${operationPrefix}.readiness`, "apps.readiness");
  }

  return null;
}

function maxOperationTokenSegments(app: RaviAppManifestRecord): number {
  const appId = app.manifest?.id ?? app.id;
  let maxSegments = 1;
  for (const [id, operation] of Object.entries(manifestOperations(app))) {
    if (!isOperationDeclaration(operation)) continue;
    maxSegments = Math.max(maxSegments, localOperationName(appId, id).split(".").length);
    if (Array.isArray(operation.aliases)) {
      for (const alias of operation.aliases) {
        if (typeof alias === "string" && alias.trim()) {
          maxSegments = Math.max(maxSegments, alias.trim().split(".").length);
        }
      }
    }
  }
  return maxSegments;
}

async function dispatchResolvedOperation(
  app: RaviAppManifestRecord,
  resolved: ResolvedOperation,
  options: {
    args: string[];
    json: boolean;
    confirmed: boolean;
    dryRun: boolean;
    fields: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    staticRootCommands: Set<string>;
    startedAt: number;
  },
): Promise<RaviAppRunResult> {
  const appId = app.manifest?.id ?? app.id;
  const operation = resolved.operation;
  const interfaceName = operation.interface;
  const mutating = operation.mutating === true;
  const controls = parseOperationControls(options.args, {
    confirmed: options.confirmed,
    dryRun: options.dryRun,
    fields: options.fields,
  });

  if (isPermissionProviderOperation(app, resolved.id)) {
    throw new Error(
      `Operation ${resolved.id} is reserved for app permission provider decisions and cannot be run directly.`,
    );
  }
  if (operation.mutating === undefined) {
    throw operationError(
      "APP_MUTATION_CLASSIFICATION_REQUIRED",
      `Operation ${resolved.id} is blocked because mutating must be declared explicitly.`,
      false,
      "safety",
    );
  }
  if (mutating && !hasDeclaredOperationPermission(operation)) {
    throw operationError(
      "APP_MUTATION_SAFETY_UNDECLARED",
      `Mutating operation ${resolved.id} must declare permission or permissions.`,
      false,
      "safety",
    );
  }
  assertCanRunAppOperation(appId, resolved.id, mutating);
  assertMutationSafety(resolved, controls);
  const permissionProvider = await evaluateAppPermissionProvider(app, resolved, {
    args: controls.args,
    cwd: options.cwd,
    env: options.env,
  });

  if (interfaceName === "builtin") {
    const handler = operation.handler?.trim();
    if (!handler || !RAVI_APP_BUILTIN_OPERATION_HANDLERS.has(handler)) {
      throw new Error(`Unsupported builtin app operation handler: ${handler ?? "(missing)"}`);
    }
    const builtinResult = await runBuiltinHandler(handler, app, controls.args, {
      cwd: options.cwd,
      env: options.env,
    });
    const readinessFailed = handler === "apps.readiness" && isRecord(builtinResult) && builtinResult.ok !== true;
    const readinessError = readinessFailed
      ? {
          code: "APP_NOT_READY",
          message: `App ${appId} is not ready.`,
          retryable: true,
          category: "readiness" as const,
        }
      : null;
    const readinessFailure = readinessError ? operationDetailsToFailure(readinessError, "app") : null;
    return withPermissionProvider(
      applySelectedFields(
        {
          ok: !readinessFailed,
          appId,
          operation: localOperationName(appId, resolved.id),
          operationId: resolved.id,
          interface: "builtin",
          mutating,
          mutationClass: mutating ? "write" : "read",
          status: readinessFailed ? "failed" : "completed",
          durationMs: Date.now() - options.startedAt,
          handler,
          result: builtinResult,
          ...(readinessFailed
            ? {
                error: readinessFailure!.message,
                failure: readinessFailure!,
                errorDetails: readinessError!,
                exitCode: readinessFailure!.exitCode,
              }
            : {}),
        },
        controls.fields,
      ),
      permissionProvider,
    );
  }

  if (interfaceName === "cli") {
    if (!operation.command?.trim()) {
      throw new Error(`CLI operation ${resolved.id} is missing command.`);
    }
    if (isRecursiveCliCommand(appId, operation.command, options.staticRootCommands)) {
      throw new Error(`CLI operation ${resolved.id} recursively invokes ravi ${appId.split("/").join(" ")}.`);
    }
    return withPermissionProvider(
      await runCliOperation(app, resolved, { ...options, args: controls.args, fields: controls.fields }),
      permissionProvider,
    );
  }

  if (interfaceName === "stream") {
    return withPermissionProvider(
      applySelectedFields(
        {
          ok: true,
          appId,
          operation: localOperationName(appId, resolved.id),
          operationId: resolved.id,
          interface: "stream",
          mutating,
          mutationClass: mutating ? "write" : "read",
          status: "completed",
          durationMs: Date.now() - options.startedAt,
          channel: operation.channel,
          result: {
            channel: operation.channel,
            message: "Stream operations must be handled by a dedicated stream/control surface.",
          },
        },
        controls.fields,
      ),
      permissionProvider,
    );
  }

  throw new Error(`App operation interface is not supported by the CLI router yet: ${interfaceName}`);
}

function withPermissionProvider(
  result: RaviAppRunResult,
  permissionProvider: RaviAppPermissionProviderAudit | null,
): RaviAppRunResult {
  if (!permissionProvider) return result;
  return { ...result, permissionProvider };
}

async function runCliOperation(
  app: RaviAppManifestRecord,
  resolved: ResolvedOperation,
  options: {
    args: string[];
    json: boolean;
    fields: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    startedAt: number;
  },
): Promise<RaviAppRunResult> {
  const appId = app.manifest?.id ?? app.id;
  const command = renderCliCommand(resolved.operation.command ?? "", {
    appId,
    operationId: resolved.id,
    args: options.args,
  });
  const runtimeCommand = resolveRaviCliCommand(command);
  const appRoot = dirname(app.path);
  const safety = operationSafety(resolved.operation);
  const timeoutMs = resolved.operation.reliability?.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const configuredAttempts = resolved.operation.reliability?.maxAttempts ?? 1;
  const maxAttempts =
    resolved.operation.mutating !== true && safety?.idempotent === true
      ? Math.min(configuredAttempts, RAVI_APP_OPERATION_MAX_ATTEMPTS)
      : 1;
  const expectsJson = options.json || resolved.operation.json === true || /(^|\s)--json(\s|$)/.test(command);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = await spawnShellCommand(runtimeCommand, {
      cwd: appRoot,
      env: {
        ...options.env,
        RAVI_APP_ID: appId,
        RAVI_APP_OPERATION_ID: resolved.id,
        RAVI_APP_ROOT: appRoot,
      },
      capture: true,
      timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
    const parsedStdout = parseJsonOutput(run.stdout);
    const childFailure = classifyCliFailure(run, parsedStdout, expectsJson);

    if (!childFailure) {
      const outputSchemaFailure = validateOperationOutput(
        app,
        resolved,
        expectsJson ? parsedStdout : run.stdout.trim(),
      );
      if (outputSchemaFailure) {
        const failure = operationDetailsToFailure(outputSchemaFailure, "app");
        return {
          ok: false,
          appId,
          operation: localOperationName(appId, resolved.id),
          operationId: resolved.id,
          interface: "cli",
          mutating: resolved.operation.mutating === true,
          mutationClass: resolved.operation.mutating === true ? "write" : "read",
          status: "failed",
          durationMs: Date.now() - options.startedAt,
          attempts: attempt,
          timedOut: false,
          truncated: false,
          command,
          exitCode: failure.exitCode,
          error: failure.message,
          failure,
          errorDetails: outputSchemaFailure,
        };
      }
      return applySelectedFields(
        {
          ok: true,
          appId,
          operation: localOperationName(appId, resolved.id),
          operationId: resolved.id,
          interface: "cli",
          mutating: resolved.operation.mutating === true,
          mutationClass: resolved.operation.mutating === true ? "write" : "read",
          status: "completed",
          durationMs: Date.now() - options.startedAt,
          attempts: attempt,
          timedOut: false,
          truncated: false,
          command,
          exitCode: run.exitCode,
          stdout: run.stdout,
          stderr: run.stderr,
          result: expectsJson ? parsedStdout : run.stdout.trim(),
        },
        options.fields,
      );
    }

    if (attempt < maxAttempts && isTransientOperationFailure(childFailure)) {
      await waitBeforeRetry(childFailure, resolved.operation.reliability?.baseDelayMs ?? 250, attempt);
      continue;
    }

    const failure = extractChildFailure(parsedStdout, run.stderr) ?? operationDetailsToFailure(childFailure, "app");
    return {
      ok: false,
      appId,
      operation: localOperationName(appId, resolved.id),
      operationId: resolved.id,
      interface: "cli",
      mutating: resolved.operation.mutating === true,
      mutationClass: resolved.operation.mutating === true ? "write" : "read",
      status: "failed",
      durationMs: Date.now() - options.startedAt,
      attempts: attempt,
      timedOut: run.timedOut,
      truncated: run.truncated,
      command,
      exitCode: failure.exitCode,
      error: failure.message,
      failure,
      errorDetails: childFailure,
    };
  }

  throw operationError("APP_OPERATION_FAILED", `Operation ${resolved.id} ended without a result.`);
}

async function runBuiltinHandler(
  handler: string,
  app: RaviAppManifestRecord,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  if (handler === "apps.help") {
    if (args.length > 0) return operationHelpResult(app, args);
    const operationIds = visibleOperationIdsForHelp(app);
    return {
      app: toSummary(app),
      operations: operationIds,
      nextCommands: [
        `ravi ${app.id.split("/").join(" ")} --help`,
        `ravi ${app.id.split("/").join(" ")} check --json`,
        `ravi apps show ${app.id} --json`,
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
  if (handler === "apps.readiness") {
    return runAppReadiness(app, args, options);
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

async function runAppReadiness(
  app: RaviAppManifestRecord,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<Record<string, unknown>> {
  const health = isRecord(app.manifest?.health) ? app.manifest.health : null;
  const checks = health && Array.isArray(health.checks) ? health.checks : [];
  if (checks.length === 0) {
    return {
      ok: false,
      appId: app.id,
      status: "unknown",
      checkedAt: new Date().toISOString(),
      checked: 0,
      executed: 0,
      durationMs: 0,
      checks: [],
    };
  }

  const appRoot = dirname(app.path);
  const results: Array<Record<string, unknown>> = [];
  const startedAt = Date.now();
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    const checkStartedAt = Date.now();
    if (!isRecord(check)) {
      results.push(unsafeReadinessCheck(index, null, true, "Readiness check must be an object."));
      continue;
    }
    const id = typeof check.id === "string" && check.id.trim() ? check.id.trim() : null;
    const required = typeof check.required === "boolean" ? check.required : true;
    if (!id || check.sideEffectFree !== true || typeof check.required !== "boolean") {
      results.push(
        unsafeReadinessCheck(
          index,
          id,
          required,
          "Readiness check requires id, required, and sideEffectFree=true before it can execute.",
        ),
      );
      continue;
    }
    if (check.type === "builtin" && check.handler === "apps.manifest.check") {
      results.push({
        index,
        id,
        type: "builtin",
        handler: check.handler,
        required,
        ok: app.valid,
        status: app.valid ? "passed" : "failed",
        durationMs: Date.now() - checkStartedAt,
        ...(app.valid ? {} : { error: app.errors.join("; ") }),
      });
      continue;
    }
    if (check.type === "cli" && typeof check.command === "string") {
      const command = renderCliCommand(check.command, {
        appId: app.id,
        operationId: `${app.id.replace(/\//g, ".")}.readiness`,
        args,
      });
      const run = await spawnShellCommand(resolveRaviCliCommand(command), {
        cwd: appRoot,
        env: {
          ...options.env,
          RAVI_APP_ID: app.id,
          RAVI_APP_OPERATION_ID: `${app.id.replace(/\//g, ".")}.readiness`,
          RAVI_APP_ROOT: appRoot,
        },
        capture: true,
        timeoutMs: typeof check.timeoutMs === "number" ? check.timeoutMs : DEFAULT_READINESS_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      });
      const parsed = parseJsonOutput(run.stdout);
      const failure = classifyCliFailure(run, parsed, true);
      results.push({
        index,
        id,
        type: "cli",
        command,
        required,
        ok: failure === null && isRecord(parsed) && parsed.ok === true,
        status: run.timedOut
          ? "timed_out"
          : failure === null && isRecord(parsed) && parsed.ok === true
            ? "passed"
            : "failed",
        durationMs: Date.now() - checkStartedAt,
        timedOut: run.timedOut,
        ...(failure
          ? { error: failure.message, errorDetails: failure }
          : isRecord(parsed) && parsed.ok === true
            ? { result: parsed }
            : {
                error: "Readiness command must return a JSON object with ok=true.",
                errorDetails: {
                  code: "APP_READINESS_INVALID_RESULT",
                  message: "Readiness command must return a JSON object with ok=true.",
                  retryable: false,
                  category: "readiness",
                },
              }),
      });
      continue;
    }
    results.push(unsafeReadinessCheck(index, id, required, "Readiness check type or handler is not supported."));
  }

  const requiredFailures = results.filter((entry) => entry.required === true && entry.ok !== true);
  const optionalFailures = results.filter((entry) => entry.required === false && entry.ok !== true);
  const hasSkippedRequired = requiredFailures.some((entry) => entry.status === "skipped");
  const status =
    requiredFailures.length > 0
      ? hasSkippedRequired
        ? "unknown"
        : "not_ready"
      : optionalFailures.length > 0
        ? "degraded"
        : "ready";
  const ok = status === "ready" || status === "degraded";
  return {
    ok,
    appId: app.id,
    status,
    checkedAt: new Date().toISOString(),
    checked: results.length,
    executed: results.filter((entry) => entry.status !== "skipped").length,
    durationMs: Date.now() - startedAt,
    checks: results,
  };
}

function unsafeReadinessCheck(
  index: number,
  id: string | null,
  required: boolean,
  message: string,
): Record<string, unknown> {
  return {
    index,
    id,
    required,
    ok: false,
    status: "skipped",
    durationMs: 0,
    error: message,
    errorDetails: {
      code: "APP_READINESS_UNDECLARED",
      message,
      retryable: false,
      category: "readiness",
    },
  };
}

function operationHelpResult(app: RaviAppManifestRecord, args: string[]): Record<string, unknown> {
  const [operationName, ...operationArgs] = args;
  if (!operationName) throw new Error(`Missing operation name for app help: ${app.id}`);
  const invocation = resolveOperationInvocation(app, operationName, operationArgs);
  if (invocation.args.length > 0) {
    throw new Error(
      `Unexpected argument(s) after app operation ${localOperationName(app.id, invocation.resolved.id)}: ${invocation.args.join(" ")}`,
    );
  }
  if (isPermissionProviderOperation(app, invocation.resolved.id)) {
    throw new Error(`Operation not found for app ${app.id}: ${args.join(" ")}`);
  }
  const operation = invocation.resolved.operation;
  const help = operation.help;
  if (!isRecord(help)) {
    throw new Error(
      `Operation ${invocation.resolved.id} has no structured help. Run: ravi apps check ${app.id} --json`,
    );
  }
  return {
    app: toSummary(app),
    operation: {
      id: invocation.resolved.id,
      name: localOperationName(app.id, invocation.resolved.id),
      interface: operation.interface,
      mutating: operation.mutating === true,
      permission: operation.permission ?? null,
      permissions: operation.permissions ?? [],
      safety: operationSafety(operation),
      help: compactOperationHelp(help),
    },
  };
}

function compactOperationHelp(help: Record<string, unknown>): Record<string, unknown> {
  return {
    summary: boundedHelpText(help.summary, 500),
    usage: boundedHelpText(help.usage, 500),
    arguments: compactHelpEntries(help.arguments, 50),
    options: compactHelpEntries(help.options, 50),
    examples: Array.isArray(help.examples)
      ? help.examples
          .filter((value): value is string => typeof value === "string")
          .slice(0, 10)
          .map((value) => boundedHelpText(value, 500))
      : [],
  };
}

function compactHelpEntries(value: unknown, limit: number): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const compact: Record<string, unknown> = {};
    for (const key of ["name", "flags", "description", "required", "value", "defaultValue", "values"]) {
      const item = entry[key];
      if (typeof item === "string") compact[key] = boundedHelpText(item, 500);
      else if (typeof item === "boolean" || typeof item === "number" || item === null) compact[key] = item;
      else if (Array.isArray(item))
        compact[key] = item.slice(0, 50).filter((candidate) => typeof candidate === "string");
    }
    return [compact];
  });
}

function boundedHelpText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function printStructuredAppHelp(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isRecord(value.operation) && isRecord(value.operation.help)) {
    const operation = value.operation;
    const help = operation.help as Record<string, unknown>;
    const usage = typeof help.usage === "string" ? help.usage : null;
    const summary = typeof help.summary === "string" ? help.summary : null;
    if (!usage || !summary) return false;
    console.log(`Usage: ${usage}`);
    console.log(`\n${summary}`);
    if (Array.isArray(help.options) && help.options.length > 0) {
      console.log("\nOPTIONS");
      for (const option of help.options) {
        if (!isRecord(option) || typeof option.flags !== "string") continue;
        console.log(`  ${option.flags}${typeof option.description === "string" ? `  ${option.description}` : ""}`);
      }
    }
    const safety = isRecord(operation.safety) ? operation.safety : null;
    if (safety) {
      console.log("\nSAFETY");
      console.log(`  ${operation.mutating === true ? "mutating" : "read-only"}`);
      console.log(`  confirmation: ${safety.confirmationRequired === true ? "required" : "not required"}`);
      console.log(`  dry-run: ${safety.dryRunSupported === true ? "supported" : "not supported"}`);
    }
    return true;
  }

  if (!isRecord(value.app) || !Array.isArray(value.operations)) return false;
  const app = value.app;
  console.log(`${typeof app.name === "string" ? app.name : (app.id ?? "Ravi App")}`);
  if (typeof app.description === "string") console.log(app.description);
  console.log("\nOperations:");
  for (const operation of value.operations) {
    if (typeof operation === "string") console.log(`  ${localOperationName(String(app.id ?? ""), operation)}`);
  }
  return true;
}

function manifestOperations(app: RaviAppManifestRecord): Record<string, unknown> {
  const operations = app.manifest?.operations;
  return operations && typeof operations === "object" && !Array.isArray(operations)
    ? (operations as Record<string, unknown>)
    : {};
}

function visibleOperationIdsForHelp(app: RaviAppManifestRecord): string[] {
  return Object.keys(manifestOperations(app))
    .filter((id) => !isPermissionProviderOperation(app, id))
    .sort();
}

function isPermissionProviderOperation(app: RaviAppManifestRecord, operationId: string): boolean {
  return app.permissions.provider?.operation === operationId;
}

function virtualBuiltin(id: string, handler: string): ResolvedOperation {
  return {
    id,
    operation: {
      interface: "builtin",
      handler,
      mutating: false,
    },
  };
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

function operationSafety(operation: RaviAppOperationDeclaration): RaviAppOperationSafetyDeclaration | null {
  return isSafetyDeclaration(operation.safety) ? operation.safety : null;
}

function isSafetyDeclaration(value: unknown): value is RaviAppOperationSafetyDeclaration {
  return (
    isRecord(value) &&
    typeof value.idempotent === "boolean" &&
    typeof value.dryRunSupported === "boolean" &&
    typeof value.confirmationRequired === "boolean"
  );
}

function assertMutationSafety(resolved: ResolvedOperation, controls: OperationControls): void {
  if (resolved.operation.mutating !== true) return;
  const safety = operationSafety(resolved.operation);
  if (!safety) {
    throw operationError(
      "APP_MUTATION_SAFETY_UNDECLARED",
      `Mutating operation ${resolved.id} is blocked because its safety contract is missing.`,
      false,
      "safety",
    );
  }
  if (controls.dryRun) {
    if (!safety.dryRunSupported) {
      throw operationError(
        "APP_DRY_RUN_UNSUPPORTED",
        `Operation ${resolved.id} does not support --dry-run.`,
        false,
        "safety",
      );
    }
    return;
  }
  if (safety.liveExecution === false) {
    throw operationError(
      "APP_LIVE_EXECUTION_DISABLED",
      `Live execution is disabled for ${resolved.id}; use --dry-run.`,
      false,
      "safety",
    );
  }
  if (safety.confirmationRequired !== true || !controls.confirmed) {
    throw operationError(
      "APP_CONFIRMATION_REQUIRED",
      `Operation ${resolved.id} requires explicit --yes or a supported --dry-run.`,
      false,
      "safety",
    );
  }
}

function parseOperationControls(
  argv: string[],
  explicit: { confirmed: boolean; dryRun: boolean; fields: string[] },
): OperationControls {
  let confirmed = explicit.confirmed;
  let dryRun = explicit.dryRun;
  const fields = [...explicit.fields];
  const args: string[] = [];
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (passthrough) {
      args.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--yes") {
      confirmed = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--fields") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw fieldsError("--fields requires a comma-separated field list.");
      }
      fields.push(...value.split(","));
      index += 1;
      continue;
    }
    if (arg.startsWith("--fields=")) {
      fields.push(...arg.slice("--fields=".length).split(","));
      continue;
    }
    args.push(arg);
  }
  if (dryRun) args.push("--dry-run");
  return { args, confirmed, dryRun, fields: normalizeFields(fields) };
}

function normalizeFields(values: string[]): string[] {
  const fields = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  if (
    fields.length > 50 ||
    fields.some((field) => !/^[A-Za-z0-9_-]+(?:\[\])?(?:\.[A-Za-z0-9_-]+(?:\[\])?)*$/.test(field))
  ) {
    throw fieldsError("--fields accepts at most 50 comma-separated dotted field paths.");
  }
  return fields;
}

function applySelectedFields(result: RaviAppRunResult, fields: string[]): RaviAppRunResult {
  if (fields.length === 0 || result.result === undefined) return result;
  return { ...result, result: projectFields(result.result, fields), selectedFields: fields };
}

function projectFields(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (!isRecord(item)) {
        throw fieldsError(`--fields requires object items; item ${index} is not an object.`);
      }
      return projectObjectFields(item, fields);
    });
  }
  if (!isRecord(value)) {
    throw fieldsError("--fields requires an object or array-of-objects result.");
  }
  return projectObjectFields(value, fields);
}

function projectObjectFields(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    mergeProjectedValue(projected, projectFieldPath(value, field.split("."), field));
  }
  return projected;
}

function projectFieldPath(value: unknown, segments: string[], field: string): Record<string, unknown> {
  if (!isRecord(value)) throw fieldsError(`Requested field does not exist: ${field}`);
  const rawSegment = segments[0]!;
  const arraySegment = rawSegment.endsWith("[]");
  const key = arraySegment ? rawSegment.slice(0, -2) : rawSegment;
  if (!(key in value)) throw fieldsError(`Requested field does not exist: ${field}`);
  const child = value[key];
  const remaining = segments.slice(1);
  if (arraySegment) {
    if (!Array.isArray(child)) throw fieldsError(`Requested field is not an array: ${key}`);
    return {
      [key]: child.map((item) => (remaining.length === 0 ? item : projectFieldPath(item, remaining, field))),
    };
  }
  return { [key]: remaining.length === 0 ? child : projectFieldPath(child, remaining, field) };
}

function mergeProjectedValue(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isRecord(current) && isRecord(value)) {
      mergeProjectedValue(current, value);
      continue;
    }
    if (Array.isArray(current) && Array.isArray(value)) {
      target[key] = value.map((item, index) => {
        const existing = current[index];
        if (isRecord(existing) && isRecord(item)) {
          const merged = { ...existing };
          mergeProjectedValue(merged, item);
          return merged;
        }
        return item;
      });
      continue;
    }
    target[key] = value;
  }
}

function classifyCliFailure(
  run: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean },
  parsedStdout: unknown,
  expectsJson: boolean,
): RaviAppOperationErrorDetails | null {
  if (run.timedOut) {
    return { code: "APP_TIMEOUT", message: "App operation timed out.", retryable: true, category: "timeout" };
  }
  if (run.truncated) {
    return {
      code: "APP_OUTPUT_TRUNCATED",
      message: "App operation exceeded the output limit.",
      retryable: false,
      category: "adapter",
    };
  }
  if (run.exitCode === 0 && expectsJson && parsedStdout === undefined) {
    return {
      code: "APP_INVALID_JSON",
      message: "App operation promised JSON but returned invalid JSON.",
      retryable: false,
      category: "adapter",
    };
  }
  if (isRecord(parsedStdout) && parsedStdout.ok === false) {
    return childErrorDetails(parsedStdout, "App operation returned ok=false.");
  }
  if (run.exitCode === 0) return null;
  const parsedStderr = parseJsonOutput(run.stderr);
  if (isRecord(parsedStderr)) return childErrorDetails(parsedStderr, `Command exited with code ${run.exitCode}`);
  if (isRecord(parsedStdout)) return childErrorDetails(parsedStdout, `Command exited with code ${run.exitCode}`);
  return {
    code: "APP_CHILD_EXIT",
    message: publicChildFailureMessage("APP_CHILD_EXIT"),
    retryable: false,
    category: "adapter",
  };
}

function childErrorDetails(payload: Record<string, unknown>, fallbackMessage: string): RaviAppOperationErrorDetails {
  const canonical = parseRaviAppFailure(payload.failure);
  if (canonical) {
    return {
      code: canonical.code,
      message: publicChildFailureMessage(canonical.code),
      retryable: canonical.retryable,
      category: failureCategoryToOperationCategory(canonical.category),
      ...(canonical.details?.httpStatus !== undefined ? { httpStatus: canonical.details.httpStatus } : {}),
      ...(canonical.details?.retryAfterSeconds !== undefined
        ? { retryAfterMs: canonical.details.retryAfterSeconds * 1000 }
        : {}),
    };
  }
  const nested = isRecord(payload.errorDetails) ? payload.errorDetails : isRecord(payload.error) ? payload.error : null;
  const code = nested && typeof nested.code === "string" ? nested.code : "APP_CHILD_EXIT";
  return {
    code,
    message: publicChildFailureMessage(code, fallbackMessage),
    retryable: nested?.retryable === true,
    category: "adapter",
    ...(nested && typeof nested.httpStatus === "number" ? { httpStatus: nested.httpStatus } : {}),
    ...(nested && typeof nested.vendorCode === "string" ? { vendorCode: nested.vendorCode } : {}),
    ...(nested && typeof nested.retryAfterMs === "number" ? { retryAfterMs: nested.retryAfterMs } : {}),
    ...(nested && typeof nested.requestId === "string" ? { requestId: nested.requestId } : {}),
  };
}

function publicChildFailureMessage(code: string, fallback = "App operation failed."): string {
  switch (code) {
    case "APP_CHILD_EXIT":
      return "App operation exited with a non-zero status.";
    default:
      return fallback.startsWith("Command exited with code ") ? "App operation failed." : fallback;
  }
}

function extractChildFailure(stdout: unknown, stderr: string): RaviAppFailure | null {
  if (isRecord(stdout)) {
    const parsed = parseRaviAppFailure(stdout.failure);
    if (parsed) return sanitizeChildFailure(parsed);
  }
  const parsedStderr = parseJsonOutput(stderr);
  const parsed = isRecord(parsedStderr) ? parseRaviAppFailure(parsedStderr.failure) : null;
  return parsed ? sanitizeChildFailure(parsed) : null;
}

function operationDetailsToFailure(details: RaviAppOperationErrorDetails, source: "router" | "app"): RaviAppFailure {
  const category = operationFailureCategory(details);
  const message = source === "app" ? publicChildFailureMessage(details.code) : details.message;
  return toRaviAppFailure(
    new RaviAppFailureError({
      code: details.code,
      category,
      message,
      retryable: details.retryable,
      details: {
        source,
        ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
        ...(details.retryAfterMs !== undefined ? { retryAfterSeconds: details.retryAfterMs / 1000 } : {}),
      },
    }),
    { code: details.code, message, source },
  );
}

function sanitizeChildFailure(failure: RaviAppFailure): RaviAppFailure {
  return {
    ...failure,
    message: publicChildFailureMessage(failure.code),
  };
}

function operationFailureCategory(details: RaviAppOperationErrorDetails): RaviAppFailureCategory {
  if (details.code === "APP_OPERATION_NOT_FOUND") return "not_found";
  if (details.httpStatus === 401) return "authentication";
  if (details.httpStatus === 403) return "authorization";
  if (details.httpStatus === 429) return "rate_limit";
  if (details.httpStatus !== undefined && details.httpStatus >= 500) return "upstream";
  switch (details.category) {
    case "input":
      return "validation";
    case "authorization":
    case "safety":
      return "authorization";
    case "timeout":
      return "timeout";
    case "dependency":
    case "readiness":
      return "upstream";
    case "adapter":
      return details.code === "APP_CHILD_EXIT" ? "execution" : "protocol";
    default:
      return "execution";
  }
}

function failureCategoryToOperationCategory(
  category: RaviAppFailureCategory,
): RaviAppOperationErrorDetails["category"] {
  switch (category) {
    case "validation":
    case "not_found":
      return "input";
    case "authentication":
    case "authorization":
      return "authorization";
    case "timeout":
      return "timeout";
    case "rate_limit":
    case "upstream":
      return "dependency";
    case "protocol":
      return "adapter";
    default:
      return "internal";
  }
}

function isTransientOperationFailure(error: RaviAppOperationErrorDetails): boolean {
  if (error.retryable !== true) return false;
  if (error.code === "APP_TIMEOUT") return true;
  return error.httpStatus === 429 || error.httpStatus === 502 || error.httpStatus === 503 || error.httpStatus === 504;
}

function validateOperationOutput(
  app: RaviAppManifestRecord,
  resolved: ResolvedOperation,
  output: unknown,
): RaviAppOperationErrorDetails | null {
  const declaration = resolved.operation.outputSchema;
  if (declaration === undefined) return null;

  try {
    const schema = loadOperationOutputSchema(app, declaration);
    const validate = addFormats(new Ajv2020({ allErrors: true, strict: true })).compile(schema);
    if (validate(output)) return null;
    return {
      code: "APP_OUTPUT_SCHEMA_MISMATCH",
      message: `Operation ${resolved.id} returned a result that does not match outputSchema.`,
      retryable: false,
      category: "adapter",
      details: {
        errors: (validate.errors ?? []).slice(0, 20).map((error: ErrorObject) => ({
          instancePath: error.instancePath,
          keyword: error.keyword,
          message: error.message ?? "schema validation failed",
        })),
      },
    };
  } catch (error) {
    return {
      code: "APP_OUTPUT_SCHEMA_UNAVAILABLE",
      message: `Operation ${resolved.id} outputSchema could not be loaded or compiled.`,
      retryable: false,
      category: "adapter",
      details: { reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

function loadOperationOutputSchema(app: RaviAppManifestRecord, declaration: unknown): Record<string, unknown> {
  if (isRecord(declaration)) return declaration;
  if (typeof declaration !== "string" || !declaration.trim()) {
    throw new Error("outputSchema must be an inline JSON Schema object or a relative file reference.");
  }

  const appRoot = resolve(dirname(app.path));
  const schemaPath = resolve(appRoot, declaration);
  if (schemaPath !== appRoot && !schemaPath.startsWith(`${appRoot}${sep}`)) {
    throw new Error("outputSchema reference escapes the app root.");
  }
  if (!existsSync(schemaPath)) throw new Error(`outputSchema file not found: ${declaration}`);
  const parsed = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("outputSchema file must contain a JSON object.");
  return parsed;
}

async function waitBeforeRetry(
  error: RaviAppOperationErrorDetails,
  baseDelayMs: number,
  attempt: number,
): Promise<void> {
  const delayMs = Math.min(error.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1), 30_000);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function operationError(
  code: string,
  message: string,
  retryable = false,
  category: RaviAppOperationErrorDetails["category"] = "internal",
): RaviAppOperationError {
  return new RaviAppOperationError({ code, message, retryable, category });
}

function fieldsError(message: string): RaviAppOperationError {
  return operationError("APP_FIELDS_INVALID", message, false, "input");
}

function toOperationErrorDetails(error: unknown): RaviAppOperationErrorDetails {
  if (error instanceof RaviAppOperationError) return error.details;
  if (error instanceof AppPermissionProviderDeniedError) {
    return {
      code: "APP_PERMISSION_PROVIDER_DENIED",
      message: error.message,
      retryable: false,
      category: "authorization",
      details: { reasonCode: error.audit.reasonCode },
    };
  }
  return {
    code: "APP_OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    category: "internal",
  };
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

function stripRouterFlags(argv: string[]): {
  json: boolean;
  help: boolean;
  confirmed: boolean;
  dryRun: boolean;
  fields: string[];
  args: string[];
} {
  let json = false;
  let help = false;
  let confirmed = false;
  let dryRun = false;
  const fields: string[] = [];
  const args: string[] = [];
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (passthrough) {
      args.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      args.push(arg);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--yes") {
      confirmed = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--fields") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw fieldsError("--fields requires a comma-separated field list.");
      }
      fields.push(...value.split(","));
      index += 1;
      continue;
    }
    if (arg.startsWith("--fields=")) {
      fields.push(...arg.slice("--fields=".length).split(","));
      continue;
    }
    args.push(arg);
  }
  return { json, help, confirmed, dryRun, fields: normalizeFields(fields), args };
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

export function resolveRaviCliCommand(
  command: string,
  runtime: { execPath?: string; entrypoint?: string } = {},
): string {
  if (!/^\s*ravi(?=\s|$)/.test(command)) return command;
  const execPath = runtime.execPath ?? process.execPath;
  const entrypoint = runtime.entrypoint ?? process.argv[1];
  if (!execPath?.trim() || !entrypoint?.trim()) return command;
  const selfInvocation = `${quoteShellArg(execPath)} ${quoteShellArg(resolve(entrypoint))}`;
  return command.replace(/^\s*ravi(?=\s|$)/, selfInvocation);
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
      detached: process.platform !== "win32",
      stdio: options.capture ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let forceKill: ReturnType<typeof setTimeout> | null = null;
    const maxOutputBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    const timeout =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            terminateChildProcess(child.pid, "SIGTERM", () => child.kill("SIGTERM"));
            forceKill = setTimeout(
              () => terminateChildProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL")),
              1_000,
            );
          }, options.timeoutMs);
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        const next = appendOutputChunk(stdout, String(chunk), maxOutputBytes);
        stdout = next.value;
        if (next.truncated) {
          truncated = true;
          terminateChildProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
          return;
        }
      });
      child.stderr?.on("data", (chunk) => {
        const next = appendOutputChunk(stderr, String(chunk), maxOutputBytes);
        stderr = next.value;
        if (next.truncated) {
          truncated = true;
          terminateChildProcess(child.pid, "SIGKILL", () => child.kill("SIGKILL"));
          return;
        }
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin ?? "");
    }
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    });
  });
}

function terminateChildProcess(pid: number | undefined, signal: NodeJS.Signals, fallback: () => void): void {
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  }
  try {
    fallback();
  } catch {}
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localOperationName(appId: string, operationId: string): string {
  const prefix = `${appId.replace(/\//g, ".")}.`;
  return operationId.startsWith(prefix) ? operationId.slice(prefix.length) : operationId;
}

function mergeStaticRootCommands(staticRootCommands?: Set<string>): Set<string> {
  return new Set([...(staticRootCommands ?? []), ...DEFAULT_STATIC_ROOT_COMMANDS]);
}

function isRecursiveCliCommand(appId: string, command: string, staticRootCommands: Set<string>): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "ravi") return false;
  const first = tokens[1];
  if (!first || staticRootCommands.has(first)) return false;
  if (first === appId) return true;

  const appSegments = appId.split("/");
  return appSegments.every((segment, index) => tokens[index + 1] === segment);
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
