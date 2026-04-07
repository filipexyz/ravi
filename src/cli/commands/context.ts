import "reflect-metadata";
import { Arg, Group, Command, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  issueRuntimeContext,
  resolveRuntimeContextOrThrow,
  revokeRuntimeContext,
  RAVI_CONTEXT_KEY_ENV,
} from "../../runtime/context-registry.js";
import { dbGetContext, dbListContexts, type ContextRecord } from "../../router/router-db.js";
import { canWithCapabilities } from "../../permissions/engine.js";
import { authorizeRuntimeContext } from "../../approval/service.js";
import type { ContextCapability } from "../../router/router-db.js";

@Group({
  name: "context",
  description: "Runtime context registry and introspection",
  scope: "open",
})
export class ContextCommands {
  @Command({ name: "list", description: "List issued runtime contexts without exposing context keys" })
  list(
    @Option({ flags: "--agent <agentId>", description: "Filter by agent ID" }) agentId?: string,
    @Option({ flags: "--session <sessionKey>", description: "Filter by session key" }) sessionKey?: string,
    @Option({ flags: "--kind <kind>", description: "Filter by context kind" }) kind?: string,
    @Option({ flags: "--all", description: "Include revoked and expired contexts" }) includeInactive = false,
  ) {
    const contexts = dbListContexts({ agentId, sessionKey, kind, includeInactive });
    this.printJson({
      count: contexts.length,
      contexts: contexts.map((context) => this.serializeContextSummary(context)),
    });
  }

  @Command({ name: "info", description: "Show full runtime context details without exposing the context key" })
  info(@Arg("contextId", { description: "Context ID to inspect" }) contextId: string) {
    const context = dbGetContext(contextId);
    if (!context) {
      fail(`Context not found: ${contextId}`);
    }

    this.printJson(this.serializeContextDetail(context));
  }

  @Command({ name: "whoami", description: "Resolve the current runtime context" })
  whoami() {
    const context = this.requireResolvedContext();
    this.printJson(this.serializeContextDetail(context));
  }

  @Command({ name: "capabilities", description: "List inherited capabilities for the current runtime context" })
  capabilities() {
    const context = this.requireResolvedContext();
    this.printJson({
      contextId: context.contextId,
      kind: context.kind,
      agentId: context.agentId ?? null,
      sessionKey: context.sessionKey ?? null,
      sessionName: context.sessionName ?? null,
      capabilities: context.capabilities,
    });
  }

  @Command({ name: "check", description: "Check whether the current runtime context allows an action" })
  check(
    @Arg("permission", { description: "Permission name (e.g. execute, access, use)" }) permission: string,
    @Arg("objectType", { description: "Object type (e.g. group, session, tool)" }) objectType: string,
    @Arg("objectId", { description: "Object identifier or pattern target" }) objectId: string,
  ) {
    const context = this.requireResolvedContext();
    this.printJson({
      contextId: context.contextId,
      agentId: context.agentId ?? null,
      permission,
      objectType,
      objectId,
      allowed: canWithCapabilities(context.capabilities, permission, objectType, objectId),
      capabilitiesCount: context.capabilities.length,
    });
  }

  @Command({ name: "authorize", description: "Request approval and extend the current runtime context if approved" })
  async authorize(
    @Arg("permission", { description: "Permission name (e.g. execute, access, use)" }) permission: string,
    @Arg("objectType", { description: "Object type (e.g. group, session, tool)" }) objectType: string,
    @Arg("objectId", { description: "Object identifier or pattern target" }) objectId: string,
  ) {
    const context = this.requireResolvedContext();
    const result = await authorizeRuntimeContext({
      context,
      permission,
      objectType,
      objectId,
    });

    this.printJson({
      contextId: result.context.contextId,
      agentId: result.context.agentId ?? null,
      permission,
      objectType,
      objectId,
      allowed: result.allowed,
      approved: result.approved,
      inherited: result.inherited,
      reason: result.reason ?? null,
      capabilitiesCount: result.context.capabilities.length,
    });
  }

  @Command({ name: "issue", description: "Issue a least-privilege child context for an external CLI" })
  issue(
    @Arg("cliName", { description: "Logical CLI name for audit and lineage" }) cliName: string,
    @Option({
      flags: "--allow <capabilities>",
      description: "Comma-separated permission:objectType:objectId entries to lease to the child context",
    })
    allow?: string,
    @Option({
      flags: "--ttl <duration>",
      description: "TTL like 30m, 2h or 1d (default: 1h, capped by the parent context)",
    })
    ttl?: string,
    @Option({ flags: "--inherit", description: "Inherit all capabilities from the current context" }) inherit = false,
  ) {
    const parent = this.requireResolvedContext();
    const child = issueRuntimeContext({
      parent,
      cliName,
      capabilities: parseCapabilityList(allow),
      ttlMs: parseDurationMs(ttl),
      inheritCapabilities: inherit,
    });

    this.printJson({
      contextId: child.contextId,
      contextKey: child.contextKey,
      kind: child.kind,
      cliName,
      agentId: child.agentId ?? null,
      sessionKey: child.sessionKey ?? null,
      sessionName: child.sessionName ?? null,
      parentContextId: parent.contextId,
      createdAt: child.createdAt,
      expiresAt: child.expiresAt ?? null,
      capabilities: child.capabilities,
      capabilitiesCount: child.capabilities.length,
      source: child.source ?? null,
      metadata: child.metadata ?? null,
      env: {
        [RAVI_CONTEXT_KEY_ENV]: child.contextKey,
      },
    });
  }

