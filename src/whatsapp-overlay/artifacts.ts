import { promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve as resolvePath } from "node:path";
import {
  getArtifact as defaultGetArtifact,
  listArtifactsPage as defaultListArtifactsPage,
  type ArtifactListPage,
  type ArtifactRecord,
} from "../artifacts/store.js";
import type { ListArtifactsOptions } from "../artifacts/store.js";
import { buildArtifactNotificationUiSpec, type ArtifactNotificationUiSpec } from "../artifacts/ui.js";
import { dbGetAgent } from "../router/router-db.js";
import { listSessions, resolveSession as resolveSessionEntry } from "../router/sessions.js";
import type { SessionEntry } from "../router/types.js";
import { buildTaskStreamSnapshot, type TaskStatus, type TaskStreamTaskEntity } from "../tasks/index.js";
import {
  buildCommand,
  buildOffsetPagination,
  normalizePageLimit,
  normalizePageOffset,
  type OffsetPagination,
} from "../utils/pagination.js";
import type { OverlayActivity, OverlayLiveState } from "./model.js";

const DEFAULT_ARTIFACTS_LIMIT = 80;
const MAX_ARTIFACTS_LIMIT = 200;
const STORE_OVERFETCH_FACTOR = 5;
const STORE_MAX_LIMIT = 500;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const OVERLAY_ARTIFACT_LIFECYCLES = ["pending", "running", "completed", "failed", "archived"] as const;
export type OverlayArtifactLifecycle = (typeof OVERLAY_ARTIFACT_LIFECYCLES)[number];

export interface OverlayArtifactSessionRef {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  displayName: string | null;
  chatId: string | null;
  activity: OverlayActivity;
  updatedAt: number;
}

export interface OverlayArtifactTaskRef {
  id: string;
  title: string | null;
  status: TaskStatus | null;
  profileId: string | null;
  updatedAt: number | null;
}

export interface OverlayArtifactAgentRef {
  agentId: string;
  name: string | null;
  session: OverlayArtifactSessionRef | null;
}

export type OverlayArtifactLinkAction = "focus-task" | "open-session" | "open-agent-session" | "open-url" | "copy";

export type OverlayArtifactLinkTargetType = "task" | "session" | "agent" | "path" | "blob" | "uri";

export interface OverlayArtifactLinkRef {
  targetType: OverlayArtifactLinkTargetType;
  targetId: string;
  label: string;
  value: string;
  action: OverlayArtifactLinkAction;
  href: string | null;
  copyText: string | null;
  task: OverlayArtifactTaskRef | null;
  session: OverlayArtifactSessionRef | null;
  agent: OverlayArtifactAgentRef | null;
}

export interface OverlayArtifactComponentRendererRef {
  surface: string;
  renderer: string | null;
  package: string | null;
  artifactId: string | null;
  source: {
    js: string | null;
    css: string | null;
  } | null;
}

export interface OverlayArtifactComponentFixture {
  id: string;
  label: string;
  props: unknown | null;
}

export interface OverlayArtifactComponentPreview {
  id: string | null;
  version: string | null;
  description: string | null;
  propsSchema: unknown | null;
  slots: string[];
  actions: string[];
  events: string[];
  surfaces: string[];
  renderers: OverlayArtifactComponentRendererRef[];
  fixtures: OverlayArtifactComponentFixture[];
}

export interface OverlayArtifactItem {
  id: string;
  kind: string;
  label: string;
  status: string;
  lifecycle: OverlayArtifactLifecycle;
  summary: string | null;
  path: string | null;
  blobPath: string | null;
  uri: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  provider: string | null;
  model: string | null;
  taskId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  sessionKey: string | null;
  agentId: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  task: OverlayArtifactTaskRef | null;
  session: OverlayArtifactSessionRef | null;
  agent: OverlayArtifactAgentRef | null;
  links: OverlayArtifactLinkRef[];
  ui: ArtifactNotificationUiSpec;
  componentPreview: OverlayArtifactComponentPreview | null;
}

