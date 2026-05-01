import "reflect-metadata";
import { statSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  attachProjectTask,
  attachProjectWorkflowRun,
  createProject,
  createProjectTask,
  dispatchProjectTask,
  initProject,
  getProjectResourceLink,
  getProjectDetails,
  linkProject,
  listProjectResourceLinks,
  listProjectStatusEntries,
  listProjects,
  normalizeProjectStatus,
  normalizeProjectWorkflowLinkRole,
  requireProjectWorkflowTemplateId,
  startProjectWorkflowRun,
  updateProject,
} from "../../projects/index.js";
import { seedCanonicalProjectFixtures } from "../../projects/fixtures.js";
import type {
  ProjectBootstrapResourceInput,
  ProjectLink,
  ProjectLinkAssetType,
  ProjectOperationalSurface,
  ProjectResourceLink,
  ProjectResourceType,
  ProjectStatusEntry,
  ProjectTaskLaunchResult,
  ProjectWorkflowLinkRole,
  ProjectWorkflowTemplateId,
} from "../../projects/types.js";
import type { TaskEvent, TaskPriority, TaskRecord } from "../../tasks/types.js";
import { getAgent } from "../../router/config.js";
import { expandHome, getOrCreateSession, resolveSession } from "../../router/index.js";
import { getSpec } from "../../specs/index.js";
import { getWorkflowRunDetails } from "../../workflows/index.js";

const VALID_LINK_ASSET_TYPES = new Set<ProjectLinkAssetType>(["workflow", "session", "agent", "resource", "spec"]);
const VALID_RESOURCE_TYPES = new Set<ProjectResourceType>([
  "repo",
  "worktree",
  "notion_page",
  "notion_database",
  "file",
  "url",
  "group",
  "contact",
]);
const VALID_TASK_PRIORITIES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);

function parseMetadata(value?: string): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("Metadata must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid metadata JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseLastSignalAt(value?: string): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.toLowerCase() === "now") {
    return Date.now();
  }
  if (/^\d+$/.test(normalized)) {
    const numeric = Number.parseInt(normalized, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      fail(`Invalid --last-signal-at value: ${value}`);
    }
    return normalized.length <= 10 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    fail(`Invalid --last-signal-at value: ${value}. Use now, epoch ms, or ISO-8601.`);
  }
  return parsed;
}

function resolveActor(): { createdBy?: string; createdByAgentId?: string; createdBySessionName?: string } {
  const ctx = getContext();
  return {
    ...(ctx?.sessionName ? { createdBy: ctx.sessionName } : {}),
    ...(ctx?.agentId ? { createdByAgentId: ctx.agentId } : {}),
    ...(ctx?.sessionName ? { createdBySessionName: ctx.sessionName } : {}),
  };
}

function requireAssetType(value: string): ProjectLinkAssetType {
  const normalized = value.trim().toLowerCase() as ProjectLinkAssetType;
  if (!VALID_LINK_ASSET_TYPES.has(normalized)) {
    fail(`Invalid asset type: ${value}. Use workflow|session|agent|resource|spec.`);
  }
  return normalized;
}

function requireResourceType(value?: string): ProjectResourceType {
  const normalized = value?.trim().toLowerCase() as ProjectResourceType | undefined;
  if (!normalized || !VALID_RESOURCE_TYPES.has(normalized)) {
    fail(
      "Resource links require --resource-type <type>. Use repo|worktree|notion_page|notion_database|file|url|group|contact.",
    );
  }
  return normalized;
}

function toMultiValues(value?: string | string[]): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toMultiValues(entry));
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isWhatsAppGroupLocator(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith("group:") || normalized.endsWith("@g.us");
}

function normalizeGroupLocator(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    fail("Group locator is required.");
  }
  if (isHttpUrl(normalized)) {
    fail("Group resources expect group:<id> or <id>@g.us. Use --type url for invite links.");
  }
  const bare = normalized
    .replace(/^group:/, "")
    .replace(/@g\.us$/i, "")
    .trim();
  if (!bare) {
    fail(`Invalid group locator: ${value}`);
  }
  return `group:${bare}`;
}

function inferResourceType(target: string): ProjectResourceType {
  const normalized = target.trim();
  if (!normalized) {
    fail("Resource target is required.");
  }
  if (isHttpUrl(normalized)) return "url";
  if (isWhatsAppGroupLocator(normalized)) return "group";

  const expanded = expandHome(normalized);
  try {
    const stats = statSync(resolvePath(expanded));
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "worktree";
  } catch {}

  fail(
    `Could not infer resource type for ${target}. Pass --type repo|worktree|file|url|group|contact|notion_page|notion_database.`,
  );
}

function normalizeResourceLocator(target: string, resourceType: ProjectResourceType): string {
  const normalized = target.trim();
  if (!normalized) {
    fail("Resource target is required.");
  }

  switch (resourceType) {
    case "repo":
      return isHttpUrl(normalized) ? normalizeUrl(normalized) : resolvePath(expandHome(normalized));
    case "worktree":
    case "file":
      return resolvePath(expandHome(normalized));
    case "url":
      return normalizeUrl(normalized);
    case "group":
      return normalizeGroupLocator(normalized);
    default:
      return normalized;
  }
}

