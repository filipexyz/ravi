/**
 * Generic dispatcher for the SDK gateway.
 *
 * Pipeline: parse flat body → validate via Zod → scope check → invoke handler →
 * optionally validate return shape → emit audit when useful → return JSON.
 *
 * Body shape: flat-only. Args and options are merged into top-level keys
 * (e.g. `{ id, limit }`). The wrapped CLI invocation form (`{ args, options }`)
 * is intentionally rejected because it leaks CLI grammar into the API surface.
 *
 * Audit emit lives here on purpose. The transport layer (server.ts) never
 * emits command audits, which prevents drift between CLI and gateway tool
 * naming. High-frequency successful read calls may be suppressed here; errors
 * still emit audit.
 *
 * Context binding: when the gateway resolves a runtime context-key, it threads
 * the resolved `ContextRecord` into the dispatcher so audit events carry the
 * public `contextId`, the lineage's `parentContextId`, and the `agentId`. The
 * raw context-key (`rctx_*`) never crosses this boundary.
 */

import { ZodError, type ZodTypeAny, type ZodIssue } from "zod";
import type { CommandRegistryEntry } from "../../cli/registry-snapshot.js";
import { runWithContext, type ToolContext } from "../../cli/context.js";
import { enforceScopeCheck } from "../../permissions/scope.js";
import { emitCliAuditEvent } from "../../cli/audit.js";
import type { ScopeContext } from "../../permissions/scope.js";
import type { ContextRecord } from "../../router/router-db.js";
import {
  errorResponse,
  internalError,
  json,
  permissionDenied,
  returnShapeError,
  validationError,
  type JsonIssue,
} from "./errors.js";

const QUIET_SUCCESS_AUDIT_TOOLS = new Set(["sessions_list", "tasks_list", "tasks_show"]);

export interface DispatchOptions {
  /** Allow `superadmin`-scoped commands. Off by default. */
  allowSuperadmin?: boolean;
  /** Override the audit emitter (tests). */
  emitAudit?: (event: AuditEvent) => Promise<void> | void;
  /** Resolved runtime context record for audit lineage and contextId fields. */
  contextRecord?: ContextRecord | null;
}

export interface AuditEvent {
  group: string;
  name: string;
  tool: string;
  input: Record<string, unknown>;
  isError: boolean;
  durationMs: number;
  contextId: string | null;
  parentContextId: string | null;
  agentId: string | null;
}

export interface DispatchResult {
  response: Response;
  /** Audit event emitted for this dispatch, or null when validation/quiet-success policy suppressed it. */
  audit: AuditEvent | null;
}

interface NormalizedInput {
  positional: unknown[];
  named: Record<string, unknown>;
}

interface NormalizeOk {
  ok: true;
  input: NormalizedInput;
}

interface NormalizeErr {
  ok: false;
  response: Response;
}

type NormalizeResult = NormalizeOk | NormalizeErr;

