/**
 * Pages app gateway installation executor.
 *
 * Handles one `apps.invoke` frame: verify (Console `pages/app-gateway/relay`
 * SPEC, "Verify, in order", steps 2 to 14), then run the operation strictly
 * through the App Router inside a short-lived parent runtime context that
 * carries no agent and no Console-user identity. Returns the serialized
 * `apps.result` / `apps.error` frame.
 *
 * Never logs or forwards the assertion, grant, args, body, result, stdout,
 * stderr, command, or context keys.
 */

import { runWithContext } from "../cli/context.js";
import { listCachedActorBindings } from "../cloud-auth/actor-bindings.js";
import type { ActorBinding } from "../cloud-auth/types.js";
import { checkGatewayArgs, normalizeGatewayDeclaration } from "../apps/gateway-declaration.js";
import { parseRaviAppCapability } from "../apps/command.js";
import { runAppOperation } from "../apps/router.js";
import { getAppManifest } from "../apps/service.js";
import type { RaviAppManifestRecord, RaviAppRunOptions, RaviAppRunResult } from "../apps/types.js";
import type { ContextCapability } from "../router/router-db.js";
import { createRuntimeContext, revokeRuntimeContext } from "../runtime/context-registry.js";
import { logger } from "../utils/logger.js";
import {
  EXECUTOR_MAX_CONCURRENCY,
  EXECUTOR_MAX_OUTPUT_BYTES,
  EXECUTOR_RUN_TIMEOUT_MS,
  type ExecutorErrorCode,
  MAX_ARG_CHARS,
  MAX_ARGS,
  MAX_ARGS_TOTAL_BYTES,
  PAGES_APP_GATEWAY_AGENT_LABEL,
  PAGES_APP_GATEWAY_CONTEXT_KIND,
  PARENT_CONTEXT_TTL_MS,
  RESULT_BODY_MAX_BYTES,
} from "./constants.js";
import { RequestIdDedupe } from "./dedupe.js";
import { type AppsInvokeFrame, serializeErrorFrame, serializeResultFrame } from "./frames.js";
import { resolveAppGatewayPrincipal } from "./principal.js";
import { readAllowedOperations, readRequireLink, type SettingReader } from "./settings.js";
import {
  AppGatewayRefusal,
  AppGatewayVerifier,
  type InstallationBinding,
  type KeyResolver,
  type VerifiedTargetGrant,
} from "./verify.js";

const log = logger.child("app-gateway:executor");

export interface AppGatewayInvokeSession extends InstallationBinding {
  /** Issuer from the ticket response the socket was opened with. */
  issuer: string;
}

export interface AppGatewayExecutorOptions {
  resolveKey: KeyResolver;
  /** Daemon environment; `RAVI_CONTEXT_KEY` is always stripped before the App Router sees it. */
  env?: NodeJS.ProcessEnv;
  readSetting?: SettingReader;
  listBindings?: () => readonly ActorBinding[];
  loadManifest?: (appId: string, env: NodeJS.ProcessEnv) => RaviAppManifestRecord;
  runApp?: (options: RaviAppRunOptions) => Promise<RaviAppRunResult>;
  dedupe?: RequestIdDedupe;
  maxConcurrency?: number;
  runTimeoutMs?: number;
  now?: () => number;
}

interface InvokeLogFields {
  requestId: string;
  appId: string;
  operation: string;
  siteId?: string;
}

export class AppGatewayExecutor {
  private readonly resolveKey: KeyResolver;
  private readonly baseEnv: NodeJS.ProcessEnv | undefined;
  private readonly readSetting: SettingReader | undefined;
  private readonly listBindings: () => readonly ActorBinding[];
  private readonly loadManifest: (appId: string, env: NodeJS.ProcessEnv) => RaviAppManifestRecord;
  private readonly runApp: (options: RaviAppRunOptions) => Promise<RaviAppRunResult>;
  private readonly dedupe: RequestIdDedupe;
  private readonly maxConcurrency: number;
  private readonly runTimeoutMs: number;
  private readonly now: () => number;
  private active = 0;

  constructor(options: AppGatewayExecutorOptions) {
    this.resolveKey = options.resolveKey;
    this.baseEnv = options.env;
    this.readSetting = options.readSetting;
    this.listBindings = options.listBindings ?? (() => listCachedActorBindings(this.env()));
    this.loadManifest = options.loadManifest ?? ((appId, env) => getAppManifest(appId, { env }));
    this.runApp = options.runApp ?? runAppOperation;
    this.now = options.now ?? Date.now;
    this.dedupe = options.dedupe ?? new RequestIdDedupe({ now: this.now });
    this.maxConcurrency = options.maxConcurrency ?? EXECUTOR_MAX_CONCURRENCY;
    this.runTimeoutMs = options.runTimeoutMs ?? EXECUTOR_RUN_TIMEOUT_MS;
  }

  /** Daemon environment at call time, never carrying `RAVI_CONTEXT_KEY`. */
  private env(): NodeJS.ProcessEnv {
    return withoutContextKey(this.baseEnv ?? process.env);
  }

