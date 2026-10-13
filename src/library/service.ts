/**
 * Library operations behind `ravi skills search|show|publish`.
 *
 * spec: skills/library
 *
 * The Console decides access, ranking and versions. This side merges local
 * skills into search, resolves bare slugs after local skills, authorizes the
 * calling agent, keeps Library skills not marked `externalAllowed` out of
 * turns that are not the operator's own, and keeps an offline copy.
 */

import type { CloudAuthError } from "../cloud-auth/errors.js";
import type { ConsoleScopeProject } from "../console-scope/types.js";
import type { ContextCapability } from "../router/router-db.js";
import {
  agentHasLibraryGrant,
  isLibrarySkillAuthorizedForAgent,
  isSkillAuthorizedForAgent,
  SKILL_NOT_AUTHORIZED,
  skillNotAuthorizedCopy,
} from "../runtime/skill-authorization.js";
import { listCatalogSkills, listInstalledSkills, type RaviSkill } from "../skills/manager.js";
import {
  findCachedLibraryRefsForSlug,
  itemRef,
  readCachedLibrarySkill,
  readLibraryIndex,
  recordLibraryItems,
  writeLibrarySkill,
  type LibraryCacheOptions,
} from "./cache.js";
import {
  isLibraryNotFoundError,
  isLibraryOfflineError,
  libraryLoginRequiredError,
  LIBRARY_SEARCH_DEFAULT_LIMIT,
  LIBRARY_SEARCH_MAX_LIMIT,
  openLibrarySession,
  type LibrarySession,
  type LibrarySessionDeps,
  type LibrarySessionOptions,
} from "./client.js";
import {
  checkLibraryNote,
  readLibraryPackage,
  type LibraryPackage,
  type ReadLibraryPackageOptions,
} from "./package.js";
import { isLibrarySlug, libraryRef, LIBRARY_ORG_SCOPE, type LibraryRef } from "./refs.js";
import { isOperatorOwnTurn, type LibraryTurnDeps } from "./turn.js";
import type { LibraryItem, LibraryPublishResponse, LibraryShowResponse } from "./types.js";

export const LIBRARY_SKILL_EXTERNAL_DENIED = "LIBRARY_SKILL_EXTERNAL_DENIED";
export const LIBRARY_SKILL_OUT_OF_VIEW = "LIBRARY_SKILL_OUT_OF_VIEW";
export const LIBRARY_REF_INVALID = "LIBRARY_REF_INVALID";
export const LIBRARY_LOGIN_HINT = "Library skipped: no Ravi Cloud login. Run `ravi login` to search the Library.";

/** A refusal decided on this side; the CLI renders it as a contract error. */
export class LibraryCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2 | 3,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "LibraryCommandError";
  }
}

/** The agent of an agent runtime turn; absent in the operator's terminal. */
export interface LibraryCaller {
  agentId: string;
  capabilities?: readonly ContextCapability[];
}

export interface LibraryServiceDeps {
  session?: LibrarySessionDeps;
  openSession?: (options: LibrarySessionOptions) => Promise<LibrarySession | null>;
  cache?: LibraryCacheOptions;
  turn?: LibraryTurnDeps;
}

