import { AppError as OmieAppError } from "./omie-orders/domain.js";
import { omieDelegation } from "./omie-orders/delegation.js";
import { OMIE_APP_ID } from "./omie-orders/scope.js";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { discoverAppManifests, getAppManifest, RAVI_APP_BUILTIN_OPERATION_HANDLERS } from "./service.js";
import {
  buildRaviAppProcessEnv,
  parseRaviAppCapability,
  resolveRaviAppCommand,
  tokenizeRaviAppCommand,
} from "./command.js";
import type {
  RaviAppAliasInvocation,
  RaviAppManifestRecord,
  RaviAppOperationDeclaration,
  RaviAppPermissionProviderAudit,
  RaviAppRunOptions,
  RaviAppRunResult,
} from "./types.js";
import { RaviAppError } from "./types.js";
import { runWithCliAudit } from "../cli/audit.js";
import { getContext } from "../cli/context.js";
import {
  AppPermissionProviderDeniedError,
  canWithCapabilityContext,
  evaluateAppPermissionProvider,
} from "../permissions/provider-runtime.js";
import {
  getRuntimeContextFromEnv,
  issueRuntimeContext,
  revokeRuntimeContext,
  type IssueRuntimeContextInput,
} from "../runtime/context-registry.js";
import { dbGetContext, type ContextRecord } from "../router/router-db.js";
import {
  assertCanRunAppOperation,
  assertCanUseApp,
  filterVisibleAppManifests,
  RaviAppPermissionDeniedError,
} from "./permissions.js";
import { enforceRaviAppRunResult } from "./error-contract.js";
import { maskedSecretForms, projectAppCliFailure } from "./failure.js";
import {
  RaviAppCompositionError,
  callerOf,
  assertOperationProvided,
  composedContextAllow,
  declaresProvides,
  declaresRequires,
  describeUnavailableDependency,
  participatesInComposition,
  resolveDependencyClosure,
} from "./composition.js";
import { logger } from "../utils/logger.js";

interface ResolvedOperation {
  id: string;
  operation: RaviAppOperationDeclaration;
}

interface ResolvedOperationInvocation {
  resolved: ResolvedOperation;
  args: string[];
}

const DEFAULT_STATIC_ROOT_COMMANDS = new Set(["apps"]);

const log = logger.child("apps-router");

/**
 * What composition changes about one CLI run. An app that does not offer or need a service gets the default: its own
 * `context.allow`, and a credential that lives until its TTL, exactly as before composition existed.
 */
interface CompositionPlan {
  /** The capabilities for the child context, when they are more than the app's own `context.allow`. */
  allow?: string[];
  /** The service another app called this one through, and that app. Recorded on the child context. */
  service?: string;
  callerAppId?: string;
  /** The child credential is revoked when the process ends. */
  operationScoped: boolean;
}

export async function runAppOperation(options: RaviAppRunOptions): Promise<RaviAppRunResult> {
  const startedAt = Date.now();
  const operationName = options.operation?.trim() || null;
  const callerContext = resolveCallerContext(options.env);
  let result: RaviAppRunResult;

  try {
    assertCanUseApp(options.appId);
    const app = getAppManifest(options.appId, options);
    if (!app.valid) {
      throw new Error(`App manifest is invalid: ${app.errors.join("; ")}`);
    }
    if (!app.manifest) {
      throw new Error(`App manifest is missing for ${app.id}`);
    }

    const invocation = resolveOperationInvocation(app, operationName, options.args ?? []);
    result = await dispatchResolvedOperation(app, invocation.resolved, {
      args: invocation.args,
      json: options.json === true,
      cwd: options.cwd,
      env: options.env,
      staticRootCommands: mergeStaticRootCommands(options.staticRootCommands),
      runtime: options.runtime,
      callerContext,
      startedAt,
      execute: options.execute === true,
    });
  } catch (error) {
    const errorCode = classifyAppRunError(error);
    const message =
      errorCode === "not_found"
        ? "Ravi app was not found."
        : errorCode === "PERMISSION_DENIED"
          ? "Ravi app operation was denied."
          : errorCode === "APP_PERMISSION_PROVIDER_FAILED"
            ? "Ravi app permission provider failed."
            : errorCode === "APP_DEPENDENCY_UNAVAILABLE"
              ? "Ravi app dependency is unavailable."
              : errorCode === "APP_OPERATION_NOT_PROVIDED"
                ? "Ravi app operation is not offered to this caller."
                : "Ravi app operation failed.";
    result = {
      ok: false,
      appId: options.appId,
      operation: operationName,
      operationId: null,
      interface: null,
      mutating: false,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: message,
      errorCode,
      ...(callerContext ? { callerContextId: callerContext.contextId } : {}),
      ...(error instanceof AppPermissionProviderDeniedError ? { permissionProvider: error.audit } : {}),
      ...(error instanceof OmieAppError && error.exitCode === 2 ? { usageError: true as const } : {}),
      ...(error instanceof RaviAppCompositionError && error.unavailable.length > 0
        ? { unavailableDependencies: error.unavailable }
        : {}),
    };
  }

  return result;
}