  /** In-flight invokes holding a concurrency slot (released only after the child group exited). */
  get activeInvokes(): number {
    return this.active;
  }

  /** Step 1 failed in the frame parser: answer `payload_invalid` and log it like any invoke. */
  refuseMalformed(requestId: string): string {
    log.info("Pages app gateway invoke", {
      requestId,
      outcome: "payload_invalid",
      durationMs: 0,
    });
    return serializeErrorFrame(requestId, "payload_invalid");
  }

  /** Steps 2 to 14 for one `apps.invoke`. Always resolves to one response frame. */
  async handleInvoke(frame: AppsInvokeFrame, session: AppGatewayInvokeSession, signal: AbortSignal): Promise<string> {
    const startedAt = this.now();
    const fields: InvokeLogFields = { requestId: frame.requestId, appId: frame.appId, operation: frame.operation };
    let response: string;
    let outcome: string;
    let unexpected: string | undefined;
    try {
      const body = await this.verifyAndRun(frame, session, signal, fields);
      response = serializeResultFrame(frame.requestId, body);
      outcome = "ok";
    } catch (error) {
      const code = error instanceof AppGatewayRefusal ? error.code : "app_gateway_operation_failed";
      // Only the error class name: messages may carry app or Console detail.
      if (!(error instanceof AppGatewayRefusal)) unexpected = error instanceof Error ? error.name : "unknown";
      response = serializeErrorFrame(frame.requestId, code);
      outcome = code;
    }
    // One line per invoke; never the ticket, assertion, grant, args, body, result, or context keys.
    log.info("Pages app gateway invoke", {
      ...fields,
      outcome,
      durationMs: this.now() - startedAt,
      ...(unexpected ? { unexpected } : {}),
    });
    return response;
  }

  private async verifyAndRun(
    frame: AppsInvokeFrame,
    session: AppGatewayInvokeSession,
    signal: AbortSignal,
    fields: InvokeLogFields,
  ): Promise<unknown> {
    const verifier = new AppGatewayVerifier({ resolveKey: this.resolveKey, issuer: session.issuer, now: this.now });

    // 2-3. Grant, then assertion bound to the grant.
    const grant = await verifier.verifyGrant(frame.grant, session);
    fields.siteId = grant.site;
    const assertion = await verifier.verifyAssertion(frame.assertion, grant);

    // 4. Replay window; only invokes that passed steps 1-3 enter the set.
    const admission = this.dedupe.admit(frame.requestId);
    if (admission === "replayed") throw new AppGatewayRefusal("app_gateway_request_replayed");
    if (admission === "full") throw new AppGatewayRefusal("app_gateway_rate_limited");

    // 5-6. Grant scope.
    if (frame.appId !== grant.app) throw new AppGatewayRefusal("app_gateway_app_forbidden");
    if (!grant.operations.includes(frame.operation)) throw new AppGatewayRefusal("app_gateway_operation_forbidden");

    // 7. Local opt-in, read on every invoke.
    const allowed = this.readSetting ? readAllowedOperations(this.readSetting) : readAllowedOperations();
    if (!allowed.has(`${frame.appId}:${frame.operation}`)) {
      throw new AppGatewayRefusal("app_gateway_permission_denied");
    }

    // 8. Local principal; optional Ravi Link requirement.
    const principal = resolveAppGatewayPrincipal({
      raviUserId: assertion.raviUserId,
      raviOrgId: assertion.raviOrgId,
      siteId: grant.site,
      installationId: session.installationId,
      bindings: this.listBindings(),
    });
    const requireLink = this.readSetting ? readRequireLink(this.readSetting) : readRequireLink();
    if (requireLink && !principal.contactId) throw new AppGatewayRefusal("app_gateway_permission_denied");

    // 9. Manifest.
    let app: RaviAppManifestRecord;
    try {
      app = this.loadManifest(frame.appId, this.env());
    } catch {
      throw new AppGatewayRefusal("app_gateway_operation_failed");
    }
    if (!app.valid || !app.manifest) throw new AppGatewayRefusal("app_gateway_operation_failed");

    // 10. Read-only operation with an explicit gateway declaration.
    const declaration = readGatewayOperation(app, frame.operation);
    if (!declaration) throw new AppGatewayRefusal("app_gateway_operation_forbidden");

    // 11-12. Viewer argv.
    const args = readArgs(frame.body);
    if (!checkGatewayArgs(declaration, args).ok) throw new AppGatewayRefusal("payload_invalid");
    const argsBytes = args.reduce((total, arg) => total + Buffer.byteLength(arg, "utf8"), 0);
    if (argsBytes > MAX_ARGS_TOTAL_BYTES) throw new AppGatewayRefusal("app_gateway_payload_too_large");

    // 13. Concurrency; the slot covers the child process group's whole life.
    if (this.active >= this.maxConcurrency) throw new AppGatewayRefusal("app_gateway_rate_limited");
    this.active++;
    try {
      const capabilities = parentCapabilities(app, frame.appId);
      const result = await this.runInParentContext({
        grant,
        frame,
        capabilities,
        metadata: {
          actorPrincipal: principal.actorPrincipal,
          surfacePrincipal: principal.surfacePrincipal,
          raviUserId: assertion.raviUserId,
          raviOrgId: assertion.raviOrgId,
          siteId: grant.site,
          projectId: grant.project,
          audience: grant.aud,
          appGatewayTargetId: grant.target,
          requestId: frame.requestId,
          source: "pages-app-gateway",
        },
        args,
        signal,
      });
      return mapRunResult(result);
    } finally {
      this.active--;
    }
  }