function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      fail(`Invalid URL protocol: ${parsed.protocol}. Use http or https.`);
    }
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    fail(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildResourceHints(resourceType: ProjectResourceType, locator: string): Record<string, unknown> {
  switch (resourceType) {
    case "repo":
    case "worktree":
    case "file":
      return {
        path: locator,
        basename: basename(locator),
      };
    case "url": {
      try {
        const parsed = new URL(locator);
        return {
          host: parsed.host,
          pathname: parsed.pathname,
        };
      } catch {
        return {};
      }
    }
    case "group":
      return {
        platform: "whatsapp",
        groupId: locator,
        bareId: locator.replace(/^group:/, ""),
      };
    default:
      return {};
  }
}

function defaultResourceLabel(resourceType: ProjectResourceType, locator: string): string | undefined {
  switch (resourceType) {
    case "repo":
      return isHttpUrl(locator)
        ? (() => {
            try {
              const parsed = new URL(locator);
              return parsed.pathname.replace(/^\/+|\/+$/g, "") || parsed.host;
            } catch {
              return locator;
            }
          })()
        : basename(locator) || locator;
    case "worktree":
      return basename(locator) ? `${basename(locator)} worktree` : locator;
    case "file":
      return basename(locator) || locator;
    case "url":
      try {
        const parsed = new URL(locator);
        return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
      } catch {
        return locator;
      }
    case "group":
      return locator.replace(/^group:/, "group ");
    default:
      return undefined;
  }
}

function coerceResourceLink(link: ProjectLink | ProjectResourceLink): ProjectResourceLink | null {
  if (link.assetType !== "resource") {
    return null;
  }

  const metadata = link.metadata ?? {};
  const resourceType =
    typeof metadata.type === "string" && VALID_RESOURCE_TYPES.has(metadata.type as ProjectResourceType)
      ? (metadata.type as ProjectResourceType)
      : null;
  const locator =
    typeof metadata.locator === "string" && metadata.locator.trim() ? metadata.locator.trim() : link.assetId;
  const label = typeof metadata.label === "string" && metadata.label.trim() ? metadata.label.trim() : null;

  return {
    ...link,
    assetType: "resource",
    resourceType,
    locator,
    label,
  };
}

function resolveResourceLinkInput(
  target: string,
  resourceTypeValue?: string,
  label?: string,
  metadataJson?: string,
): { assetId: string; resourceType: ProjectResourceType; metadata: Record<string, unknown> } {
  const resourceType = resourceTypeValue ? requireResourceType(resourceTypeValue) : inferResourceType(target);
  const locator = normalizeResourceLocator(target, resourceType);
  const explicitLabel = label?.trim() ? label.trim() : undefined;
  const effectiveLabel = explicitLabel ?? defaultResourceLabel(resourceType, locator);
  const metadata = parseMetadata(metadataJson) ?? {};

  return {
    assetId: locator,
    resourceType,
    metadata: {
      ...metadata,
      ...buildResourceHints(resourceType, locator),
      type: resourceType,
      locator,
      ...(effectiveLabel ? { label: effectiveLabel } : {}),
    },
  };
}

function resolveOwnerAgent(value?: string): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "none") return null;
  const agent = getAgent(normalized);
  if (!agent) {
    fail(`Agent not found: ${normalized}`);
  }
  return normalized;
}

function resolveOperatorSession(value?: string): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "none") return null;
  const session = resolveSession(normalized);
  if (!session) {
    fail(`Session not found: ${normalized}`);
  }
  return session.name ?? session.sessionKey;
}

function slugifyProjectHint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildProjectSessionKey(ownerAgentId: string, projectHint: string, sessionName: string): string {
  const projectSegment = slugifyProjectHint(projectHint) || "project";
  const sessionSegment = slugifyProjectHint(sessionName) || "operator";
  return `agent:${ownerAgentId}:project:${projectSegment}:session:${sessionSegment}`;
}

function resolveOrEnsureOperatorSession(
  value: string | undefined,
  ownerAgentId: string | null | undefined,
  projectHint: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "none") return null;

  const existing = resolveSession(normalized);
  if (existing) {
    return existing.name ?? existing.sessionKey;
  }

  if (!ownerAgentId) {
    fail(`Session not found: ${normalized}. Pass --owner-agent to create it or create the session first.`);
  }

  const agent = getAgent(ownerAgentId);
  if (!agent) {
    fail(`Agent not found: ${ownerAgentId}`);
  }

  const created = getOrCreateSession(
    buildProjectSessionKey(ownerAgentId, projectHint, normalized),
    ownerAgentId,
    agent.cwd,
    {
      name: normalized,
    },
  );
  return created.name ?? created.sessionKey;
}

function parseProjectWorkflowTemplates(value?: string | string[]): ProjectWorkflowTemplateId[] | undefined {
  const entries = toMultiValues(value);
  if (entries.length === 0) return undefined;
  return entries.map((entry) => requireProjectWorkflowTemplateId(entry));
}

function parseWorkflowRunIds(value?: string | string[]): string[] | undefined {
  const entries = toMultiValues(value);
  return entries.length > 0 ? entries : undefined;
}

function parseProjectWorkflowRole(value?: string): ProjectWorkflowLinkRole | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalizeProjectWorkflowLinkRole(normalized);
}

function parseTaskPriority(value?: string): TaskPriority | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!VALID_TASK_PRIORITIES.has(normalized as TaskPriority)) {
    fail(`Invalid priority: ${value}. Use low|normal|high|urgent.`);
  }
  return normalized as TaskPriority;
}

function shouldDispatchProjectTask(dispatch?: boolean, agentId?: string, sessionName?: string): boolean {
  return dispatch === true || Boolean(agentId?.trim()) || Boolean(sessionName?.trim());
}

function parseBootstrapResources(value?: string | string[]): ProjectBootstrapResourceInput[] | undefined {
  const entries = toMultiValues(value);
  if (entries.length === 0) return undefined;
  return entries.map((entry) => {
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      fail(`Invalid --resource entry: ${entry}. Use <type:locator>.`);
    }
    const resourceType = requireResourceType(entry.slice(0, separator));
    const target = entry.slice(separator + 1).trim();
    if (!target) {
      fail(`Invalid --resource entry: ${entry}. Locator is required after <type:>.`);
    }

    const resolved = resolveResourceLinkInput(target, resourceType);
    return {
      type: resolved.resourceType,
      assetId: resolved.assetId,
      label:
        typeof resolved.metadata.label === "string" && resolved.metadata.label.trim()
          ? resolved.metadata.label.trim()
          : undefined,
      metadata: resolved.metadata,
    };
  });
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compact(value: string, limit = 72): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function formatWorkflowStatusCounts(details: NonNullable<ReturnType<typeof getProjectDetails>>): string {
  if (!details.workflowAggregate) {
    return "none";
  }

  const aggregate = details.workflowAggregate;
  const segments = [
    aggregate.running > 0 ? `running ${aggregate.running}` : null,
    aggregate.blocked > 0 ? `blocked ${aggregate.blocked}` : null,
    aggregate.ready > 0 ? `ready ${aggregate.ready}` : null,
    aggregate.waiting > 0 ? `waiting ${aggregate.waiting}` : null,
    aggregate.done > 0 ? `done ${aggregate.done}` : null,
    aggregate.failed > 0 ? `failed ${aggregate.failed}` : null,
    aggregate.cancelled > 0 ? `cancelled ${aggregate.cancelled}` : null,
    aggregate.draft > 0 ? `draft ${aggregate.draft}` : null,
    aggregate.archived > 0 ? `archived ${aggregate.archived}` : null,
    aggregate.missing > 0 ? `missing ${aggregate.missing}` : null,
  ].filter((value): value is string => Boolean(value));

  return segments.length > 0 ? segments.join(", ") : "none";
}