export interface OverlayArtifactsQuery {
  limit: number;
  offset: number;
  orderBy: "createdAt" | "updatedAt";
  lifecycle: OverlayArtifactLifecycle | null;
  kind: string | null;
  tag: string | null;
  taskId: string | null;
  sessionId: string | null;
  agentId: string | null;
}

export interface OverlayArtifactsStats {
  total: number;
  byKind: Record<string, number>;
  byLifecycle: Record<OverlayArtifactLifecycle, number>;
  recentCount: number;
}

export type OverlayArtifactsPagination = OffsetPagination;

export interface OverlayArtifactsSnapshot {
  ok: true;
  generatedAt: number;
  query: OverlayArtifactsQuery;
  pagination: OverlayArtifactsPagination;
  stats: OverlayArtifactsStats;
  items: OverlayArtifactItem[];
}

export interface BuildOverlayArtifactsPayloadArgs {
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "updatedAt" | null;
  lifecycle?: OverlayArtifactLifecycle | null;
  kind?: string | null;
  tag?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  liveBySessionName?: Map<string, OverlayLiveState>;
  sessions?: SessionEntry[];
  listArtifacts?: (options: ListArtifactsOptions) => ArtifactRecord[];
  listArtifactsPage?: (options: ListArtifactsOptions) => ArtifactListPage;
  resolveTask?: (taskId: string) => TaskStreamTaskEntity | null;
  resolveSession?: (nameOrKey: string) => SessionEntry | null;
  resolveAgentName?: (agentId: string) => string | null;
  now?: () => number;
}