  // 14. App Router run inside a parent context with no agent and no Console identity.
  private async runInParentContext(input: {
    grant: VerifiedTargetGrant;
    frame: AppsInvokeFrame;
    capabilities: ContextCapability[];
    metadata: Record<string, unknown>;
    args: string[];
    signal: AbortSignal;
  }): Promise<RaviAppRunResult> {
    const context = createRuntimeContext({
      kind: PAGES_APP_GATEWAY_CONTEXT_KIND,
      capabilities: input.capabilities,
      metadata: input.metadata,
      ttlMs: PARENT_CONTEXT_TTL_MS,
    });
    try {
      return await runWithContext(
        {
          agentId: PAGES_APP_GATEWAY_AGENT_LABEL,
          context,
          contextId: context.contextId,
          transport: "gateway",
          suppressCliOutput: true,
        },
        () =>
          this.runApp({
            appId: input.frame.appId,
            operation: input.frame.operation,
            args: input.args,
            json: true,
            execute: false,
            exactOperation: true,
            timeoutMs: this.runTimeoutMs,
            maxOutputBytes: EXECUTOR_MAX_OUTPUT_BYTES,
            signal: input.signal,
            env: this.env(),
          }),
      );
    } finally {
      try {
        revokeRuntimeContext(context.contextId, { cascade: true, reason: "pages-app-gateway-invoke-finished" });
      } catch {
        // Expiry (35 s TTL) still bounds the context if revoke fails.
      }
    }
  }
}

function readGatewayOperation(app: RaviAppManifestRecord, operationId: string) {
  const operations = app.manifest?.operations;
  if (!operations || typeof operations !== "object" || Array.isArray(operations)) return null;
  if (!Object.hasOwn(operations, operationId)) return null;
  const operation = (operations as Record<string, unknown>)[operationId];
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return null;
  const declaration = operation as Record<string, unknown>;
  if (declaration.mutating !== false) return null;
  if (declaration.interface !== "builtin" && declaration.interface !== "cli") return null;
  if (app.permissions.provider?.operation === operationId) return null;
  return normalizeGatewayDeclaration(declaration.gateway);
}

/** Step 11: only an optional `args` array of bounded strings without NUL. */
function readArgs(body: Record<string, unknown>): string[] {
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "args")) throw new AppGatewayRefusal("payload_invalid");
  const args = body.args;
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > MAX_ARGS) throw new AppGatewayRefusal("payload_invalid");
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_CHARS || arg.includes("\u0000")) {
      throw new AppGatewayRefusal("payload_invalid");
    }
  }
  return [...(args as string[])];
}

function parentCapabilities(app: RaviAppManifestRecord, appId: string): ContextCapability[] {
  const capabilities: ContextCapability[] = [
    { permission: "use", objectType: "app", objectId: appId, source: "pages-app-gateway" },
  ];
  try {
    for (const entry of app.manifest?.context?.allow ?? []) capabilities.push(parseRaviAppCapability(entry));
  } catch {
    throw new AppGatewayRefusal("app_gateway_operation_failed");
  }
  return capabilities;
}

/** Result mapping table. Never forwards stdout, stderr, command, context ids, or provider details. */
export function mapRunResult(result: RaviAppRunResult): unknown {
  if (result.ok) {
    const body = result.result ?? null;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new AppGatewayRefusal("app_gateway_operation_failed");
    }
    if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > RESULT_BODY_MAX_BYTES) {
      throw new AppGatewayRefusal("app_gateway_payload_too_large");
    }
    return serialized === undefined ? null : body;
  }
  throw new AppGatewayRefusal(errorCodeForRun(result));
}

function errorCodeForRun(result: RaviAppRunResult): ExecutorErrorCode {
  if (result.errorCode === "APP_OUTPUT_TOO_LARGE") return "app_gateway_payload_too_large";
  if (result.errorCode === "APP_OPERATION_TIMEOUT") return "app_gateway_operation_failed";
  if (result.status === "blocked") return "app_gateway_operation_forbidden";
  if (result.errorCode === "PERMISSION_DENIED" || result.errorCode === "APP_PERMISSION_PROVIDER_FAILED") {
    return "app_gateway_permission_denied";
  }
  return "app_gateway_operation_failed";
}

function withoutContextKey(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { RAVI_CONTEXT_KEY: _contextKey, ...rest } = env;
  return rest;
}
