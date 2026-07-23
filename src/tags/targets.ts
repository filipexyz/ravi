import { discoverRaviCommands, normalizeRaviCommandId, resolveRaviCommand } from "../commands/index.js";
import { getAppManifest, normalizeAppId } from "../apps/service.js";
import { getContactDetails } from "../contacts.js";
import { getDevinSession } from "../devin/store.js";
import { dbGetInsight } from "../insights/insight-db.js";
import { getDb } from "../router/router-db.js";
import { resolveObserverProfile } from "../runtime/observation-profiles.js";
import { findInstalledSkill, findSkillByName, listCatalogSkills } from "../skills/manager.js";
import { normalizeSpecId, specExists } from "../specs/service.js";
import { resolveTaskProfile } from "../tasks/profiles.js";
import { TAG_ASSET_TYPES, type TagAssetType } from "./types.js";

export type TagTargetOperation = "attach" | "detach" | "search";

export interface ResolvedTagTarget {
  assetType: TagAssetType;
  assetId: string;
  input: string;
  exists: boolean;
  label?: string;
}

export type TagTargetSelectorInput = {
  target?: string;
} & Partial<Record<TagAssetType, string | undefined>>;

export interface TagTargetDescriptor {
  assetType: TagAssetType;
  flag: string;
  label: string;
  valueLabel: string;
  resolve: (value: string) => ResolvedTagTarget | null;
  normalizeMissing?: (value: string) => string;
  allowOrphanLookup?: boolean;
}

interface TableResolverOptions {
  assetType: TagAssetType;
  table: string;
  column?: string;
  flag: string;
  label: string;
  valueLabel?: string;
}

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function rowExists(table: string, column: string, value: string): boolean {
  try {
    return Boolean(getDb().prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value));
  } catch (error) {
    if (missingTable(error)) return false;
    throw error;
  }
}