export async function dispatch(
  cmd: CommandRegistryEntry,
  body: unknown,
  scopeContext: ScopeContext,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const tool = `${cmd.groupSegments.join("_")}_${cmd.command}`;
  const lineage = extractLineage(opts.contextRecord);

  if (cmd.scope === "superadmin" && !opts.allowSuperadmin) {
    return {
      response: errorResponse(403, "PermissionDenied", {
        reason: `superadmin commands are not exposed by this gateway. Pass --allow-superadmin to opt in.`,
      }),
      audit: null,
    };
  }

  const normalized = normalizeBody(cmd, body);
  if (!normalized.ok) {
    return { response: normalized.response, audit: null };
  }

  const validation = validateAndPack(cmd, normalized.input);
  if (!validation.ok) {
    return { response: validationError(validation.issues), audit: null };
  }

  const startedAt = Date.now();
  let isError = false;
  let response: Response;
  let returnValue: unknown;

  try {
    returnValue = await runWithContext(
      asToolContext(scopeContext, opts.contextRecord ?? null),
      () =>
        new Promise<unknown>((resolve, reject) => {
          const scopeResult = enforceScopeCheck(cmd.scope, cmd.groupSegments.join("_"), cmd.command);
          if (!scopeResult.allowed) {
            reject(new ScopeDenied(scopeResult.errorMessage));
            return;
          }
          try {
            const instance = new cmd.cls();
            const method = (instance as unknown as Record<string, Function>)[cmd.method];
            const result = method.apply(instance, validation.callArgs);
            if (result && typeof (result as PromiseLike<unknown>).then === "function") {
              (result as Promise<unknown>).then(resolve, reject);
            } else {
              resolve(result);
            }
          } catch (err) {
            reject(err);
          }
        }),
    );
  } catch (err) {
    if (err instanceof ScopeDenied) {
      response = permissionDenied(err.message);
      const audit = buildAuditEvent(cmd, tool, validation.inputForAudit, true, startedAt, lineage);
      const auditEmitted = await emitDispatchAudit(audit, opts.emitAudit);
      return { response, audit: auditEmitted ? audit : null };
    }
    isError = true;
    const message = err instanceof Error ? err.message : String(err);
    response = internalError(message);
    const audit = buildAuditEvent(cmd, tool, validation.inputForAudit, isError, startedAt, lineage);
    const auditEmitted = await emitDispatchAudit(audit, opts.emitAudit);
    return { response, audit: auditEmitted ? audit : null };
  }

  if (cmd.binary) {
    if (!(returnValue instanceof Response)) {
      response = returnShapeError([
        {
          path: [],
          code: "invalid_type",
          message: `Command "${cmd.fullName}" is declared @Returns.binary() but handler returned ${describeReturnValue(returnValue)} instead of a Response.`,
        },
      ]);
      const audit = buildAuditEvent(cmd, tool, validation.inputForAudit, true, startedAt, lineage);
      const auditEmitted = await emitDispatchAudit(audit, opts.emitAudit);
      return { response, audit: auditEmitted ? audit : null };
    }
    const audit = buildAuditEvent(cmd, tool, validation.inputForAudit, isError, startedAt, lineage);
    const auditEmitted = await emitDispatchAudit(audit, opts.emitAudit);
    return { response: returnValue, audit: auditEmitted ? audit : null };
  }

  if (cmd.returns) {
    const returnIssues = checkReturnShape(cmd.returns, returnValue);
    if (returnIssues) {
      response = returnShapeError(returnIssues);
      const audit = buildAuditEvent(cmd, tool, validation.inputForAudit, true, startedAt, lineage);
      const auditEmitted = await emitDispatchAudit(audit, opts.emitAudit);
      return { response, audit: auditEmitted ? audit : null };
    }
  }

  response = json(200, returnValue ?? {});
  const audit = buildAuditEvent(cmd, tool, validation.inputForAudit, isError, startedAt, lineage);
  const auditEmitted = await emitDispatchAudit(audit, opts.emitAudit);
  return { response, audit: auditEmitted ? audit : null };
}

function describeReturnValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

interface AuditLineage {
  contextId: string | null;
  parentContextId: string | null;
  agentId: string | null;
}

function extractLineage(record: ContextRecord | null | undefined): AuditLineage {
  if (!record) return { contextId: null, parentContextId: null, agentId: null };
  const parentContextId = typeof record.metadata?.parentContextId === "string" ? record.metadata.parentContextId : null;
  return {
    contextId: record.contextId,
    parentContextId,
    agentId: record.agentId ?? null,
  };
}

function buildAuditEvent(
  cmd: CommandRegistryEntry,
  tool: string,
  input: Record<string, unknown>,
  isError: boolean,
  startedAt: number,
  lineage: AuditLineage,
): AuditEvent {
  return {
    group: cmd.groupSegments.join("_"),
    name: cmd.command,
    tool,
    input,
    isError,
    durationMs: Date.now() - startedAt,
    contextId: lineage.contextId,
    parentContextId: lineage.parentContextId,
    agentId: lineage.agentId,
  };
}

class ScopeDenied extends Error {}

