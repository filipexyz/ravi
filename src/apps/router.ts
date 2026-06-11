import { spawn } from "node:child_process";
import { discoverAppManifests, getAppManifest, RAVI_APP_BUILTIN_OPERATION_HANDLERS } from "./service.js";
import type {
  RaviAppAliasInvocation,
  RaviAppManifestRecord,
  RaviAppOperationDeclaration,
  RaviAppRunOptions,
  RaviAppRunResult,
} from "./types.js";
import { emitCliAuditEvent } from "../cli/audit.js";
import { assertCanRunAppOperation, assertCanUseApp, filterVisibleAppManifests } from "./permissions.js";

interface ResolvedOperation {
  id: string;
  operation: RaviAppOperationDeclaration;
}

const DEFAULT_STATIC_ROOT_COMMANDS = new Set(["apps"]);

export async function runAppOperation(options: RaviAppRunOptions): Promise<RaviAppRunResult> {
  const startedAt = Date.now();
  const operationName = options.operation?.trim() || null;
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

    const resolved = resolveOperation(app, operationName);
    result = await dispatchResolvedOperation(app, resolved, {
      args: options.args ?? [],
      json: options.json === true,
      cwd: options.cwd,
      env: options.env,
      staticRootCommands: mergeStaticRootCommands(options.staticRootCommands),
      startedAt,
    });
  } catch (error) {
    result = {
      ok: false,
      appId: options.appId,
      operation: operationName,
      operationId: null,
      interface: null,
      mutating: false,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

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
    const { json, help, args } = stripRouterFlags(rest);
    const operation = help ? "help" : args[0];
    return {
      appId: candidate,
      operation,
      args: operation ? args.slice(1) : args,
      json,
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
    cwd: options.cwd,
    env: options.env,
    staticRootCommands: options.staticRootCommands,
  });
  printAppRunResult(result, { json: invocation.json });
  if (!result.ok) process.exitCode = 1;
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
  const appId = app.manifest?.id ?? app.id;
  const operationPrefix = appId.replace(/\//g, ".");
  const operations = manifestOperations(app);

  if (!operationName || operationName === "help") {
    return virtualBuiltin(`${operationPrefix}.help`, "apps.help");
  }
  if (operationName === "show") {
    return virtualBuiltin(`${operationPrefix}.show`, "apps.manifest.show");
  }
  if (operationName === "check") {
    return virtualBuiltin(`${operationPrefix}.check`, "apps.manifest.check");
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

  throw new Error(`Operation not found for app ${appId}: ${operationName}`);
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
    startedAt: number;
  },
): Promise<RaviAppRunResult> {
  const appId = app.manifest?.id ?? app.id;
  const operation = resolved.operation;
  const interfaceName = operation.interface;
  const mutating = operation.mutating === true;

  if (mutating && !hasDeclaredOperationPermission(operation)) {
    throw new Error(`Mutating operation ${resolved.id} must declare permission or permissions.`);
  }
  assertCanRunAppOperation(appId, resolved.id, mutating);

  if (interfaceName === "builtin") {
    const handler = operation.handler?.trim();
    if (!handler || !RAVI_APP_BUILTIN_OPERATION_HANDLERS.has(handler)) {
      throw new Error(`Unsupported builtin app operation handler: ${handler ?? "(missing)"}`);
    }
    return {
      ok: true,
      appId,
      operation: localOperationName(appId, resolved.id),
      operationId: resolved.id,
      interface: "builtin",
      mutating,
      status: "completed",
      durationMs: Date.now() - options.startedAt,
      handler,
      result: runBuiltinHandler(handler, app),
    };
  }

  if (interfaceName === "cli") {
    if (!operation.command?.trim()) {
      throw new Error(`CLI operation ${resolved.id} is missing command.`);
    }
    if (isRecursiveCliCommand(appId, operation.command, options.staticRootCommands)) {
      throw new Error(`CLI operation ${resolved.id} recursively invokes ravi ${appId.split("/").join(" ")}.`);
    }
    return runCliOperation(app, resolved, options);
  }

  if (interfaceName === "stream") {
    return {
      ok: true,
      appId,
      operation: localOperationName(appId, resolved.id),
      operationId: resolved.id,
      interface: "stream",
      mutating,
      status: "completed",
      durationMs: Date.now() - options.startedAt,
      channel: operation.channel,
      result: {
        channel: operation.channel,
        message: "Stream operations must be handled by a dedicated stream/control surface.",
      },
    };
  }

  throw new Error(`App operation interface is not supported by the CLI router yet: ${interfaceName}`);
}

async function runCliOperation(
  app: RaviAppManifestRecord,
  resolved: ResolvedOperation,
  options: {
    args: string[];
    json: boolean;
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
  const run = await spawnShellCommand(command, {
    cwd: options.cwd,
    env: options.env,
    capture: options.json,
  });
  const parsed = options.json ? parseJsonOutput(run.stdout) : undefined;

  return {
    ok: run.exitCode === 0,
    appId,
    operation: localOperationName(appId, resolved.id),
    operationId: resolved.id,
    interface: "cli",
    mutating: resolved.operation.mutating === true,
    status: run.exitCode === 0 ? "completed" : "failed",
    durationMs: Date.now() - options.startedAt,
    command,
    exitCode: run.exitCode,
    ...(options.json
      ? {
          stdout: run.stdout,
          stderr: run.stderr,
          result: parsed ?? run.stdout.trim(),
        }
      : {}),
    ...(run.exitCode === 0
      ? {}
      : {
          error: run.stderr.trim() || `Command exited with code ${run.exitCode}`,
        }),
  };
}

function runBuiltinHandler(handler: string, app: RaviAppManifestRecord): unknown {
  if (handler === "apps.help") {
    const operationIds = Object.keys(manifestOperations(app)).sort();
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
  args: string[];
} {
  let json = false;
  let help = false;
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
    args.push(arg);
  }
  return { json, help, args };
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; capture: boolean },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      shell: true,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
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