function classifyAppRunError(error: unknown): string {
  if (error instanceof RaviAppError) return error.code;
  if (error instanceof RaviAppCompositionError) return error.code;
  if (error instanceof OmieAppError && /^(OMIE_[A-Z0-9_]+|INVALID_INPUT)$/.test(error.code)) return error.code;
  if (error instanceof RaviAppPermissionDeniedError) return "PERMISSION_DENIED";
  if (error instanceof AppPermissionProviderDeniedError) {
    return ["deny", "needs_grant", "not_applicable"].includes(error.audit.decision)
      ? "PERMISSION_DENIED"
      : "APP_PERMISSION_PROVIDER_FAILED";
  }
  return "APP_OPERATION_FAILED";
}

export function resolveAppAliasInvocation(
  argv: string[],
  options: {
    staticRootCommands?: Set<string>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Name the app without asking the local permission store which apps this
     * caller may use. A process that carries a runtime context only rewrites
     * the alias into `apps run`; the gateway (the daemon that owns the context)
     * authorizes that run. The local store is real state, which such a process
     * may not open (`REAL_STATE_ACCESS_REFUSED`).
     */
    skipVisibility?: boolean;
  } = {},
): RaviAppAliasInvocation | null {
  if (argv.length === 0) return null;
  const first = argv[0];
  if (!first || first.startsWith("-")) return null;
  if (mergeStaticRootCommands(options.staticRootCommands).has(first)) return null;

  const discovered = discoverAppManifests({ cwd: options.cwd, env: options.env });
  const appIds = new Set(
    (options.skipVisibility === true ? discovered : filterVisibleAppManifests(discovered))
      .map((record) => record.manifest?.id ?? record.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const maxSegments = Math.min(argv.length, Math.max(1, ...Array.from(appIds, (id) => id.split("/").length)));

  for (let segmentCount = maxSegments; segmentCount >= 1; segmentCount--) {
    const candidate = argv.slice(0, segmentCount).join("/");
    if (!appIds.has(candidate)) continue;
    const rest = argv.slice(segmentCount);
    const { json, help, execute, args } = stripRouterFlags(rest);
    const operation = help ? "help" : args[0];
    return {
      appId: candidate,
      operation,
      args: help ? args : operation ? args.slice(1) : args,
      json,
      ...(execute ? { execute: true } : {}),
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

  await runWithCliAudit(
    {
      group: "apps",
      name: "run",
      tool: "apps_run",
      input: {
        appId: invocation.appId,
        operation: invocation.operation,
        json: invocation.json,
        execute: invocation.execute === true,
        argumentCount: invocation.args.length,
      },
      closeLazyConnection: true,
    },
    async () => {
      const result = await runAppOperation({
        appId: invocation.appId,
        operation: invocation.operation,
        args: invocation.args,
        json: invocation.json,
        execute: invocation.execute === true,
        cwd: options.cwd,
        env: options.env,
        staticRootCommands: options.staticRootCommands,
      });
      enforceRaviAppRunResult(result, invocation.json);
      printAppRunResult(result, { json: invocation.json });
    },
  );
  return true;
}

export function printAppRunResult(result: RaviAppRunResult, options: { json?: boolean } = {}): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.ok) {
    console.error(result.error ?? "App operation failed.");
    return;
  }

  if (result.interface === "cli") {
    return;
  }

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
  throw new Error(`Operation not found for app ${appId}: ${operationName}`);
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
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    staticRootCommands: Set<string>;
    runtime?: RaviAppRunOptions["runtime"];
    callerContext?: ContextRecord;
    startedAt: number;
    execute: boolean;
  },
): Promise<RaviAppRunResult> {
  const appId = app.manifest?.id ?? app.id;
  const operation = resolved.operation;
  const interfaceName = operation.interface;
  const mutating = operation.mutating === true;

  if (isPermissionProviderOperation(app, resolved.id)) {
    throw new Error(
      `Operation ${resolved.id} is reserved for app permission provider decisions and cannot be run directly.`,
    );
  }
  if (mutating && !hasDeclaredOperationPermission(operation)) {
    throw new Error(`Mutating operation ${resolved.id} must declare permission or permissions.`);
  }
  // Composition (spec apps/router): another app may call an app that offers services only through them, and an app
  // that needs services runs only when they are there. Both read the manifests and start nothing, so they sit before
  // anything with a side effect. Apps that neither offer nor need a service do not discover anything here.
  const records = lazyManifests(options);
  const calledThrough = assertCallerMayCall(app, resolved.id, options.callerContext, records);
  assertCanRunAppOperation(appId, resolved.id, mutating);
  const composition = planComposition(app, interfaceName, calledThrough, records, options.callerContext);
  if (mutating && !options.execute) {
    return {
      ok: false,
      appId,
      operation: localOperationName(appId, resolved.id),
      operationId: resolved.id,
      interface: interfaceName,
      mutating: true,
      status: "blocked",
      durationMs: Date.now() - options.startedAt,
      dryRun: true,
      plan: {
        appId,
        operationId: resolved.id,
        interface: interfaceName,
        mutating: true,
        argumentCount: options.args.length,
      },
      ...(options.callerContext ? { callerContextId: options.callerContext.contextId } : {}),
    };
  }
  const permissionProvider = await evaluateAppPermissionProvider(app, resolved, {
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  });

  if (interfaceName === "builtin") {
    const handler = operation.handler?.trim();
    if (!handler || !RAVI_APP_BUILTIN_OPERATION_HANDLERS.has(handler)) {
      throw new Error(`Unsupported builtin app operation handler: ${handler ?? "(missing)"}`);
    }
    return withPermissionProvider(
      {
        ok: true,
        appId,
        operation: localOperationName(appId, resolved.id),
        operationId: resolved.id,
        interface: "builtin",
        mutating,
        status: "completed",
        durationMs: Date.now() - options.startedAt,
        ...(options.callerContext ? { callerContextId: options.callerContext.contextId } : {}),
        handler,
        result: await runBuiltinHandler(handler, app, options.args),
      },
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
      await runCliOperation(app, resolved, { ...options, composition }),
      permissionProvider,
    );
  }

  throw new Error(`App operation interface is not supported by the router: ${interfaceName}`);
}

function lazyManifests(options: { cwd?: string; env?: NodeJS.ProcessEnv }): () => RaviAppManifestRecord[] {
  let discovered: RaviAppManifestRecord[] | undefined;
  return () => {
    discovered ??= discoverAppManifests({ cwd: options.cwd, env: options.env });
    return discovered;
  };
}

/**
 * When the caller is a process another app's operation launched (or a credential that process derived), and this app
 * offers services, the call must go through one of them. A caller whose lineage cannot be followed to its origin is
 * refused too: it could be an app, and nothing says it is not. An app that offers nothing keeps the earlier rule:
 * whatever the caller's `use:app:<id>` capability lets it do.
 */
function assertCallerMayCall(
  app: RaviAppManifestRecord,
  operationId: string,
  callerContext: ContextRecord | undefined,
  records: () => RaviAppManifestRecord[],
): { service: string; callerAppId: string } | null {
  if (!declaresProvides(app.manifest)) return null;
  const calleeId = app.manifest?.id ?? app.id;
  const caller = callerOf(callerContext, dbGetContext);
  if (caller.kind === "direct") return null;
  if (caller.kind === "unknown") {
    throw new RaviAppCompositionError(
      "APP_OPERATION_NOT_PROVIDED",
      `${operationId} on ${calleeId}, which offers services, was called by a context whose lineage cannot be followed to its origin.`,
    );
  }
  if (caller.appId === calleeId) return null;
  return { ...assertOperationProvided(app, operationId, caller.appId, records()), callerAppId: caller.appId };
}

/**
 * Decide, before anything starts, how this run composes: refuse when a service the app needs is not there, and widen
 * the child context to the composed ceiling (the app's own `context.allow`, its providers', and the right to call
 * them) so each provider's context can be issued from it.
 */
function planComposition(
  app: RaviAppManifestRecord,
  interfaceName: string,
  calledThrough: { service: string; callerAppId: string } | null,
  records: () => RaviAppManifestRecord[],
  invoker: ContextRecord | undefined,
): CompositionPlan {
  const plan: CompositionPlan = {
    operationScoped: participatesInComposition(app.manifest),
    ...(calledThrough ? { service: calledThrough.service, callerAppId: calledThrough.callerAppId } : {}),
  };
  // Only an operation that starts the app's own process needs what the app needs. `help`, `show` and `check` are how a
  // missing provider gets diagnosed, so they keep answering.
  if (interfaceName !== "cli" || !declaresRequires(app.manifest)) return plan;
  const closure = resolveDependencyClosure(app, records());
  if (closure.unavailable.length > 0) {
    throw new RaviAppCompositionError(
      "APP_DEPENDENCY_UNAVAILABLE",
      closure.unavailable.map(describeUnavailableDependency).join(" "),
      closure.unavailable,
    );
  }
  return { ...plan, allow: composedContextAllow(app, closure, publicRoutingCapability(invoker)) };
}

/**
 * What `apps run` is asked for at the gateway, in the forms that are about `run` and nothing else. A composed app
 * reaches its providers through the public CLI, which becomes `apps run`, so its credential carries the form its
 * invoker holds. The wider forms that also satisfy the gateway (`execute:group:apps`, `mutate:apps:*`) are never
 * passed on: they open `apps delete`, `apps scaffold` and `apps import-cli` too. An invoker that holds none of these
 * gets the semantic one named, and the child context is refused: it could not have run an app through the gateway.
 */
const APPS_RUN_ACCESS_FORMS = ["mutate:apps:run", "mutate:apps.run:*", "execute:group:apps_run"] as const;

function publicRoutingCapability(invoker: ContextRecord | undefined): string | undefined {
  if (!invoker) return undefined;
  const held = APPS_RUN_ACCESS_FORMS.find((form) => {
    const [permission, objectType, objectId] = form.split(":") as [string, string, string];
    return canWithCapabilityContext(invoker, permission, objectType, objectId);
  });
  return held ?? APPS_RUN_ACCESS_FORMS[0];
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
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    runtime?: RaviAppRunOptions["runtime"];
    callerContext?: ContextRecord;
    startedAt: number;
    composition: CompositionPlan;
  },
): Promise<RaviAppRunResult> {
  const appId = app.manifest?.id ?? app.id;
  const invocation = resolveRaviAppCommand(resolved.operation.command ?? "", options.args, options.runtime);
  const appRoot = dirname(app.path);
  const childContext = issueAppChildContext(
    app,
    resolved.id,
    options.callerContext,
    options.composition,
    resolved.operation.permission,
    options.args,
  );
  let run: Awaited<ReturnType<typeof spawnExecutable>>;
  try {
    run = await spawnExecutable(invocation.executable, invocation.argv, {
      cwd: appRoot,
      env: buildRaviAppProcessEnv(options.env ?? process.env, {
        appId,
        operationId: resolved.id,
        appRoot,
        contextKey: childContext?.contextKey,
      }),
      capture: options.json,
    });
  } finally {
    // An app that offers or needs a service holds its credential for the operation, not for the TTL. Whatever the
    // process handed to a provider ends with it too (the revocation cascades down the lineage).
    if (childContext && options.composition.operationScoped) revokeAppChildContext(childContext);
  }
  const parsed = options.json ? parseJsonOutput(run.stdout) : undefined;

  const base = {
    appId,
    operation: localOperationName(appId, resolved.id),
    operationId: resolved.id,
    interface: "cli" as const,
    mutating: resolved.operation.mutating === true,
    durationMs: Date.now() - options.startedAt,
    ...(options.callerContext ? { callerContextId: options.callerContext.contextId } : {}),
    ...(childContext ? { childContextId: childContext.contextId } : {}),
  };
  if (run.exitCode !== 0) {
    // The child's output never crosses raw: only a redacted, bounded projection of its error does
    // (spec apps/router, "Failed App Output"). The child key is masked by value, in every form an app may log it in,
    // on top of the patterns.
    return {
      ...base,
      ok: false,
      status: "failed",
      errorCode: "APP_OPERATION_FAILED",
      error: "Ravi app operation failed.",
      failure: projectAppCliFailure(run, {
        secrets: childContext?.contextKey ? maskedSecretForms(childContext.contextKey) : [],
      }),
    };
  }
  return {
    ...base,
    ok: true,
    status: "completed",
    command: invocation.displayCommand,
    exitCode: run.exitCode,
    ...(options.json
      ? {
          stdout: run.stdout,
          stderr: run.stderr,
          result: parsed ?? run.stdout.trim(),
        }
      : {}),
  };
}

