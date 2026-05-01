import "reflect-metadata";
import { readFileSync } from "node:fs";
import { Arg, Group, Command, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  issueRuntimeContext,
  resolveRuntimeContextOrThrow,
  revokeRuntimeContext,
  getContextLineage,
  RAVI_CONTEXT_KEY_ENV,
} from "../../runtime/context-registry.js";
import { dbGetContext, dbListContexts, type ContextRecord } from "../../router/router-db.js";
import { listSessions, resolveSession } from "../../router/sessions.js";
import { buildRuntimeSessionVisibilityPayload } from "../../runtime/session-visibility.js";
import {
  CredentialsFileError,
  emptyCredentialsFile,
  getCredentialsPath,
  readCredentialsFile,
  setDefaultCredentialsEntry,
  upsertCredentialsEntry,
  writeCredentialsFile,
  type CredentialsFile,
} from "../../runtime/credentials-store.js";
import { canWithCapabilityContext } from "../../permissions/engine.js";
import { authorizeRuntimeContext } from "../../approval/service.js";
import type { ContextCapability } from "../../router/router-db.js";
import { buildPreToolUseDenyResult, emitBashDeniedAudit, evaluateBashPermission } from "../../bash/hook.js";
import {
  formatInspectionSection,
  printInspectionBlock,
  printInspectionField,
  type InspectionMeta,
} from "../inspection-output.js";

const CONTEXT_DB_META = { source: "context-db", freshness: "persisted" } as const;
const RESOLVER_META = { source: "resolver", freshness: "live" } as const;
const DERIVED_META = { source: "derived", freshness: "derived-now" } as const;

interface ContextLineageSummary {
  parentContextId: string | null;
  parentContextKind: string | null;
  issuedFor: string | null;
  issuedAt: number | null;
  issuanceMode: string | null;
  approvalSource: unknown;
}

interface SerializedContextSummary {
  contextId: string;
  kind: string;
  status: "active" | "expired" | "revoked";
  agentId: string | null;
  sessionKey: string | null;
  sessionName: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  capabilitiesCount: number;
  parentContextId: string | null;
  issuedFor: string | null;
  issuanceMode: string | null;
}

interface SerializedContextDetail extends SerializedContextSummary {
  source: ContextRecord["source"] | null;
  metadata: Record<string, unknown> | null;
  capabilities: ContextCapability[];
  lineage: ContextLineageSummary;
}

interface ContextCapabilitiesPayload {
  contextId: string;
  kind: string;
  agentId: string | null;
  sessionKey: string | null;
  sessionName: string | null;
  capabilities: ContextCapability[];
}

interface ContextCheckPayload {
  contextId: string;
  agentId: string | null;
  permission: string;
  objectType: string;
  objectId: string;
  allowed: boolean;
  capabilitiesCount: number;
}

interface ContextAuthorizePayload extends ContextCheckPayload {
  approved: boolean;
  inherited: boolean;
  reason: string | null;
}

interface ContextIssuePayload {
  contextId: string;
  contextKey: string;
  kind: string;
  cliName: string;
  agentId: string | null;
  sessionKey: string | null;
  sessionName: string | null;
  parentContextId: string;
  createdAt: number;
  expiresAt: number | null;
  capabilities: ContextCapability[];
  capabilitiesCount: number;
  source: ContextRecord["source"] | null;
  metadata: Record<string, unknown> | null;
  env: Record<string, string>;
}