export function buildOverlayArtifactsPayload(args: BuildOverlayArtifactsPayloadArgs = {}): OverlayArtifactsSnapshot {
  const limit = normalizeArtifactsLimit(args.limit);
  const offset = normalizeArtifactsOffset(args.offset);
  const orderBy = normalizeArtifactsOrderBy(args.orderBy);
  const lifecycle = normalizeLifecycle(args.lifecycle ?? null);
  const kind = cleanFilterToken(args.kind);
  const tag = cleanFilterToken(args.tag);
  const taskId = cleanFilterToken(args.taskId);
  const sessionId = cleanFilterToken(args.sessionId);
  const agentId = cleanFilterToken(args.agentId);
  const sessions = sortSessionsByUpdatedAt(args.sessions ?? listSessions());
  const listArtifactsPageImpl = args.listArtifactsPage ?? (args.listArtifacts ? null : defaultListArtifactsPage);
  const resolveTask = args.resolveTask ?? defaultResolveTask;
  const resolveSession = args.resolveSession ?? resolveSessionEntry;
  const resolveAgentName = args.resolveAgentName ?? defaultResolveAgentName;
  const now = (args.now ?? Date.now)();

  const storeOptions: ListArtifactsOptions = {
    includeDeleted: lifecycle === "archived" || lifecycle === null,
    orderBy,
    ...(kind ? { kind } : {}),
    ...(tag ? { tag } : {}),
    ...(sessionId ? { session: sessionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  };

  const page = listArtifactsPageImpl
    ? listArtifactsPageImpl({
        ...storeOptions,
        limit,
        offset,
      })
    : null;
  const records =
    page?.items ??
    args.listArtifacts?.({
      ...storeOptions,
      limit: Math.min(STORE_MAX_LIMIT, (offset + limit) * STORE_OVERFETCH_FACTOR),
      offset: 0,
    }) ??
    [];

  const taskCache = new Map<string, OverlayArtifactTaskRef | null>();
  const sessionCache = new Map<string, OverlayArtifactSessionRef | null>();
  const agentCache = new Map<string, OverlayArtifactAgentRef | null>();

  const filtered: OverlayArtifactItem[] = [];

  for (const record of records) {
    const itemLifecycle = deriveLifecycle(record);
    if (lifecycle && itemLifecycle !== lifecycle) continue;
    if (agentId && record.agentId !== agentId) continue;
    if (!page && tag && !artifactRecordMatchesTag(record, tag)) continue;

    const item = toOverlayArtifactItem(record, itemLifecycle, {
      sessions,
      liveBySessionName: args.liveBySessionName,
      resolveTaskRef(id) {
        if (taskCache.has(id)) return taskCache.get(id) ?? null;
        const task = toArtifactTaskRef(resolveTask(id));
        taskCache.set(id, task);
        return task;
      },
      resolveSessionRef(nameOrKey) {
        if (sessionCache.has(nameOrKey)) return sessionCache.get(nameOrKey) ?? null;
        const session = resolveSession(nameOrKey);
        const ref = session ? toArtifactSessionRef(session, args.liveBySessionName) : null;
        sessionCache.set(nameOrKey, ref);
        return ref;
      },
      resolveAgentRef(id) {
        if (agentCache.has(id)) return agentCache.get(id) ?? null;
        const ref = toArtifactAgentRef(id, resolveAgentName(id), sessions, args.liveBySessionName);
        agentCache.set(id, ref);
        return ref;
      },
    });
    filtered.push(item);
  }

  const pageItems = page ? filtered : filtered.slice(offset, offset + limit);
  const total = page ? page.total : filtered.length;
  const stats = buildArtifactsStats(pageItems, now, total);
  const pagination = buildArtifactsPagination({
    limit,
    offset,
    returned: pageItems.length,
    total,
    lifecycle,
    kind,
    tag,
    taskId,
    sessionId,
    agentId,
    orderBy,
  });

  return {
    ok: true,
    generatedAt: now,
    query: {
      limit,
      offset,
      orderBy,
      lifecycle,
      kind,
      tag,
      taskId,
      sessionId,
      agentId,
    },
    pagination,
    stats,
    items: pageItems,
  };
}

export function normalizeArtifactsLimit(limit: number | string | null | undefined): number {
  return normalizePageLimit(limit, { defaultLimit: DEFAULT_ARTIFACTS_LIMIT, maxLimit: MAX_ARTIFACTS_LIMIT });
}

export function normalizeArtifactsOffset(offset: number | string | null | undefined): number {
  return normalizePageOffset(offset);
}

export function normalizeArtifactsOrderBy(orderBy: string | null | undefined): "createdAt" | "updatedAt" {
  if (orderBy === "updatedAt" || orderBy === "updated_at" || orderBy === "updated") return "updatedAt";
  return "createdAt";
}

export function normalizeLifecycle(value: string | null | undefined): OverlayArtifactLifecycle | null {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  return (OVERLAY_ARTIFACT_LIFECYCLES as readonly string[]).includes(normalized)
    ? (normalized as OverlayArtifactLifecycle)
    : null;
}

export function deriveLifecycle(record: Pick<ArtifactRecord, "status" | "deletedAt">): OverlayArtifactLifecycle {
  if (record.deletedAt) return "archived";
  const status = (record.status ?? "").trim().toLowerCase();
  if (!status) return "running";
  if (status === "archived" || status === "deleted") return "archived";
  if (status === "completed" || status === "done" || status === "succeeded" || status === "success") {
    return "completed";
  }
  if (status === "failed" || status === "error" || status === "errored") return "failed";
  if (status === "pending" || status === "queued" || status === "waiting") return "pending";
  return "running";
}

function cleanFilterToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function artifactRecordMatchesTag(record: ArtifactRecord, tag: string): boolean {
  const normalizedTag = normalizeArtifactTagForCompare(tag);
  if (!normalizedTag) return true;
  return (record.tags ?? []).some((item) => normalizeArtifactTagForCompare(item) === normalizedTag);
}

function normalizeArtifactTagForCompare(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function sortSessionsByUpdatedAt(sessions: SessionEntry[]): SessionEntry[] {
  return [...sessions].sort((left, right) => {
    return (
      (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0) ||
      String(right.name ?? right.sessionKey).localeCompare(String(left.name ?? left.sessionKey))
    );
  });
}

function defaultResolveTask(taskId: string): TaskStreamTaskEntity | null {
  try {
    return (
      buildTaskStreamSnapshot({
        taskId,
        eventsLimit: 1,
      }).selectedTask?.task ?? null
    );
  } catch {
    return null;
  }
}

function defaultResolveAgentName(agentId: string): string | null {
  return dbGetAgent(agentId)?.name ?? null;
}

function toArtifactTaskRef(task: TaskStreamTaskEntity | null): OverlayArtifactTaskRef | null {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title || null,
    status: task.status ?? null,
    profileId: task.profileId ?? null,
    updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : null,
  };
}

function toArtifactSessionRef(
  session: SessionEntry,
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlayArtifactSessionRef {
  const sessionName = session.name ?? session.sessionKey;
  const live = liveBySessionName?.get(sessionName);
  return {
    sessionKey: session.sessionKey,
    sessionName,
    agentId: session.agentId,
    displayName: session.displayName ?? null,
    chatId: session.lastTo ?? null,
    activity: live?.activity ?? (session.abortedLastRun === true ? "blocked" : "idle"),
    updatedAt: Number(session.updatedAt) || 0,
  };
}

function toArtifactAgentRef(
  agentId: string,
  name: string | null,
  sessions: SessionEntry[],
  liveBySessionName?: Map<string, OverlayLiveState>,
): OverlayArtifactAgentRef | null {
  if (!agentId) return null;
  const session = sessions.find((item) => item.agentId === agentId) ?? null;
  return {
    agentId,
    name,
    session: session ? toArtifactSessionRef(session, liveBySessionName) : null,
  };
}

interface ArtifactBuildHelpers {
  sessions: SessionEntry[];
  liveBySessionName?: Map<string, OverlayLiveState>;
  resolveTaskRef: (taskId: string) => OverlayArtifactTaskRef | null;
  resolveSessionRef: (nameOrKey: string) => OverlayArtifactSessionRef | null;
  resolveAgentRef: (agentId: string) => OverlayArtifactAgentRef | null;
}

function toOverlayArtifactItem(
  record: ArtifactRecord,
  lifecycle: OverlayArtifactLifecycle,
  helpers: ArtifactBuildHelpers,
): OverlayArtifactItem {
  const taskRef = record.taskId ? helpers.resolveTaskRef(record.taskId) : null;
  const sessionRef = record.sessionKey
    ? helpers.resolveSessionRef(record.sessionKey)
    : record.sessionName
      ? helpers.resolveSessionRef(record.sessionName)
      : null;
  const agentRef = record.agentId ? helpers.resolveAgentRef(record.agentId) : null;
  const path = record.filePath ?? record.blobPath ?? record.uri ?? null;
  const label = record.title?.trim() || record.kind || record.id;

  return {
    id: record.id,
    kind: record.kind,
    label,
    status: record.status,
    lifecycle,
    summary: record.summary ?? null,
    path,
    blobPath: record.blobPath ?? null,
    uri: record.uri ?? null,
    mimeType: record.mimeType ?? null,
    sizeBytes: record.sizeBytes ?? null,
    provider: record.provider ?? null,
    model: record.model ?? null,
    taskId: record.taskId ?? null,
    sessionId: record.sessionKey ?? record.sessionName ?? null,
    sessionName: record.sessionName ?? null,
    sessionKey: record.sessionKey ?? null,
    agentId: record.agentId ?? null,
    tags: Array.isArray(record.tags) ? record.tags : [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    task: taskRef,
    session: sessionRef,
    agent: agentRef,
    links: buildArtifactLinks(record, { taskRef, sessionRef, agentRef }),
    ui: buildArtifactNotificationUiSpec({ artifact: record, lifecycle }),
    componentPreview: buildOverlayArtifactComponentPreview(record),
  };
}

function buildOverlayArtifactComponentPreview(record: ArtifactRecord): OverlayArtifactComponentPreview | null {
  if (record.kind !== "ui.component") return null;
  const manifest = selectComponentManifest(record);
  const nestedSchemas = asPlainRecord(manifest.schemas);

  return {
    id:
      cleanComponentText(manifest.id) ||
      cleanComponentText(manifest.componentId) ||
      cleanComponentText(manifest.name) ||
      cleanComponentText(record.title) ||
      record.id,
    version: cleanComponentText(manifest.version) || null,
    description: cleanComponentText(manifest.description) || cleanComponentText(record.summary) || null,
    propsSchema: normalizeComponentJsonValue(
      manifest.propsSchema ?? manifest.props_schema ?? nestedSchemas?.props ?? null,
    ),
    slots: normalizeComponentStringList(manifest.slots),
    actions: normalizeComponentNameList(manifest.actions),
    events: normalizeComponentNameList(manifest.events),
    surfaces: normalizeComponentStringList(manifest.surfaces),
    renderers: normalizeComponentRenderers(manifest.renderers),
    fixtures: normalizeComponentFixtures(manifest.fixtures),
  };
}

function selectComponentManifest(record: ArtifactRecord): Record<string, unknown> {
  const metadata = asPlainRecord(record.metadata);
  const output = asPlainRecord(record.output);
  const input = asPlainRecord(record.input);
  const candidates = [
    asPlainRecord(output?.component),
    asPlainRecord(output?.manifest),
    output,
    asPlainRecord(metadata?.component),
    asPlainRecord(metadata?.manifest),
    metadata,
    asPlainRecord(input?.component),
    asPlainRecord(input?.manifest),
    input,
  ].filter((value): value is Record<string, unknown> => Boolean(value));

  return candidates.find(isComponentManifestLike) ?? candidates[0] ?? {};
}

function isComponentManifestLike(value: Record<string, unknown>): boolean {
  return (
    cleanComponentText(value.schema)?.includes("ui.component") === true ||
    cleanComponentText(value.kind) === "ui.component" ||
    cleanComponentText(value.id) !== null ||
    cleanComponentText(value.componentId) !== null ||
    value.propsSchema !== undefined ||
    value.props_schema !== undefined
  );
}

function normalizeComponentStringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanComponentText(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 12);
}

function normalizeComponentNameList(value: unknown): string[] {
  if (typeof value === "string") {
    return normalizeComponentStringList(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((nested) => {
        if (typeof nested === "string") return nested.trim();
        const item = asPlainRecord(nested);
        return (
          cleanComponentText(item?.id) ||
          cleanComponentText(item?.name) ||
          cleanComponentText(item?.type) ||
          cleanComponentText(item?.label)
        );
      })
      .filter((item): item is string => Boolean(item))
      .slice(0, 12);
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([key, nested]) => {
      const item = asPlainRecord(nested);
      return cleanComponentText(item?.id) || cleanComponentText(item?.name) || key || cleanComponentText(item?.label);
    })
    .filter((item): item is string => Boolean(item))
    .slice(0, 12);
}

function normalizeComponentRenderers(value: unknown): OverlayArtifactComponentRendererRef[] {
  if (!value || typeof value !== "object") return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);

  return entries
    .map(([surfaceKey, nested]) => {
      const item = asPlainRecord(nested);
      if (!item) return null;
      const surface = cleanComponentText(item.surface) || surfaceKey;
      return {
        surface,
        renderer:
          cleanComponentText(item.renderer) ||
          cleanComponentText(item.id) ||
          cleanComponentText(item.implementation) ||
          null,
        package: cleanComponentText(item.package) || cleanComponentText(item.packageId) || null,
        artifactId: cleanComponentText(item.artifactId) || null,
        source: normalizeComponentRendererSource(item.source ?? item.inline ?? item),
      };
    })
    .filter((item): item is OverlayArtifactComponentRendererRef => Boolean(item?.surface))
    .slice(0, 8);
}

function normalizeComponentRendererSource(value: unknown): OverlayArtifactComponentRendererRef["source"] {
  const item = asPlainRecord(value);
  if (!item) return null;
  const js =
    cleanComponentSource(item.js, 30_000) ||
    cleanComponentSource(item.javascript, 30_000) ||
    cleanComponentSource(item.script, 30_000);
  const css =
    cleanComponentSource(item.css, 20_000) ||
    cleanComponentSource(item.style, 20_000) ||
    cleanComponentSource(item.styles, 20_000);
  if (!js && !css) return null;
  return { js, css };
}

function normalizeComponentFixtures(value: unknown): OverlayArtifactComponentFixture[] {
  if (!value || typeof value !== "object") return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);

  return entries
    .map(([fixtureKey, nested]) => {
      const item = asPlainRecord(nested);
      if (!item) return null;
      const id = cleanComponentText(item.id) || fixtureKey;
      return {
        id,
        label: cleanComponentText(item.label) || cleanComponentText(item.name) || id,
        props: normalizeComponentJsonValue(item.props ?? null),
      };
    })
    .filter((item): item is OverlayArtifactComponentFixture => Boolean(item?.id))
    .slice(0, 6);
}

function normalizeComponentJsonValue(value: unknown, depth = 0): unknown | null {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "string") return value.length > 30_000 ? `${value.slice(0, 30_000)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => normalizeComponentJsonValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      out[key] = normalizeComponentJsonValue(nested, depth + 1);
    }
    return out;
  }
  return null;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanComponentText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanComponentSource(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function buildArtifactLinks(
  record: ArtifactRecord,
  refs: {
    taskRef: OverlayArtifactTaskRef | null;
    sessionRef: OverlayArtifactSessionRef | null;
    agentRef: OverlayArtifactAgentRef | null;
  },
): OverlayArtifactLinkRef[] {
  const links: OverlayArtifactLinkRef[] = [];
  const seen = new Set<string>();

  const push = (link: OverlayArtifactLinkRef) => {
    const key = `${link.targetType}:${link.targetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  if (record.taskId) {
    push({
      targetType: "task",
      targetId: record.taskId,
      label: "task",
      value: refs.taskRef?.id ?? record.taskId,
      action: "focus-task",
      href: null,
      copyText: refs.taskRef?.id ?? record.taskId,
      task: refs.taskRef,
      session: null,
      agent: null,
    });
  }

  const sessionTargetId = record.sessionKey ?? record.sessionName ?? null;
  if (sessionTargetId) {
    push({
      targetType: "session",
      targetId: sessionTargetId,
      label: "session",
      value: refs.sessionRef?.sessionName ?? sessionTargetId,
      action: "open-session",
      href: null,
      copyText: refs.sessionRef?.sessionName ?? sessionTargetId,
      task: null,
      session: refs.sessionRef,
      agent: null,
    });
  }

  if (record.agentId) {
    push({
      targetType: "agent",
      targetId: record.agentId,
      label: "agent",
      value: refs.agentRef?.name || refs.agentRef?.agentId || record.agentId,
      action: "open-agent-session",
      href: null,
      copyText: refs.agentRef?.agentId ?? record.agentId,
      task: null,
      session: refs.agentRef?.session ?? null,
      agent: refs.agentRef,
    });
  }

  if (record.uri) {
    const isHttp = isAbsoluteUrl(record.uri);
    push({
      targetType: "uri",
      targetId: record.uri,
      label: "uri",
      value: summarizePathTarget(record.uri),
      action: isHttp ? "open-url" : "copy",
      href: isHttp ? record.uri : null,
      copyText: record.uri,
      task: null,
      session: null,
      agent: null,
    });
  }

  if (record.filePath) {
    push({
      targetType: "path",
      targetId: record.filePath,
      label: "path",
      value: summarizePathTarget(record.filePath),
      action: "copy",
      href: null,
      copyText: record.filePath,
      task: null,
      session: null,
      agent: null,
    });
  }

  if (record.blobPath && record.blobPath !== record.filePath) {
    push({
      targetType: "blob",
      targetId: record.blobPath,
      label: "blob",
      value: summarizePathTarget(record.blobPath),
      action: "copy",
      href: null,
      copyText: record.blobPath,
      task: null,
      session: null,
      agent: null,
    });
  }

  return links;
}

function buildArtifactsStats(items: OverlayArtifactItem[], now: number, total = items.length): OverlayArtifactsStats {
  const byKind: Record<string, number> = {};
  const byLifecycle: Record<OverlayArtifactLifecycle, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    archived: 0,
  };
  let recentCount = 0;

  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    byLifecycle[item.lifecycle] += 1;
    if (Number.isFinite(item.updatedAt) && now - item.updatedAt <= RECENT_WINDOW_MS) {
      recentCount += 1;
    }
  }

  return {
    total,
    byKind,
    byLifecycle,
    recentCount,
  };
}