function openSession(options: LibrarySessionOptions, deps: LibraryServiceDeps): Promise<LibrarySession | null> {
  return deps.openSession ? deps.openSession(options) : openLibrarySession(options, deps.session);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SkillSearchSource = "system" | "installed" | "library";

export interface SkillSearchResult {
  ref: string;
  source: SkillSearchSource;
  scope: "org" | "project" | null;
  project: string | null;
  name: string;
  description: string | null;
  version: number | null;
  externalAllowed?: boolean;
  authorized?: boolean;
  next: string;
  score: number;
}

export interface SkillSearchPayload {
  query: string;
  total: number;
  stale: boolean;
  library: {
    status: "ok" | "stale" | "skipped" | "error";
    project: string | null;
    hint?: string;
    error?: { code: string; message: string };
  };
  items: SkillSearchResult[];
}

export interface SkillSearchInput {
  query: string;
  limit?: number;
  project?: string | null;
  local?: boolean;
  caller?: LibraryCaller | null;
}

/** Lowercase, accents removed. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function searchTerms(query: string): string[] {
  return normalizeSearchText(query)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Simple score of query terms over a name and a description (0 = no match). */
export function scoreSkillText(terms: readonly string[], name: string, description: string | null | undefined): number {
  const normalizedName = normalizeSearchText(name);
  const nameTokens = normalizedName.split(/[^a-z0-9]+/).filter(Boolean);
  const normalizedDescription = normalizeSearchText(description ?? "");
  const descriptionTokens = normalizedDescription.split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;
  for (const term of terms) {
    if (normalizedName === term) score += 6;
    else if (nameTokens.some((token) => token.startsWith(term))) score += 4;
    else if (normalizedName.includes(term)) score += 3;
    else if (descriptionTokens.some((token) => token.startsWith(term))) score += 2;
    else if (normalizedDescription.includes(term)) score += 1;
  }
  return score;
}

export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIBRARY_SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(LIBRARY_SEARCH_MAX_LIMIT, Math.trunc(limit)));
}

function localSkillPool(): Array<{ skill: RaviSkill; source: "system" | "installed" }> {
  const seen = new Set<string>();
  const pool: Array<{ skill: RaviSkill; source: "system" | "installed" }> = [];
  for (const skill of listCatalogSkills()) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    pool.push({ skill, source: "system" });
  }
  for (const skill of listInstalledSkills({ includeCodex: false })) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    pool.push({ skill, source: "installed" });
  }
  return pool;
}

export async function searchSkills(
  input: SkillSearchInput,
  deps: LibraryServiceDeps = {},
): Promise<SkillSearchPayload> {
  const limit = clampSearchLimit(input.limit);
  const terms = searchTerms(input.query);
  const caller = input.caller ?? null;

  const local: SkillSearchResult[] = [];
  for (const { skill, source } of localSkillPool()) {
    const score = scoreSkillText(terms, skill.name, skill.description);
    if (terms.length > 0 && score === 0) continue;
    local.push({
      ref: skill.name,
      source,
      scope: null,
      project: null,
      name: skill.name,
      description: skill.description ?? null,
      version: null,
      ...(caller
        ? {
            authorized: isSkillAuthorizedForAgent(
              caller.agentId,
              skill.pluginName ? `${skill.pluginName}-${skill.name}` : skill.name,
              { capabilities: caller.capabilities },
            ),
          }
        : {}),
      next: `ravi skills show ${skill.name}`,
      score,
    });
  }

  let library: SkillSearchPayload["library"] = { status: "skipped", project: null };
  let libraryItems: LibraryItem[] = [];
  if (input.local) {
    library = { status: "skipped", project: null, hint: "--local: the Library was not searched." };
  } else {
    const session = await openSessionForCaller(input.project ?? null, caller, deps);
    if (!session) {
      library = { status: "skipped", project: null, hint: LIBRARY_LOGIN_HINT };
    } else {
      const projectRef = session.project?.ref ?? null;
      try {
        const response = await session.client.search({ query: input.query, project: projectRef, limit });
        libraryItems = response.items;
        recordLibraryItems(session.orgId, libraryItems, deps.cache);
        library = { status: "ok", project: projectRef };
      } catch (error) {
        if (!isLibraryOfflineError(error)) {
          const cloud = error as CloudAuthError;
          if (typeof cloud?.code !== "string") throw error;
          library = { status: "error", project: projectRef, error: { code: cloud.code, message: cloud.message } };
        } else {
          libraryItems = cachedSearch(session.orgId, terms, session.project, deps.cache);
          library = {
            status: "stale",
            project: projectRef,
            hint: "The Console could not be reached: Library results come from the local cache.",
          };
        }
      }
    }
  }

  const ownTurn = lazyOwnTurn(deps.turn);
  const libraryResults: SkillSearchResult[] = [];
  for (const item of libraryItems) {
    // Items not marked for it never reach a turn that is not the operator's own.
    if (!item.externalAllowed && !ownTurn()) continue;
    const ref = itemRef(item);
    const id = refForItem(item).id;
    const score = Math.max(scoreSkillText(terms, item.slug, item.description), scoreSkillText(terms, item.name, null));
    libraryResults.push({
      ref,
      source: "library",
      scope: item.scope,
      project: item.project?.slug ?? null,
      name: item.name,
      description: item.description || null,
      version: item.version,
      externalAllowed: item.externalAllowed,
      ...(caller
        ? { authorized: isLibrarySkillAuthorizedForAgent(caller.agentId, id, { capabilities: caller.capabilities }) }
        : {}),
      next: `ravi skills show ${ref}`,
      // The Console matched it (maybe in the body): keep it, after better local matches.
      score: terms.length > 0 ? Math.max(score, 0.5) : 0,
    });
  }

  const merged = [...local, ...libraryResults]
    .map((result, order) => ({ result, order }))
    .sort((a, b) => b.result.score - a.result.score || a.order - b.order)
    .map(({ result }) => result)
    .slice(0, limit);
  const stale = library.status === "stale";
  return { query: input.query, total: merged.length, stale, library, items: merged };
}

