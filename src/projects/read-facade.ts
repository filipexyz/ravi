import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { TagAssetType, TagBinding } from "../tags/types.js";
import type { TaskPriority, TaskStatus } from "../tasks/types.js";
import type {
  WorkflowNodeKind,
  WorkflowNodeReleaseMode,
  WorkflowNodeRequirement,
  WorkflowNodeRunStatus,
  WorkflowRunStatus,
} from "../workflows/types.js";
import { getRaviDbPath } from "../router/router-db.js";
import type {
  ProjectDetails,
  ProjectLink,
  ProjectListQuery,
  ProjectOperationalSurface,
  ProjectRecord,
  ProjectResourceLink,
  ProjectStatusEntry,
  ProjectSummary,
  ProjectWorkflowAggregate,
  ProjectWorkflowLinkSurface,
} from "./types.js";

type SqlRow = Record<string, unknown>;

function readAll<T>(database: Database, sql: string): T[] {
  const statement = database.prepare(sql);
  try {
    return statement.all() as T[];
  } finally {
    statement.finalize();
  }
}

interface ReadOnlyWorkflowRun {
  id: string;
  workflowSpecId: string;
  title: string;
  status: WorkflowRunStatus;
  updatedAt: number;
}

interface ReadOnlyWorkflowSpec {
  id: string;
  title: string;
}

interface ReadOnlyWorkflowNode {
  id: string;
  workflowRunId: string;
  specNodeKey: string;
  label: string;
  kind: WorkflowNodeKind;
  requirement: WorkflowNodeRequirement;
  releaseMode: WorkflowNodeReleaseMode;
  status: WorkflowNodeRunStatus;
  currentTaskId: string | null;
  lastTaskTransitionAt: number | null;
  updatedAt: number;
}

interface ReadOnlyTask {
  id: string;
  title: string;
  status: TaskStatus;
  progress: number;
  priority: TaskPriority;
}

export interface ProjectsReadSnapshot {
  dbPath: string;
  databaseExists: boolean;
  projects: ProjectRecord[];
  links: ProjectLink[];
  tags: TagBinding[];
  workflowRuns: ReadOnlyWorkflowRun[];
  workflowSpecs: ReadOnlyWorkflowSpec[];
  workflowNodes: ReadOnlyWorkflowNode[];
  tasks: ReadOnlyTask[];
}

export class ProjectsReadSchemaError extends Error {
  readonly table: string;
  readonly missingColumns: string[];

  constructor(table: string, missingColumns: string[]) {
    super(`Unsupported projects read schema in table ${table}`);
    this.name = "ProjectsReadSchemaError";
    this.table = table;
    this.missingColumns = [...missingColumns].sort();
  }
}

export class AmbiguousProjectReferenceError extends Error {
  readonly reference: string;
  readonly candidates: Array<{ id: string; slug: string }>;

  constructor(reference: string, candidates: ProjectRecord[]) {
    super(`Ambiguous project reference: ${reference}`);
    this.name = "AmbiguousProjectReferenceError";
    this.reference = reference;
    this.candidates = candidates.map(({ id, slug }) => ({ id, slug }));
  }
}

export class AmbiguousProjectResourceReferenceError extends Error {
  readonly projectId: string;
  readonly reference: string;
  readonly candidates: Array<{ id: string; assetId: string; locator: string; label: string | null }>;

  constructor(projectId: string, reference: string, candidates: ProjectResourceLink[]) {
    super(`Ambiguous project resource reference: ${reference}`);
    this.name = "AmbiguousProjectResourceReferenceError";
    this.projectId = projectId;
    this.reference = reference;
    this.candidates = candidates.map(({ id, assetId, locator, label }) => ({ id, assetId, locator, label }));
  }
}

function tableNames(database: Database): Set<string> {
  return new Set(
    readAll<{ name: string }>(database, "SELECT name FROM sqlite_master WHERE type = 'table'").map(({ name }) => name),
  );
}

function tableColumns(database: Database, table: string): Set<string> {
  const escaped = table.replaceAll('"', '""');
  return new Set(readAll<{ name: string }>(database, `PRAGMA table_info("${escaped}")`).map(({ name }) => name));
}