function declaresOperationHelp(help: Record<string, unknown>): boolean {
  const hasText = ["usage", "routedUsage", "summary", "backingRequest"].some((key) => {
    const value = help[key];
    return typeof value === "string" && value.trim() !== "";
  });
  const hasList = ["arguments", "options", "examples", "sections"].some((key) => {
    const value = help[key];
    return Array.isArray(value) && value.length > 0;
  });
  return hasText || hasList;
}

function cliPassthroughHelpCommand(operation: RaviAppOperationDeclaration): string | null {
  if (operation.interface !== "cli") return null;
  const command = typeof operation.command === "string" ? operation.command.trim() : "";
  if (!command || !command.includes("{args}")) return null;
  return command.replace("{args}", "--help");
}

function undeclaredOperationHelpHint(
  app: RaviAppManifestRecord,
  operationId: string,
  appHelpCommand: string | null,
): string {
  if (appHelpCommand) {
    return `Este app nao declara ajuda para ${operationId}. A operacao repassa para o comando do app: rode ${appHelpCommand} para ler a ajuda dele.`;
  }
  return `Este app nao declara ajuda para ${operationId}. Rode ravi apps show ${app.id} --json para ver o manifesto.`;
}

async function runBuiltinHandler(handler: string, app: RaviAppManifestRecord, args: string[] = []): Promise<unknown> {
  if (handler === "apps.omie-orders.read") {
    const { runOmieOrdersHost } = await import("./omie-orders/native.js");
    return runOmieOrdersHost(app.id, "read", args);
  }
  if (handler === "apps.help") {
    const operationIds = visibleOperationIdsForHelp(app);
    const perOpHint = `ravi ${app.id.split("/").join(" ")} help <op> — help enxuto por operacao`;
    const requested = args[0];
    if (requested) {
      const operations = manifestOperations(app);
      const ids = Object.keys(operations);
      const match = ids.find((id) => id === requested) ?? ids.find((id) => id.endsWith(`.${requested}`));
      if (match) {
        const operation = (operations[match] ?? {}) as RaviAppOperationDeclaration & Record<string, unknown>;
        const help = (operation.help ?? {}) as Record<string, unknown>;
        const safety = operation.safety as Record<string, unknown> | undefined;
        const helpDeclared = declaresOperationHelp(help);
        const appHelpCommand = cliPassthroughHelpCommand(operation);
        return {
          app: app.id,
          operation: match,
          found: true,
          usage: help.usage,
          routedUsage: help.routedUsage,
          description: operation.description,
          mutating: operation.mutating === true,
          safety: safety
            ? {
                risk: safety.risk,
                liveExecution: safety.liveExecution,
                confirmationRequired: safety.confirmationRequired,
                destructive: safety.destructive,
                gates: safety.gates,
              }
            : undefined,
          backingRequest: help.backingRequest,
          arguments: help.arguments ?? [],
          options: help.options ?? [],
          examples: help.examples ?? [],
          inputSchema: operation.inputSchema,
          summary: help.summary,
          sections: help.sections ?? [],
          helpDeclared,
          ...(helpDeclared
            ? {}
            : {
                hint: undeclaredOperationHelpHint(app, match, appHelpCommand),
                ...(appHelpCommand ? { appHelpCommand } : {}),
              }),
          dica: perOpHint,
        };
      }
      return {
        app: app.id,
        operation: requested,
        found: false,
        error: `Operacao desconhecida: ${requested}`,
        suggestions: ids.filter((id) => id.includes(requested)).slice(0, 10),
        disponiveis: ids.length,
      };
    }
    return {
      app: toDetail(app),
      operations: operationIds,
      index: operationIds.map((id) => {
        const operation = (manifestOperations(app)[id] ?? {}) as RaviAppOperationDeclaration & Record<string, unknown>;
        let description = typeof operation.description === "string" ? operation.description : "";
        if (!description && operation.interface === "builtin") {
          if (operation.handler === "apps.help") {
            description = "Mostra este indice (ou help <op> para detalhe)";
          } else if (operation.handler === "apps.manifest.show") {
            description = "Mostra o manifesto completo do app (grande, uso raro)";
          } else if (operation.handler === "apps.manifest.check") {
            description = "Valida a saude/config do app";
          }
        }
        return {
          op: localOperationName(app.id, id),
          description,
          mutating: operation.mutating === true,
        };
      }),
      hint: perOpHint,
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
  execute: boolean;
  args: string[];
} {
  let json = false;
  let help = false;
  let execute = false;
  const args: string[] = [];
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    args.push(arg);
  }
  return { json, help, execute, args };
}

function spawnExecutable(
  executable: string,
  argv: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
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
  return new Promise((resolveRun) => {
    const child = spawn(executable, argv, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env,
      shell: false,
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
    let spawnError: Error | null = null;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      resolveRun({
        exitCode,
        stdout,
        stderr: spawnError ? `${stderr}${stderr ? "\n" : ""}${spawnError.message}` : stderr,
        timedOut,
        truncated,
      });
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

function mergeStaticRootCommands(staticRootCommands?: Set<string>): Set<string> {
  return new Set([...(staticRootCommands ?? []), ...DEFAULT_STATIC_ROOT_COMMANDS]);
}

function isRecursiveCliCommand(appId: string, command: string, staticRootCommands: Set<string>): boolean {
  const tokens = resolveCommandTokens(command);
  if (tokens[0] !== "ravi") return false;
  const first = tokens[1];
  if (!first || staticRootCommands.has(first)) return false;
  if (first === appId) return true;

  const appSegments = appId.split("/");
  return appSegments.every((segment, index) => tokens[index + 1] === segment);
}

function resolveCallerContext(env?: NodeJS.ProcessEnv): ContextRecord | undefined {
  return (
    getContext({ localOnly: true })?.context ?? getRuntimeContextFromEnv(env ?? process.env) ?? getContext()?.context
  );
}

function issueAppChildContext(
  app: RaviAppManifestRecord,
  operationId: string,
  parent: ContextRecord | undefined,
  composition: CompositionPlan,
  operationPermission?: string,
  args: string[] = [],
): ContextRecord | undefined {
  if (!parent) return undefined;
  const appId = app.manifest?.id ?? app.id;
  const ceiling = composition.allow ?? app.manifest?.context?.allow ?? [];
  const allow = appId === OMIE_APP_ID ? omieDelegation(operationId, operationPermission, args, ceiling) : ceiling;
  const capabilities = allow.map(parseRaviAppCapability);
  const input: IssueRuntimeContextInput = {
    parent,
    cliName: `app:${appId}`,
    kind: "app-runtime",
    capabilities,
    inheritCapabilities: false,
    metadata: {
      appId,
      operationId,
      source: "app-router",
      // Why this app runs for another one: the service it was called through, so the lineage explains itself.
      ...(composition.service && composition.callerAppId
        ? { composition: { service: composition.service, consumerAppId: composition.callerAppId } }
        : {}),
      ...(appId === OMIE_APP_ID
        ? {
            actorPrincipal: parent.metadata?.actorPrincipal,
            actorResolution: parent.metadata?.actorResolution,
            surfacePrincipal: parent.metadata?.surfacePrincipal,
          }
        : {}),
    },
  };
  return issueRuntimeContext(input);
}

function revokeAppChildContext(context: ContextRecord): void {
  try {
    revokeRuntimeContext(context.contextId, { cascade: true, reason: "app_operation_finished" });
  } catch (error) {
    // The operation already ran and its result stands. The credential then lives until its TTL, which is the bounded
    // behavior apps had before composition; say so rather than change what the caller is told.
    log.warn("Could not revoke the app child context at the end of its operation", {
      contextId: context.contextId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveCommandTokens(command: string): string[] {
  try {
    return tokenizeRaviAppCommand(command);
  } catch {
    return [];
  }
}