interface AgentRuntimeCleanupCandidate {
  context: SerializedContextSummary;
  lastSeenAt: number;
  sessionExists: boolean;
}

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
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const contexts = dbListContexts({ agentId, sessionKey, kind, includeInactive });
    const payload = {
      count: contexts.length,
      contexts: contexts.map((context) => this.serializeContextSummary(context)),
    };

    this.printPayload(payload, asJson, () => this.printContextList(payload.contexts));
    return payload;
  }

  @Command({ name: "info", description: "Show full runtime context details without exposing the context key" })
  info(
    @Arg("contextId", { description: "Context ID to inspect" }) contextId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const context = dbGetContext(contextId);
    if (!context) {
      fail(`Context not found: ${contextId}`);
    }

    const payload = this.serializeContextDetail(context);
    this.printPayload(payload, asJson, () => this.printContextRecord(payload, CONTEXT_DB_META, "Context"));
    return payload;
  }

  @Command({ name: "whoami", description: "Resolve the current runtime context" })
  whoami(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const context = this.requireResolvedContext();
    const payload = this.serializeContextDetail(context);
    this.printPayload(payload, asJson, () => this.printContextRecord(payload, RESOLVER_META, "Current Context"));
    return payload;
  }

  @Command({ name: "capabilities", description: "List inherited capabilities for the current runtime context" })
  capabilities(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const context = this.requireResolvedContext();
    const payload: ContextCapabilitiesPayload = {
      contextId: context.contextId,
      kind: context.kind,
      agentId: context.agentId ?? null,
      sessionKey: context.sessionKey ?? null,
      sessionName: context.sessionName ?? null,
      capabilities: context.capabilities,
    };

    this.printPayload(payload, asJson, () => this.printCapabilitiesPayload(payload));
    return payload;
  }

  @Command({ name: "visibility", description: "Show the current context session visibility" })
  visibility(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const context = this.requireResolvedContext();
    const session =
      (context.sessionKey ? resolveSession(context.sessionKey) : null) ??
      (context.sessionName ? resolveSession(context.sessionName) : null);
    if (!session) {
      fail("Current context is not linked to a live session.");
    }

    const payload = buildRuntimeSessionVisibilityPayload(session);
    this.printPayload(payload, asJson, () => {
      printInspectionField("Session Key", payload.sessionKey, RESOLVER_META);
      printInspectionField("Agent", payload.agentId, RESOLVER_META);
      printInspectionField("Provider", payload.provider ?? "-", RESOLVER_META);
      printInspectionField("Loaded Skills", payload.loadedSkills.length, RESOLVER_META);
      if (payload.skills.length > 0) {
        console.log(`\n${formatInspectionSection(`  Skills (${payload.skills.length})`, RESOLVER_META)}`);
        for (const skill of payload.skills) {
          console.log(`  - ${skill.id} :: ${skill.state} :: ${skill.confidence}`);
        }
      }
    });
    return payload;
  }

  @Command({ name: "check", description: "Check whether the current runtime context allows an action" })
  check(
    @Arg("permission", { description: "Permission name (e.g. execute, access, use)" }) permission: string,
    @Arg("objectType", { description: "Object type (e.g. group, session, tool)" }) objectType: string,
    @Arg("objectId", { description: "Object identifier or pattern target" }) objectId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const context = this.requireResolvedContext();
    const payload: ContextCheckPayload = {
      contextId: context.contextId,
      agentId: context.agentId ?? null,
      permission,
      objectType,
      objectId,
      allowed: canWithCapabilityContext(context, permission, objectType, objectId),
      capabilitiesCount: context.capabilities.length,
    };

    this.printPayload(payload, asJson, () => this.printCheckResult(payload));
    return payload;
  }

  @Command({ name: "authorize", description: "Request approval and extend the current runtime context if approved" })
  async authorize(
    @Arg("permission", { description: "Permission name (e.g. execute, access, use)" }) permission: string,
    @Arg("objectType", { description: "Object type (e.g. group, session, tool)" }) objectType: string,
    @Arg("objectId", { description: "Object identifier or pattern target" }) objectId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const context = this.requireResolvedContext();
    const result = await authorizeRuntimeContext({
      context,
      permission,
      objectType,
      objectId,
    });

    const payload: ContextAuthorizePayload = {
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
    };

    this.printPayload(payload, asJson, () => this.printAuthorizeResult(payload));
    return payload;
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
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const parent = this.requireResolvedContext();
    const child = issueRuntimeContext({
      parent,
      cliName,
      capabilities: parseCapabilityList(allow),
      ttlMs: parseDurationMs(ttl),
      inheritCapabilities: inherit,
    });

    const payload: ContextIssuePayload = {
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
    };

    this.printPayload(payload, asJson, () => this.printIssuedContext(payload));
    return payload;
  }

  @Command({ name: "revoke", description: "Revoke a runtime context by context ID" })
  revoke(
    @Arg("contextId", { description: "Context ID to revoke" }) contextId: string,
    @Option({
      flags: "--no-cascade",
      description: "Do not revoke descendant contexts (use only for narrow rotation; emits a loud warning)",
    })
    cascade = true,
    @Option({ flags: "--reason <text>", description: "Reason recorded in metadata for audit and forensics" })
    reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (cascade === false) {
      console.error(
        "WARNING: --no-cascade leaves descendant contexts active. Workers using child rctx_* keys will keep auth.",
      );
    }
    const result = revokeRuntimeContext(contextId, { cascade, reason });
    const payload = this.serializeRevokeResult(result.context, result.cascaded, result.revokedAt);
    this.printPayload(payload, asJson, () =>
      this.printRevokeResult(payload.context, payload.cascaded, payload.revokedAt),
    );
    return payload;
  }

  @Command({
    name: "cleanup-agent-runtime",
    description: "Dry-run or revoke stale agent-runtime contexts left by old turn-scoped issuance",
  })
  cleanupAgentRuntime(
    @Option({
      flags: "--older-than <duration>",
      description: "Only include contexts whose last use or creation is older than this duration (default: 1h)",
    })
    olderThan = "1h",
    @Option({ flags: "--agent <agentId>", description: "Filter by agent ID" }) agentId?: string,
    @Option({ flags: "--session <sessionKey>", description: "Filter by session key" }) sessionKey?: string,
    @Option({ flags: "--reason <text>", description: "Revocation reason for audit metadata" })
    reason = "agent_runtime_cleanup",
    @Option({ flags: "--revoke", description: "Actually revoke matching contexts; omitted means dry-run" })
    revoke = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const olderThanMs = parseDurationMs(olderThan);
    if (olderThanMs === undefined) {
      fail(`Invalid duration: "${olderThan}". Expected 30m, 2h or 1d`);
    }

    const now = Date.now();
    const cutoffAt = now - olderThanMs;
    const sessionKeys = new Set(listSessions().map((session) => session.sessionKey));
    const candidates = dbListContexts({
      agentId,
      sessionKey,
      kind: "agent-runtime",
      includeInactive: false,
    })
      .filter((context) => context.kind === "agent-runtime")
      .filter((context) => (agentId ? context.agentId === agentId : true))
      .filter((context) => (sessionKey ? context.sessionKey === sessionKey : true))
      .filter((context) => (context.lastUsedAt ?? context.createdAt) <= cutoffAt)
      .map((context): AgentRuntimeCleanupCandidate => {
        const key = context.sessionKey ?? "";
        return {
          context: this.serializeContextSummary(context),
          lastSeenAt: context.lastUsedAt ?? context.createdAt,
          sessionExists: key ? sessionKeys.has(key) : false,
        };
      });

    const revoked = revoke
      ? candidates.map((candidate) => {
          const result = revokeRuntimeContext(candidate.context.contextId, { reason });
          return this.serializeRevokeResult(result.context, result.cascaded, result.revokedAt);
        })
      : [];

    const payload = {
      dryRun: !revoke,
      reason: revoke ? reason : null,
      olderThan,
      olderThanMs,
      cutoffAt,
      scanned: {
        kind: "agent-runtime",
        agentId: agentId ?? null,
        sessionKey: sessionKey ?? null,
      },
      candidatesCount: candidates.length,
      revokedCount: revoked.length,
      candidates,
      revoked,
    };

    this.printPayload(payload, asJson, () => this.printAgentRuntimeCleanup(payload));
    return payload;
  }

  @Command({ name: "lineage", description: "Show ancestor chain and descendant tree for a runtime context" })
  lineage(
    @Arg("contextId", { description: "Context ID to inspect" }) contextId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const lineage = getContextLineage(contextId);
    if (!lineage) {
      fail(`Context not found: ${contextId}`);
    }

    const payload = {
      context: this.serializeContextDetail(lineage.context),
      ancestors: lineage.ancestors.map((c) => this.serializeContextSummary(c)),
      descendants: lineage.descendants.map((c) => this.serializeContextSummary(c)),
    };

    this.printPayload(payload, asJson, () => this.printLineage(payload));
    return payload;
  }

  @Command({
    name: "codex-bash-hook",
    description: "Evaluate a Codex PreToolUse Bash hook payload from stdin using the current Ravi context",
  })
  codexBashHook(@Option({ flags: "--json", description: "Print raw JSON result" }) _asJson = false) {
    const output = this.handleCodexBashHook();
    console.log(JSON.stringify(output));
    return output;
  }

  private requireResolvedContext(options: { touch?: boolean; readOnly?: boolean } = {}) {
    const inlineContext = getContext()?.context;
    if (inlineContext) {
      return inlineContext;
    }

    const contextKey = process.env[RAVI_CONTEXT_KEY_ENV];
    if (!contextKey) {
      fail(`Missing ${RAVI_CONTEXT_KEY_ENV}`);
    }

    try {
      return resolveRuntimeContextOrThrow(contextKey, {
        touch: options.touch ?? true,
        readOnly: options.readOnly,
      });
    } catch (err) {
      fail(`Failed to resolve context: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private printJson(payload: unknown): void {
    console.log(JSON.stringify(payload, null, 2));
  }

  private handleCodexBashHook(inputPayload?: Record<string, unknown>): Record<string, unknown> {
    let payload: Record<string, unknown>;
    try {
      payload = inputPayload ?? parseCodexHookPayload();
    } catch (error) {
      return buildPreToolUseDenyResult(
        `Invalid Codex hook payload: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const context = this.requireResolvedContext({ touch: false, readOnly: true });
      const toolInput = asRecord(payload.tool_input);
      const command = typeof toolInput?.command === "string" ? toolInput.command : null;
      if (!command) {
        return buildPreToolUseDenyResult("Codex hook payload is missing tool_input.command");
      }

      const decision = evaluateBashPermission(command, {
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        sessionName: context.sessionName,
        capabilities: context.capabilities,
      });

      if (!decision.allowed) {
        emitBashDeniedAudit(command, decision, context.agentId);
        return buildPreToolUseDenyResult(decision.reason ?? "Bash command denied by Ravi");
      }

      return {};
    } catch (error) {
      return buildPreToolUseDenyResult(
        `Failed to resolve Ravi context for Codex bash hook: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private printPayload(payload: unknown, asJson: boolean, printer: () => void): void {
    if (asJson) {
      this.printJson(payload);
      return;
    }
    printer();
  }

  private printContextList(contexts: SerializedContextSummary[]): void {
    if (contexts.length === 0) {
      console.log(`\n${formatInspectionSection("Contexts (0)", CONTEXT_DB_META)}\n`);
      console.log("  (none)");
      return;
    }

    console.log(`\n${formatInspectionSection(`Contexts (${contexts.length})`, CONTEXT_DB_META)}\n`);
    for (const context of contexts) {
      console.log(
        `- ${context.contextId} :: ${context.status} :: ${context.kind} :: caps=${context.capabilitiesCount}`,
      );
      console.log(
        `  agent=${context.agentId ?? "-"} session=${context.sessionName ?? context.sessionKey ?? "-"} created=${formatTimestamp(
          context.createdAt,
        )}`,
      );
      console.log(
        `  expires=${formatTimestamp(context.expiresAt)} lastUsed=${formatTimestamp(context.lastUsedAt)} revoked=${formatTimestamp(
          context.revokedAt,
        )}`,
      );
      const lineage = this.formatLineageSummary(context);
      if (lineage) {
        console.log(`  lineage=${lineage}`);
      }
    }
  }

  private printContextRecord(detail: SerializedContextDetail, meta: InspectionMeta, heading: string): void {
    console.log(`\n${heading}: ${detail.contextId}\n`);
    printInspectionField("Kind", detail.kind, meta);
    printInspectionField("Status", detail.status, DERIVED_META);
    printInspectionField("Agent", detail.agentId ?? "-", meta);
    printInspectionField("Session Key", detail.sessionKey ?? "-", meta);
    printInspectionField("Session Name", detail.sessionName ?? "-", meta);
    printInspectionField("Created", formatTimestamp(detail.createdAt), meta);
    printInspectionField("Expires", formatTimestamp(detail.expiresAt), meta);
    printInspectionField("Last Used", formatTimestamp(detail.lastUsedAt), meta);
    printInspectionField("Revoked", formatTimestamp(detail.revokedAt), meta);
    printInspectionField("Capabilities", detail.capabilitiesCount, meta);

    const lineageLines = this.formatLineageLines(detail.lineage);
    if (lineageLines.length > 0) {
      console.log(`\n${formatInspectionSection("  Lineage", DERIVED_META)}`);
      for (const line of lineageLines) {
        console.log(`    ${line}`);
      }
    }

    if (detail.source) {
      console.log(`\n${formatInspectionSection("  Source", meta)}`);
      console.log(
        `    channel=${detail.source.channel} account=${detail.source.accountId} chat=${detail.source.chatId}`,
      );
    }

    console.log(`\n${formatInspectionSection(`  Capabilities (${detail.capabilitiesCount})`, meta)}`);
    this.printCapabilitiesList(detail.capabilities);

    if (detail.metadata && Object.keys(detail.metadata).length > 0) {
      printInspectionBlock("Metadata", DERIVED_META, JSON.stringify(detail.metadata, null, 2).split("\n"), {
        indent: 2,
        labelWidth: 14,
      });
    }
  }

  private printCapabilitiesPayload(payload: ContextCapabilitiesPayload): void {
    console.log(`\nCurrent Context: ${payload.contextId}\n`);
    printInspectionField("Kind", payload.kind, RESOLVER_META);
    printInspectionField("Agent", payload.agentId ?? "-", RESOLVER_META);
    printInspectionField("Session Key", payload.sessionKey ?? "-", RESOLVER_META);
    printInspectionField("Session Name", payload.sessionName ?? "-", RESOLVER_META);
    console.log(`\n${formatInspectionSection(`  Capabilities (${payload.capabilities.length})`, RESOLVER_META)}`);
    this.printCapabilitiesList(payload.capabilities);
  }

  private printCheckResult(payload: ContextCheckPayload): void {
    console.log(`\nPermission Check: ${payload.allowed ? "allowed" : "denied"}\n`);
    printInspectionField("Context", payload.contextId, RESOLVER_META);
    printInspectionField("Agent", payload.agentId ?? "-", RESOLVER_META);
    printInspectionField("Permission", payload.permission, DERIVED_META);
    printInspectionField("Object", `${payload.objectType}:${payload.objectId}`, DERIVED_META);
    printInspectionField("Matched Caps", payload.capabilitiesCount, RESOLVER_META);
  }

  private printAuthorizeResult(payload: ContextAuthorizePayload): void {
    console.log(`\nAuthorization: ${payload.allowed ? "allowed" : "denied"}\n`);
    printInspectionField("Context", payload.contextId, RESOLVER_META);
    printInspectionField("Permission", payload.permission, DERIVED_META);
    printInspectionField("Object", `${payload.objectType}:${payload.objectId}`, DERIVED_META);
    printInspectionField("Approved", payload.approved ? "yes" : "no", DERIVED_META);
    printInspectionField("Inherited", payload.inherited ? "yes" : "no", DERIVED_META);
    printInspectionField("Reason", payload.reason ?? "-", DERIVED_META);
    printInspectionField("Capabilities", payload.capabilitiesCount, RESOLVER_META);
  }

  private printIssuedContext(payload: ContextIssuePayload): void {
    console.log(`\nIssued Context: ${payload.contextId}\n`);
    printInspectionField("Kind", payload.kind, DERIVED_META);
    printInspectionField("CLI", payload.cliName, DERIVED_META);
    printInspectionField("Agent", payload.agentId ?? "-", DERIVED_META);
    printInspectionField("Session Key", payload.sessionKey ?? "-", DERIVED_META);
    printInspectionField("Session Name", payload.sessionName ?? "-", DERIVED_META);
    printInspectionField("Parent", payload.parentContextId, DERIVED_META);
    printInspectionField("Created", formatTimestamp(payload.createdAt), DERIVED_META);
    printInspectionField("Expires", formatTimestamp(payload.expiresAt), DERIVED_META);
    console.log(`\n${formatInspectionSection(`  Capabilities (${payload.capabilitiesCount})`, DERIVED_META)}`);
    this.printCapabilitiesList(payload.capabilities);
    console.log(`\n${formatInspectionSection("  Export", DERIVED_META)}`);
    for (const [name, value] of Object.entries(payload.env)) {
      console.log(`    ${name}=${value}`);
    }
  }

  private printCapabilitiesList(capabilities: ContextCapability[]): void {
    if (capabilities.length === 0) {
      console.log("    (none)");
      return;
    }
    for (const capability of capabilities) {
      console.log(`    - ${capability.permission}:${capability.objectType}:${capability.objectId}`);
    }
  }

  private formatLineageSummary(context: SerializedContextSummary): string | null {
    const parts = [
      context.parentContextId ? `parent=${context.parentContextId}` : null,
      context.issuedFor ? `issuedFor=${context.issuedFor}` : null,
      context.issuanceMode ? `mode=${context.issuanceMode}` : null,
    ].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(" ") : null;
  }

  private formatLineageLines(lineage: ContextLineageSummary): string[] {
    return [
      lineage.parentContextId ? `parentContextId=${lineage.parentContextId}` : null,
      lineage.parentContextKind ? `parentContextKind=${lineage.parentContextKind}` : null,
      lineage.issuedFor ? `issuedFor=${lineage.issuedFor}` : null,
      lineage.issuedAt ? `issuedAt=${formatTimestamp(lineage.issuedAt)}` : null,
      lineage.issuanceMode ? `issuanceMode=${lineage.issuanceMode}` : null,
      lineage.approvalSource ? `approvalSource=${JSON.stringify(lineage.approvalSource)}` : null,
    ].filter((value): value is string => Boolean(value));
  }

  private serializeRevokeResult(
    context: ContextRecord,
    cascaded: ContextRecord[],
    revokedAt: number,
  ): { context: SerializedContextDetail; cascaded: SerializedContextSummary[]; revokedAt: number } {
    return {
      context: this.serializeContextDetail(context),
      cascaded: cascaded.map((c) => this.serializeContextSummary(c)),
      revokedAt,
    };
  }

  private printRevokeResult(
    context: SerializedContextDetail,
    cascaded: SerializedContextSummary[],
    revokedAt: number,
  ): void {
    this.printContextRecord(context, CONTEXT_DB_META, "Revoked Context");
    console.log(`\n${formatInspectionSection(`  Cascaded (${cascaded.length})`, DERIVED_META)}`);
    if (cascaded.length === 0) {
      console.log("    (none)");
    } else {
      for (const ctx of cascaded) {
        console.log(`    - ${ctx.contextId} :: ${ctx.kind} :: agent=${ctx.agentId ?? "-"}`);
      }
    }
    printInspectionField("Revoked At", formatTimestamp(revokedAt), DERIVED_META);
  }

  private printAgentRuntimeCleanup(payload: {
    dryRun: boolean;
    olderThan: string;
    cutoffAt: number;
    candidatesCount: number;
    revokedCount: number;
    candidates: AgentRuntimeCleanupCandidate[];
  }): void {
    const mode = payload.dryRun ? "dry-run" : "revoked";
    console.log(`\n${formatInspectionSection(`Agent Runtime Cleanup (${mode})`, CONTEXT_DB_META)}\n`);
    printInspectionField("Older Than", payload.olderThan, DERIVED_META);
    printInspectionField("Cutoff", formatTimestamp(payload.cutoffAt), DERIVED_META);
    printInspectionField("Candidates", payload.candidatesCount, CONTEXT_DB_META);
    printInspectionField("Revoked", payload.revokedCount, DERIVED_META);
    if (payload.candidates.length === 0) {
      console.log("\n  (none)");
      return;
    }
    console.log();
    for (const candidate of payload.candidates) {
      const context = candidate.context;
      console.log(
        `- ${context.contextId} :: agent=${context.agentId ?? "-"} session=${context.sessionName ?? context.sessionKey ?? "-"}`,
      );
      console.log(
        `  lastSeen=${formatTimestamp(candidate.lastSeenAt)} sessionExists=${candidate.sessionExists ? "yes" : "no"}`,
      );
    }
    if (payload.dryRun) {
      console.log("\nRun again with --revoke to revoke these contexts.");
    }
  }

  private printLineage(payload: {
    context: SerializedContextDetail;
    ancestors: SerializedContextSummary[];
    descendants: SerializedContextSummary[];
  }): void {
    this.printContextRecord(payload.context, CONTEXT_DB_META, "Context Lineage");
    console.log(`\n${formatInspectionSection(`  Ancestors (${payload.ancestors.length})`, DERIVED_META)}`);
    if (payload.ancestors.length === 0) {
      console.log("    (root)");
    } else {
      for (const ctx of payload.ancestors) {
        console.log(`    - ${ctx.contextId} :: ${ctx.kind} :: agent=${ctx.agentId ?? "-"}`);
      }
    }
    console.log(`\n${formatInspectionSection(`  Descendants (${payload.descendants.length})`, DERIVED_META)}`);
    if (payload.descendants.length === 0) {
      console.log("    (none)");
    } else {
      for (const ctx of payload.descendants) {
        console.log(`    - ${ctx.contextId} :: ${ctx.kind} :: status=${ctx.status} :: agent=${ctx.agentId ?? "-"}`);
      }
    }
  }

  private serializeContextSummary(context: ContextRecord): SerializedContextSummary {
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

  private serializeContextDetail(context: ContextRecord): SerializedContextDetail {
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

interface SerializedCredentialEntry {
  contextKey: string;
  contextId: string;
  agentId: string | null;
  label: string | null;
  kind: string | null;
  issuedAt: number;
  expiresAt: number | null;
  isDefault: boolean;
}

@Group({
  name: "context.credentials",
  description: "Manage the local runtime context credentials store (~/.ravi/credentials.json)",
  scope: "open",
})
export class ContextCredentialsCommands {
  @Command({ name: "list", description: "List entries in the local credentials store" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false) {
    const path = getCredentialsPath();
    const file = this.loadCredentialsOrFail(path);
    const exists = file !== null;
    const data = file ?? emptyCredentialsFile();
    const entries = serializeCredentialsFile(data);
    const payload = { path, exists, default: data.default ?? null, entries };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`\nCredentials: ${path}`);
      if (!exists) {
        console.log("  (file not yet written; run 'ravi daemon init-admin-key' or 'ravi context credentials add')");
      } else {
        console.log(`  default: ${data.default ?? "(none)"}`);
        if (entries.length === 0) {
          console.log("  (no entries)");
        } else {
          for (const entry of entries) {
            const marker = entry.isDefault ? "*" : " ";
            console.log(
              `  ${marker} ${entry.contextKey} :: ${entry.kind ?? "-"} :: agent=${entry.agentId ?? "-"} label=${entry.label ?? "-"}`,
            );
            console.log(
              `      contextId=${entry.contextId} issued=${formatTimestamp(entry.issuedAt)} expires=${formatTimestamp(
                entry.expiresAt,
              )}`,
            );
          }
        }
      }
    }
    return payload;
  }

  @Command({ name: "add", description: "Add a runtime context-key to the local credentials store" })
  add(
    @Arg("contextKey", { description: "Runtime context-key (rctx_*)" }) contextKey: string,
    @Option({ flags: "--label <label>", description: "Human label (defaults to hostname)" }) label?: string,
    @Option({ flags: "--set-default", description: "Mark this entry as the default" }) setDefault = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!contextKey.startsWith("rctx_")) {
      fail(`Expected an rctx_* key, got "${contextKey.slice(0, 8)}..."`);
    }
    const record = resolveRuntimeContextOrThrow(contextKey, { touch: false, readOnly: true });
    const path = getCredentialsPath();
    const file = this.loadCredentialsOrFail(path) ?? emptyCredentialsFile();
    const entry = {
      context_id: record.contextId,
      agent_id: record.agentId ?? "",
      label: label ?? "",
      kind: record.kind,
      issued_at: record.createdAt,
      expires_at: record.expiresAt ?? null,
    };
    const next = upsertCredentialsEntry(file, contextKey, entry, { setDefault });
    writeCredentialsFile(next, path);
    const payload = {
      path,
      default: next.default,
      added: contextKey,
    };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Stored ${contextKey} in ${payload.path}${next.default === contextKey ? " (default)" : ""}`);
    }
    return payload;
  }

  @Command({ name: "set-default", description: "Mark a stored context-key as the default" })
  setDefault(
    @Arg("contextKey", { description: "Runtime context-key (rctx_*)" }) contextKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const path = getCredentialsPath();
    const file = this.loadCredentialsOrFail(path);
    if (!file) {
      fail(`No credentials file at ${path} — add an entry first with 'ravi context credentials add'`);
    }
    if (!(contextKey in file.contexts)) {
      fail(`No credential entry for ${contextKey} — add it first with 'ravi context credentials add'`);
    }
    const next = setDefaultCredentialsEntry(file, contextKey);
    writeCredentialsFile(next, path);
    const payload = { path, default: next.default };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Default credential set to ${contextKey}`);
    }
    return payload;
  }

  @Command({ name: "remove", description: "Remove a stored context-key from the credentials store" })
  remove(
    @Arg("contextKey", { description: "Runtime context-key (rctx_*)" }) contextKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const path = getCredentialsPath();
    const file = this.loadCredentialsOrFail(path);
    if (!file || !(contextKey in file.contexts)) {
      fail(`No credential entry for ${contextKey} in ${path}`);
    }
    const contexts = { ...file.contexts };
    delete contexts[contextKey];
    const nextDefault = file.default && file.default !== contextKey ? file.default : null;
    const next: CredentialsFile = { version: file.version, default: nextDefault, contexts };
    writeCredentialsFile(next, path);
    const payload = { path, default: next.default, removed: contextKey };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Removed ${contextKey} from ${payload.path}`);
    }
    return payload;
  }

  private loadCredentialsOrFail(path: string): CredentialsFile | null {
    try {
      return readCredentialsFile(path);
    } catch (err) {
      if (err instanceof CredentialsFileError) {
        fail(err.message);
      }
      throw err;
    }
  }
}

function serializeCredentialsFile(data: CredentialsFile): SerializedCredentialEntry[] {
  const entries: SerializedCredentialEntry[] = [];
  for (const [contextKey, entry] of Object.entries(data.contexts ?? {})) {
    entries.push({
      contextKey,
      contextId: entry.context_id,
      agentId: entry.agent_id ?? null,
      label: entry.label ?? null,
      kind: entry.kind ?? null,
      issuedAt: entry.issued_at,
      expiresAt: entry.expires_at ?? null,
      isDefault: data.default === contextKey,
    });
  }
  return entries.sort((a, b) => b.issuedAt - a.issuedAt);
}

function formatTimestamp(value: number | null | undefined): string {
  return typeof value === "number" ? new Date(value).toISOString() : "-";
}

function parseCodexHookPayload(): Record<string, unknown> {
  const raw = readFileSync(0, "utf8").trim();
  if (!raw) {
    throw new Error("stdin is empty");
  }

  const parsed = JSON.parse(raw);
  return asRecord(parsed) ?? {};
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
