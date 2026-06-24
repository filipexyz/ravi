/**
 * Agents Commands - Agent management CLI
 */

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Group, Command, CommandAccess, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  agentCreateReturnSchema,
  agentDebounceReturnSchema,
  agentDebugReturnSchema,
  agentDeleteReturnSchema,
  agentInstructionSyncReturnSchema,
  agentPermissionsReturnSchema,
  agentResetReturnSchema,
  agentSessionReturnSchema,
  agentSetReturnSchema,
  agentShowReturnSchema,
  agentSpecModeReturnSchema,
  agentsListReturnSchema,
  declareCommandReturns,
} from "./operational-return-schemas.js";
import { getScopeContext, filterVisibleAgents, canViewAgent } from "../../permissions/scope.js";
import { nats } from "../../nats.js";
import {
  getAgent,
  getAllAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  setAgentDebounce,
  ensureAgentDirs,
  loadRouterConfig,
  setAgentSpecMode,
} from "../../router/config.js";
import { DmScopeSchema } from "../../router/router-db.js";
import {
  deleteSession,
  getSessionTurnUsageSummary,
  getSessionsByAgent,
  getMainSession,
  resolveSession,
  type SessionTurnUsageSummary,
} from "../../router/sessions.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "../../runtime/provider-registry.js";
import { validateRuntimeModelSelector } from "../../runtime/model-validation.js";
import { locateRuntimeTranscript } from "../../transcripts.js";
import {
  ensureAgentInstructionFiles,
  inspectAgentInstructionFiles,
  type AgentInstructionState,
} from "../../runtime/agent-instructions.js";
import { formatCliRuntimeTarget, getCliRuntimeMismatchMessage, inspectCliRuntimeTarget } from "../runtime-target.js";
import type { AgentConfig } from "../../router/types.js";
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";
import { searchTagBindingsForSelector } from "../../tags/service.js";
import type { TagBinding } from "../../tags/types.js";
import {
  buildAgentRuntimePermissionsDefaults,
  ensureAgentCanViewAgent,
  getAgentRuntimePermissionsConfigFromDefaults,
  normalizeAgentRuntimePermissionProfile,
  type AgentRuntimePermissionsConfig,
} from "../../permissions/agent-runtime-permissions-provider.js";

/** Notify gateway that config changed */
function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

function printAgentMutationTarget(): void {
  const summary = inspectCliRuntimeTarget();
  for (const line of formatCliRuntimeTarget(summary)) {
    console.log(line);
  }
}

function assertAgentMutationRuntime(allowRuntimeMismatch?: boolean): void {
  const summary = inspectCliRuntimeTarget();
  const mismatch = getCliRuntimeMismatchMessage(summary);
  if (mismatch && !allowRuntimeMismatch) {
    fail(`${mismatch}\nRe-run with the repo CLI/runtime or pass --allow-runtime-mismatch if you really mean it.`);
  }
}

interface DebugTurn {
  type: string;
  timestamp: string;
  text?: string;
  toolUse?: string;
}

interface DebugSessionSummary {
  sessionKey: string;
  name?: string;
  agentId: string;
  agentCwd: string;
  runtimeId?: string;
  runtimeProvider?: string;
  channel?: string;
  to?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  lifetimeTokens?: {
    input: number;
    output: number;
    total: number;
    context: number;
  };
  turnUsage?: SessionTurnUsageSummary;
  compactionCount?: number;
  tags: TagBinding[];
  createdAt: number;
  updatedAt: number;
}

interface AgentInstructionSyncSummary {
  agentId: string;
  cwd: string;
  before: AgentInstructionState;
  after: AgentInstructionState;
  changed: boolean;
}

type AgentJsonSummary = AgentConfig & {
  isDefault: boolean;
  effectiveProvider: string;
  tags: TagBinding[];
};

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function formatTagSlugs(tags: TagBinding[]): string {
  return tags.length > 0 ? tags.map((tag) => tag.tagSlug).join(", ") : "-";
}

function listAgentTags(agentId: string): TagBinding[] {
  return searchTagBindingsForSelector({ selector: { agent: agentId } }).bindings;
}