function buildArtifactsPagination(args: {
  limit: number;
  offset: number;
  returned: number;
  total: number;
  orderBy: "createdAt" | "updatedAt";
  lifecycle: OverlayArtifactLifecycle | null;
  kind: string | null;
  tag: string | null;
  taskId: string | null;
  sessionId: string | null;
  agentId: string | null;
}): OverlayArtifactsPagination {
  return buildOffsetPagination({
    limit: args.limit,
    offset: args.offset,
    returned: args.returned,
    total: args.total,
    nextCommand: (nextOffset) => buildArtifactsNextCommand({ ...args, offset: nextOffset }),
  });
}

function buildArtifactsNextCommand(args: {
  limit: number;
  offset: number;
  orderBy: "createdAt" | "updatedAt";
  lifecycle: OverlayArtifactLifecycle | null;
  kind: string | null;
  tag: string | null;
  taskId: string | null;
  sessionId: string | null;
  agentId: string | null;
}): string {
  const parts = [
    "ravi",
    "artifacts",
    "list",
    "--rich",
    "--json",
    "--limit",
    String(args.limit),
    "--offset",
    String(args.offset),
  ];
  if (args.kind) parts.push("--kind", args.kind);
  if (args.tag) parts.push("--tag", args.tag);
  if (args.orderBy !== "createdAt") parts.push("--order-by", args.orderBy);
  if (args.sessionId) parts.push("--session", args.sessionId);
  if (args.taskId) parts.push("--task", args.taskId);
  if (args.lifecycle) parts.push("--lifecycle", args.lifecycle);
  if (args.agentId) parts.push("--agent", args.agentId);
  return buildCommand(parts);
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function summarizePathTarget(value: string): string {
  if (isAbsoluteUrl(value)) {
    try {
      const url = new URL(value);
      return url.pathname.split("/").filter(Boolean).at(-1) ?? url.host;
    } catch {
      return value;
    }
  }

  const trimmed = value.trim();
  if (!trimmed) return value;
  const base = basename(trimmed);
  return base || trimmed;
}

export const ARTIFACT_BLOB_MAX_BYTES = 10 * 1024 * 1024;

export const ARTIFACT_BLOB_IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
});