function formatProjectRuntimeHotspot(operational: ProjectOperationalSurface | null | undefined): string {
  if (!operational) {
    return "none";
  }

  const segments = [
    operational.hottestWorkflowRunId
      ? `${operational.hottestWorkflowTitle ?? operational.hottestWorkflowRunId} (${operational.hottestWorkflowStatus ?? "missing"})`
      : null,
    operational.hottestNodeKey
      ? `${operational.hottestNodeLabel ?? operational.hottestNodeKey} (${operational.hottestNodeStatus ?? "pending"})`
      : null,
    operational.hottestTaskId
      ? `${operational.hottestTaskTitle ?? operational.hottestTaskId} (${operational.hottestTaskStatus ?? "open"}${typeof operational.hottestTaskProgress === "number" ? `, ${operational.hottestTaskProgress}%` : ""})`
      : null,
  ].filter((value): value is string => Boolean(value));

  return segments.length > 0 ? segments.join(" -> ") : "none";
}

function formatProjectRuntimeLead(operational: ProjectOperationalSurface | null | undefined): string {
  if (!operational) {
    return "-";
  }

  if (operational.hottestTaskId) {
    const taskTitle = operational.hottestTaskTitle ?? operational.hottestTaskId;
    const progress =
      typeof operational.hottestTaskProgress === "number" ? ` · ${operational.hottestTaskProgress}%` : "";
    return `task ${taskTitle} :: ${operational.hottestTaskStatus ?? "open"}${progress}`;
  }
  if (operational.hottestNodeKey) {
    return `node ${operational.hottestNodeLabel ?? operational.hottestNodeKey} :: ${operational.hottestNodeStatus ?? "pending"}`;
  }
  if (operational.hottestWorkflowRunId) {
    return `workflow ${operational.hottestWorkflowTitle ?? operational.hottestWorkflowRunId} :: ${operational.hottestWorkflowStatus ?? "missing"}`;
  }
  return "-";
}

function describeLink(link: ProjectLink): string {
  const roleSuffix = link.role ? ` :: role ${link.role}` : "";

  switch (link.assetType) {
    case "workflow": {
      const details = getWorkflowRunDetails(link.assetId);
      if (!details) {
        return `workflow:${link.assetId}${roleSuffix}`;
      }
      return `workflow:${link.assetId} :: ${details.run.status} :: ${details.run.title}${roleSuffix}`;
    }
    case "session": {
      const session = resolveSession(link.assetId);
      if (!session) {
        return `session:${link.assetId}${roleSuffix}`;
      }
      return `session:${session.name ?? session.sessionKey} :: agent ${session.agentId}${roleSuffix}`;
    }
    case "agent": {
      const agent = getAgent(link.assetId);
      if (!agent) {
        return `agent:${link.assetId}${roleSuffix}`;
      }
      return `agent:${link.assetId} :: ${agent.cwd}${roleSuffix}`;
    }
    case "resource": {
      const resource = coerceResourceLink(link);
      const type = resource?.resourceType ?? "resource";
      const head = resource?.label ? `resource:${type} :: ${resource.label}` : `resource:${type}`;
      return `${head} :: ${resource?.locator ?? link.assetId}${roleSuffix}`;
    }
    case "spec": {
      try {
        const spec = getSpec(link.assetId);
        return `spec:${spec.id} :: ${spec.kind} :: ${spec.title}${roleSuffix}`;
      } catch {
        return `spec:${link.assetId}${roleSuffix}`;
      }
    }
  }
}

function printProject(details: NonNullable<ReturnType<typeof getProjectDetails>>): void {
  console.log(`\nProject ${details.project.id}`);
  console.log(`Slug:        ${details.project.slug}`);
  console.log(`Title:       ${details.project.title}`);
  console.log(`Status:      ${details.project.status}`);
  console.log(`Runtime:     ${details.operational?.runtimeStatus ?? details.workflowAggregate?.overallStatus ?? "-"}`);
  console.log(`Last signal: ${formatTimestamp(details.project.lastSignalAt)}`);
  if (details.project.ownerAgentId) console.log(`Owner:       ${details.project.ownerAgentId}`);
  if (details.project.operatorSessionName) console.log(`Session:     ${details.project.operatorSessionName}`);
  console.log(`Summary:     ${details.project.summary}`);
  console.log(`Hypothesis:  ${details.project.hypothesis}`);
  console.log(`Next step:   ${details.project.nextStep}`);
  console.log(`Hot path:    ${formatProjectRuntimeHotspot(details.operational)}`);

  console.log("\nWorkflows:");
  if (details.linkedWorkflows.length === 0) {
    console.log("  - none");
  } else {
    if (details.workflowAggregate) {
      console.log(
        `  Runtime:    ${details.workflowAggregate.overallStatus ?? "-"} :: ${formatWorkflowStatusCounts(details)}`,
      );
      if (details.workflowAggregate.primaryWorkflowRunId) {
        const primaryTitle =
          details.workflowAggregate.primaryWorkflowTitle ?? details.workflowAggregate.primaryWorkflowRunId;
        console.log(
          `  Primary:    ${details.workflowAggregate.primaryWorkflowRunId} :: ${details.workflowAggregate.primaryWorkflowStatus ?? "-"} :: ${primaryTitle}`,
        );
      }
      if (details.workflowAggregate.focusedWorkflowRunId) {
        const focusedTitle =
          details.workflowAggregate.focusedWorkflowTitle ?? details.workflowAggregate.focusedWorkflowRunId;
        const focusedRole = details.workflowAggregate.focusedWorkflowRole
          ? ` :: role ${details.workflowAggregate.focusedWorkflowRole}`
          : "";
        console.log(
          `  Focus:      ${details.workflowAggregate.focusedWorkflowRunId} :: ${details.workflowAggregate.focusedWorkflowStatus ?? "-"} :: ${focusedTitle}${focusedRole}`,
        );
      }
    }
    for (const workflow of details.linkedWorkflows) {
      const roleSuffix = workflow.role ? ` :: role ${workflow.role}` : "";
      const status = workflow.workflowRunStatus ?? "missing";
      const title = workflow.workflowRunTitle ?? workflow.workflowRunId;
      const specSuffix = workflow.workflowSpecTitle ? ` :: spec ${workflow.workflowSpecTitle}` : "";
      console.log(`  - ${workflow.workflowRunId} :: ${status} :: ${title}${specSuffix}${roleSuffix}`);
    }
  }

  console.log("\nLinks:");
  if (details.links.length === 0) {
    console.log("  - none");
    return;
  }

  for (const link of details.links) {
    console.log(`  - ${describeLink(link)}`);
  }
}

