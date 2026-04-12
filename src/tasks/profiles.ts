import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { discoverPlugins } from "../plugins/index.js";
import { getRaviStateDir } from "../utils/paths.js";
import systemProfilesRaw from "./profile-catalog/system-profiles.json" with { type: "json" };
import type {
  DispatchTaskInput,
  ResolvedTaskProfile,
  TaskProfileArtifactDefinition,
  TaskProfileArtifactRef,
  TaskProfileDefinition,
  TaskProfileScaffoldPreset,
  TaskProfileInputValues,
  TaskProfileTaskDocumentUsage,
  TaskProfileSnapshot,
  TaskProfileStateFieldDefinition,
  TaskProfileSourceKind,
  TaskProfileState,
  TaskRecord,
  TaskWorktreeConfig,
} from "./types.js";

export const DEFAULT_TASK_PROFILE_ID = "default";
export const BRAINSTORM_TASK_PROFILE_ID = "brainstorm";

const TASK_PROFILE_SOURCE_PRECEDENCE: TaskProfileSourceKind[] = ["system", "plugin", "workspace", "user"];
const PROFILE_MANIFEST_FILENAME = "profile.json";
const WORKSPACE_PROFILE_SEGMENTS = [".ravi", "task-profiles"] as const;
const LEGACY_PROFILE_DRIVER_KEY = "driver";
const LEGACY_TASK_DOCUMENT_TOP_LEVEL_KEY = "taskDoc" + "Mode";
const LEGACY_TASK_DOCUMENT_SYNC_KEY = "taskDoc" + "First";

function expandProfileHomePath(path: string): string {
  if (!path.startsWith("~")) {
    return path;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    return path;
  }

  if (path === "~") {
    return home;
  }

  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolvePath(home, path.slice(2));
  }

  return path;
}

const TaskProfileTemplateRefObjectSchema = z
  .object({
    inline: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const provided = Number(Boolean(value.inline)) + Number(Boolean(value.path));
    if (provided !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Template reference requires exactly one of inline or path.",
      });
    }
  });

const TaskProfileTemplateRefSchema = z.union([z.string().trim().min(1), TaskProfileTemplateRefObjectSchema]);

const TaskProfileArtifactDefinitionSchema = z.object({
  kind: z.string().trim().min(1),
  label: z.string().trim().min(1),
  pathTemplate: z.string().trim().min(1),
  primary: z.boolean().optional(),
  primaryWhenStatuses: z.array(z.enum(["open", "dispatched", "in_progress", "blocked", "done", "failed"])).default([]),
  showWhenStatuses: z.array(z.enum(["open", "dispatched", "in_progress", "blocked", "done", "failed"])).default([]),
});

const TaskProfileStateFieldDefinitionSchema = z.object({
  path: z.string().trim().min(1),
  valueTemplate: z.string().trim().min(1),
  transform: z.enum(["identity", "slug"]).optional(),
});

const TaskProfileManifestSchema = z.object({
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  sessionNameTemplate: z.string().trim().min(1),
  workspaceBootstrap: z.object({
    mode: z.enum(["inherit", "task_dir", "path"]),
    path: z.string().trim().min(1).optional(),
    branch: z.string().trim().min(1).optional(),
    ensureTaskDir: z.boolean(),
  }),
  sync: z.object({
    artifactFirst: z.boolean().optional(),
    taskDocument: z
      .object({
        mode: z.enum(["required", "optional"]),
      })
      .optional(),
  }),
  rendererHints: z.object({
    label: z.string().trim().min(1),
    showTaskDoc: z.boolean(),
    showWorkspace: z.boolean(),
  }),
  defaultTags: z.array(z.string().trim().min(1)).default([]),
  inputs: z
    .array(
      z.object({
        key: z.string().trim().min(1),
        label: z.string().trim().min(1).optional(),
        description: z.string().trim().min(1).optional(),
        required: z.boolean().optional(),
        defaultValue: z.string().optional(),
      }),
    )
    .default([]),
  completion: z
    .object({
      summaryRequired: z.boolean().optional(),
      summaryLabel: z.string().trim().min(1).optional(),
      notes: z.string().trim().min(1).optional(),
    })
    .default({}),
  progress: z
    .object({
      requireMessage: z.boolean().optional(),
      notes: z.string().trim().min(1).optional(),
    })
    .default({}),
  artifacts: z.array(TaskProfileArtifactDefinitionSchema).default([]),
  state: z.array(TaskProfileStateFieldDefinitionSchema).default([]),
  templates: z.object({
    dispatch: TaskProfileTemplateRefSchema,
    resume: TaskProfileTemplateRefSchema,
    dispatchSummary: TaskProfileTemplateRefSchema,
    dispatchEventMessage: TaskProfileTemplateRefSchema,
  }),
});

type TaskProfileManifest = z.infer<typeof TaskProfileManifestSchema>;
type TaskProfileTemplateKey = keyof TaskProfileManifest["templates"];

interface ProfileLoadSource {
  sourceKind: TaskProfileSourceKind;
  source: string;
  manifestPath?: string | null;
}

interface TaskProfileProtocolContext {
  task: TaskRecord;
  profile: ResolvedTaskProfile;
  effectiveCwd: string;
  worktree?: TaskWorktreeConfig;
  taskDocPath?: string | null;
  primaryArtifact: TaskProfileArtifactRef | null;
  input?: Record<string, string>;
  agentId?: string;
  sessionName?: string;
}

export interface TaskProfilePreviewResult {
  profile: ResolvedTaskProfile;
  task: TaskRecord;
  primaryArtifact: TaskProfileArtifactRef | null;
  rendered: {
    dispatch: string;
    resume: string;
    dispatchSummary: string;
    dispatchEventMessage: string;
  };
  input: Record<string, string>;
}

export interface TaskProfileValidationResult {
  id: string;
  version: string;
  sourceKind: TaskProfileSourceKind;
  source: string;
  valid: boolean;
  error?: string;
}

export interface InitTaskProfileScaffoldResult {
  sourceKind: "workspace" | "user";
  profileDir: string;
  manifestPath: string;
}

function normalizeTaskProfileSyncPolicy(
  sync: TaskProfileManifest["sync"] | TaskProfileDefinition["sync"],
): TaskProfileDefinition["sync"] {
  return {
    artifactFirst: sync.artifactFirst ?? sync.taskDocument?.mode === "required",
    ...(sync.taskDocument ? { taskDocument: { mode: sync.taskDocument.mode } } : {}),
  };
}

export function getTaskProfileTaskDocumentMode(
  profile: Pick<TaskProfileDefinition, "sync">,
): TaskProfileTaskDocumentUsage {
  return profile.sync.taskDocument?.mode ?? "none";
}