export type ArtifactBlobErrorCode =
  | "missing_id"
  | "not_found"
  | "no_path"
  | "outside_allowlist"
  | "unsupported_media_type"
  | "too_large";

export type ResolveArtifactBlobResult =
  | {
      ok: true;
      artifactId: string;
      path: string;
      mimeType: string;
      sizeBytes: number;
    }
  | {
      ok: false;
      status: number;
      code: ArtifactBlobErrorCode;
      error: string;
    };

export interface ResolveArtifactBlobOptions {
  artifactId: string;
  getArtifact?: (id: string) => ArtifactRecord | null;
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<{ size: number }>;
  allowlistRoots?: readonly string[];
  maxBytes?: number;
}

export function defaultArtifactBlobAllowlistRoots(): string[] {
  const home = homedir();
  const roots = new Set<string>();
  roots.add(resolvePath(home, ".ravi"));
  roots.add(resolvePath(home, "ravi"));
  roots.add(resolvePath(home, "dev/filipelabs"));
  roots.add(process.cwd());
  return [...roots];
}

function collectArtifactCandidatePaths(record: ArtifactRecord): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const push = (value: string | undefined) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || isAbsoluteUrl(trimmed)) return;
    if (!isAbsolute(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    paths.push(trimmed);
  };
  push(record.filePath);
  push(record.blobPath);
  if (typeof record.uri === "string" && record.uri.trim().startsWith("file://")) {
    try {
      push(new URL(record.uri.trim()).pathname);
    } catch {
      /* ignore malformed file:// URIs */
    }
  }
  return paths;
}