function printProjectStatus(details: NonNullable<ReturnType<typeof getProjectDetails>>): void {
  console.log(`\n${details.project.slug}`);
  console.log(`Project:   ${details.project.status}`);
  console.log(`Runtime:   ${details.operational?.runtimeStatus ?? details.workflowAggregate?.overallStatus ?? "-"}`);
  console.log(`Workflows: ${details.linkedWorkflows.length}`);
  if (details.workflowAggregate) {
    console.log(`Counts:    ${formatWorkflowStatusCounts(details)}`);
  }
  console.log(`Signal:    ${formatTimestamp(details.project.lastSignalAt)}`);
  console.log(`Lead:      ${formatProjectRuntimeLead(details.operational)}`);
  console.log(`Next:      ${details.project.nextStep}`);
  if (details.workflowAggregate?.primaryWorkflowRunId) {
    const primaryTitle =
      details.workflowAggregate.primaryWorkflowTitle ?? details.workflowAggregate.primaryWorkflowRunId;
    console.log(
      `Primary:   ${details.workflowAggregate.primaryWorkflowRunId} :: ${details.workflowAggregate.primaryWorkflowStatus ?? "-"} :: ${primaryTitle}`,
    );
  }
  if (details.workflowAggregate?.focusedWorkflowRunId) {
    const focusedTitle =
      details.workflowAggregate.focusedWorkflowTitle ?? details.workflowAggregate.focusedWorkflowRunId;
    const focusedRole = details.workflowAggregate.focusedWorkflowRole
      ? ` :: role ${details.workflowAggregate.focusedWorkflowRole}`
      : "";
    console.log(
      `Focus:     ${details.workflowAggregate.focusedWorkflowRunId} :: ${details.workflowAggregate.focusedWorkflowStatus ?? "-"} :: ${focusedTitle}${focusedRole}`,
    );
  }
}

async function emitTaskMutation(task: TaskRecord, event: TaskEvent): Promise<void> {
  const { emitTaskEvent } = await import("../../tasks/index.js");
  await emitTaskEvent(task, event);
}

async function emitProjectTaskCreated(result: Awaited<ReturnType<typeof createProjectTask>>): Promise<void> {
  await emitTaskMutation(result.createdTask, result.event);
  for (const related of result.relatedEvents) {
    await emitTaskMutation(related.task, related.event);
  }
  if (result.launch) {
    await emitProjectTaskLaunch(result.launch);
  }
}

async function emitProjectTaskLaunch(launch: ProjectTaskLaunchResult): Promise<void> {
  await emitTaskMutation(launch.task, launch.event);
}

function printProjectTaskLaunch(launch: ProjectTaskLaunchResult | null): void {
  if (!launch) {
    return;
  }
  console.log(`  Launch:    ${launch.mode === "dispatched" ? "dispatched" : "launch planned"}`);
  if (launch.mode === "dispatched") {
    console.log(`  Session:   ${launch.sessionName}`);
  } else {
    console.log(`  Session:   ${launch.launchPlan.sessionName}`);
  }
}

function printProjectNext(entries: ProjectStatusEntry[]): void {
  if (entries.length === 0) {
    console.log("\nNo projects found.\n");
    return;
  }

  console.log(`\nProjects next (${entries.length}):\n`);
  for (const entry of entries) {
    const runtime = entry.operational?.runtimeStatus ?? "-";
    const hot = formatProjectRuntimeLead(entry.operational);
    const workflowCount = entry.operational?.workflowCount ?? entry.linkedWorkflows.length;
    console.log(
      `- ${entry.project.slug} :: ${entry.project.status} :: runtime ${runtime} :: wf ${workflowCount} :: signal ${formatTimestamp(entry.project.lastSignalAt)}`,
    );
    console.log(`  lead ${compact(hot, 96)}`);
    console.log(`  next ${compact(entry.project.nextStep, 96)}`);
  }
}

function printProjectResource(resource: ProjectResourceLink): void {
  console.log(`\nResource ${resource.id}`);
  console.log(`Type:       ${resource.resourceType ?? "-"}`);
  console.log(`Locator:    ${resource.locator}`);
  if (resource.label) console.log(`Label:      ${resource.label}`);
  if (resource.role) console.log(`Role:       ${resource.role}`);
  console.log(`Created:    ${formatTimestamp(resource.createdAt)}`);
  console.log(`Updated:    ${formatTimestamp(resource.updatedAt)}`);
  if (resource.metadata && Object.keys(resource.metadata).length > 0) {
    console.log("\nMetadata:");
    console.log(JSON.stringify(resource.metadata, null, 2));
  }
}

function resolveLinkTarget(
  assetType: ProjectLinkAssetType,
  target: string,
  resourceType?: string,
  label?: string,
  metadataJson?: string,
): { assetId: string; metadata?: Record<string, unknown> } {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    fail("Link target is required.");
  }

  switch (assetType) {
    case "workflow": {
      const details = getWorkflowRunDetails(normalizedTarget);
      if (!details) {
        fail(`Workflow run not found: ${normalizedTarget}`);
      }
      return { assetId: details.run.id };
    }
    case "session": {
      const session = resolveSession(normalizedTarget);
      if (!session) {
        fail(`Session not found: ${normalizedTarget}`);
      }
      return { assetId: session.name ?? session.sessionKey };
    }
    case "agent": {
      const agent = getAgent(normalizedTarget);
      if (!agent) {
        fail(`Agent not found: ${normalizedTarget}`);
      }
      return { assetId: normalizedTarget };
    }
    case "resource":
      return resolveResourceLinkInput(normalizedTarget, resourceType, label, metadataJson);
    case "spec": {
      const spec = getSpec(normalizedTarget);
      return { assetId: spec.id };
    }
  }
}