export function taskProfileUsesTaskDocument(profile: Pick<TaskProfileDefinition, "sync">): boolean {
  return getTaskProfileTaskDocumentMode(profile) !== "none";
}

export function taskProfileRequiresTaskDocument(profile: Pick<TaskProfileDefinition, "sync">): boolean {
  return getTaskProfileTaskDocumentMode(profile) === "required";
}

export function taskProfileUsesArtifactFirstSync(profile: Pick<TaskProfileDefinition, "sync">): boolean {
  return profile.sync.artifactFirst ?? false;
}

function normalizeProfileId(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeTemplateString(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function formatTaskWorktree(worktree?: TaskWorktreeConfig): string {
  if (!worktree || worktree.mode === "inherit") {
    return "agent default cwd";
  }
  return `${worktree.path ?? "-"}${worktree.branch ? ` (branch ${worktree.branch})` : ""}`;
}

function parseTaskProfileManifest(raw: unknown, source: ProfileLoadSource): TaskProfileManifest {
  assertNoLegacyTaskProfileFields(raw, source);
  try {
    return TaskProfileManifestSchema.parse(raw);
  } catch (error) {
    const origin = source.manifestPath ?? source.source;
    throw new Error(
      `Invalid task profile manifest at ${origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertNoLegacyTaskProfileFields(raw: unknown, source: ProfileLoadSource): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  const origin = source.manifestPath ?? source.source;
  const manifest = raw as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(manifest, LEGACY_PROFILE_DRIVER_KEY)) {
    throw new Error(
      `Task profile manifest at ${origin} uses removed field "driver". Keep runtime contracts declarative and use --preset only with ravi tasks profiles init.`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(manifest, LEGACY_TASK_DOCUMENT_TOP_LEVEL_KEY)) {
    throw new Error(
      `Task profile manifest at ${origin} uses a removed top-level task document field. Use sync.taskDocument.`,
    );
  }

  const sync = manifest.sync;
  if (!sync || typeof sync !== "object" || Array.isArray(sync)) {
    return;
  }

  const syncRecord = sync as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(syncRecord, LEGACY_TASK_DOCUMENT_SYNC_KEY)) {
    throw new Error(
      `Task profile manifest at ${origin} uses a removed sync alias for artifact-first behavior. Use sync.artifactFirst.`,
    );
  }

  const taskDocument = syncRecord.taskDocument;
  if (!taskDocument || typeof taskDocument !== "object" || Array.isArray(taskDocument)) {
    return;
  }

  const mode = (taskDocument as Record<string, unknown>).mode;
  if (mode === "none") {
    throw new Error(
      `Task profile manifest at ${origin} uses removed mode "sync.taskDocument.mode=none". Omit taskDocument.`,
    );
  }
}

function readTemplateRef(
  ref: TaskProfileManifest["templates"][TaskProfileTemplateKey],
  source: ProfileLoadSource,
  templateKey: TaskProfileTemplateKey,
): string {
  if (typeof ref === "string") {
    return normalizeTemplateString(ref);
  }
  if (ref.inline) {
    return normalizeTemplateString(ref.inline);
  }

  const manifestDir = source.manifestPath ? dirname(source.manifestPath) : null;
  if (!manifestDir) {
    throw new Error(`Task profile ${source.source} template ${templateKey} uses a relative path without manifestPath.`);
  }

  const absoluteTemplatePath = resolvePath(manifestDir, ref.path!);
  if (!existsSync(absoluteTemplatePath)) {
    throw new Error(
      `Task profile ${source.manifestPath} references missing template ${templateKey}: ${absoluteTemplatePath}`,
    );
  }
  return normalizeTemplateString(readFileSync(absoluteTemplatePath, "utf8"));
}

function resolveManifestToProfile(manifest: TaskProfileManifest, source: ProfileLoadSource): TaskProfileSnapshot {
  return {
    id: manifest.id,
    version: manifest.version,
    label: manifest.label,
    description: manifest.description,
    sessionNameTemplate: manifest.sessionNameTemplate,
    workspaceBootstrap: manifest.workspaceBootstrap,
    sync: normalizeTaskProfileSyncPolicy(manifest.sync),
    rendererHints: manifest.rendererHints,
    defaultTags: [...manifest.defaultTags],
    inputs: manifest.inputs.map((item) => ({ ...item })),
    completion: { ...manifest.completion },
    progress: { ...manifest.progress },
    artifacts: manifest.artifacts.map((artifact) => ({
      ...artifact,
      primaryWhenStatuses: [...artifact.primaryWhenStatuses],
      showWhenStatuses: [...artifact.showWhenStatuses],
    })),
    state: manifest.state.map((field) => ({ ...field })),
    templates: {
      dispatch: readTemplateRef(manifest.templates.dispatch, source, "dispatch"),
      resume: readTemplateRef(manifest.templates.resume, source, "resume"),
      dispatchSummary: readTemplateRef(manifest.templates.dispatchSummary, source, "dispatchSummary"),
      dispatchEventMessage: readTemplateRef(manifest.templates.dispatchEventMessage, source, "dispatchEventMessage"),
    },
    sourceKind: source.sourceKind,
    source: source.source,
    manifestPath: source.manifestPath ?? null,
  };
}

function toResolvedTaskProfile(definition: TaskProfileDefinition, requestedId: string | null): ResolvedTaskProfile {
  const sync = normalizeTaskProfileSyncPolicy(definition.sync);
  return {
    ...definition,
    sync,
    defaultTags: [...(definition.defaultTags ?? [])],
    inputs: [...(definition.inputs ?? [])],
    completion: { ...(definition.completion ?? {}) },
    progress: { ...(definition.progress ?? {}) },
    artifacts: (definition.artifacts ?? []).map((artifact) => ({
      ...artifact,
      primaryWhenStatuses: [...(artifact.primaryWhenStatuses ?? [])],
      showWhenStatuses: [...(artifact.showWhenStatuses ?? [])],
    })),
    state: (definition.state ?? []).map((field) => ({ ...field })),
    requestedId,
    resolvedFromFallback: definition.id !== (requestedId ?? DEFAULT_TASK_PROFILE_ID),
  };
}

export function buildTaskProfileSnapshot(profile: ResolvedTaskProfile): TaskProfileSnapshot {
  const { requestedId: _requestedId, resolvedFromFallback: _resolvedFromFallback, ...snapshot } = profile;
  return snapshot;
}

export function resolveTaskProfileForTask(
  task: Pick<TaskRecord, "profileId" | "profileSnapshot">,
): ResolvedTaskProfile {
  if (task.profileSnapshot) {
    return toResolvedTaskProfile(task.profileSnapshot, normalizeProfileId(task.profileId) ?? task.profileSnapshot.id);
  }
  return resolveTaskProfile(task.profileId);
}

function buildSystemProfiles(): TaskProfileSnapshot[] {
  const manifests = z.array(z.unknown()).parse(systemProfilesRaw);
  return manifests.map((raw) => {
    const manifest = parseTaskProfileManifest(raw, {
      sourceKind: "system",
      source: "system",
      manifestPath: null,
    });
    return resolveManifestToProfile(manifest, {
      sourceKind: "system",
      source: `system:${manifest.id}`,
      manifestPath: null,
    });
  });
}

function loadProfilesFromDirectory(
  root: string,
  sourceKind: Exclude<TaskProfileSourceKind, "system">,
  sourcePrefix: string,
): TaskProfileSnapshot[] {
  if (!existsSync(root)) {
    return [];
  }

  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const profiles: TaskProfileSnapshot[] = [];
  for (const entry of entries) {
    const manifestPath = joinPath(root, entry.name, PROFILE_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      continue;
    }
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifest = parseTaskProfileManifest(raw, {
      sourceKind,
      source: sourcePrefix,
      manifestPath,
    });
    profiles.push(
      resolveManifestToProfile(manifest, {
        sourceKind,
        source: `${sourcePrefix}:${manifestPath}`,
        manifestPath,
      }),
    );
  }

  return profiles;
}

function listWorkspaceProfileRoots(cwd = process.cwd()): string[] {
  const roots: string[] = [];
  let current = resolvePath(cwd);

  while (true) {
    const candidate = joinPath(current, ...WORKSPACE_PROFILE_SEGMENTS);
    if (existsSync(candidate)) {
      roots.push(candidate);
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots.reverse();
}

function loadPluginProfiles(): TaskProfileSnapshot[] {
  const plugins = discoverPlugins();
  const profiles: TaskProfileSnapshot[] = [];
  for (const plugin of plugins) {
    const pluginName = plugin.path.split("/").pop() ?? "plugin";
    profiles.push(
      ...loadProfilesFromDirectory(joinPath(plugin.path, "task-profiles"), "plugin", `plugin:${pluginName}`),
    );
  }
  return profiles;
}

function loadWorkspaceProfiles(): TaskProfileSnapshot[] {
  const profiles: TaskProfileSnapshot[] = [];
  for (const root of listWorkspaceProfileRoots()) {
    profiles.push(...loadProfilesFromDirectory(root, "workspace", "workspace"));
  }
  return profiles;
}

function loadUserProfiles(): TaskProfileSnapshot[] {
  return loadProfilesFromDirectory(joinPath(getRaviStateDir(), "task-profiles"), "user", "user");
}

function loadTaskProfileCatalog(): Map<string, TaskProfileSnapshot> {
  const catalog = new Map<string, TaskProfileSnapshot>();
  const sources: Record<TaskProfileSourceKind, TaskProfileSnapshot[]> = {
    system: buildSystemProfiles(),
    plugin: loadPluginProfiles(),
    workspace: loadWorkspaceProfiles(),
    user: loadUserProfiles(),
  };

  for (const sourceKind of TASK_PROFILE_SOURCE_PRECEDENCE) {
    for (const profile of sources[sourceKind]) {
      catalog.set(profile.id, profile);
    }
  }

  return catalog;
}

export function listTaskProfiles(): ResolvedTaskProfile[] {
  return [...loadTaskProfileCatalog().values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((profile) => toResolvedTaskProfile(profile, profile.id));
}

export function getTaskProfileDefinition(profileId?: string | null): TaskProfileDefinition | undefined {
  const normalized = normalizeProfileId(profileId);
  if (!normalized) {
    return undefined;
  }
  return loadTaskProfileCatalog().get(normalized);
}

export function requireTaskProfileDefinition(profileId?: string | null): TaskProfileDefinition {
  const normalized = normalizeProfileId(profileId);
  if (!normalized) {
    const fallback = loadTaskProfileCatalog().get(DEFAULT_TASK_PROFILE_ID);
    if (!fallback) {
      throw new Error(`Missing built-in task profile: ${DEFAULT_TASK_PROFILE_ID}`);
    }
    return fallback;
  }

  const profile = loadTaskProfileCatalog().get(normalized);
  if (!profile) {
    throw new Error(
      `Unknown task profile: ${normalized}. Available profiles: ${listTaskProfiles()
        .map((item) => item.id)
        .join(", ")}.`,
    );
  }
  return profile;
}

export function resolveTaskProfile(profileId?: string | null): ResolvedTaskProfile {
  const requestedId = normalizeProfileId(profileId) ?? null;
  const definition = requireTaskProfileDefinition(requestedId ?? DEFAULT_TASK_PROFILE_ID);
  return toResolvedTaskProfile(definition, requestedId);
}

export function renderTaskSessionTemplate(template: string, taskId: string): string {
  return template.replaceAll("<task-id>", taskId);
}

export function getDefaultTaskSessionNameForProfile(taskId: string, profileId?: string | null): string {
  const profile = resolveTaskProfile(profileId);
  return renderTaskSessionTemplate(profile.sessionNameTemplate, taskId);
}

export function getDefaultTaskSessionNameForTask(
  task: Pick<TaskRecord, "id" | "profileId" | "profileSnapshot">,
): string {
  const profile = resolveTaskProfileForTask(task);
  return renderTaskSessionTemplate(profile.sessionNameTemplate, task.id);
}

export function resolveBrainstormTaskSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "brainstorm";
}

function cloneTaskProfileState(state?: TaskProfileState): TaskProfileState {
  return state ? (JSON.parse(JSON.stringify(state)) as TaskProfileState) : {};
}

function getTaskProfileStateValue(state: TaskProfileState | undefined, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = state;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setTaskProfileStateValue(state: TaskProfileState, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  let current: Record<string, unknown> = state as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function applyTaskProfileStateTransform(
  value: string,
  transform?: TaskProfileStateFieldDefinition["transform"],
): string {
  const resolvedTransform = transform ?? "identity";
  switch (resolvedTransform) {
    case "identity":
      return value;
    case "slug":
      return resolveBrainstormTaskSlug(value);
  }
}

function buildStateTemplateContext(
  task: Pick<TaskRecord, "title" | "profileInput"> &
    Partial<
      Pick<
        TaskRecord,
        | "id"
        | "instructions"
        | "status"
        | "priority"
        | "progress"
        | "parentTaskId"
        | "taskDir"
        | "summary"
        | "blockerReason"
      >
    >,
  profile: ResolvedTaskProfile,
  profileState: TaskProfileState,
): Record<string, unknown> {
  return {
    task: {
      id: task.id ?? "",
      title: task.title,
      instructions: task.instructions ?? "",
      status: task.status ?? "open",
      priority: task.priority ?? "normal",
      progress: task.progress ?? 0,
      parentTaskId: task.parentTaskId ?? "",
      taskDir: task.taskDir ?? "",
      summary: task.summary ?? "",
      blockerReason: task.blockerReason ?? "",
    },
    profile: {
      id: profile.id,
      version: profile.version,
      label: profile.label,
      description: profile.description,
      sync: profile.sync,
      source: profile.source,
      sourceKind: profile.sourceKind,
    },
    profileState,
    session: {
      agentId: "",
      name: "",
      cwd: "",
    },
    worktree: {
      mode: "inherit",
      path: "",
      branch: "",
      label: "agent default cwd",
    },
    artifacts: {
      primary: null,
      items: [],
      byKind: {},
    },
    input: resolveProfileInputValues(profile, task.profileInput),
  };
}

export function resolveTaskProfileState(
  task: Pick<TaskRecord, "title" | "profileId" | "profileSnapshot" | "profileState" | "profileInput">,
  profileArg?: ResolvedTaskProfile,
): TaskProfileState | undefined {
  const profile = profileArg ?? resolveTaskProfileForTask(task);
  if (profile.state.length === 0) {
    return task.profileState;
  }
  const resolvedState = cloneTaskProfileState(task.profileState);

  for (const field of profile.state) {
    const existing = getTaskProfileStateValue(resolvedState, field.path);
    if (existing !== undefined && existing !== null && String(existing).trim() !== "") {
      continue;
    }

    const rendered = renderStrictTemplate(
      field.valueTemplate,
      buildStateTemplateContext(task, profile, resolvedState),
      {
        profileId: profile.id,
        templateName: `state:${field.path}`,
      },
    );
    setTaskProfileStateValue(resolvedState, field.path, applyTaskProfileStateTransform(rendered, field.transform));
  }

  return Object.keys(resolvedState).length > 0 ? resolvedState : undefined;
}

export function shouldPersistTaskProfileState(
  task: Pick<TaskRecord, "title" | "profileId" | "profileSnapshot" | "profileState" | "profileInput">,
  profileArg?: ResolvedTaskProfile,
): boolean {
  const profile = profileArg ?? resolveTaskProfileForTask(task);
  const currentState = task.profileState ?? {};
  const resolvedState = resolveTaskProfileState(task, profile) ?? {};
  return JSON.stringify(currentState) !== JSON.stringify(resolvedState);
}

function shouldShowArtifact(definition: TaskProfileArtifactDefinition, status: TaskRecord["status"]): boolean {
  return (definition.showWhenStatuses ?? []).length === 0 || (definition.showWhenStatuses ?? []).includes(status);
}

function buildArtifactRenderContext(
  task: TaskRecord,
  context: Omit<TaskProfileProtocolContext, "primaryArtifact">,
  profileState: TaskProfileState | undefined,
): Record<string, unknown> {
  return {
    task: {
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      status: task.status,
      priority: task.priority,
      progress: task.progress,
      parentTaskId: task.parentTaskId ?? "",
      taskDir: task.taskDir ?? "",
      taskDocPath: context.taskDocPath ?? "",
      profileId: task.profileId ?? context.profile.id,
      profileVersion: task.profileVersion ?? context.profile.version,
      profileSource: task.profileSource ?? context.profile.source,
      summary: task.summary ?? "",
      blockerReason: task.blockerReason ?? "",
    },
    profile: {
      id: context.profile.id,
      version: context.profile.version,
      label: context.profile.label,
      description: context.profile.description,
      sync: context.profile.sync,
      source: context.profile.source,
      sourceKind: context.profile.sourceKind,
      workspaceBootstrap: context.profile.workspaceBootstrap,
      rendererHints: context.profile.rendererHints,
      defaultTags: context.profile.defaultTags,
      inputs: context.profile.inputs,
      completion: context.profile.completion,
      progress: context.profile.progress,
    },
    session: {
      agentId: context.agentId ?? "",
      name: context.sessionName ?? "",
      cwd: context.effectiveCwd,
    },
    worktree: {
      mode: context.worktree?.mode ?? "inherit",
      path: context.worktree?.path ?? "",
      branch: context.worktree?.branch ?? "",
      label: formatTaskWorktree(context.worktree),
    },
    profileState: profileState ?? {},
    input: resolveProfileInputValues(context.profile, task.profileInput, context.input),
  };
}

interface ResolvedProfileArtifact {
  artifact: TaskProfileArtifactRef;
  primaryCandidate: boolean;
}

function buildResolvedProfileArtifacts(
  task: TaskRecord,
  context: Omit<TaskProfileProtocolContext, "primaryArtifact">,
): ResolvedProfileArtifact[] {
  const profileState = resolveTaskProfileState(task, context.profile);
  const renderContext = buildArtifactRenderContext(task, context, profileState);
  const explicitPrimaryKinds = new Set(
    context.profile.artifacts
      .filter((artifact) => (artifact.primaryWhenStatuses ?? []).includes(task.status))
      .map((artifact) => artifact.kind),
  );
  const useExplicitPrimary = explicitPrimaryKinds.size > 0;

  return context.profile.artifacts
    .filter((artifact) => shouldShowArtifact(artifact, task.status))
    .map((definition) => {
      const path = renderStrictTemplate(definition.pathTemplate, renderContext, {
        profileId: context.profile.id,
        templateName: `artifact:${definition.kind}`,
      }).trim();

      if (!path || path === "-") {
        return null;
      }

      return {
        artifact: {
          kind: definition.kind,
          label: definition.label,
          path,
        },
        primaryCandidate: useExplicitPrimary ? explicitPrimaryKinds.has(definition.kind) : Boolean(definition.primary),
      };
    })
    .filter((artifact): artifact is ResolvedProfileArtifact => artifact !== null);
}

export function resolveTaskProfileArtifacts(
  task: TaskRecord,
  options: {
    effectiveCwd: string;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    worktree?: TaskWorktreeConfig;
    agentId?: string;
    sessionName?: string;
    input?: Record<string, string>;
  },
): TaskProfileArtifactRef[] {
  const profile = options.taskProfile ?? resolveTaskProfileForTask(task);
  return buildResolvedProfileArtifacts(task, {
    task,
    profile,
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    ...(options.input ? { input: options.input } : {}),
  }).map((item) => item.artifact);
}

function resolveProtocolPrimaryArtifact(
  task: TaskRecord,
  context: Omit<TaskProfileProtocolContext, "primaryArtifact">,
): TaskProfileArtifactRef | null {
  const artifacts = buildResolvedProfileArtifacts(task, context);
  if (artifacts.length === 0) {
    return null;
  }
  return artifacts.find((artifact) => artifact.primaryCandidate)?.artifact ?? artifacts[0]?.artifact ?? null;
}

function buildArtifactTemplateModel(
  task: TaskRecord,
  context: Omit<TaskProfileProtocolContext, "primaryArtifact">,
  primaryArtifact: TaskProfileArtifactRef | null,
): Record<string, unknown> {
  const artifacts = buildResolvedProfileArtifacts(task, context).map((item) => item.artifact);
  const byKind = Object.fromEntries(artifacts.map((artifact) => [artifact.kind, artifact]));
  const primary = primaryArtifact ?? resolveProtocolPrimaryArtifact(task, context);

  return {
    primary,
    items: artifacts,
    byKind,
  };
}

function resolveProfileInputValues(
  profile: ResolvedTaskProfile,
  taskInput?: TaskProfileInputValues,
  overrideInput?: Record<string, string>,
): TaskProfileInputValues {
  const resolved: TaskProfileInputValues = {};
  for (const definition of profile.inputs) {
    if (definition.defaultValue !== undefined) {
      resolved[definition.key] = definition.defaultValue;
    }
  }
  for (const [key, value] of Object.entries(taskInput ?? {})) {
    resolved[key] = value;
  }
  for (const [key, value] of Object.entries(overrideInput ?? {})) {
    resolved[key] = value;
  }

  const missingRequired = profile.inputs
    .filter((definition) => definition.required)
    .map((definition) => definition.key)
    .filter((key) => !resolved[key]?.trim());
  if (missingRequired.length > 0) {
    throw new Error(`Task profile ${profile.id} requires input(s): ${missingRequired.join(", ")}.`);
  }

  return resolved;
}

export function resolveTaskProfileInputValues(
  profileArg: ResolvedTaskProfile | string,
  taskInput?: TaskProfileInputValues,
  overrideInput?: Record<string, string>,
): TaskProfileInputValues {
  const profile = typeof profileArg === "string" ? resolveTaskProfile(profileArg) : profileArg;
  return resolveProfileInputValues(profile, taskInput, overrideInput);
}

function resolveTemplatePath(root: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function toTemplateString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function renderStrictTemplate(
  template: string,
  context: Record<string, unknown>,
  metadata: { profileId: string; templateName: string },
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (!key) {
      throw new Error(`Task profile ${metadata.profileId} has an empty placeholder in ${metadata.templateName}.`);
    }

    const root = key.split(".")[0];
    if (!["task", "profile", "session", "worktree", "artifacts", "profileState", "input"].includes(root)) {
      throw new Error(
        `Unknown placeholder root "${root}" in task profile ${metadata.profileId} template ${metadata.templateName}.`,
      );
    }

    const value = resolveTemplatePath(context, key);
    if (value === undefined) {
      throw new Error(
        `Unknown placeholder "{{${key}}}" in task profile ${metadata.profileId} template ${metadata.templateName}.`,
      );
    }
    return toTemplateString(value);
  });
}

function buildTemplateContext(
  task: TaskRecord,
  options: {
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    primaryArtifact?: TaskProfileArtifactRef | null;
    agentId?: string;
    sessionName?: string;
    input?: Record<string, string>;
  },
): Record<string, unknown> {
  const profile = options.taskProfile ?? resolveTaskProfileForTask(task);
  const profileState = resolveTaskProfileState(task, profile) ?? {};
  const protocolArtifacts = buildArtifactTemplateModel(
    task,
    {
      task,
      profile,
      effectiveCwd: options.effectiveCwd,
      ...(options.worktree ? { worktree: options.worktree } : {}),
      ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
      ...(options.agentId ? { agentId: options.agentId } : {}),
      ...(options.sessionName ? { sessionName: options.sessionName } : {}),
      ...(options.input ? { input: options.input } : {}),
    },
    options.primaryArtifact ?? null,
  );

  return {
    task: {
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      status: task.status,
      priority: task.priority,
      progress: task.progress,
      parentTaskId: task.parentTaskId ?? "-",
      taskDir: task.taskDir ?? "-",
      taskDocPath: options.taskDocPath ?? "-",
      profileId: task.profileId ?? profile.id,
      profileVersion: task.profileVersion ?? profile.version,
      profileSource: task.profileSource ?? profile.source,
      summary: task.summary ?? "",
      blockerReason: task.blockerReason ?? "",
    },
    profile: {
      id: profile.id,
      version: profile.version,
      label: profile.label,
      description: profile.description,
      sync: profile.sync,
      source: profile.source,
      sourceKind: profile.sourceKind,
      sessionNameTemplate: profile.sessionNameTemplate,
      workspaceBootstrap: profile.workspaceBootstrap,
      rendererHints: profile.rendererHints,
      defaultTags: profile.defaultTags,
      inputs: profile.inputs,
      completion: profile.completion,
      progress: profile.progress,
    },
    session: {
      agentId: options.agentId ?? "-",
      name: options.sessionName ?? "-",
      cwd: options.effectiveCwd,
    },
    worktree: {
      mode: options.worktree?.mode ?? "inherit",
      path: options.worktree?.path ?? "-",
      branch: options.worktree?.branch ?? "",
      label: formatTaskWorktree(options.worktree),
    },
    artifacts: protocolArtifacts,
    profileState,
    input: resolveProfileInputValues(profile, task.profileInput, options.input),
  };
}

export function resolveTaskProfilePrimaryArtifact(
  task: TaskRecord,
  options: {
    effectiveCwd: string;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    worktree?: TaskWorktreeConfig;
    agentId?: string;
    sessionName?: string;
    input?: Record<string, string>;
  },
): TaskProfileArtifactRef | null {
  const profile = options.taskProfile ?? resolveTaskProfileForTask(task);
  return resolveProtocolPrimaryArtifact(task, {
    task,
    profile,
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    ...(options.input ? { input: options.input } : {}),
  });
}

function renderProfileTemplate(
  profile: ResolvedTaskProfile,
  templateName: keyof TaskProfileDefinition["templates"],
  context: Record<string, unknown>,
): string {
  return renderStrictTemplate(profile.templates[templateName], context, {
    profileId: profile.id,
    templateName,
  });
}

export function buildTaskDispatchPromptForProfile(
  task: TaskRecord,
  agentId: string,
  sessionName: string,
  options: {
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    primaryArtifact?: TaskProfileArtifactRef | null;
    input?: Record<string, string>;
  },
): string {
  const profile = options.taskProfile ?? resolveTaskProfileForTask(task);
  const context = buildTemplateContext(task, {
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    taskProfile: profile,
    ...(options.primaryArtifact !== undefined ? { primaryArtifact: options.primaryArtifact } : {}),
    agentId,
    sessionName,
    ...(options.input ? { input: options.input } : {}),
  });
  return renderProfileTemplate(profile, "dispatch", context);
}

export function buildTaskResumePromptForProfile(
  task: TaskRecord,
  options: {
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    primaryArtifact?: TaskProfileArtifactRef | null;
    agentId?: string;
    sessionName?: string;
    input?: Record<string, string>;
  },
): string {
  const profile = options.taskProfile ?? resolveTaskProfileForTask(task);
  const context = buildTemplateContext(task, {
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    taskProfile: profile,
    ...(options.primaryArtifact !== undefined ? { primaryArtifact: options.primaryArtifact } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    ...(options.input ? { input: options.input } : {}),
  });
  return renderProfileTemplate(profile, "resume", context);
}

export function buildTaskDispatchEventMessageForProfile(
  task: TaskRecord,
  input: DispatchTaskInput,
  options: {
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    primaryArtifact?: TaskProfileArtifactRef | null;
    input?: Record<string, string>;
  },
): string {
  const profile = options.taskProfile ?? resolveTaskProfileForTask(task);
  const context = buildTemplateContext(task, {
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    taskProfile: profile,
    ...(options.primaryArtifact !== undefined ? { primaryArtifact: options.primaryArtifact } : {}),
    agentId: input.agentId,
    sessionName: input.sessionName,
    ...(options.input ? { input: options.input } : {}),
  });
  return renderProfileTemplate(profile, "dispatchEventMessage", context);
}

export function buildTaskDispatchSummaryForProfile(
  task: TaskRecord,
  options: {
    effectiveCwd: string;
    worktree?: TaskWorktreeConfig;
    taskDocPath?: string | null;
    taskProfile?: ResolvedTaskProfile;
    primaryArtifact?: TaskProfileArtifactRef | null;
    agentId?: string;
    sessionName?: string;
    input?: Record<string, string>;
  },
): string {
  const profile = options.taskProfile ?? resolveTaskProfileForTask(task);
  const context = buildTemplateContext(task, {
    effectiveCwd: options.effectiveCwd,
    ...(options.worktree ? { worktree: options.worktree } : {}),
    ...(options.taskDocPath !== undefined ? { taskDocPath: options.taskDocPath } : {}),
    taskProfile: profile,
    ...(options.primaryArtifact !== undefined ? { primaryArtifact: options.primaryArtifact } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionName ? { sessionName: options.sessionName } : {}),
    ...(options.input ? { input: options.input } : {}),
  });
  return renderProfileTemplate(profile, "dispatchSummary", context);
}

function resolvePreviewWorktreeContext(
  task: Pick<TaskRecord, "taskDir">,
  profile: ResolvedTaskProfile,
  effectiveCwd: string,
  worktree?: TaskWorktreeConfig,
): TaskWorktreeConfig | undefined {
  if (worktree) {
    if (worktree.mode === "inherit") {
      return worktree;
    }

    const expandedPath = expandProfileHomePath(worktree.path ?? "");
    return {
      ...worktree,
      path: expandedPath ? (expandedPath.startsWith("/") ? expandedPath : resolvePath(effectiveCwd, expandedPath)) : "",
    };
  }

  if (profile.workspaceBootstrap.mode === "task_dir" && task.taskDir) {
    return {
      mode: "path",
      path: task.taskDir,
      ...(profile.workspaceBootstrap.branch ? { branch: profile.workspaceBootstrap.branch } : {}),
    };
  }

  if (profile.workspaceBootstrap.mode === "path" && profile.workspaceBootstrap.path) {
    const expandedPath = expandProfileHomePath(profile.workspaceBootstrap.path);
    return {
      mode: "path",
      path: expandedPath.startsWith("/") ? expandedPath : resolvePath(effectiveCwd, expandedPath),
      ...(profile.workspaceBootstrap.branch ? { branch: profile.workspaceBootstrap.branch } : {}),
    };
  }

  return undefined;
}

export function previewTaskProfile(
  profileId: string,
  options: {
    title: string;
    instructions?: string;
    priority?: TaskRecord["priority"];
    status?: TaskRecord["status"];
    progress?: number;
    effectiveCwd?: string;
    agentId?: string;
    sessionName?: string;
    worktree?: TaskWorktreeConfig;
    input?: Record<string, string>;
  },
): TaskProfilePreviewResult {
  const profile = toResolvedTaskProfile(
    requireTaskProfileDefinition(profileId),
    normalizeProfileId(profileId) ?? profileId,
  );
  const taskId = `task-preview-${profile.id}`;
  const effectiveCwd = resolvePath(options.effectiveCwd ?? process.cwd());
  const taskDir = profile.workspaceBootstrap.ensureTaskDir
    ? resolvePath(effectiveCwd, ".ravi", "task-profile-preview", taskId)
    : undefined;
  const taskDocPath = taskProfileUsesTaskDocument(profile) && taskDir ? joinPath(taskDir, "TASK.md") : null;
  const task: TaskRecord = {
    id: taskId,
    title: options.title,
    instructions: options.instructions ?? "Preview generated by ravi tasks profiles preview.",
    status: options.status ?? "open",
    priority: options.priority ?? "normal",
    progress: options.progress ?? 0,
    profileId: profile.id,
    profileVersion: profile.version,
    profileSource: profile.source,
    profileSnapshot: buildTaskProfileSnapshot(profile),
    profileInput: resolveProfileInputValues(profile, options.input),
    ...(taskDir ? { taskDir } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
  const taskWithState = {
    ...task,
    ...(resolveTaskProfileState(task, profile) ? { profileState: resolveTaskProfileState(task, profile) } : {}),
  };
  const resolvedWorktree = resolvePreviewWorktreeContext(taskWithState, profile, effectiveCwd, options.worktree);
  const primaryArtifact = resolveTaskProfilePrimaryArtifact(taskWithState, {
    effectiveCwd,
    ...(resolvedWorktree ? { worktree: resolvedWorktree } : {}),
    ...(taskDocPath !== undefined ? { taskDocPath } : {}),
    taskProfile: profile,
    agentId: options.agentId ?? "dev",
    sessionName: options.sessionName ?? renderTaskSessionTemplate(profile.sessionNameTemplate, taskId),
    ...(options.input ? { input: options.input } : {}),
  });

  return {
    profile,
    task: taskWithState,
    primaryArtifact,
    input: resolveProfileInputValues(profile, taskWithState.profileInput),
    rendered: {
      dispatch: buildTaskDispatchPromptForProfile(
        taskWithState,
        options.agentId ?? "dev",
        options.sessionName ?? renderTaskSessionTemplate(profile.sessionNameTemplate, taskId),
        {
          effectiveCwd,
          ...(resolvedWorktree ? { worktree: resolvedWorktree } : {}),
          ...(taskDocPath !== undefined ? { taskDocPath } : {}),
          taskProfile: profile,
          ...(primaryArtifact !== undefined ? { primaryArtifact } : {}),
          ...(options.input ? { input: options.input } : {}),
        },
      ),
      resume: buildTaskResumePromptForProfile(taskWithState, {
        effectiveCwd,
        ...(resolvedWorktree ? { worktree: resolvedWorktree } : {}),
        ...(taskDocPath !== undefined ? { taskDocPath } : {}),
        taskProfile: profile,
        ...(primaryArtifact !== undefined ? { primaryArtifact } : {}),
        agentId: options.agentId ?? "dev",
        sessionName: options.sessionName ?? renderTaskSessionTemplate(profile.sessionNameTemplate, taskId),
        ...(options.input ? { input: options.input } : {}),
      }),
      dispatchSummary: buildTaskDispatchSummaryForProfile(taskWithState, {
        effectiveCwd,
        ...(resolvedWorktree ? { worktree: resolvedWorktree } : {}),
        ...(taskDocPath !== undefined ? { taskDocPath } : {}),
        taskProfile: profile,
        ...(primaryArtifact !== undefined ? { primaryArtifact } : {}),
        agentId: options.agentId ?? "dev",
        sessionName: options.sessionName ?? renderTaskSessionTemplate(profile.sessionNameTemplate, taskId),
        ...(options.input ? { input: options.input } : {}),
      }),
      dispatchEventMessage: buildTaskDispatchEventMessageForProfile(
        taskWithState,
        {
          agentId: options.agentId ?? "dev",
          sessionName: options.sessionName ?? renderTaskSessionTemplate(profile.sessionNameTemplate, taskId),
        },
        {
          effectiveCwd,
          ...(resolvedWorktree ? { worktree: resolvedWorktree } : {}),
          ...(taskDocPath !== undefined ? { taskDocPath } : {}),
          taskProfile: profile,
          ...(primaryArtifact !== undefined ? { primaryArtifact } : {}),
          ...(options.input ? { input: options.input } : {}),
        },
      ),
    },
  };
}

export function validateTaskProfiles(profileId?: string): TaskProfileValidationResult[] {
  const profiles = profileId
    ? [toResolvedTaskProfile(requireTaskProfileDefinition(profileId), normalizeProfileId(profileId) ?? profileId)]
    : listTaskProfiles();

  return profiles.map((profile) => {
    try {
      const sampleInput = Object.fromEntries(
        profile.inputs.map((definition) => [definition.key, definition.defaultValue ?? `sample-${definition.key}`]),
      );
      previewTaskProfile(profile.id, {
        title: `Validate ${profile.id}`,
        instructions: "Validation preview for task profile templates.",
        agentId: "dev",
        sessionName: renderTaskSessionTemplate(profile.sessionNameTemplate, `task-validate-${profile.id}`),
        input: sampleInput,
      });
      return {
        id: profile.id,
        version: profile.version,
        sourceKind: profile.sourceKind,
        source: profile.source,
        valid: true,
      };
    } catch (error) {
      return {
        id: profile.id,
        version: profile.version,
        sourceKind: profile.sourceKind,
        source: profile.source,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function validateInitProfileId(profileId: string): string {
  const normalized = profileId.trim();
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(normalized)) {
    throw new Error("Profile id must match /^[a-z0-9][a-z0-9-_]*$/i.");
  }
  return normalized;
}

function getWorkspaceProfileRootForWrite(cwd = process.cwd()): string {
  const roots = listWorkspaceProfileRoots(cwd);
  if (roots.length > 0) {
    return roots[roots.length - 1]!;
  }
  return joinPath(resolvePath(cwd), ...WORKSPACE_PROFILE_SEGMENTS);
}

function buildScaffoldArtifacts(preset: TaskProfileScaffoldPreset): TaskProfileArtifactDefinition[] {
  switch (preset) {
    case "doc-first":
      return [
        {
          kind: "task-doc",
          label: "TASK.md",
          pathTemplate: "{{task.taskDocPath}}",
          primary: true,
        },
      ];
    case "brainstorm":
      return [
        {
          kind: "brainstorm-draft",
          label: "Brainstorm draft",
          pathTemplate: "{{session.cwd}}/.genie/brainstorms/{{profileState.brainstorm.slug}}/DRAFT.md",
          primary: true,
        },
        {
          kind: "brainstorm-design",
          label: "Brainstorm design",
          pathTemplate: "{{session.cwd}}/.genie/brainstorms/{{profileState.brainstorm.slug}}/DESIGN.md",
          primaryWhenStatuses: ["done"],
        },
        {
          kind: "brainstorm-jar",
          label: "Brainstorm jar",
          pathTemplate: "{{session.cwd}}/.genie/brainstorm.md",
        },
      ];
    case "runtime-only":
      return [];
    case "content":
      return [
        {
          kind: "content-draft",
          label: "Content draft",
          pathTemplate: "{{task.taskDir}}/draft.md",
          primary: true,
        },
        {
          kind: "content-notes",
          label: "Content notes",
          pathTemplate: "{{task.taskDir}}/notes.md",
        },
        {
          kind: "content-sources",
          label: "Sources",
          pathTemplate: "{{task.taskDir}}/sources",
        },
        {
          kind: "content-assets",
          label: "Assets",
          pathTemplate: "{{task.taskDir}}/assets",
        },
        {
          kind: "content-exports",
          label: "Exports",
          pathTemplate: "{{task.taskDir}}/exports",
        },
      ];
    default: {
      const exhaustive: never = preset;
      throw new Error(`Unsupported task profile scaffold preset for artifacts: ${exhaustive}`);
    }
  }
}

function buildScaffoldState(preset: TaskProfileScaffoldPreset): TaskProfileStateFieldDefinition[] {
  switch (preset) {
    case "brainstorm":
      return [
        {
          path: "brainstorm.slug",
          valueTemplate: "{{task.title}}",
          transform: "slug",
        },
      ];
    case "doc-first":
    case "runtime-only":
    case "content":
      return [];
    default: {
      const exhaustive: never = preset;
      throw new Error(`Unsupported task profile scaffold preset for state: ${exhaustive}`);
    }
  }
}

function buildScaffoldTemplateBundle(preset: TaskProfileScaffoldPreset): TaskProfileDefinition["templates"] {
  switch (preset) {
    case "doc-first":
      return {
        dispatch:
          "[System] Execute: Você assumiu a task {{task.id}} no Ravi.\n\nTítulo: {{task.title}}\nProfile: {{profile.id}}/{{profile.version}}\nTASK.md: {{task.taskDocPath}}\nObjetivo:\n{{task.instructions}}",
        resume:
          '[System] Daemon reiniciou. Continue a task {{task.id}} ("{{task.title}}") de onde parou.\nProgresso: {{task.progress}}% | TASK.md: {{task.taskDocPath}}',
        dispatchSummary: "The target session was instructed to edit TASK.md first, then sync through:",
        dispatchEventMessage:
          "Dispatched to {{session.agentId}}/{{session.name}}. Edit {{task.taskDocPath}} first, then sync via ravi tasks report|done|block|fail {{task.id}}.",
      };
    case "brainstorm":
      return {
        dispatch:
          "[System] Execute: Você assumiu a task {{task.id}} no Ravi.\n\nTítulo: {{task.title}}\nProfile: {{profile.id}}/{{profile.version}}\nSlug: {{profileState.brainstorm.slug}}\nDraft: {{artifacts.primary.path}}\nObjetivo:\n{{task.instructions}}",
        resume:
          '[System] Daemon reiniciou. Continue a task {{task.id}} ("{{task.title}}") de onde parou.\nProgresso: {{task.progress}}% | slug: {{profileState.brainstorm.slug}} | draft: {{artifacts.primary.path}}',
        dispatchSummary:
          "The target session was instructed to load brainstorm, use the draft artifact as primary state, then sync through:",
        dispatchEventMessage:
          "Dispatched to {{session.agentId}}/{{session.name}}. Use {{artifacts.primary.path}} as primary artifact and sync via ravi tasks report|done|block|fail {{task.id}}.",
      };
    case "runtime-only":
      return {
        dispatch:
          "[System] Execute: Você assumiu a task {{task.id}} no Ravi.\n\nTítulo: {{task.title}}\nProfile: {{profile.id}}/{{profile.version}}\nObjetivo:\n{{task.instructions}}",
        resume:
          '[System] Daemon reiniciou. Continue a task {{task.id}} ("{{task.title}}") de onde parou.\nProgresso: {{task.progress}}% | profile: {{profile.id}}',
        dispatchSummary: "The target session received the task without a task-document protocol. Sync through:",
        dispatchEventMessage:
          "Dispatched to {{session.agentId}}/{{session.name}}. Operate directly in the runtime substrate and sync via ravi tasks report|done|block|fail {{task.id}}.",
      };
    case "content":
      return {
        dispatch:
          "[System] Execute: Você assumiu a task {{task.id}} no Ravi.\n\nTítulo: {{task.title}}\nProfile: {{profile.id}}/{{profile.version}}\nTask dir: {{task.taskDir}}\nArtifact: {{artifacts.primary.path}}\nObjetivo:\n{{task.instructions}}\n\nInstruções de execução:\n- trate {{task.taskDir}} como o workspace canônico do item\n- este profile nasce sem TASK.md e sem manifesto obrigatório\n- comece por {{artifacts.primary.path}} e só materialize `notes.md`, `sources/`, `assets/` e `exports/` se precisar\n- mantenha lifecycle/comentários/assignments no substrate via ravi tasks comment|report|done|block|fail {{task.id}}",
        resume:
          '[System] Daemon reiniciou. Continue a task {{task.id}} ("{{task.title}}") de onde parou.\nProgresso: {{task.progress}}% | profile: {{profile.id}} | task dir: {{task.taskDir}} | artifact: {{artifacts.primary.path}}',
        dispatchSummary:
          "The target session received a content workspace rooted at task_dir. Work from the primary artifact and sync through:",
        dispatchEventMessage:
          "Dispatched to {{session.agentId}}/{{session.name}}. Content workspace rooted at {{task.taskDir}} with primary artifact {{artifacts.primary.path}}; keep lifecycle in the task substrate and sync via ravi tasks comment|report|done|block|fail {{task.id}}.",
      };
  }
}

export function initTaskProfileScaffold(
  profileId: string,
  preset: TaskProfileScaffoldPreset,
  options: {
    sourceKind?: "workspace" | "user";
    cwd?: string;
  } = {},
): InitTaskProfileScaffoldResult {
  const normalizedId = validateInitProfileId(profileId);
  const sourceKind = options.sourceKind ?? "workspace";
  const root =
    sourceKind === "workspace"
      ? getWorkspaceProfileRootForWrite(options.cwd)
      : joinPath(getRaviStateDir(), "task-profiles");
  const profileDir = joinPath(root, normalizedId);
  const manifestPath = joinPath(profileDir, PROFILE_MANIFEST_FILENAME);
  if (existsSync(manifestPath)) {
    throw new Error(`Task profile scaffold already exists: ${manifestPath}`);
  }

  mkdirSync(profileDir, { recursive: true });
  const templates = buildScaffoldTemplateBundle(preset);
  writeFileSync(joinPath(profileDir, "dispatch.md"), `${templates.dispatch}\n`, "utf8");
  writeFileSync(joinPath(profileDir, "resume.md"), `${templates.resume}\n`, "utf8");
  writeFileSync(joinPath(profileDir, "dispatch-summary.txt"), `${templates.dispatchSummary}\n`, "utf8");
  writeFileSync(joinPath(profileDir, "dispatch-event.txt"), `${templates.dispatchEventMessage}\n`, "utf8");

  const manifest = {
    id: normalizedId,
    version: "1",
    label: normalizedId,
    description: `Custom task profile ${normalizedId}.`,
    sessionNameTemplate: "<task-id>-work",
    workspaceBootstrap: {
      mode: preset === "content" ? "task_dir" : "inherit",
      ensureTaskDir: preset === "doc-first" || preset === "content",
    },
    sync: {
      artifactFirst: preset === "doc-first",
      ...(preset === "doc-first" ? { taskDocument: { mode: "required" as const } } : {}),
    },
    rendererHints: {
      label:
        preset === "brainstorm"
          ? "Brainstorm draft"
          : preset === "runtime-only"
            ? "Runtime only"
            : preset === "content"
              ? "Content workspace"
              : "Custom",
      showTaskDoc: preset === "doc-first",
      showWorkspace: true,
    },
    defaultTags: [`task.profile.${normalizedId}`],
    inputs: [],
    completion: {
      summaryRequired: true,
      summaryLabel: "Resumo",
    },
    progress: {
      requireMessage: true,
    },
    artifacts: buildScaffoldArtifacts(preset),
    state: buildScaffoldState(preset),
    templates: {
      dispatch: { path: "./dispatch.md" },
      resume: { path: "./resume.md" },
      dispatchSummary: { path: "./dispatch-summary.txt" },
      dispatchEventMessage: { path: "./dispatch-event.txt" },
    },
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    sourceKind,
    profileDir,
    manifestPath,
  };
}