function requireColumns(database: Database, table: string, required: string[]): void {
  const columns = tableColumns(database, table);
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) throw new ProjectsReadSchemaError(table, missing);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readProjects(database: Database, tables: Set<string>): ProjectRecord[] {
  if (!tables.has("projects")) return [];
  requireColumns(database, "projects", [
    "id",
    "slug",
    "title",
    "status",
    "summary",
    "hypothesis",
    "next_step",
    "last_signal_at",
    "created_at",
    "updated_at",
  ]);
  return readAll<SqlRow>(database, "SELECT * FROM projects ORDER BY updated_at DESC, id ASC").map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    status: row.status as ProjectRecord["status"],
    summary: String(row.summary),
    hypothesis: String(row.hypothesis),
    nextStep: String(row.next_step),
    lastSignalAt: Number(row.last_signal_at),
    ...(optionalString(row.owner_agent_id) ? { ownerAgentId: String(row.owner_agent_id) } : {}),
    ...(optionalString(row.operator_session_name) ? { operatorSessionName: String(row.operator_session_name) } : {}),
    ...(optionalString(row.created_by) ? { createdBy: String(row.created_by) } : {}),
    ...(optionalString(row.created_by_agent_id) ? { createdByAgentId: String(row.created_by_agent_id) } : {}),
    ...(optionalString(row.created_by_session_name)
      ? { createdBySessionName: String(row.created_by_session_name) }
      : {}),
    ...(optionalNumber(row.archived_at) !== undefined ? { archivedAt: Number(row.archived_at) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

function readProjectLinks(database: Database, tables: Set<string>): ProjectLink[] {
  if (!tables.has("project_links")) return [];
  requireColumns(database, "project_links", ["id", "project_id", "asset_type", "asset_id", "created_at", "updated_at"]);
  return readAll<SqlRow>(database, "SELECT * FROM project_links ORDER BY updated_at DESC, created_at DESC, id ASC").map(
    (row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      assetType: row.asset_type as ProjectLink["assetType"],
      assetId: String(row.asset_id),
      ...(optionalString(row.role) ? { role: String(row.role) } : {}),
      ...(optionalRecord(row.metadata_json) ? { metadata: optionalRecord(row.metadata_json) } : {}),
      ...(optionalString(row.created_by) ? { createdBy: String(row.created_by) } : {}),
      ...(optionalString(row.created_by_agent_id) ? { createdByAgentId: String(row.created_by_agent_id) } : {}),
      ...(optionalString(row.created_by_session_name)
        ? { createdBySessionName: String(row.created_by_session_name) }
        : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }),
  );
}

function readProjectTags(database: Database, tables: Set<string>): TagBinding[] {
  if (!tables.has("tag_bindings") && !tables.has("tag_definitions")) return [];
  if (!tables.has("tag_bindings") || !tables.has("tag_definitions")) {
    throw new ProjectsReadSchemaError("tag_bindings/tag_definitions", [
      ...(!tables.has("tag_bindings") ? ["tag_bindings"] : []),
      ...(!tables.has("tag_definitions") ? ["tag_definitions"] : []),
    ]);
  }
  requireColumns(database, "tag_bindings", ["id", "tag_id", "asset_type", "asset_id", "created_at", "updated_at"]);
  requireColumns(database, "tag_definitions", ["id", "slug"]);
  return readAll<SqlRow>(
    database,
    `SELECT b.*, d.slug AS tag_slug
     FROM tag_bindings b
     JOIN tag_definitions d ON d.id = b.tag_id
     WHERE b.asset_type = 'project'
     ORDER BY b.updated_at DESC, b.id ASC`,
  ).map((row) => ({
    id: String(row.id),
    tagId: String(row.tag_id),
    tagSlug: String(row.tag_slug),
    assetType: row.asset_type as TagAssetType,
    assetId: String(row.asset_id),
    source: optionalString(row.source) ?? "ravi",
    ...(optionalRecord(row.metadata_json) ? { metadata: optionalRecord(row.metadata_json) } : {}),
    ...(optionalString(row.created_by) ? { createdBy: String(row.created_by) } : {}),
    ...(optionalString(row.updated_by) ? { updatedBy: String(row.updated_by) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

function readWorkflowRuns(database: Database, tables: Set<string>): ReadOnlyWorkflowRun[] {
  if (!tables.has("workflow_runs")) return [];
  requireColumns(database, "workflow_runs", ["id", "workflow_spec_id", "title", "status", "updated_at"]);
  return readAll<SqlRow>(database, "SELECT id, workflow_spec_id, title, status, updated_at FROM workflow_runs").map(
    (row) => ({
      id: String(row.id),
      workflowSpecId: String(row.workflow_spec_id),
      title: String(row.title),
      status: row.status as WorkflowRunStatus,
      updatedAt: Number(row.updated_at),
    }),
  );
}

function readWorkflowSpecs(database: Database, tables: Set<string>): ReadOnlyWorkflowSpec[] {
  if (!tables.has("workflow_specs")) return [];
  requireColumns(database, "workflow_specs", ["id", "title"]);
  return readAll<SqlRow>(database, "SELECT id, title FROM workflow_specs").map((row) => ({
    id: String(row.id),
    title: String(row.title),
  }));
}

function readWorkflowNodes(database: Database, tables: Set<string>): ReadOnlyWorkflowNode[] {
  if (!tables.has("workflow_node_runs")) return [];
  requireColumns(database, "workflow_node_runs", [
    "id",
    "workflow_run_id",
    "spec_node_key",
    "label",
    "node_kind",
    "requirement",
    "release_mode",
    "status",
    "updated_at",
  ]);
  return readAll<SqlRow>(database, "SELECT * FROM workflow_node_runs").map((row) => ({
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    specNodeKey: String(row.spec_node_key),
    label: String(row.label),
    kind: row.node_kind as WorkflowNodeKind,
    requirement: row.requirement as WorkflowNodeRequirement,
    releaseMode: row.release_mode as WorkflowNodeReleaseMode,
    status: row.status as WorkflowNodeRunStatus,
    currentTaskId: optionalString(row.current_task_id) ?? null,
    lastTaskTransitionAt: optionalNumber(row.last_task_transition_at) ?? null,
    updatedAt: Number(row.updated_at),
  }));
}

function readTasks(database: Database, tables: Set<string>): ReadOnlyTask[] {
  if (!tables.has("tasks")) return [];
  requireColumns(database, "tasks", ["id", "title", "status", "priority", "progress"]);
  return readAll<SqlRow>(database, "SELECT id, title, status, priority, progress FROM tasks").map((row) => ({
    id: String(row.id),
    title: String(row.title),
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    progress: Number(row.progress),
  }));
}

export function readProjectsSnapshot(): ProjectsReadSnapshot {
  const dbPath = getRaviDbPath();
  const empty = {
    dbPath,
    databaseExists: false,
    projects: [],
    links: [],
    tags: [],
    workflowRuns: [],
    workflowSpecs: [],
    workflowNodes: [],
    tasks: [],
  } satisfies ProjectsReadSnapshot;
  if (!existsSync(dbPath)) return empty;

  const database = new Database(dbPath, { readonly: true, create: false });
  let transactionOpen = false;
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    database.exec("BEGIN");
    transactionOpen = true;
    const tables = tableNames(database);
    const snapshot = {
      dbPath,
      databaseExists: true,
      projects: readProjects(database, tables),
      links: readProjectLinks(database, tables),
      tags: readProjectTags(database, tables),
      workflowRuns: readWorkflowRuns(database, tables),
      workflowSpecs: readWorkflowSpecs(database, tables),
      workflowNodes: readWorkflowNodes(database, tables),
      tasks: readTasks(database, tables),
    };
    database.exec("COMMIT");
    transactionOpen = false;
    return snapshot;
  } finally {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original read error; close still releases the handle.
      }
    }
    database.close();
  }
}

const WORKFLOW_STATUS_PRECEDENCE: readonly WorkflowRunStatus[] = [
  "failed",
  "blocked",
  "running",
  "ready",
  "waiting",
  "draft",
  "done",
  "cancelled",
  "archived",
];

const NODE_STATUS_PRECEDENCE: readonly WorkflowNodeRunStatus[] = [
  "failed",
  "blocked",
  "running",
  "ready",
  "awaiting_release",
  "pending",
  "done",
  "skipped",
  "cancelled",
  "archived",
];

const PROJECT_STATUS_PRECEDENCE: readonly ProjectRecord["status"][] = [
  "blocked",
  "active",
  "paused",
  "done",
  "archived",
];

function rank<T extends string>(value: T | null | undefined, order: readonly T[]): number {
  if (!value) return order.length;
  const index = order.indexOf(value);
  return index >= 0 ? index : order.length;
}

function asResourceLink(link: ProjectLink): ProjectResourceLink | null {
  if (link.assetType !== "resource") return null;
  const type = optionalString(link.metadata?.type)?.toLowerCase() as ProjectResourceLink["resourceType"];
  return {
    ...link,
    assetType: "resource",
    resourceType: type ?? null,
    locator: optionalString(link.metadata?.locator) ?? link.assetId,
    label: optionalString(link.metadata?.label) ?? null,
  };
}

export class ProjectsReadFacade {
  constructor(readonly snapshot: ProjectsReadSnapshot = readProjectsSnapshot()) {}

  private resolveProject(reference: string): ProjectRecord | null {
    const normalized = reference.trim();
    if (!normalized) throw new Error("Project reference is required.");
    const matches = this.snapshot.projects.filter(({ id, slug }) => id === normalized || slug === normalized);
    if (matches.length > 1) throw new AmbiguousProjectReferenceError(normalized, matches);
    return matches[0] ?? null;
  }

  private projectTags(project: ProjectRecord): TagBinding[] {
    return this.snapshot.tags.filter(({ assetId }) => assetId === project.id || assetId === project.slug);
  }

  private projectLinks(project: ProjectRecord): ProjectLink[] {
    return this.snapshot.links.filter(({ projectId }) => projectId === project.id);
  }

  list(query: ProjectListQuery = {}): ProjectSummary[] {
    return this.snapshot.projects
      .filter((project) => !query.status || project.status === query.status)
      .filter((project) => !query.tagSlug || this.projectTags(project).some(({ tagSlug }) => tagSlug === query.tagSlug))
      .map((project) => ({
        ...project,
        linkCount: this.projectLinks(project).length,
        tags: this.projectTags(project),
      }))
      .sort((left, right) => right.lastSignalAt - left.lastSignalAt || left.slug.localeCompare(right.slug));
  }

  get(reference: string): ProjectDetails | null {
    const project = this.resolveProject(reference);
    if (!project) return null;
    const links = this.projectLinks(project);
    const linkedWorkflows = this.linkedWorkflows(links);
    const workflowAggregate = this.workflowAggregate(linkedWorkflows);
    return {
      project,
      tags: this.projectTags(project),
      links,
      linkedWorkflows,
      workflowAggregate,
      operational: this.operationalSurface(linkedWorkflows, workflowAggregate),
    };
  }

  status(query: ProjectListQuery = {}): ProjectStatusEntry[] {
    return this.list(query)
      .map((project) => {
        const details = this.get(project.id)!;
        return {
          project,
          links: details.links,
          linkedWorkflows: details.linkedWorkflows,
          workflowAggregate: details.workflowAggregate,
          operational: details.operational,
        };
      })
      .sort(
        (left, right) =>
          rank(left.operational?.runtimeStatus, WORKFLOW_STATUS_PRECEDENCE) -
            rank(right.operational?.runtimeStatus, WORKFLOW_STATUS_PRECEDENCE) ||
          rank(left.project.status, PROJECT_STATUS_PRECEDENCE) -
            rank(right.project.status, PROJECT_STATUS_PRECEDENCE) ||
          right.project.lastSignalAt - left.project.lastSignalAt ||
          left.project.slug.localeCompare(right.project.slug),
      );
  }

  resources(projectReference: string): ProjectResourceLink[] {
    const project = this.resolveProject(projectReference);
    if (!project) return [];
    return this.projectLinks(project)
      .map(asResourceLink)
      .filter((link): link is ProjectResourceLink => Boolean(link));
  }

  resource(projectReference: string, resourceReference: string): ProjectResourceLink | null {
    const project = this.resolveProject(projectReference);
    if (!project) return null;
    const normalized = resourceReference.trim();
    if (!normalized) throw new Error("Resource reference is required.");
    const needle = normalized.toLowerCase();
    const matches = this.resources(project.id).filter(
      ({ id, assetId, locator, label }) =>
        id === normalized || assetId === normalized || locator === normalized || label?.toLowerCase() === needle,
    );
    if (matches.length > 1) throw new AmbiguousProjectResourceReferenceError(project.id, normalized, matches);
    return matches[0] ?? null;
  }

  private linkedWorkflows(links: ProjectLink[]): ProjectWorkflowLinkSurface[] {
    return links
      .filter(({ assetType }) => assetType === "workflow")
      .map((link) => {
        const run = this.snapshot.workflowRuns.find(({ id }) => id === link.assetId);
        const spec = run ? this.snapshot.workflowSpecs.find(({ id }) => id === run.workflowSpecId) : undefined;
        return {
          linkId: link.id,
          role: link.role ?? null,
          workflowRunId: link.assetId,
          workflowRunTitle: run?.title ?? null,
          workflowRunStatus: run?.status ?? null,
          workflowSpecId: run?.workflowSpecId ?? null,
          workflowSpecTitle: spec?.title ?? null,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt,
        };
      });
  }

  private workflowAggregate(workflows: ProjectWorkflowLinkSurface[]): ProjectWorkflowAggregate | null {
    if (workflows.length === 0) return null;
    const ordered = [...workflows].sort(
      (left, right) =>
        (left.role === "primary" ? -1 : 0) - (right.role === "primary" ? -1 : 0) ||
        right.updatedAt - left.updatedAt ||
        left.workflowRunId.localeCompare(right.workflowRunId),
    );
    const primary = ordered[0];
    const focused = [...workflows].sort(
      (left, right) => right.updatedAt - left.updatedAt || left.workflowRunId.localeCompare(right.workflowRunId),
    )[0];
    const aggregate: ProjectWorkflowAggregate = {
      total: workflows.length,
      missing: 0,
      draft: 0,
      waiting: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      archived: 0,
      primaryWorkflowRunId: primary?.workflowRunId ?? null,
      primaryWorkflowTitle: primary?.workflowRunTitle ?? null,
      primaryWorkflowStatus: primary?.workflowRunStatus ?? null,
      focusedWorkflowRunId: focused?.workflowRunId ?? null,
      focusedWorkflowTitle: focused?.workflowRunTitle ?? null,
      focusedWorkflowStatus: focused?.workflowRunStatus ?? null,
      focusedWorkflowRole: focused?.role ?? null,
      overallStatus: null,
    };
    for (const workflow of workflows) {
      if (!workflow.workflowRunStatus) aggregate.missing += 1;
      else aggregate[workflow.workflowRunStatus] += 1;
    }
    aggregate.overallStatus = WORKFLOW_STATUS_PRECEDENCE.find((status) => aggregate[status] > 0) ?? null;
    return aggregate;
  }

  private operationalSurface(
    workflows: ProjectWorkflowLinkSurface[],
    aggregate: ProjectWorkflowAggregate | null,
  ): ProjectOperationalSurface | null {
    if (workflows.length === 0) return null;
    const hottestWorkflow = [...workflows].sort(
      (left, right) =>
        rank(left.workflowRunStatus, WORKFLOW_STATUS_PRECEDENCE) -
          rank(right.workflowRunStatus, WORKFLOW_STATUS_PRECEDENCE) ||
        (left.role === "primary" ? -1 : 0) - (right.role === "primary" ? -1 : 0) ||
        right.updatedAt - left.updatedAt ||
        left.workflowRunId.localeCompare(right.workflowRunId),
    )[0]!;
    const hottestNode = this.snapshot.workflowNodes
      .filter(({ workflowRunId }) => workflowRunId === hottestWorkflow.workflowRunId)
      .sort(
        (left, right) =>
          rank(left.status, NODE_STATUS_PRECEDENCE) - rank(right.status, NODE_STATUS_PRECEDENCE) ||
          Number(Boolean(right.currentTaskId)) - Number(Boolean(left.currentTaskId)) ||
          (right.lastTaskTransitionAt ?? 0) - (left.lastTaskTransitionAt ?? 0) ||
          right.updatedAt - left.updatedAt ||
          left.specNodeKey.localeCompare(right.specNodeKey),
      )[0];
    const task = hottestNode?.currentTaskId
      ? this.snapshot.tasks.find(({ id }) => id === hottestNode.currentTaskId)
      : undefined;
    return {
      runtimeStatus: aggregate?.overallStatus ?? hottestWorkflow.workflowRunStatus,
      workflowCount: workflows.length,
      hottestWorkflowRunId: hottestWorkflow.workflowRunId,
      hottestWorkflowTitle: hottestWorkflow.workflowRunTitle ?? hottestWorkflow.workflowRunId,
      hottestWorkflowStatus: hottestWorkflow.workflowRunStatus,
      hottestNodeRunId: hottestNode?.id ?? null,
      hottestNodeKey: hottestNode?.specNodeKey ?? null,
      hottestNodeLabel: hottestNode?.label ?? null,
      hottestNodeKind: hottestNode?.kind ?? null,
      hottestNodeRequirement: hottestNode?.requirement ?? null,
      hottestNodeReleaseMode: hottestNode?.releaseMode ?? null,
      hottestNodeStatus: hottestNode?.status ?? null,
      hottestTaskId: task?.id ?? null,
      hottestTaskTitle: task?.title ?? null,
      hottestTaskStatus: task?.status ?? null,
      hottestTaskProgress: task?.progress ?? null,
      hottestTaskPriority: task?.priority ?? null,
    };
  }
}