  @Command({ name: "revoke", description: "Revoke a runtime context by context ID" })
  revoke(@Arg("contextId", { description: "Context ID to revoke" }) contextId: string) {
    const context = revokeRuntimeContext(contextId);
    this.printJson(this.serializeContextDetail(context));
  }

  private requireResolvedContext() {
    const inlineContext = getContext()?.context;
    if (inlineContext) {
      return inlineContext;
    }

    const contextKey = process.env[RAVI_CONTEXT_KEY_ENV];
    if (!contextKey) {
      fail(`Missing ${RAVI_CONTEXT_KEY_ENV}`);
    }

    try {
      return resolveRuntimeContextOrThrow(contextKey, { touch: true });
    } catch (err) {
      fail(`Failed to resolve context: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private printJson(payload: unknown): void {
    console.log(JSON.stringify(payload, null, 2));
  }

  private serializeContextSummary(context: ContextRecord) {
    const lineage = this.extractLineage(context);
    return {
      contextId: context.contextId,
      kind: context.kind,
      status: this.getContextStatus(context),
      agentId: context.agentId ?? null,
      sessionKey: context.sessionKey ?? null,
      sessionName: context.sessionName ?? null,
      createdAt: context.createdAt,
      expiresAt: context.expiresAt ?? null,
      lastUsedAt: context.lastUsedAt ?? null,
      revokedAt: context.revokedAt ?? null,
      capabilitiesCount: context.capabilities.length,
      parentContextId: lineage.parentContextId,
      issuedFor: lineage.issuedFor,
      issuanceMode: lineage.issuanceMode,
    };
  }

  private serializeContextDetail(context: ContextRecord) {
    return {
      ...this.serializeContextSummary(context),
      source: context.source ?? null,
      metadata: context.metadata ?? null,
      capabilities: context.capabilities,
      lineage: this.extractLineage(context),
    };
  }

  private extractLineage(context: ContextRecord) {
    const metadata = context.metadata ?? {};
    return {
      parentContextId: typeof metadata.parentContextId === "string" ? metadata.parentContextId : null,
      parentContextKind: typeof metadata.parentContextKind === "string" ? metadata.parentContextKind : null,
      issuedFor: typeof metadata.issuedFor === "string" ? metadata.issuedFor : null,
      issuedAt: typeof metadata.issuedAt === "number" ? metadata.issuedAt : null,
      issuanceMode: typeof metadata.issuanceMode === "string" ? metadata.issuanceMode : null,
      approvalSource: metadata.approvalSource ?? null,
    };
  }

  private getContextStatus(context: ContextRecord): "active" | "expired" | "revoked" {
    if (context.revokedAt && context.revokedAt <= Date.now()) return "revoked";
    if (context.expiresAt && context.expiresAt <= Date.now()) return "expired";
    return "active";
  }
}

function parseCapabilityList(input: string | undefined): ContextCapability[] {
  if (!input) return [];
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseCapability);
}

function parseCapability(input: string): ContextCapability {
  const firstColon = input.indexOf(":");
  const secondColon = input.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1 || secondColon === input.length - 1) {
    fail(`Invalid capability format: "${input}". Expected permission:objectType:objectId, e.g. execute:group:daemon`);
  }

  const permission = input.slice(0, firstColon).trim();
  const objectType = input.slice(firstColon + 1, secondColon).trim();
  const objectId = input.slice(secondColon + 1).trim();
  if (!permission || !objectType || !objectId) {
    fail(`Invalid capability format: "${input}". Expected permission:objectType:objectId, e.g. execute:group:daemon`);
  }

  return { permission, objectType, objectId };
}

function parseDurationMs(input: string | undefined): number | undefined {
  if (!input) return undefined;

  const match = input.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i);
  if (!match) {
    fail(`Invalid duration: "${input}". Expected 30m, 2h or 1d`);
  }

  const value = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m" || unit === "min") return value * 60_000;
  if (unit === "h" || unit === "hr") return value * 3_600_000;
  if (unit === "d") return value * 86_400_000;

  fail(`Invalid duration: "${input}". Expected 30m, 2h or 1d`);
}