function isPathInsideAllowlist(canonicalPath: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (!root) continue;
    if (canonicalPath === root) return true;
    const rootWithSep = root.endsWith("/") ? root : `${root}/`;
    if (canonicalPath.startsWith(rootWithSep)) return true;
  }
  return false;
}

export async function resolveArtifactBlob(options: ResolveArtifactBlobOptions): Promise<ResolveArtifactBlobResult> {
  const id = typeof options.artifactId === "string" ? options.artifactId.trim() : "";
  if (!id) {
    return { ok: false, status: 400, code: "missing_id", error: "Missing artifact id" };
  }

  const getArtifactImpl = options.getArtifact ?? defaultGetArtifact;
  const realpathImpl = options.realpath ?? ((p: string) => fsPromises.realpath(p));
  const statImpl =
    options.stat ??
    (async (p: string) => {
      const result = await fsPromises.stat(p);
      return { size: result.size };
    });
  const maxBytes = options.maxBytes ?? ARTIFACT_BLOB_MAX_BYTES;
  const allowlistRoots = options.allowlistRoots ?? defaultArtifactBlobAllowlistRoots();

  const record = getArtifactImpl(id);
  if (!record || record.deletedAt) {
    return { ok: false, status: 404, code: "not_found", error: `Artifact not found: ${id}` };
  }

  const candidates = collectArtifactCandidatePaths(record);
  if (candidates.length === 0) {
    return { ok: false, status: 404, code: "no_path", error: "Artifact has no local path" };
  }

  let lastFailure: ResolveArtifactBlobResult | null = null;
  for (const candidate of candidates) {
    let canonicalPath: string;
    try {
      canonicalPath = await realpathImpl(candidate);
    } catch {
      lastFailure = { ok: false, status: 404, code: "not_found", error: "Artifact path is not readable" };
      continue;
    }

    if (!isPathInsideAllowlist(canonicalPath, allowlistRoots)) {
      lastFailure = {
        ok: false,
        status: 403,
        code: "outside_allowlist",
        error: "Path is outside the artifact allowlist",
      };
      continue;
    }

    const ext = extname(canonicalPath).toLowerCase();
    const mimeType = ARTIFACT_BLOB_IMAGE_MIME_BY_EXT[ext];
    if (!mimeType) {
      lastFailure = {
        ok: false,
        status: 415,
        code: "unsupported_media_type",
        error: `Unsupported media type for ${ext || "(no extension)"}`,
      };
      continue;
    }

    let sizeBytes: number;
    try {
      const result = await statImpl(canonicalPath);
      sizeBytes = result.size;
    } catch {
      lastFailure = { ok: false, status: 404, code: "not_found", error: "Artifact path is not readable" };
      continue;
    }

    if (sizeBytes > maxBytes) {
      lastFailure = { ok: false, status: 413, code: "too_large", error: `Artifact exceeds ${maxBytes} bytes` };
      continue;
    }

    return {
      ok: true,
      artifactId: id,
      path: canonicalPath,
      mimeType,
      sizeBytes,
    };
  }

  return (
    lastFailure ?? {
      ok: false,
      status: 404,
      code: "not_found",
      error: "Artifact path is not readable",
    }
  );
}