function rowById<T extends Record<string, unknown>>(table: string, column: string, value: string): T | null {
  try {
    return (getDb().prepare(`SELECT * FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value) as T | undefined) ?? null;
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

function makeTableDescriptor(options: TableResolverOptions): TagTargetDescriptor {
  const column = options.column ?? "id";
  return {
    assetType: options.assetType,
    flag: options.flag,
    label: options.label,
    valueLabel: options.valueLabel ?? "id",
    allowOrphanLookup: true,
    resolve(value: string): ResolvedTagTarget | null {
      const assetId = value.trim();
      if (!assetId) return null;
      if (!rowExists(options.table, column, assetId)) return null;
      return {
        assetType: options.assetType,
        assetId,
        input: value,
        exists: true,
      };
    },
  };
}

function normalizeNumericId(value: string, label: string): string {
  const trimmed = value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== trimmed) {
    throw new Error(`${label} must be a numeric id, got: ${value}`);
  }
  return trimmed;
}

function resolveSessionTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  const row =
    rowById<{ session_key: string; name: string | null }>("sessions", "session_key", input) ??
    rowById<{ session_key: string; name: string | null }>("sessions", "name", input);
  if (!row) return null;
  return {
    assetType: "session",
    assetId: row.name ?? row.session_key,
    input: value,
    exists: true,
    label: row.name ?? row.session_key,
  };
}

function resolveAppTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const app = getAppManifest(input);
    const appId = app.manifest?.id ?? app.id;
    return {
      assetType: "app",
      assetId: appId,
      input: value,
      exists: true,
      label: app.name ?? appId,
    };
  } catch {
    return null;
  }
}

function resolveAutomationTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;

  if (input === "session-followup" || input === "daemon-restart") {
    return {
      assetType: "automation",
      assetId: input,
      input: value,
      exists: true,
      label: input,
    };
  }

  const separator = input.indexOf(":");
  if (separator <= 0 || separator === input.length - 1) return null;
  const kind = input.slice(0, separator);
  const id = input.slice(separator + 1);
  const table = kind === "cron" ? "cron_jobs" : kind === "trigger" ? "triggers" : null;
  if (!table) return null;
  const row = rowById<{ id: string; name?: string | null }>(table, "id", id);
  if (!row) return null;
  return {
    assetType: "automation",
    assetId: input,
    input: value,
    exists: true,
    label: row.name ?? input,
  };
}

function resolveProjectTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  const row =
    rowById<{ id: string; slug: string; title: string }>("projects", "id", input) ??
    rowById<{ id: string; slug: string; title: string }>("projects", "slug", input);
  if (!row) return null;
  return {
    assetType: "project",
    assetId: row.slug,
    input: value,
    exists: true,
    label: row.title,
  };
}

function resolveRouteTarget(value: string): ResolvedTagTarget | null {
  const assetId = normalizeNumericId(value, "Route");
  const row = rowById<{ id: number; pattern: string }>("routes", "id", assetId);
  if (!row) return null;
  return {
    assetType: "route",
    assetId: String(row.id),
    input: value,
    exists: true,
    label: row.pattern,
  };
}

function resolveContactTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  const details = getContactDetails(input);
  if (!details) return null;
  return {
    assetType: "contact",
    assetId: details.contact.id,
    input: value,
    exists: true,
    label: details.contact.displayName ?? details.contact.primaryPhone ?? details.contact.id,
  };
}

function resolveProfileTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const profile = resolveTaskProfile(input);
    return {
      assetType: "profile",
      assetId: profile.id,
      input: value,
      exists: true,
      label: profile.label ?? profile.id,
    };
  } catch {
    return null;
  }
}

function resolveObserverProfileTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const profile = resolveObserverProfile(input);
    return {
      assetType: "observer_profile",
      assetId: profile.id,
      input: value,
      exists: true,
      label: profile.label,
    };
  } catch {
    return null;
  }
}

function resolveCommandTarget(value: string): ResolvedTagTarget | null {
  const id = normalizeRaviCommandId(value);
  const registry = discoverRaviCommands({ agentCwd: process.cwd() });
  const command = resolveRaviCommand(registry, id);
  if (!command) return null;
  return {
    assetType: "command",
    assetId: command.id,
    input: value,
    exists: true,
    label: command.title ?? command.id,
  };
}

function resolveSkillTarget(value: string): ResolvedTagTarget | null {
  const skill = findSkillByName(listCatalogSkills(), value) ?? findInstalledSkill(value);
  if (!skill) return null;
  return {
    assetType: "skill",
    assetId: skill.name,
    input: value,
    exists: true,
    label: skill.description ? `${skill.name} - ${skill.description.split("\n")[0]}` : skill.name,
  };
}

function resolveSpecTarget(value: string): ResolvedTagTarget | null {
  const id = normalizeSpecId(value);
  if (!specExists(id)) return null;
  return {
    assetType: "spec",
    assetId: id,
    input: value,
    exists: true,
    label: id,
  };
}

function resolveInsightTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  const insight = dbGetInsight(input);
  if (!insight) return null;
  return {
    assetType: "insight",
    assetId: insight.id,
    input: value,
    exists: true,
    label: insight.summary,
  };
}

function resolveDevinSessionTarget(value: string): ResolvedTagTarget | null {
  const input = value.trim();
  if (!input) return null;
  const session = getDevinSession(input);
  if (!session) return null;
  return {
    assetType: "devin_session",
    assetId: session.devinId,
    input: value,
    exists: true,
    label: session.title ?? session.devinId,
  };
}

function unsupportedDescriptor(assetType: TagAssetType, flag: string, label: string): TagTargetDescriptor {
  return {
    assetType,
    flag,
    label,
    valueLabel: "id",
    allowOrphanLookup: true,
    resolve(): ResolvedTagTarget | null {
      return null;
    },
  };
}

export const TAG_TARGET_DESCRIPTORS: readonly TagTargetDescriptor[] = [
  makeTableDescriptor({ assetType: "agent", table: "agents", flag: "agent", label: "Agent" }),
  {
    assetType: "automation",
    flag: "automation",
    label: "Automation",
    valueLabel: "principal-id",
    allowOrphanLookup: true,
    resolve: resolveAutomationTarget,
  },
  {
    assetType: "app",
    flag: "app",
    label: "App",
    valueLabel: "id",
    allowOrphanLookup: true,
    resolve: resolveAppTarget,
    normalizeMissing: normalizeAppId,
  },
  {
    assetType: "session",
    flag: "session",
    label: "Session",
    valueLabel: "name",
    allowOrphanLookup: true,
    resolve: resolveSessionTarget,
  },
  makeTableDescriptor({ assetType: "task", table: "tasks", flag: "task", label: "Task" }),
  {
    assetType: "project",
    flag: "project",
    label: "Project",
    valueLabel: "id-or-slug",
    allowOrphanLookup: true,
    resolve: resolveProjectTarget,
  },
  {
    assetType: "profile",
    flag: "profile",
    label: "Task profile",
    valueLabel: "id",
    allowOrphanLookup: true,
    resolve: resolveProfileTarget,
  },
  {
    assetType: "contact",
    flag: "contact",
    label: "Contact",
    valueLabel: "id-or-identity",
    allowOrphanLookup: true,
    resolve: resolveContactTarget,
  },
  makeTableDescriptor({ assetType: "chat", table: "chats", flag: "chat", label: "Chat" }),
  {
    assetType: "route",
    flag: "route",
    label: "Route",
    valueLabel: "id",
    allowOrphanLookup: true,
    resolve: resolveRouteTarget,
    normalizeMissing: (value) => normalizeNumericId(value, "Route"),
  },
  makeTableDescriptor({
    assetType: "instance",
    table: "instances",
    column: "name",
    flag: "instance",
    label: "Instance",
  }),
  makeTableDescriptor({ assetType: "artifact", table: "artifacts", flag: "artifact", label: "Artifact" }),
  {
    assetType: "insight",
    flag: "insight",
    label: "Insight",
    valueLabel: "id",
    allowOrphanLookup: true,
    resolve: resolveInsightTarget,
  },
  makeTableDescriptor({
    assetType: "workflow_spec",
    table: "workflow_specs",
    flag: "workflow-spec",
    label: "Workflow spec",
  }),
  makeTableDescriptor({
    assetType: "workflow_run",
    table: "workflow_runs",
    flag: "workflow-run",
    label: "Workflow run",
  }),
  makeTableDescriptor({
    assetType: "workflow_node",
    table: "workflow_node_runs",
    flag: "workflow-node",
    label: "Workflow node",
  }),
  makeTableDescriptor({ assetType: "cron_job", table: "cron_jobs", flag: "cron-job", label: "Cron job" }),
  makeTableDescriptor({ assetType: "trigger", table: "triggers", flag: "trigger", label: "Trigger" }),
  makeTableDescriptor({ assetType: "hook", table: "hooks", flag: "hook", label: "Hook" }),
  makeTableDescriptor({
    assetType: "task_automation",
    table: "task_automations",
    flag: "task-automation",
    label: "Task automation",
  }),
  makeTableDescriptor({
    assetType: "observer_rule",
    table: "observer_rules",
    flag: "observer-rule",
    label: "Observer rule",
  }),
  makeTableDescriptor({
    assetType: "observer_binding",
    table: "observer_bindings",
    flag: "observer-binding",
    label: "Observer binding",
  }),
  {
    assetType: "observer_profile",
    flag: "observer-profile",
    label: "Observer profile",
    valueLabel: "id",
    allowOrphanLookup: true,
    resolve: resolveObserverProfileTarget,
  },
  {
    assetType: "command",
    flag: "command",
    label: "Ravi command",
    valueLabel: "name",
    allowOrphanLookup: true,
    resolve: resolveCommandTarget,
    normalizeMissing: normalizeRaviCommandId,
  },
  {
    assetType: "skill",
    flag: "skill",
    label: "Skill",
    valueLabel: "name",
    allowOrphanLookup: true,
    resolve: resolveSkillTarget,
  },
  makeTableDescriptor({
    assetType: "skill_gate_rule",
    table: "skill_gate_rules",
    flag: "skill-gate-rule",
    label: "Skill gate rule",
  }),
  makeTableDescriptor({
    assetType: "context",
    table: "contexts",
    column: "context_id",
    flag: "context",
    label: "Context",
  }),
  makeTableDescriptor({
    assetType: "call_profile",
    table: "call_profiles",
    flag: "call-profile",
    label: "Call profile",
  }),
  makeTableDescriptor({
    assetType: "call_request",
    table: "call_requests",
    flag: "call-request",
    label: "Call request",
  }),
  makeTableDescriptor({
    assetType: "call_voice_agent",
    table: "call_voice_agents",
    flag: "call-voice-agent",
    label: "Call voice agent",
  }),
  makeTableDescriptor({ assetType: "call_tool", table: "call_tools", flag: "call-tool", label: "Call tool" }),
  unsupportedDescriptor("outbound_queue", "outbound-queue", "Outbound queue"),
  unsupportedDescriptor("outbound_entry", "outbound-entry", "Outbound entry"),
  {
    assetType: "spec",
    flag: "spec",
    label: "Spec",
    valueLabel: "id",
    allowOrphanLookup: true,
    resolve: resolveSpecTarget,
    normalizeMissing: normalizeSpecId,
  },
  {
    assetType: "devin_session",
    flag: "devin-session",
    label: "Devin session",
    valueLabel: "id-or-devin-id",
    allowOrphanLookup: true,
    resolve: resolveDevinSessionTarget,
  },
];

const DESCRIPTORS_BY_TYPE = new Map(TAG_TARGET_DESCRIPTORS.map((descriptor) => [descriptor.assetType, descriptor]));
const DESCRIPTORS_BY_FLAG = new Map(TAG_TARGET_DESCRIPTORS.map((descriptor) => [descriptor.flag, descriptor]));

export function getTagTargetDescriptor(assetType: TagAssetType): TagTargetDescriptor {
  const descriptor = DESCRIPTORS_BY_TYPE.get(assetType);
  if (!descriptor) {
    throw new Error(`Unsupported tag asset type: ${assetType}`);
  }
  return descriptor;
}

export function formatTagTargetSelectorHelp(): string {
  const flags = TAG_TARGET_DESCRIPTORS.map((descriptor) => `--${descriptor.flag}`).join(", ");
  return `${flags}, or --target <asset-type:id>`;
}

function normalizeAssetType(value: string): TagAssetType {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_") as TagAssetType;
  if (!(TAG_ASSET_TYPES as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid tag target type: ${value}. Use ${TAG_ASSET_TYPES.join("|")}.`);
  }
  return normalized;
}

function parseGenericTarget(value: string): { assetType: TagAssetType; assetId: string } {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error("Invalid --target. Use <asset-type>:<asset-id>, for example task:task-123.");
  }
  return {
    assetType: normalizeAssetType(trimmed.slice(0, separator)),
    assetId: trimmed.slice(separator + 1).trim(),
  };
}