@Group({
  name: "projects",
  description: "Project alignment/context substrate",
  scope: "open",
  skillGate: "ravi-system-projects",
})
export class ProjectCommands {
  @Command({ name: "init", description: "Materialize a project with cheap links and optional canonical workflows" })
  init(
    @Arg("title", { description: "Project title" }) title: string,
    @Option({ flags: "--slug <slug>", description: "Stable project slug" }) slug?: string,
    @Option({ flags: "--status <status>", description: "active|paused|blocked|done|archived" }) status?: string,
    @Option({ flags: "--summary <text>", description: "Human summary for the workstream" }) summary?: string,
    @Option({ flags: "--hypothesis <text>", description: "Current working hypothesis" }) hypothesis?: string,
    @Option({ flags: "--next-step <text>", description: "Next human step" }) nextStep?: string,
    @Option({ flags: "--owner-agent <id>", description: "Owning agent id or 'none' (defaults to current actor agent)" })
    ownerAgentId?: string,
    @Option({
      flags: "--session <name>",
      description: "Operator session name; links existing or creates one for the owner agent",
    })
    operatorSession?: string,
    @Option({
      flags: "--resource <type:locator...>",
      description: "Resource links to attach: repo|worktree|notion_page|notion_database|file|url|group|contact",
    })
    resources?: string | string[],
    @Option({
      flags: "--workflow-template <id...>",
      description: "Instantiate canonical workflow templates: technical-change|gated-release|operational-response",
    })
    workflowTemplates?: string | string[],
    @Option({ flags: "--workflow-run <id...>", description: "Attach existing workflow run ids" })
    workflowRuns?: string | string[],
    @Option({ flags: "--last-signal-at <value>", description: "now, epoch ms, or ISO-8601" }) lastSignalAt?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const actor = resolveActor();
      const resolvedOwnerAgentId = resolveOwnerAgent(ownerAgentId ?? actor.createdByAgentId);
      const resolvedLastSignalAt = parseLastSignalAt(lastSignalAt);
      const resolvedOperatorSession = resolveOrEnsureOperatorSession(
        operatorSession ?? actor.createdBySessionName,
        resolvedOwnerAgentId,
        slug ?? title,
      );
      const parsedResources = parseBootstrapResources(resources);
      const parsedWorkflowTemplates = parseProjectWorkflowTemplates(workflowTemplates);
      const parsedWorkflowRunIds = parseWorkflowRunIds(workflowRuns);
      const result = initProject({
        title,
        ...(slug?.trim() ? { slug: slug.trim() } : {}),
        ...(status ? { status: normalizeProjectStatus(status) } : {}),
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
        ...(hypothesis?.trim() ? { hypothesis: hypothesis.trim() } : {}),
        ...(nextStep?.trim() ? { nextStep: nextStep.trim() } : {}),
        ...(resolvedLastSignalAt !== undefined ? { lastSignalAt: resolvedLastSignalAt } : {}),
        ...(resolvedOwnerAgentId !== undefined ? { ownerAgentId: resolvedOwnerAgentId } : {}),
        ...(resolvedOperatorSession !== undefined ? { operatorSessionName: resolvedOperatorSession } : {}),
        ...(parsedResources ? { resources: parsedResources } : {}),
        ...(parsedWorkflowTemplates ? { workflowTemplates: parsedWorkflowTemplates } : {}),
        ...(parsedWorkflowRunIds ? { workflowRunIds: parsedWorkflowRunIds } : {}),
        ...actor,
      });

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Initialized project ${result.details.project.slug}`);
        if (result.workflows.length > 0) {
          console.log(
            `  Workflows: ${result.workflows.map((workflow) => `${workflow.workflowRunId} (${workflow.source === "template" ? workflow.templateId : "existing"})`).join(", ")}`,
          );
        }
        printProject(result.details);
      }
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "create", description: "Create one project" })
  create(
    @Arg("title", { description: "Project title" }) title: string,
    @Option({ flags: "--slug <slug>", description: "Stable project slug" }) slug?: string,
    @Option({ flags: "--status <status>", description: "active|paused|blocked|done|archived" }) status?: string,
    @Option({ flags: "--summary <text>", description: "Human summary for the workstream" }) summary?: string,
    @Option({ flags: "--hypothesis <text>", description: "Current working hypothesis" }) hypothesis?: string,
    @Option({ flags: "--next-step <text>", description: "Next human step" }) nextStep?: string,
    @Option({ flags: "--last-signal-at <value>", description: "now, epoch ms, or ISO-8601" }) lastSignalAt?: string,
    @Option({ flags: "--owner-agent <id>", description: "Owning agent id" }) ownerAgentId?: string,
    @Option({ flags: "--session <name>", description: "Operator session name or key" }) operatorSession?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const resolvedOwnerAgentId = resolveOwnerAgent(ownerAgentId);
      const resolvedOperatorSession = resolveOperatorSession(operatorSession);
      const resolvedLastSignalAt = parseLastSignalAt(lastSignalAt);
      const project = createProject({
        title,
        ...(slug?.trim() ? { slug: slug.trim() } : {}),
        ...(status ? { status: normalizeProjectStatus(status) } : {}),
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
        ...(hypothesis?.trim() ? { hypothesis: hypothesis.trim() } : {}),
        ...(nextStep?.trim() ? { nextStep: nextStep.trim() } : {}),
        ...(resolvedLastSignalAt !== undefined ? { lastSignalAt: resolvedLastSignalAt } : {}),
        ...(resolvedOwnerAgentId !== undefined ? { ownerAgentId: resolvedOwnerAgentId } : {}),
        ...(resolvedOperatorSession !== undefined ? { operatorSessionName: resolvedOperatorSession } : {}),
        ...resolveActor(),
      });
      const details = getProjectDetails(project.id)!;

      if (asJson) {
        console.log(JSON.stringify(details, null, 2));
      } else {
        console.log(`\n✓ Created project ${details.project.slug}`);
        printProject(details);
      }
      return details;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "list", description: "List projects" })
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) status?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const projects = listProjects({
        ...(status ? { status: normalizeProjectStatus(status) } : {}),
      });
      const payload = { total: projects.length, projects };

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else if (projects.length === 0) {
        console.log("\nNo projects found.\n");
      } else {
        console.log(`\nProjects (${projects.length}):\n`);
        for (const project of projects) {
          const line = [
            `${project.slug}`,
            project.status,
            `${project.linkCount} links`,
            `signal ${formatTimestamp(project.lastSignalAt)}`,
            `next ${compact(project.nextStep, 40)}`,
          ].join(" :: ");
          console.log(`- ${line}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "show", description: "Show one project with linked context" })
  show(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getProjectDetails(projectRef.trim());
    if (!details) {
      fail(`Project not found: ${projectRef}`);
    }

    if (asJson) {
      console.log(JSON.stringify(details, null, 2));
    } else {
      printProject(details);
    }
    return details;
  }

  @Command({ name: "status", description: "Show one project with workflow runtime rollup" })
  status(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getProjectDetails(projectRef.trim());
    if (!details) {
      fail(`Project not found: ${projectRef}`);
    }

    if (asJson) {
      console.log(JSON.stringify(details, null, 2));
    } else {
      printProjectStatus(details);
    }
    return details;
  }

  @Command({ name: "next", description: "List projects as an operational next-work surface" })
  next(
    @Option({ flags: "--status <status>", description: "Filter by project status" }) status?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const entries = listProjectStatusEntries({
        ...(status ? { status: normalizeProjectStatus(status) } : {}),
      });
      const payload = { total: entries.length, projects: entries };

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printProjectNext(entries);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "update", description: "Update one project" })
  update(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Option({ flags: "--title <text>", description: "New title" }) title?: string,
    @Option({ flags: "--status <status>", description: "active|paused|blocked|done|archived" }) status?: string,
    @Option({ flags: "--summary <text>", description: "Human summary" }) summary?: string,
    @Option({ flags: "--hypothesis <text>", description: "Working hypothesis" }) hypothesis?: string,
    @Option({ flags: "--next-step <text>", description: "Next human step" }) nextStep?: string,
    @Option({ flags: "--last-signal-at <value>", description: "now, epoch ms, or ISO-8601" }) lastSignalAt?: string,
    @Option({ flags: "--touch-signal", description: "Set last_signal_at to now" }) touchSignal?: boolean,
    @Option({ flags: "--owner-agent <id>", description: "Owning agent id or 'none'" }) ownerAgentId?: string,
    @Option({ flags: "--session <name>", description: "Operator session name or 'none'" }) operatorSession?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const resolvedOwnerAgentId = resolveOwnerAgent(ownerAgentId);
      const resolvedOperatorSession = resolveOperatorSession(operatorSession);
      const signalAt = parseLastSignalAt(lastSignalAt) ?? (touchSignal ? Date.now() : undefined);
      const project = updateProject(projectRef, {
        ...(title?.trim() ? { title: title.trim() } : {}),
        ...(status ? { status: normalizeProjectStatus(status) } : {}),
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
        ...(hypothesis?.trim() ? { hypothesis: hypothesis.trim() } : {}),
        ...(nextStep?.trim() ? { nextStep: nextStep.trim() } : {}),
        ...(signalAt !== undefined ? { lastSignalAt: signalAt } : {}),
        ...(resolvedOwnerAgentId !== undefined ? { ownerAgentId: resolvedOwnerAgentId } : {}),
        ...(resolvedOperatorSession !== undefined ? { operatorSessionName: resolvedOperatorSession } : {}),
      });
      const details = getProjectDetails(project.id)!;

      if (asJson) {
        console.log(JSON.stringify(details, null, 2));
      } else {
        console.log(`\n✓ Updated project ${details.project.slug}`);
        printProject(details);
      }
      return details;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "link", description: "Link workflow/session/agent/resource/spec context to a project" })
  link(
    @Arg("assetType", { description: "workflow|session|agent|resource|spec" }) assetTypeValue: string,
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("target", { description: "Asset id, session, agent, or locator" }) target: string,
    @Option({ flags: "--role <text>", description: "Optional role for this link" }) role?: string,
    @Option({ flags: "--resource-type <type>", description: "Required for resource links" }) resourceType?: string,
    @Option({ flags: "--label <text>", description: "Human label for resource links" }) label?: string,
    @Option({ flags: "--meta <json>", description: "Free JSON metadata for this link" }) metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const assetType = requireAssetType(assetTypeValue);
      const resolved = resolveLinkTarget(assetType, target, resourceType, label, metadataJson);
      const parsedMetadata = resolved.metadata ?? parseMetadata(metadataJson);
      const details = linkProject({
        projectRef,
        assetType,
        assetId: resolved.assetId,
        ...(role?.trim() ? { role: role.trim() } : {}),
        ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
        ...resolveActor(),
      });

      if (asJson) {
        console.log(JSON.stringify(details, null, 2));
      } else {
        console.log(`\n✓ Linked ${assetType}:${resolved.assetId} -> ${details.project.slug}`);
        const linked = details.links.find(
          (entry) => entry.assetType === assetType && entry.assetId === resolved.assetId,
        );
        if (linked) {
          console.log(`  ${describeLink(linked)}`);
        }
      }
      return details;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

@Group({
  name: "projects.workflows",
  description: "Project-scoped workflow run operations",
  scope: "open",
  skillGate: "ravi-system-projects",
})
export class ProjectWorkflowCommands {
  @Command({ name: "start", description: "Start one workflow run from a project and link it in one step" })
  start(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("specId", { description: "Workflow spec id" }) workflowSpecId: string,
    @Option({ flags: "--role <role>", description: "primary|support (defaults from current project state)" })
    role?: string,
    @Option({ flags: "--run-id <id>", description: "Optional workflow run id" }) workflowRunId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const actor = resolveActor();
      const result = startProjectWorkflowRun({
        projectRef,
        workflowSpecId,
        ...(workflowRunId?.trim() ? { workflowRunId: workflowRunId.trim() } : {}),
        ...(role?.trim() ? { role: parseProjectWorkflowRole(role) } : {}),
        ...actor,
      });

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Started workflow ${result.run.run.id} for ${result.details.project.slug}`);
        console.log(
          `  Linked: ${result.workflow.role ?? "-"} :: ${result.workflow.workflowRunTitle ?? result.workflow.workflowRunId}`,
        );
        if (result.defaults.ownerAgentId) console.log(`  Owner:  ${result.defaults.ownerAgentId}`);
        if (result.defaults.operatorSessionName) console.log(`  Session:${result.defaults.operatorSessionName}`);
        printProjectStatus(result.details);
      }
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "attach", description: "Attach one existing workflow run to a project in one step" })
  attach(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("runId", { description: "Workflow run id" }) workflowRunId: string,
    @Option({ flags: "--role <role>", description: "primary|support (defaults from current project state)" })
    role?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const actor = resolveActor();
      const result = attachProjectWorkflowRun({
        projectRef,
        workflowRunId,
        ...(role?.trim() ? { role: parseProjectWorkflowRole(role) } : {}),
        ...actor,
      });

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Attached workflow ${result.workflow.workflowRunId} to ${result.details.project.slug}`);
        console.log(
          `  Linked: ${result.workflow.role ?? "-"} :: ${result.workflow.workflowRunTitle ?? result.workflow.workflowRunId}`,
        );
        if (result.defaults.ownerAgentId) console.log(`  Owner:  ${result.defaults.ownerAgentId}`);
        if (result.defaults.operatorSessionName) console.log(`  Session:${result.defaults.operatorSessionName}`);
        printProjectStatus(result.details);
      }
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

@Group({
  name: "projects.tasks",
  description: "Project-scoped task operations",
  skillGate: "ravi-system-projects",
})
export class ProjectTaskCommands {
  @Command({ name: "create", description: "Create a task attempt from a project workflow node" })
  async create(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("nodeKey", { description: "Workflow node key" }) nodeKey: string,
    @Arg("title", { description: "Task title" }) title: string,
    @Option({ flags: "--instructions <text>", description: "Task instructions" }) instructions?: string,
    @Option({ flags: "--workflow <run-id>", description: "Linked workflow run id (defaults to project focus)" })
    workflowRunId?: string,
    @Option({ flags: "--priority <priority>", description: "low|normal|high|urgent" }) priority?: string,
    @Option({ flags: "--profile <profile-id>", description: "Task profile id" }) profileId?: string,
    @Option({ flags: "--dispatch", description: "Dispatch after create using project defaults" }) dispatch?: boolean,
    @Option({ flags: "--agent <id>", description: "Override project owner agent for dispatch" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Override project operator session for dispatch" })
    sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!instructions?.trim()) {
      fail("--instructions is required");
    }

    try {
      const actor = resolveActor();
      const result = await createProjectTask({
        projectRef,
        nodeKey,
        title,
        instructions,
        ...(workflowRunId?.trim() ? { workflowRunId: workflowRunId.trim() } : {}),
        ...(priority?.trim() ? { priority: parseTaskPriority(priority) } : {}),
        ...(profileId?.trim() ? { profileId: profileId.trim() } : {}),
        dispatch: shouldDispatchProjectTask(dispatch, agentId, sessionName),
        ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
        ...(sessionName?.trim() ? { sessionName: sessionName.trim() } : {}),
        ...actor,
      });
      await emitProjectTaskCreated(result);

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Created task ${result.createdTask.id} for ${result.details.project.slug}/${nodeKey}`);
        console.log(`  Workflow:  ${result.workflow.workflowRunId}`);
        console.log(
          `  Defaults:  owner ${result.defaults.ownerAgentId ?? "-"} :: session ${result.defaults.operatorSessionName ?? "-"}`,
        );
        printProjectTaskLaunch(result.launch);
        printProjectStatus(result.details);
      }
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "attach", description: "Attach an existing task to a project workflow node" })
  async attach(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("nodeKey", { description: "Workflow node key" }) nodeKey: string,
    @Arg("taskId", { description: "Existing task id" }) taskId: string,
    @Option({ flags: "--workflow <run-id>", description: "Linked workflow run id (defaults to project focus)" })
    workflowRunId?: string,
    @Option({ flags: "--dispatch", description: "Dispatch after attach using project defaults" }) dispatch?: boolean,
    @Option({ flags: "--agent <id>", description: "Override project owner agent for dispatch" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Override project operator session for dispatch" })
    sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const actor = resolveActor();
      const result = await attachProjectTask({
        projectRef,
        nodeKey,
        taskId,
        ...(workflowRunId?.trim() ? { workflowRunId: workflowRunId.trim() } : {}),
        dispatch: shouldDispatchProjectTask(dispatch, agentId, sessionName),
        ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
        ...(sessionName?.trim() ? { sessionName: sessionName.trim() } : {}),
        ...actor,
      });
      if (result.launch) {
        await emitProjectTaskLaunch(result.launch);
      }

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Attached task ${result.task.id} to ${result.details.project.slug}/${nodeKey}`);
        console.log(`  Workflow:  ${result.workflow.workflowRunId}`);
        console.log(
          `  Defaults:  owner ${result.defaults.ownerAgentId ?? "-"} :: session ${result.defaults.operatorSessionName ?? "-"}`,
        );
        printProjectTaskLaunch(result.launch);
        printProjectStatus(result.details);
      }
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "dispatch", description: "Dispatch a task using project owner/session defaults" })
  async dispatch(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("taskId", { description: "Existing task id" }) taskId: string,
    @Option({ flags: "--agent <id>", description: "Override project owner agent" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Override project operator session" }) sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const actor = resolveActor();
      const result = await dispatchProjectTask({
        projectRef,
        taskId,
        ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
        ...(sessionName?.trim() ? { sessionName: sessionName.trim() } : {}),
        ...actor,
      });
      await emitProjectTaskLaunch(result.launch);

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Dispatched task ${result.task.id} from ${result.details.project.slug}`);
        console.log(
          `  Defaults:  owner ${result.defaults.ownerAgentId ?? "-"} :: session ${result.defaults.operatorSessionName ?? "-"}`,
        );
        printProjectTaskLaunch(result.launch);
        printProjectStatus(result.details);
      }
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

@Group({
  name: "projects.resources",
  description: "Cheap project resource links",
  scope: "open",
  skillGate: "ravi-system-projects",
})
export class ProjectResourceCommands {
  @Command({ name: "add", description: "Add one resource link to a project" })
  add(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("target", { description: "Path, URL, group id, or locator" }) target: string,
    @Option({ flags: "--type <type>", description: "repo|worktree|file|url|group|contact|notion_page|notion_database" })
    resourceType?: string,
    @Option({ flags: "--role <text>", description: "Optional role for this resource" }) role?: string,
    @Option({ flags: "--label <text>", description: "Human label override" }) label?: string,
    @Option({ flags: "--meta <json>", description: "Free JSON metadata for this resource" }) metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const resolved = resolveResourceLinkInput(target, resourceType, label, metadataJson);
      const details = linkProject({
        projectRef,
        assetType: "resource",
        assetId: resolved.assetId,
        ...(role?.trim() ? { role: role.trim() } : {}),
        metadata: resolved.metadata,
        ...resolveActor(),
      });
      const resource = getProjectResourceLink(details.project.id, resolved.assetId);
      const payload = resource ?? details;

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`\n✓ Added resource:${resolved.resourceType} -> ${details.project.slug}`);
        if (resource) {
          console.log(`  ${describeLink(resource)}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "list", description: "List resource links for a project" })
  list(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Option({ flags: "--type <type>", description: "Optional resource type filter" }) resourceType?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const resources = listProjectResourceLinks(
        projectRef,
        resourceType?.trim() ? requireResourceType(resourceType) : undefined,
      );
      const payload = { total: resources.length, resources };

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else if (resources.length === 0) {
        console.log("\nNo resource links found.\n");
      } else {
        console.log(`\nProject resources (${resources.length}):\n`);
        for (const resource of resources) {
          console.log(`- ${resource.id} :: ${describeLink(resource)}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "show", description: "Show one resource link on a project" })
  show(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Arg("resource", { description: "Resource link id, label, or locator" }) resourceRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const resource = getProjectResourceLink(projectRef, resourceRef);
      if (!resource) {
        fail(`Resource not found on project ${projectRef}: ${resourceRef}`);
      }

      if (asJson) {
        console.log(JSON.stringify(resource, null, 2));
      } else {
        printProjectResource(resource);
      }
      return resource;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "import", description: "Import multiple cheap resources into a project" })
  import(
    @Arg("project", { description: "Project id or slug" }) projectRef: string,
    @Option({ flags: "--repo <locator...>", description: "One or more repo locators (path or canonical URL)" })
    repos?: string | string[],
    @Option({ flags: "--worktree <path...>", description: "One or more local worktree paths" })
    worktrees?: string | string[],
    @Option({ flags: "--url <href...>", description: "One or more URLs" }) urls?: string | string[],
    @Option({ flags: "--group <id...>", description: "One or more group:<id> or <id>@g.us locators" })
    groups?: string | string[],
    @Option({ flags: "--role <text>", description: "Optional role applied to every imported resource" }) role?: string,
    @Option({ flags: "--meta <json>", description: "Common JSON metadata merged into every imported resource" })
    metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const queue = [
        ...toMultiValues(repos).map((target) => ({ target, type: "repo" as const })),
        ...toMultiValues(worktrees).map((target) => ({ target, type: "worktree" as const })),
        ...toMultiValues(urls).map((target) => ({ target, type: "url" as const })),
        ...toMultiValues(groups).map((target) => ({ target, type: "group" as const })),
      ];

      if (queue.length === 0) {
        fail("Provide at least one of --repo, --worktree, --url, or --group.");
      }

      const imported: ProjectResourceLink[] = [];
      const seen = new Set<string>();
      const actor = resolveActor();

      for (const entry of queue) {
        const resolved = resolveResourceLinkInput(entry.target, entry.type, undefined, metadataJson);
        const dedupeKey = `${resolved.resourceType}:${resolved.assetId}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);

        linkProject({
          projectRef,
          assetType: "resource",
          assetId: resolved.assetId,
          ...(role?.trim() ? { role: role.trim() } : {}),
          metadata: resolved.metadata,
          ...actor,
        });

        const stored = getProjectResourceLink(projectRef, resolved.assetId);
        if (stored) {
          imported.push(stored);
        }
      }

      const payload = { total: imported.length, resources: imported };

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`\n✓ Imported ${imported.length} resources into ${projectRef}\n`);
        for (const resource of imported) {
          console.log(`- ${describeLink(resource)}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

@Group({
  name: "projects.fixtures",
  description: "Canonical demo fixtures for project/workflow/task flows",
  scope: "open",
})
export class ProjectFixtureCommands {
  @Command({ name: "seed", description: "Reset and seed the canonical project fixtures used in demos and smoke tests" })
  async seed(
    @Option({ flags: "--owner-agent <id>", description: "Owner agent for the seeded projects" }) ownerAgentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const actor = resolveActor();
      const resolvedOwnerAgentId = resolveOwnerAgent(ownerAgentId) ?? resolveOwnerAgent("main");
      if (!resolvedOwnerAgentId) {
        fail("Owner agent is required.");
      }

      const result = await seedCanonicalProjectFixtures({
        ownerAgentId: resolvedOwnerAgentId,
        actor: actor.createdBy,
        actorAgentId: actor.createdByAgentId,
        actorSessionName: actor.createdBySessionName,
      });

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Seeded ${result.total} canonical project fixtures\n`);
        for (const fixture of result.fixtures) {
          console.log(
            `- ${fixture.projectSlug} :: ${fixture.projectStatus} :: runtime ${fixture.workflowStatus ?? "-"} :: ${fixture.workflowRunId}`,
          );
        }

        console.log("\nProof:");
        for (const fixture of result.fixtures) {
          console.log(`- ${fixture.projectSlug}`);
          for (const command of fixture.proofCommands.slice(0, 3)) {
            console.log(`  ${command}`);
          }
        }
      }
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