function normalizeBody(cmd: CommandRegistryEntry, body: unknown): NormalizeResult {
  if (body === undefined || body === null) {
    return { ok: true, input: { positional: [], named: {} } };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      response: errorResponse(400, "BadRequest", {
        message: "Request body must be a JSON object.",
      }),
    };
  }
  const obj = body as Record<string, unknown>;

  const allowed = new Set<string>();
  for (const a of cmd.args) allowed.add(a.name);
  for (const o of cmd.options) allowed.add(o.name);

  const named: Record<string, unknown> = {};
  const positional: unknown[] = [];
  const unknownKeys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!allowed.has(k)) {
      unknownKeys.push(k);
      continue;
    }
    named[k] = v;
  }

  if (unknownKeys.length > 0) {
    const issues: JsonIssue[] = unknownKeys.map((k) => ({
      path: [k],
      code: "unrecognized_keys",
      message: `Unknown field "${k}" for ${cmd.fullName}.`,
    }));
    return { ok: false, response: validationError(issues) };
  }

  for (const arg of cmd.args) {
    if (arg.name in named) {
      positional[arg.index] = named[arg.name];
    }
  }

  return { ok: true, input: { positional, named } };
}

interface PackOk {
  ok: true;
  callArgs: unknown[];
  inputForAudit: Record<string, unknown>;
}

interface PackErr {
  ok: false;
  issues: JsonIssue[];
}

function validateAndPack(cmd: CommandRegistryEntry, input: NormalizedInput): PackOk | PackErr {
  const issues: JsonIssue[] = [];
  const totalParams = cmd.args.length + cmd.options.length;
  const callArgs: unknown[] = new Array(totalParams).fill(undefined);
  const auditInput: Record<string, unknown> = {};

  for (const arg of cmd.args) {
    const fromPositional = input.positional[arg.index];
    const value = fromPositional !== undefined ? fromPositional : input.named[arg.name];
    const out = applySchema(arg.schema, value);
    if (out.ok) {
      callArgs[arg.index] = out.value;
      if (out.value !== undefined) auditInput[arg.name] = out.value;
    } else {
      pushIssues(issues, [arg.name], out.issues);
    }
  }

  for (const opt of cmd.options) {
    const value = input.named[opt.name];
    const out = applySchema(opt.schema, value);
    if (out.ok) {
      callArgs[opt.index] = out.value;
      if (out.value !== undefined) auditInput[opt.name] = out.value;
    } else {
      pushIssues(issues, [opt.name], out.issues);
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, callArgs, inputForAudit: auditInput };
}

function pushIssues(target: JsonIssue[], prefix: (string | number)[], issues: ZodIssue[]): void {
  for (const issue of issues) {
    target.push({
      path: [...prefix, ...issue.path.map(coerceKey)],
      code: issue.code,
      message: issue.message,
    });
  }
}

function coerceKey(value: PropertyKey): string | number {
  if (typeof value === "number") return value;
  return String(value);
}

interface SchemaOk {
  ok: true;
  value: unknown;
}

interface SchemaErr {
  ok: false;
  issues: ZodIssue[];
}

function applySchema(schema: ZodTypeAny, value: unknown): SchemaOk | SchemaErr {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, issues: (result.error as ZodError).issues };
}

function checkReturnShape(schema: ZodTypeAny, value: unknown): JsonIssue[] | null {
  const result = schema.safeParse(value);
  if (result.success) return null;
  const issues = (result.error as ZodError).issues.map<JsonIssue>((i) => ({
    path: i.path.map(coerceKey),
    code: i.code,
    message: i.message,
  }));
  return issues;
}

function asToolContext(scope: ScopeContext, record: ContextRecord | null): ToolContext {
  const ctx: ToolContext = { suppressCliOutput: true };
  if (scope.agentId) ctx.agentId = scope.agentId;
  if (scope.sessionKey) ctx.sessionKey = scope.sessionKey;
  if (scope.sessionName) ctx.sessionName = scope.sessionName;
  if (record) {
    ctx.contextId = record.contextId;
    ctx.context = record;
  }
  return ctx;
}

async function emitDispatchAudit(event: AuditEvent, override: DispatchOptions["emitAudit"]): Promise<boolean> {
  if (!event.isError && QUIET_SUCCESS_AUDIT_TOOLS.has(event.tool)) return false;
  if (override) {
    await override(event);
    return true;
  }
  await emitCliAuditEvent({
    group: event.group,
    name: event.name,
    tool: event.tool,
    input: event.input,
    isError: event.isError,
    status: "completed",
    durationMs: event.durationMs,
    contextId: event.contextId,
    parentContextId: event.parentContextId,
    agentId: event.agentId,
    closeLazyConnection: false,
  });
  return true;
}