function listSessionTagsForSummary(session: { sessionKey: string; name?: string | null }): TagBinding[] {
  const ids = [session.name, session.sessionKey].filter((value): value is string => Boolean(value?.trim()));
  const seen = new Set<string>();
  const tags: TagBinding[] = [];
  for (const id of ids) {
    for (const binding of searchTagBindingsForSelector({ selector: { target: `session:${id}` } }).bindings) {
      const key = `${binding.tagSlug}:${binding.assetType}:${binding.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(binding);
    }
  }
  return tags;
}

function buildAgentJson(agent: AgentConfig, defaultAgent: string): AgentJsonSummary {
  return {
    ...agent,
    isDefault: agent.id === defaultAgent,
    effectiveProvider: agent.provider ?? DEFAULT_RUNTIME_PROVIDER_ID,
    tags: listAgentTags(agent.id),
  };
}

function validateAgentModelValue(providerId: string | undefined, model: string): void {
  const result = validateRuntimeModelSelector(providerId ?? DEFAULT_RUNTIME_PROVIDER_ID, model);
  if (!result.ok) {
    fail(result.error ?? `Invalid model: ${model}`);
  }
}

function parseRuntimePermissionCapabilities(value: string | undefined): AgentRuntimePermissionsConfig["capabilities"] {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (!raw) return [];
  return raw.split(",").map((entry) => {
    const parts = entry.trim().split(":");
    if (parts.length < 3) {
      fail(`Invalid capability '${entry}'. Expected permission:objectType:objectId`);
    }
    const [permission, objectType, ...objectIdParts] = parts;
    const objectId = objectIdParts.join(":").trim();
    if (!permission?.trim() || !objectType?.trim() || !objectId) {
      fail(`Invalid capability '${entry}'. Expected permission:objectType:objectId`);
    }
    return {
      permission: permission.trim(),
      objectType: objectType.trim(),
      objectId,
    };
  });
}

function describeRuntimePermissionConfig(config: AgentRuntimePermissionsConfig | null): string {
  if (!config) return "bootstrap";
  const parts = [config.profile ?? "custom"];
  if (config.capabilities?.length) {
    parts.push(`${config.capabilities.length} explicit`);
  }
  return parts.join(" + ");
}

function sessionLifetimeTokens(session: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}): number {
  return session.totalTokens ?? (session.inputTokens ?? 0) + (session.outputTokens ?? 0);
}

function formatTokenCount(value: number | null | undefined): string {
  return Math.round(value ?? 0).toLocaleString("en-US");
}

function formatDurationMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatCostUsd(value: number | null | undefined): string {
  const n = value ?? 0;
  if (n <= 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function buildDebugSessionSummary(session: {
  sessionKey: string;
  name?: string | null;
  agentId: string;
  agentCwd: string;
  providerSessionId?: string | null;
  sdkSessionId?: string | null;
  runtimeProvider?: string | null;
  lastChannel?: string | null;
  lastTo?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  contextTokens?: number | null;
  compactionCount?: number | null;
  createdAt: number;
  updatedAt: number;
}): DebugSessionSummary {
  const input = session.inputTokens ?? 0;
  const output = session.outputTokens ?? 0;
  const context = session.contextTokens ?? 0;
  const turnUsage = getSessionTurnUsageSummary(session.sessionKey);
  return {
    sessionKey: session.sessionKey,
    ...(session.name ? { name: session.name } : {}),
    agentId: session.agentId,
    agentCwd: session.agentCwd,
    ...((session.providerSessionId ?? session.sdkSessionId)
      ? { runtimeId: session.providerSessionId ?? session.sdkSessionId ?? undefined }
      : {}),
    ...(session.runtimeProvider ? { runtimeProvider: session.runtimeProvider } : {}),
    ...(session.lastChannel ? { channel: session.lastChannel } : {}),
    ...(session.lastTo ? { to: session.lastTo } : {}),
    ...(session.inputTokens !== undefined && session.inputTokens !== null ? { inputTokens: session.inputTokens } : {}),
    ...(session.outputTokens !== undefined && session.outputTokens !== null
      ? { outputTokens: session.outputTokens }
      : {}),
    ...(session.totalTokens !== undefined && session.totalTokens !== null ? { totalTokens: session.totalTokens } : {}),
    ...(session.contextTokens !== undefined && session.contextTokens !== null
      ? { contextTokens: session.contextTokens }
      : {}),
    lifetimeTokens: {
      input,
      output,
      total: session.totalTokens ?? input + output,
      context,
    },
    turnUsage,
    ...(session.compactionCount !== undefined && session.compactionCount !== null
      ? { compactionCount: session.compactionCount }
      : {}),
    tags: listSessionTagsForSummary(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function parseTranscriptEntries(raw: string): { parsedEntries: Record<string, unknown>[]; turns: DebugTurn[] } {
  const lines = raw.trim().split("\n").filter(Boolean);
  const parsedEntries: Record<string, unknown>[] = [];
  const turns: DebugTurn[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, any>;
      parsedEntries.push(entry);

      if (entry.type === "user" && entry.message?.content) {
        const content =
          typeof entry.message.content === "string"
            ? entry.message.content
            : JSON.stringify(entry.message.content).slice(0, 200);
        turns.push({
          type: "user",
          timestamp: entry.timestamp ?? "",
          text: content.slice(0, 300),
        });
      } else if (entry.type === "assistant" && entry.message?.content) {
        const parts = entry.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>;
        const textParts = parts
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { text?: string }) => p.text ?? "");
        const toolParts = parts
          .filter((p: { type: string }) => p.type === "tool_use")
          .map((p: { name?: string; input?: unknown }) => `${p.name}(${JSON.stringify(p.input).slice(0, 100)})`);

        turns.push({
          type: "assistant",
          timestamp: entry.timestamp ?? "",
          text: textParts.join(" ").slice(0, 300) || undefined,
          toolUse: toolParts.join(", ").slice(0, 200) || undefined,
        });
      }
    } catch {
      // skip malformed lines
    }
  }

  return { parsedEntries, turns };
}

@Group({
  name: "agents",
  description: "Agent management",
})
export class AgentsCommands {
  @Command({ name: "list", description: "List all agents" })
  @CommandAccess({ kind: "read", resource: "agents", action: "list", risk: "low" })
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical tag slug" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching agents to skip (default: 0)" }) offset?: string,
  ) {
    const ctx = getScopeContext();
    const agents = filterItemsByCanonicalTag(
      filterVisibleAgents(ctx, getAllAgents()),
      "agent",
      tagSlug,
      (agent) => agent.id,
    );
    const config = loadRouterConfig();
    const page = paginateCliItems(agents, { limit, offset });
    const pageAgents = page.items;
    const agentRows = pageAgents.map((agent) => buildAgentJson(agent, config.defaultAgent));
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "agents", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: agentRows.length,
      total: page.total,
      options: ["--tag", tagSlug?.trim() || null],
    });
    const payload = {
      total: page.total,
      pagination,
      defaultAgent: config.defaultAgent,
      filters: {
        tag: tagSlug?.trim() || null,
      },
      items: agentRows,
      agents: agentRows,
    };

    if (asJson) {
      printJson(payload);
    } else if (pageAgents.length === 0) {
      console.log("No agents configured.");
      console.log("\nCreate an agent: ravi agents create <id> <cwd>");
    } else {
      console.log("\nAgents:\n");
      console.log("  ID              CWD                          TAGS");
      console.log("  --------------  ---------------------------  ---------------------------");

      for (const agent of agentRows) {
        const isDefault = agent.id === config.defaultAgent;
        const id = (agent.id + (isDefault ? " *" : "")).padEnd(14);
        const cwd = agent.cwd.padEnd(27);

        console.log(`  ${id}  ${cwd}  ${formatTagSlugs(agent.tags)}`);
      }

      console.log(
        `\n  Total: ${page.total} (${agentRows.length} returned, limit ${page.limit}, offset ${page.offset}; * = default)`,
      );
      if (pagination.nextCommand) {
        console.log("\n  Next page:");
        console.log(`    ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show agent details" })
  @CommandAccess({ kind: "read", resource: "agents", action: "show", risk: "low" })
  show(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ctx = getScopeContext();
    if (!canViewAgent(ctx, id)) {
      fail(`Agent not found: ${id}`);
    }
    const agent = getAgent(id);
    const config = loadRouterConfig();

    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const isDefault = agent.id === config.defaultAgent;
    const runtimePermissions = getAgentRuntimePermissionsConfigFromDefaults(agent.defaults);
    const payload = {
      agent: buildAgentJson(agent, config.defaultAgent),
      runtimePermissions,
      permissionsCommand: `ravi agents permissions ${agent.id}`,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nAgent: ${agent.id}${isDefault ? " (default)" : ""}`);
      console.log(`  Name:          ${agent.name || "-"}`);
      console.log(`  CWD:           ${agent.cwd}`);
      console.log(`  Model:         ${agent.model || "-"}`);
      console.log(`  Provider:      ${agent.provider || DEFAULT_RUNTIME_PROVIDER_ID}`);
      console.log(`  DM Scope:      ${agent.dmScope || "-"}`);
      console.log(`  Mode:          ${agent.mode ?? "active"}`);
      console.log(`  Permissions:   ${describeRuntimePermissionConfig(runtimePermissions)}`);
      console.log(`  Debounce:      ${agent.debounceMs ? `${agent.debounceMs}ms` : "disabled"}`);
      console.log(`  Group Debounce:${agent.groupDebounceMs ? ` ${agent.groupDebounceMs}ms` : " -"}`);
      console.log(`  Matrix:        ${agent.matrixAccount || "-"}`);

      console.log(`  Spec Mode:     ${agent.specMode ? "enabled" : "disabled"}`);
      console.log(`  Tags:          ${formatTagSlugs(payload.agent.tags)}`);
      console.log(`  Permissions:   ravi agents permissions ${agent.id}`);

      if (agent.remote) {
        console.log(`  Remote:        ${agent.remote}${agent.remoteUser ? ` (user: ${agent.remoteUser})` : ""}`);
      }

      if (agent.defaults && Object.keys(agent.defaults).length > 0) {
        console.log(`  Defaults:      ${JSON.stringify(agent.defaults)}`);
      }

      if (agent.systemPromptAppend) {
        console.log(`  System Append: ${agent.systemPromptAppend.slice(0, 50)}...`);
      }
    }
    return payload;
  }

  @Command({ name: "create", description: "Create a new agent" })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "create", risk: "medium" })
  create(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("cwd", { description: "Working directory" }) cwd: string,
    @Option({ flags: "--provider <provider>", description: "Runtime provider id" }) provider?: string,
    @Option({ flags: "--model <model>", description: "Runtime model selector" }) model?: string,
    @Option({
      flags: "--allow-runtime-mismatch",
      description: "Allow mutation even when the CLI bundle differs from the live daemon runtime",
    })
    allowRuntimeMismatch?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalizedProvider = provider?.trim() || undefined;
    const normalizedModel = model?.trim() || undefined;
    if (normalizedModel) validateAgentModelValue(normalizedProvider, normalizedModel);
    assertAgentMutationRuntime(allowRuntimeMismatch);

    try {
      createAgent({
        id,
        cwd,
        ...(normalizedProvider ? { provider: normalizedProvider } : {}),
        ...(normalizedModel ? { model: normalizedModel } : {}),
      });
      const creatorAgentId = getScopeContext()?.agentId;
      const creatorVisibilityChanged =
        creatorAgentId && creatorAgentId !== id ? ensureAgentCanViewAgent(creatorAgentId, id) : false;

      // Ensure directory exists
      const config = loadRouterConfig();
      ensureAgentDirs(config);
      ensureAgentInstructionFiles(cwd.replace("~", homedir()), {
        createAgentsStub: `# ${id}\n\nInstruções do agente aqui.\n`,
      });

      const createdAgent =
        getAgent(id) ??
        ({
          id,
          cwd,
          ...(normalizedProvider ? { provider: normalizedProvider } : {}),
          ...(normalizedModel ? { model: normalizedModel } : {}),
        } as AgentConfig);
      const payload = {
        action: "create" as const,
        changed: true as const,
        agent: buildAgentJson(createdAgent, config.defaultAgent),
        runtimeTarget: inspectCliRuntimeTarget(),
        permissions: {
          default: "bootstrap" as const,
          configureCommand: `ravi agents permissions ${id}`,
          inspectCommand: `ravi permissions materialize --subject-type agent --subject-id ${id} --json`,
          leastPrivilegeExample: `ravi agents permissions ${id} bootstrap --capabilities <permission>:<objectType>:<objectId>`,
          breakGlassCommand: `ravi agents permissions ${id} full-access`,
          visibility: {
            defaultAgent: config.defaultAgent,
            ...(creatorAgentId ? { creatorAgentId, creatorVisibilityChanged } : {}),
          },
        },
      };
      if (asJson) {
        printJson(payload);
      } else {
        printAgentMutationTarget();
        console.log(`\u2713 Agent created: ${id}`);
        console.log(`  CWD: ${cwd}`);
        if (normalizedProvider) {
          console.log(`  Provider: ${normalizedProvider}`);
        }
        if (normalizedModel) {
          console.log(`  Model: ${normalizedModel}`);
        }
        console.log(`  Permissions: bootstrap`);
        console.log(`  Inspect: ravi permissions materialize --subject-type agent --subject-id ${id} --json`);
        console.log(
          `  Configure least privilege: ravi agents permissions ${id} bootstrap --capabilities <permission>:<objectType>:<objectId>`,
        );
        console.log(`  Break-glass only: ravi agents permissions ${id} full-access`);
      }
      emitConfigChanged();
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "sync-instructions", description: "Migrate agent workspaces to AGENTS.md as the canonical file" })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "sync-instructions", risk: "high" })
  syncInstructions(
    @Option({ flags: "--agent <id>", description: "Sync only one agent" }) agentId?: string,
    @Option({
      flags: "--materialize-missing",
      description: "Create a default AGENTS.md stub when both instruction files are missing",
    })
    materializeMissing?: boolean,
    @Option({ flags: "--json", description: "Print machine-readable output" }) json?: boolean,
  ) {
    const ctx = getScopeContext();
    const visibleAgents = filterVisibleAgents(ctx, getAllAgents());
    const selectedAgents = agentId ? visibleAgents.filter((agent) => agent.id === agentId) : visibleAgents;

    if (agentId && selectedAgents.length === 0) {
      fail(`Agent not found: ${agentId}`);
    }

    const results: AgentInstructionSyncSummary[] = selectedAgents.map((agent) => {
      const cwd = agent.cwd.replace("~", homedir());
      const before = inspectAgentInstructionFiles(cwd);
      ensureAgentInstructionFiles(
        cwd,
        materializeMissing && before.state === "missing-both"
          ? { createAgentsStub: `# ${agent.id}\n\nInstruções do agente aqui.\n` }
          : {},
      );
      const after = inspectAgentInstructionFiles(cwd);

      return {
        agentId: agent.id,
        cwd,
        before: before.state,
        after: after.state,
        changed: before.state !== after.state,
      };
    });

    const migrated = results.filter((result) => result.changed && result.after === "agents-canonical");
    const alreadyCanonical = results.filter((result) => !result.changed && result.after === "agents-canonical");
    const missing = results.filter((result) => result.after === "missing-both");
    const manualReview = results.filter(
      (result) =>
        result.after !== "agents-canonical" && result.after !== "missing-both" && result.after !== "agents-only",
    );
    const incomplete = results.filter(
      (result) =>
        result.after === "agents-only" || result.after === "claude-only" || result.after === "agents-bridge-only",
    );

    const payload = {
      total: results.length,
      migrated: migrated.length,
      alreadyCanonical: alreadyCanonical.length,
      missing: missing.length,
      manualReview: manualReview.length,
      incomplete: incomplete.length,
      results,
    };

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log("\nInstruction sync summary:\n");
      console.log(`  Migrated:          ${migrated.length}`);
      console.log(`  Already canonical: ${alreadyCanonical.length}`);
      console.log(`  Missing files:     ${missing.length}`);
      console.log(`  Manual review:     ${manualReview.length}`);
      console.log(`  Incomplete:        ${incomplete.length}`);

      for (const result of [...migrated, ...missing, ...manualReview, ...incomplete]) {
        console.log(`\n  ${result.agentId}`);
        console.log(`    ${result.cwd}`);
        console.log(`    ${result.before} -> ${result.after}`);
      }
    }
    return payload;
  }

  @Command({ name: "delete", description: "Delete an agent" })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "delete", risk: "destructive" })
  delete(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const before = getAgent(id);
      const deleted = deleteAgent(id);
      if (deleted) {
        const payload = {
          action: "delete" as const,
          changed: true as const,
          agentId: id,
          before,
        };
        if (asJson) {
          printJson(payload);
        } else {
          console.log(`\u2713 Agent deleted: ${id}`);
        }
        emitConfigChanged();
        return payload;
      }
      fail(`Agent not found: ${id}`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set agent property" })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "set", risk: "medium" })
  async set(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("key", { description: "Property key" }) key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const validKeys = [
      "name",
      "cwd",
      "model",
      "provider",
      "dmScope",
      "systemPromptAppend",
      "matrixAccount",
      "settingSources",
      "mode",
      "groupDebounceMs",
      "defaults",
      "remote",
      "remoteUser",
    ];
    if (!validKeys.includes(key)) {
      fail(`Invalid key: ${key}. Valid keys: ${validKeys.join(", ")}`);
    }

    // Parse groupDebounceMs as integer
    if (key === "groupDebounceMs") {
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed < 0) {
        fail(`Invalid groupDebounceMs: ${value}. Must be a positive integer (ms) or 0 to disable`);
      }
      try {
        updateAgent(id, { groupDebounceMs: parsed === 0 ? undefined : parsed });
        const debouncePayload = {
          action: "set" as const,
          changed: true as const,
          agentId: id,
          key,
          value: parsed === 0 ? null : parsed,
          agent: getAgent(id),
        };
        if (asJson) {
          printJson(debouncePayload);
        } else {
          console.log(
            parsed === 0
              ? `\u2713 groupDebounceMs disabled: ${id}`
              : `\u2713 groupDebounceMs set: ${id} -> ${parsed}ms`,
          );
        }
        emitConfigChanged();
        return debouncePayload;
      } catch (err) {
        fail(`Error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Validate dmScope values
    if (key === "dmScope") {
      const result = DmScopeSchema.safeParse(value);
      if (!result.success) {
        fail(`Invalid dmScope: ${value}. Valid scopes: ${DmScopeSchema.options.join(", ")}`);
      }
    }

    // Provider ids are intentionally open; runtime registration decides whether an id can execute.
    if (key === "model") {
      validateAgentModelValue(agent.provider, value);
    }
    if (key === "provider" && agent.model) {
      validateAgentModelValue(value, agent.model);
    }

    // Validate matrixAccount (will be validated in updateAgent, but give better error)
    if (key === "matrixAccount" && value !== "null" && value !== "") {
      const { dbGetMatrixAccount } = await import("../../router/router-db.js");
      const account = dbGetMatrixAccount(value);
      if (!account) {
        fail(`Matrix account not found: ${value}. Run: ravi matrix users-list`);
      }
    }

    // Validate mode values
    if (key === "mode") {
      if (value !== "active" && value !== "sentinel") {
        fail(`Invalid mode: ${value}. Valid modes: active, sentinel`);
      }
    }

    // Validate remote (VMID, hostname/IP, or worker:<id>)
    if (key === "remote" && !/^(worker:[a-zA-Z0-9.\-_]+|[a-zA-Z0-9.\-_]+)$/.test(value)) {
      fail(`Invalid remote: ${value}. Must be a VMID, hostname/IP, or worker:<id>`);
    }

    // Validate remoteUser (Unix username)
    if (key === "remoteUser" && !/^[a-zA-Z0-9._-]+$/.test(value)) {
      fail(`Invalid remoteUser: ${value}. Must be a valid Unix username`);
    }

    // Parse settingSources as JSON array
    let parsedValue: unknown = value;
    if (key === "settingSources") {
      try {
        parsedValue = JSON.parse(value);
        if (!Array.isArray(parsedValue)) {
          fail(`settingSources must be an array, e.g. '["user", "project"]'`);
        }
        const valid = ["user", "project"];
        for (const s of parsedValue) {
          if (!valid.includes(s)) {
            fail(`Invalid settingSource: ${s}. Valid values: ${valid.join(", ")}`);
          }
        }
      } catch {
        fail(`settingSources must be valid JSON array, e.g. '["user", "project"]'`);
      }
    }

    // Parse defaults as JSON object
    if (key === "defaults") {
      try {
        parsedValue = JSON.parse(value);
        if (typeof parsedValue !== "object" || parsedValue === null || Array.isArray(parsedValue)) {
          fail(`defaults must be a JSON object, e.g. '{"tts_voice":"abc","image_mode":"fast"}'`);
        }
      } catch {
        fail(`defaults must be valid JSON object, e.g. '{"tts_voice":"abc","image_mode":"fast"}'`);
      }
    }

    try {
      updateAgent(id, { [key]: parsedValue });
      if (key === "cwd" || key === "provider") {
        ensureAgentDirs(loadRouterConfig());
      }
      const payload = {
        action: "set" as const,
        changed: true as const,
        agentId: id,
        key,
        value: parsedValue,
        agent: getAgent(id),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(
          `\u2713 ${key} set: ${id} -> ${typeof parsedValue === "string" ? parsedValue : JSON.stringify(parsedValue)}`,
        );
      }
      emitConfigChanged();
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "permissions", description: "Set or show an agent runtime permission profile" })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "permissions", risk: "high" })
  permissions(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("profile", { required: false, description: "Profile: bootstrap, full-access, none" }) profile?: string,
    @Option({
      flags: "--capabilities <list>",
      description: "Comma-separated explicit capabilities (permission:objectType:objectId)",
    })
    capabilitiesInput?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--clear-capabilities", description: "Remove explicit capabilities while preserving profile" })
    clearCapabilities?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const before = getAgentRuntimePermissionsConfigFromDefaults(agent.defaults);
    if (clearCapabilities && capabilitiesInput !== undefined) {
      fail("Use either --capabilities or --clear-capabilities, not both");
    }
    const explicitCapabilities = clearCapabilities ? [] : parseRuntimePermissionCapabilities(capabilitiesInput);

    if (profile === undefined && explicitCapabilities === undefined) {
      const payload = {
        action: "permissions" as const,
        changed: false as const,
        agentId: id,
        profile: before?.profile ?? "bootstrap",
        runtimePermissions: before,
        command: `ravi agents permissions ${id}`,
        inspectCommand: `ravi permissions materialize --subject-type agent --subject-id ${id} --json`,
        leastPrivilegeExample: `ravi agents permissions ${id} bootstrap --capabilities <permission>:<objectType>:<objectId>`,
        breakGlassCommand: `ravi agents permissions ${id} full-access`,
        agent: buildAgentJson(agent, loadRouterConfig().defaultAgent),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`Runtime permissions for ${id}: ${describeRuntimePermissionConfig(before)}`);
        console.log(`  Inspect effective: ravi permissions materialize --subject-type agent --subject-id ${id} --json`);
        console.log(
          `  Least privilege:   ravi agents permissions ${id} bootstrap --capabilities <permission>:<objectType>:<objectId>`,
        );
        console.log(`  Clear:             ravi agents permissions ${id} none`);
        console.log(`  Break-glass only:  ravi agents permissions ${id} full-access`);
      }
      return payload;
    }

    const normalizedProfile = profile === undefined ? before?.profile : normalizeAgentRuntimePermissionProfile(profile);
    if (profile !== undefined && normalizedProfile === null) {
      fail(`Invalid runtime permission profile: ${profile}. Valid profiles: bootstrap, full-access, none`);
    }

    const nextConfig =
      normalizedProfile === "none"
        ? null
        : {
            ...(before ?? {}),
            ...(normalizedProfile ? { profile: normalizedProfile } : {}),
          };
    if (nextConfig && explicitCapabilities !== undefined) {
      if (explicitCapabilities.length > 0) {
        nextConfig.capabilities = explicitCapabilities;
      } else {
        delete nextConfig.capabilities;
      }
    }
    const after: AgentRuntimePermissionsConfig | null =
      nextConfig && Object.keys(nextConfig).length > 0 ? nextConfig : null;

    const nextDefaults = buildAgentRuntimePermissionsDefaults(agent.defaults, after);
    updateAgent(id, { defaults: nextDefaults });
    const updated = getAgent(id) ?? { ...agent, defaults: nextDefaults };
    const payload = {
      action: "permissions" as const,
      changed: true as const,
      agentId: id,
      before,
      after,
      defaults: nextDefaults ?? null,
      agent: buildAgentJson(updated, loadRouterConfig().defaultAgent),
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\u2713 Runtime permissions set: ${id} -> ${describeRuntimePermissionConfig(after)}`);
      if (after?.profile === "full-access") {
        console.log("  Break-glass: materializes admin system:* for the agent and its own automation turns");
        console.log(
          "  Prefer replacing this with a provider-owned permission profile or narrow explicit capabilities.",
        );
      }
    }
    emitConfigChanged();
    return payload;
  }

  @Command({ name: "debounce", description: "Set message debounce time" })
  @CommandAccess({ kind: "read", resource: "agents", action: "debounce", risk: "low" })
  debounce(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("ms", { required: false, description: "Debounce time in ms (0 to disable)" }) ms?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    // No ms = show current debounce
    if (ms === undefined) {
      const current = agent.debounceMs;
      const showPayload = {
        agentId: id,
        debounceMs: current && current > 0 ? current : null,
        enabled: Boolean(current && current > 0),
      };
      if (asJson) {
        printJson(showPayload);
      } else {
        if (current && current > 0) {
          console.log(`\nDebounce for agent: ${id}`);
          console.log(`  Time: ${current}ms`);
          console.log(`\nMessages arriving within ${current}ms will be grouped.`);
        } else {
          console.log(`\nDebounce for agent: ${id}`);
          console.log("  Status: disabled");
        }
        console.log("\nUsage:");
        console.log("  ravi agents debounce <id> <ms>   # Set debounce time");
        console.log("  ravi agents debounce <id> 0      # Disable debounce");
        console.log("\nExamples:");
        console.log("  ravi agents debounce main 2000   # Group messages within 2 seconds");
        console.log("  ravi agents debounce main 500    # Group messages within 500ms");
      }
      return showPayload;
    }

    const debounceMs = parseInt(ms, 10);
    if (Number.isNaN(debounceMs) || debounceMs < 0) {
      fail(`Invalid debounce time: ${ms}. Must be a positive integer (ms) or 0 to disable`);
    }

    try {
      setAgentDebounce(id, debounceMs);
      const setPayload = {
        action: "set-debounce" as const,
        changed: true,
        agentId: id,
        debounceMs: debounceMs === 0 ? null : debounceMs,
        enabled: debounceMs > 0,
      };
      if (asJson) {
        printJson(setPayload);
      } else {
        if (debounceMs === 0) {
          console.log(`✓ Debounce disabled: ${id}`);
        } else {
          console.log(`✓ Debounce set: ${id} -> ${debounceMs}ms`);
        }
      }
      return setPayload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "spec-mode", description: "Enable or disable spec mode for an agent" })
  @CommandAccess({ kind: "read", resource: "agents", action: "spec-mode", risk: "low" })
  specMode(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("enabled", { required: false, description: "true/false" }) enabled?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    if (enabled === undefined) {
      const showPayload = {
        agentId: id,
        specMode: Boolean(agent.specMode),
      };
      if (asJson) {
        printJson(showPayload);
      } else {
        console.log(`\nSpec mode for agent: ${id}`);
        console.log(`  Status: ${agent.specMode ? "enabled" : "disabled"}`);
        console.log("\nUsage:");
        console.log("  ravi agents spec-mode <id> true    # Enable spec mode");
        console.log("  ravi agents spec-mode <id> false   # Disable spec mode");
      }
      return showPayload;
    }

    if (enabled !== "true" && enabled !== "false") {
      fail(`Invalid value: ${enabled}. Must be 'true' or 'false'`);
    }

    const value = enabled === "true";
    try {
      setAgentSpecMode(id, value);
      const setPayload = {
        action: "set-spec-mode" as const,
        changed: true,
        agentId: id,
        specMode: value,
      };
      if (asJson) {
        printJson(setPayload);
      } else {
        console.log(`✓ Spec mode ${value ? "enabled" : "disabled"}: ${id}`);
      }
      emitConfigChanged();
      return setPayload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "session", description: "Show agent session status" })
  @CommandAccess({ kind: "read", resource: "agents", action: "session", risk: "low" })
  session(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const sessions = getSessionsByAgent(id);
    const payload = {
      agent: buildAgentJson(agent, loadRouterConfig().defaultAgent),
      total: sessions.length,
      sessions: sessions.map(buildDebugSessionSummary),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(`\n📋 Sessions for agent: ${id}\n`);

    if (sessions.length === 0) {
      console.log("  No active sessions");
      console.log(`\n  Start a session with: ravi agents run ${id} "hello"`);
      return payload;
    }

    for (const session of sessions) {
      const turnUsage = getSessionTurnUsageSummary(session.sessionKey);
      const lifetimeTokens = sessionLifetimeTokens(session);
      const effectiveContextTokens =
        session.contextTokens && session.contextTokens > 0
          ? session.contextTokens
          : (turnUsage.lastTurn?.effectiveContextTokens ?? 0);
      const updated = new Date(session.updatedAt).toLocaleString();

      console.log(`  ${session.name ?? session.sessionKey}`);
      console.log(`    Runtime: ${session.providerSessionId ?? session.sdkSessionId ?? "(none)"}`);
      console.log(`    Lifetime tokens: ${formatTokenCount(lifetimeTokens)}`);
      console.log(`    Effective context: ${formatTokenCount(effectiveContextTokens)}`);
      if (turnUsage.lastTurn) {
        console.log(
          `    Last turn: context=${formatTokenCount(turnUsage.lastTurn.effectiveContextTokens)} input=${formatTokenCount(turnUsage.lastTurn.inputTokens)} cache=${formatTokenCount(turnUsage.lastTurn.cacheReadTokens + turnUsage.lastTurn.cacheCreationTokens)} output=${formatTokenCount(turnUsage.lastTurn.outputTokens)} duration=${formatDurationMs(turnUsage.lastTurn.durationMs)}`,
        );
      }
      if (turnUsage.recent.completeTurns > 0) {
        console.log(
          `    Recent 24h: turns=${turnUsage.recent.completeTurns} avgContext=${formatTokenCount(turnUsage.recent.effectiveContextTokensAvg)} maxContext=${formatTokenCount(turnUsage.recent.effectiveContextTokensMax)} avgInput=${formatTokenCount(turnUsage.recent.inputTokensAvg)} cost=${formatCostUsd(turnUsage.recent.costUsdTotal)}`,
        );
      }
      console.log(`    Updated: ${updated}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "reset", description: "Reset agent session" })
  @CommandAccess({ kind: "mutate", resource: "agents", action: "reset", risk: "medium" })
  async reset(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("nameOrKey", { required: false, description: "Session name/key, 'all' to reset all, or omit for main" })
    nameOrKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    // Helper: abort SDK session + delete from DB
    const resetOne = async (key: string, name?: string): Promise<boolean> => {
      // Abort SDK streaming session in daemon (use session name for topic)
      const abortRequest = {
        sessionKey: key,
        ...(name ? { sessionName: name } : {}),
        source: "cli",
        action: "agents.reset-session",
        reason: "cli_agent_session_reset",
        actor: "cli",
      };
      await nats.emit("ravi.session.abort", abortRequest);
      return deleteSession(key);
    };

    // Reset all sessions for this agent
    if (nameOrKey === "all") {
      const sessions = getSessionsByAgent(id);
      if (sessions.length === 0) {
        const emptyPayload = {
          action: "reset" as const,
          changed: false,
          agentId: id,
          target: "all" as const,
          resetSessions: [],
          count: 0,
        };
        if (asJson) {
          printJson(emptyPayload);
        } else {
          console.log(`ℹ️  No sessions to reset for agent: ${id}`);
        }
        return emptyPayload;
      }
      let count = 0;
      const resetSessions: Array<{ sessionKey: string; name?: string; deleted: boolean }> = [];
      for (const s of sessions) {
        const deleted = await resetOne(s.sessionKey, s.name);
        if (deleted) count++;
        resetSessions.push({
          sessionKey: s.sessionKey,
          ...(s.name ? { name: s.name } : {}),
          deleted,
        });
      }
      const allPayload = {
        action: "reset" as const,
        changed: count > 0,
        agentId: id,
        target: "all" as const,
        resetSessions,
        count,
      };
      if (asJson) {
        printJson(allPayload);
      } else {
        console.log(`✅ Reset ${count} session${count !== 1 ? "s" : ""} for agent: ${id}`);
      }
      return allPayload;
    }

    // Resolve by name, or find main session
    let session;
    if (nameOrKey) {
      session = resolveSession(nameOrKey);
    } else {
      session = getMainSession(id);
    }

    if (session) {
      const deleted = await resetOne(session.sessionKey, session.name);
      const label = session.name ?? session.sessionKey;
      const sessionPayload = {
        action: "reset" as const,
        changed: deleted,
        agentId: id,
        target: nameOrKey ?? "main",
        session: buildDebugSessionSummary(session),
      };
      if (asJson) {
        printJson(sessionPayload);
      } else {
        if (deleted) {
          console.log(`✅ Session reset: ${label}`);
        } else {
          console.log(`ℹ️  Session already clean: ${label}`);
        }
      }
      return sessionPayload;
    } else {
      // Show available sessions as hint
      const sessions = getSessionsByAgent(id);
      const notFoundPayload = {
        action: "reset" as const,
        changed: false,
        agentId: id,
        target: nameOrKey ?? "main",
        reason: "not_found" as const,
        availableSessions: sessions.map((s) => s.name ?? s.sessionKey),
      };
      if (asJson) {
        printJson(notFoundPayload);
      } else {
        if (sessions.length > 0) {
          console.log(`ℹ️  No session found: ${nameOrKey ?? "(main)"}`);
          console.log(`\n  Available sessions for ${id}:`);
          for (const s of sessions) {
            console.log(`    ${s.name ?? s.sessionKey}`);
          }
          console.log(`\n  Usage:`);
          console.log(`    ravi agents reset ${id} <name>   Reset specific session`);
          console.log(`    ravi agents reset ${id} all      Reset all sessions`);
        } else {
          console.log(`ℹ️  No sessions to reset for agent: ${id}`);
        }
      }
      return notFoundPayload;
    }
  }

  @Command({ name: "debug", description: "Show last turns of an agent session (what it received, what it responded)" })
  @CommandAccess({ kind: "read", resource: "agents", action: "debug", risk: "low" })
  debug(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("nameOrKey", { required: false, description: "Session name/key (omit for main)" }) nameOrKey?: string,
    @Option({ flags: "-n, --turns <count>", description: "Number of recent turns to show (default: 5)" })
    turnsStr?: string,
    @Option({ flags: "--json", description: "Output raw debug data as JSON" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    let session;
    if (nameOrKey) {
      session = resolveSession(nameOrKey);
    } else {
      session = getMainSession(id);
    }

    if (!session) {
      const sessions = getSessionsByAgent(id);
      const notFoundPayload = {
        error: `No session found: ${nameOrKey ?? "(main)"}` as const,
        agentId: id,
        availableSessions: sessions.map((s) => s.name ?? s.sessionKey),
      };
      if (asJson) {
        console.log(JSON.stringify(notFoundPayload));
      } else {
        console.log(`ℹ️  No session found: ${nameOrKey ?? "(main)"}`);
        if (sessions.length > 0) {
          console.log(`\n  Available sessions for ${id}:`);
          for (const s of sessions) {
            console.log(`    ${s.name ?? s.sessionKey}`);
          }
        }
      }
      return notFoundPayload;
    }

    const maxTurns = parseInt(turnsStr ?? "5", 10);
    const sessionSummary = buildDebugSessionSummary(session);

    if (!asJson) {
      // Session metadata
      console.log(`\n🔍 Debug: ${session.name ?? session.sessionKey}\n`);
      console.log(`  Agent:       ${session.agentId}`);
      console.log(`  CWD:         ${session.agentCwd}`);
      console.log(`  Runtime ID:  ${session.providerSessionId ?? session.sdkSessionId ?? "(none)"}`);
      console.log(`  Channel:     ${session.lastChannel ?? "-"} → ${session.lastTo ?? "-"}`);
      console.log(
        `  Lifetime:    in=${session.inputTokens} out=${session.outputTokens} total=${session.totalTokens} ctx=${session.contextTokens}`,
      );
      console.log(`  Compactions:  ${session.compactionCount}`);
      console.log(`  Created:     ${new Date(session.createdAt).toLocaleString()}`);
      console.log(`  Updated:     ${new Date(session.updatedAt).toLocaleString()}`);
    }

    // Try to read provider transcript
    const providerSessionId = session.providerSessionId ?? session.sdkSessionId;
    if (!providerSessionId) {
      const noRuntimePayload = {
        session: sessionSummary,
        transcript: {
          available: false as const,
          reason: "No runtime session ID" as const,
        },
        entries: [] as const,
      };
      if (asJson) {
        console.log(JSON.stringify(noRuntimePayload));
      } else {
        console.log(`\n  ⚠️  No runtime session ID — cannot read transcript`);
      }
      return noRuntimePayload;
    }

    const agentConfig = getAgent(session.agentId);
    const transcript = locateRuntimeTranscript({
      runtimeProvider: session.runtimeProvider,
      providerSessionId,
      agentCwd: session.agentCwd,
      remote: agentConfig?.remote,
    });

    if (!transcript.path) {
      const noTranscriptPayload = {
        session: sessionSummary,
        transcript: {
          available: false as const,
          reason: transcript.reason ?? "Transcript not found",
        },
        entries: [] as const,
      };
      if (asJson) {
        console.log(JSON.stringify(noTranscriptPayload));
      } else {
        console.log(`\n  ⚠️  ${transcript.reason ?? "Transcript not found"}`);
      }
      return noTranscriptPayload;
    }

    // Read and parse JSONL
    const raw = readFileSync(transcript.path, "utf-8");
    const { parsedEntries, turns } = parseTranscriptEntries(raw);

    // Show last N turns
    const recent = turns.slice(-maxTurns * 2); // user+assistant pairs
    const recentRawEntries = parsedEntries
      .filter((entry) => entry.type === "user" || entry.type === "assistant")
      .slice(-maxTurns * 2);
    const transcriptPayload = {
      session: sessionSummary,
      transcript: {
        available: true as const,
        path: transcript.path,
        totalEntries: parsedEntries.length,
        selectedEntries: recentRawEntries.length,
      },
      entries: recentRawEntries,
    };

    if (asJson) {
      console.log(JSON.stringify(transcriptPayload));
      return transcriptPayload;
    }

    console.log(`\n  📋 Last ${Math.min(recent.length, maxTurns * 2)} entries (of ${turns.length} total):\n`);

    for (const turn of recent) {
      const time = turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : "";
      const prefix = turn.type === "user" ? "  👤 USER" : "  🤖 ASST";

      if (turn.text) {
        console.log(`${prefix} [${time}] ${turn.text}`);
      }
      if (turn.toolUse) {
        console.log(`${prefix} [${time}] 🔧 ${turn.toolUse}`);
      }
    }

    console.log();
    return transcriptPayload;
  }
}

declareCommandReturns(AgentsCommands, {
  create: agentCreateReturnSchema,
  debounce: agentDebounceReturnSchema,
  debug: agentDebugReturnSchema,
  delete: agentDeleteReturnSchema,
  list: agentsListReturnSchema,
  permissions: agentPermissionsReturnSchema,
  reset: agentResetReturnSchema,
  session: agentSessionReturnSchema,
  set: agentSetReturnSchema,
  show: agentShowReturnSchema,
  specMode: agentSpecModeReturnSchema,
  syncInstructions: agentInstructionSyncReturnSchema,
});