function cachedSearch(
  orgId: string,
  terms: readonly string[],
  project: ConsoleScopeProject | null,
  cache: LibraryCacheOptions | undefined,
): LibraryItem[] {
  const index = readLibraryIndex(orgId, cache);
  return Object.values(index.items)
    .map((entry) => entry.item)
    .filter((item) => item.scope === "org" || projectMatches(project, item.project?.slug, item.project?.id))
    .filter(
      (item) =>
        terms.length === 0 ||
        scoreSkillText(terms, item.slug, item.description) > 0 ||
        scoreSkillText(terms, item.name, null) > 0,
    );
}

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

export interface LibraryShowOutcome extends LibraryShowResponse {
  ref: LibraryRef;
  stale: boolean;
  /** Version directory in the local cache, when written or read from there. */
  cacheDir: string | null;
  consoleUrl: string | null;
}

export interface LibraryShowInput {
  /** A ref (`org/x`, `clinica/x`) or id. */
  ref?: LibraryRef;
  /** A bare slug with no local match. */
  slug?: string;
  project?: string | null;
  caller?: LibraryCaller | null;
}

/**
 * Load a Library skill. Returns null for a bare slug when the Library has no
 * such item in the caller's view (or there is no login), so the CLI can fail
 * with its usual SKILL_NOT_FOUND.
 */