function collectTargetSelections(input: TagTargetSelectorInput): Array<{
  assetType: TagAssetType;
  assetId: string;
  flag: string;
}> {
  const selections: Array<{ assetType: TagAssetType; assetId: string; flag: string }> = [];
  if (input.target?.trim()) {
    const parsed = parseGenericTarget(input.target);
    const descriptor = getTagTargetDescriptor(parsed.assetType);
    selections.push({ ...parsed, flag: "target" });
    if (!DESCRIPTORS_BY_FLAG.has(descriptor.flag)) {
      throw new Error(`Missing tag target descriptor flag for ${parsed.assetType}.`);
    }
  }
  for (const descriptor of TAG_TARGET_DESCRIPTORS) {
    const value = input[descriptor.assetType]?.trim();
    if (value) {
      selections.push({ assetType: descriptor.assetType, assetId: value, flag: descriptor.flag });
    }
  }
  return selections;
}

export function hasTagTargetSelector(input: TagTargetSelectorInput): boolean {
  return collectTargetSelections(input).length > 0;
}

export function resolveTagTargetSelector(
  input: TagTargetSelectorInput,
  options: { operation: TagTargetOperation },
): ResolvedTagTarget {
  const selections = collectTargetSelections(input);
  if (selections.length !== 1) {
    throw new Error(`Use exactly one tag target: ${formatTagTargetSelectorHelp()}.`);
  }

  const selection = selections[0];
  const descriptor = getTagTargetDescriptor(selection.assetType);
  const resolved = descriptor.resolve(selection.assetId);
  if (resolved) return resolved;

  if (options.operation === "attach") {
    throw new Error(`${descriptor.label} not found: ${selection.assetId}`);
  }

  if (descriptor.allowOrphanLookup === false) {
    throw new Error(`${descriptor.label} not found: ${selection.assetId}`);
  }

  const assetId = descriptor.normalizeMissing
    ? descriptor.normalizeMissing(selection.assetId)
    : selection.assetId.trim();
  if (!assetId) {
    throw new Error(`${descriptor.label} id is required.`);
  }
  return {
    assetType: descriptor.assetType,
    assetId,
    input: selection.assetId,
    exists: false,
  };
}