export async function showLibrarySkill(
  input: LibraryShowInput,
  deps: LibraryServiceDeps = {},
): Promise<LibraryShowOutcome | null> {
  const caller = input.caller ?? null;
  const session = await openSessionForCaller(input.project ?? null, caller, deps);
  if (!session) {
    if (input.ref) throw libraryLoginRequiredError();
    return null;
  }

  let shown: LibraryShowResponse | null = null;
  let stale = false;
  let cacheDir: string | null = null;
  try {
    shown = input.ref
      ? await session.client.showRef(input.ref)
      : await session.client.showSlug(input.slug ?? "", { project: session.project?.ref ?? null });
  } catch (error) {
    if (isLibraryNotFoundError(error)) {
      if (input.ref) throw notFound(input.ref.ref);
      return null;
    }
    if (!isLibraryOfflineError(error)) throw error;
    const refs = input.ref
      ? [input.ref.ref]
      : findCachedLibraryRefsForSlug(session.orgId, input.slug ?? "", projectKey(session.project), deps.cache);
    const cached = refs.map((ref) => readCachedLibrarySkill(session.orgId, ref, deps.cache)).find(Boolean) ?? null;
    if (!cached) throw error;
    shown = { item: cached.item, version: cached.version };
    stale = true;
    cacheDir = cached.dir;
  }

  const ref = refForItem(shown.item);
  if (caller) {
    // A project item of another project is outside the agent's view unless
    // a grant names it exactly.
    if (
      ref.scope === "project" &&
      !projectMatches(session.project, shown.item.project?.slug, shown.item.project?.id) &&
      !agentHasLibraryGrant(caller.agentId, ref.id)
    ) {
      throw new LibraryCommandError(
        LIBRARY_SKILL_OUT_OF_VIEW,
        `Library skill '${ref.ref}' belongs to project '${ref.project}', which is not this agent's Console project.`,
        3,
        {
          suggestedAction: `Ask an operator to grant it explicitly ('ravi skills grant ${caller.agentId} ${ref.ref}') or to bind this agent to that project.`,
        },
      );
    }
    if (!isLibrarySkillAuthorizedForAgent(caller.agentId, ref.id, { capabilities: caller.capabilities })) {
      const copy = skillNotAuthorizedCopy(ref.ref, caller.agentId);
      throw new LibraryCommandError(SKILL_NOT_AUTHORIZED, copy.message, 1, { suggestedAction: copy.suggestedAction });
    }
  }
  if (!shown.item.externalAllowed && !lazyOwnTurn(deps.turn)()) {
    throw new LibraryCommandError(
      LIBRARY_SKILL_EXTERNAL_DENIED,
      `Library skill '${ref.ref}' is not marked for conversations with people outside the organization, and this turn is not the operator's own.`,
      3,
      {
        suggestedAction:
          "Answer without this skill. A publisher can allow it with 'ravi skills publish <dir> --scope <scope> --external --execute'.",
      },
    );
  }

  if (!stale) cacheDir = writeLibrarySkill(session.orgId, shown, deps.cache);
  return { ...shown, ref, stale, cacheDir, consoleUrl: session.consoleUrl };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export interface LibraryPublishInput extends ReadLibraryPackageOptions {
  dir: string;
  scope: string;
  note?: string;
  external?: boolean;
}

export interface LibraryPublishPlan {
  ref: string;
  scope: "org" | "project";
  project: string | null;
  slug: string;
  name: string;
  description: string;
  externalAllowed: boolean;
  note: string | null;
  /** `file`, not `path`: the contract envelope redacts keys ending in "path". */
  files: Array<{ file: string; bytes: number }>;
  totalBytes: number;
  contentHash: string;
  currentVersion: number;
  nextVersion: number;
  unchanged: boolean;
}

export interface PreparedLibraryPublish {
  plan: LibraryPublishPlan;
  pkg: LibraryPackage;
  session: LibrarySession;
  target: LibraryRef;
}

/** `--scope org` or a project ref. Throws LIBRARY_REF_INVALID. */
export function parsePublishScope(scope: string | undefined): { scope: "org" | "project"; project: string | null } {
  const value = scope?.trim().toLowerCase() ?? "";
  if (value === LIBRARY_ORG_SCOPE) return { scope: "org", project: null };
  if (isLibrarySlug(value)) return { scope: "project", project: value };
  throw new LibraryCommandError(LIBRARY_REF_INVALID, "--scope must be 'org' or a project slug (a-z, 0-9 and -).", 2, {
    suggestedAction: "Pass --scope org, or --scope <project-slug> (list projects with: ravi projects list)",
  });
}

/** Validate the folder, read the current published version and build the plan. */
export async function prepareLibraryPublish(
  input: LibraryPublishInput,
  deps: LibraryServiceDeps = {},
): Promise<PreparedLibraryPublish> {
  const scope = parsePublishScope(input.scope);
  const note = checkLibraryNote(input.note);
  const pkg = readLibraryPackage(input.dir, { slug: input.slug, name: input.name });
  const target = libraryRef(scope.scope, scope.project, pkg.slug);
  const session = await openSession({ resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();

  let current: LibraryShowResponse | null = null;
  try {
    current = await session.client.showRef(target);
  } catch (error) {
    if (!isLibraryNotFoundError(error)) throw error;
  }
  const currentVersion = current?.version.number ?? 0;
  const externalAllowed = input.external === true;
  const unchanged = current !== null && current.version.contentHash === pkg.contentHash;
  return {
    pkg,
    session,
    target,
    plan: {
      ref: target.ref,
      scope: target.scope,
      project: target.project,
      slug: pkg.slug,
      name: pkg.name,
      description: pkg.description,
      externalAllowed,
      note: note ?? null,
      files: pkg.files.map((file) => ({ file: file.path, bytes: file.bytes })),
      totalBytes: pkg.totalBytes,
      contentHash: pkg.contentHash,
      currentVersion,
      nextVersion: unchanged ? currentVersion : currentVersion + 1,
      unchanged,
    },
  };
}

export async function executeLibraryPublish(
  prepared: PreparedLibraryPublish,
  deps: LibraryServiceDeps = {},
): Promise<LibraryPublishResponse & { ref: string; cacheDir: string | null }> {
  const { plan, pkg, session } = prepared;
  const result = await session.client.publish({
    scope: plan.scope,
    ...(plan.project ? { project: plan.project } : {}),
    slug: plan.slug,
    name: plan.name,
    description: plan.description,
    externalAllowed: plan.externalAllowed,
    ...(plan.note ? { note: plan.note } : {}),
    baseVersion: plan.currentVersion,
    files: pkg.files.map((file) => ({ path: file.path, content: file.content })),
  });
  const cacheDir = writeLibrarySkill(
    session.orgId,
    {
      item: result.item,
      version: {
        number: result.version.number,
        note: plan.note,
        contentHash: result.version.contentHash,
        publishedAt: result.item.publishedAt ?? null,
        files: pkg.files,
      },
    },
    deps.cache,
  );
  return { ...result, ref: itemRef(result.item), cacheDir };
}

// ---------------------------------------------------------------------------

function refForItem(item: LibraryItem): LibraryRef {
  return item.scope === "org"
    ? libraryRef("org", null, item.slug)
    : libraryRef("project", item.project?.slug ?? "", item.slug);
}

function notFound(ref: string): LibraryCommandError {
  return new LibraryCommandError("SKILL_NOT_FOUND", `Library skill not found: ${ref}`, 1, {
    suggestedAction: "Search for it with: ravi skills search <words> --json",
  });
}

/**
 * The session for a call. In an agent runtime the view is the agent's own
 * Console project: `--project` naming another project is refused.
 */
async function openSessionForCaller(
  project: string | null,
  caller: LibraryCaller | null,
  deps: LibraryServiceDeps,
): Promise<LibrarySession | null> {
  const explicit = project?.trim().toLowerCase() || null;
  if (!caller || !explicit) return openSession({ project: explicit }, deps);
  const session = await openSession({}, deps);
  if (session && !projectMatches(session.project, explicit, explicit)) {
    throw new LibraryCommandError(
      LIBRARY_SKILL_OUT_OF_VIEW,
      `Project '${explicit}' is not this agent's Console project, so its Library skills are outside the agent's view.`,
      3,
      { suggestedAction: "Drop --project: an agent sees org skills and the skills of its own Console project." },
    );
  }
  return session;
}

function projectKey(project: ConsoleScopeProject | null): string | null {
  return project?.slug?.toLowerCase() ?? project?.ref?.toLowerCase() ?? null;
}

function projectMatches(
  project: ConsoleScopeProject | null,
  slug: string | null | undefined,
  id: string | null | undefined,
): boolean {
  if (!project) return false;
  const keys = new Set(
    [project.ref, project.slug, project.id]
      .filter((value): value is string => Boolean(value))
      .map((v) => v.toLowerCase()),
  );
  return Boolean((slug && keys.has(slug.toLowerCase())) || (id && keys.has(id.toLowerCase())));
}

function lazyOwnTurn(deps: LibraryTurnDeps | undefined): () => boolean {
  let value: boolean | undefined;
  return () => {
    value ??= isOperatorOwnTurn(deps);
    return value;
  };
}
