/**
 * Library agent definitions behind `ravi agents search|show|install|update|publish`.
 *
 * spec: skills/library
 *
 * A definition is `AGENTS.md` (the instructions), an optional `HEARTBEAT.md`
 * and an optional `agent.json` with suggested `provider`, `model`, permission
 * `profile` and required `skills`. The Console stores and versions them; this
 * side installs one as a new local agent and decides locally what needs the
 * write brake: a permission profile above the bootstrap floor and any skill
 * grant. A definition never carries routes, instances, contacts, paths or
 * credentials, in either direction.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  buildAgentRuntimePermissionsDefaults,
  getAgentRuntimePermissionsConfigFromDefaults,
  normalizeAgentRuntimePermissionProfile,
  type AgentRuntimePermissionProfile,
} from "../permissions/agent-default-capabilities-provider.js";
import { createAgent, ensureAgentDirs, getAgent, loadRouterConfig, updateAgent } from "../router/config.js";
import { dbListSkillGrantsForAgent, dbUpsertSkillGrant } from "../router/router-db.js";
import type { AgentConfig } from "../router/types.js";
import { ensureAgentInstructionFiles } from "../runtime/agent-instructions.js";
import { findSkillByName, listCatalogSkills, listInstalledSkills } from "../skills/manager.js";
import {
  dbGetLibraryAgentState,
  dbSetLibraryAgentListed,
  dbSetLibraryAgentDescription,
  dbSetLibraryAgentOrigin,
  LIBRARY_AGENT_DESCRIPTION_MAX,
  type LibraryAgentState,
} from "./agents-db.js";
import {
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
  openLibrarySession,
  type LibrarySession,
  type LibrarySessionDeps,
  type LibrarySessionOptions,
} from "./client.js";
import { checkLibraryNote, LIBRARY_LIMITS, libraryContentHash, sha256 } from "./package.js";
import { isLibrarySlug, libraryRef, parseLibraryRef, type LibraryRef } from "./refs.js";
import {
  clampSearchLimit,
  LIBRARY_LOGIN_HINT,
  LibraryCommandError,
  parsePublishScope,
  scoreSkillText,
} from "./service.js";
import { isOperatorOwnTurn, type LibraryTurnDeps } from "./turn.js";
import type {
  LibraryAgentManifest,
  LibraryItem,
  LibraryProposal,
  LibraryPublishResponse,
  LibraryShowResponse,
} from "./types.js";

export const LIBRARY_AGENT_CANNOT_INSTALL = "LIBRARY_AGENT_CANNOT_INSTALL";
export const LIBRARY_AGENT_EDITED_LOCALLY = "LIBRARY_AGENT_EDITED_LOCALLY";
export const LIBRARY_AGENT_NO_ORIGIN = "LIBRARY_AGENT_NO_ORIGIN";
export const AGENT_INSTRUCTIONS_FILE = "AGENTS.md";
export const AGENT_HEARTBEAT_FILE = "HEARTBEAT.md";
export const AGENT_MANIFEST_FILE = "agent.json";
/** The profile every new agent starts with; anything that adds authority above it is braked. */
const BOOTSTRAP_PROFILE = "bootstrap";
const LOCAL_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface LibraryAgentServiceDeps {
  session?: LibrarySessionDeps;
  openSession?: (options: LibrarySessionOptions) => Promise<LibrarySession | null>;
  cache?: LibraryCacheOptions;
  turn?: LibraryTurnDeps;
  /** Home directory for the default cwd (`~/ravi/<id>`). */
  home?: string;
}

function openSession(options: LibrarySessionOptions, deps: LibraryAgentServiceDeps) {
  return deps.openSession ? deps.openSession(options) : openLibrarySession(options, deps.session);
}

function agentCache(deps: LibraryAgentServiceDeps): LibraryCacheOptions {
  return { ...deps.cache, kind: "agent" };
}

function agentNotFound(ref: string): LibraryCommandError {
  return new LibraryCommandError("NOT_FOUND", `Library agent not found: ${ref}`, 1, {
    suggestedAction: "Search for it with: ravi agents search <words> --json",
  });
}

function externalDenied(ref: string): LibraryCommandError {
  return new LibraryCommandError(
    "LIBRARY_SKILL_EXTERNAL_DENIED",
    `Library agent '${ref}' is not marked for conversations with people outside the organization, and this turn is not the operator's own.`,
    3,
    { suggestedAction: "Answer without it." },
  );
}

// ---------------------------------------------------------------------------
// Search and show

export interface LibraryAgentSearchResult {
  ref: string;
  scope: "org" | "project";
  project: string | null;
  name: string;
  description: string | null;
  version: number;
  next: string;
}

export interface LibraryAgentSearchPayload {
  query: string;
  total: number;
  stale: boolean;
  library: {
    status: "ok" | "stale" | "skipped" | "error";
    project: string | null;
    hint?: string;
    error?: { code: string; message: string };
  };
  items: LibraryAgentSearchResult[];
}

export async function searchLibraryAgents(
  input: { query: string; project?: string | null; limit?: number },
  deps: LibraryAgentServiceDeps = {},
): Promise<LibraryAgentSearchPayload> {
  const limit = clampSearchLimit(input.limit);
  const terms = input.query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const session = await openSession({ project: input.project?.trim() || null }, deps);
  if (!session) {
    return {
      query: input.query,
      total: 0,
      stale: false,
      library: { status: "skipped", project: null, hint: LIBRARY_LOGIN_HINT },
      items: [],
    };
  }
  const projectRef = session.project?.ref ?? null;
  let items: LibraryItem[] = [];
  let library: LibraryAgentSearchPayload["library"];
  try {
    const response = await session.client.forAgents().search({ query: input.query, project: projectRef, limit });
    items = response.items;
    recordLibraryItems(session.orgId, items, agentCache(deps));
    library = { status: "ok", project: projectRef };
  } catch (error) {
    if (!isLibraryOfflineError(error)) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code !== "string") throw error;
      library = { status: "error", project: projectRef, error: { code, message: (error as Error).message } };
    } else {
      items = Object.values(readLibraryIndex(session.orgId, agentCache(deps)).items)
        .map((entry) => entry.item)
        .filter(
          (item) =>
            terms.length === 0 ||
            scoreSkillText(terms, item.slug, item.description) > 0 ||
            scoreSkillText(terms, item.name, null) > 0,
        );
      library = {
        status: "stale",
        project: projectRef,
        hint: "The Console could not be reached: results come from the local cache.",
      };
    }
  }
  let ownTurn: boolean | undefined;
  const results: LibraryAgentSearchResult[] = [];
  for (const item of items) {
    if (!item.externalAllowed && !(ownTurn ??= isOperatorOwnTurn(deps.turn))) continue;
    const ref = itemRef(item);
    results.push({
      ref,
      scope: item.scope,
      project: item.project?.slug ?? null,
      name: item.name,
      description: item.description || null,
      version: item.version,
      next: `ravi agents show ${ref}`,
    });
  }
  const sliced = results.slice(0, limit);
  return { query: input.query, total: sliced.length, stale: library.status === "stale", library, items: sliced };
}

export interface LibraryAgentDefinition {
  ref: string;
  item: LibraryItem;
  version: number;
  contentHash: string;
  note: string | null;
  publishedAt: string | null;
  agent: LibraryAgentManifest;
  instructions: string;
  heartbeat: string | null;
  files: Array<{ file: string; bytes: number }>;
  stale: boolean;
}

/** The manifest the Console parsed, or the one in `agent.json` when it sent none. */
function manifestOf(shown: LibraryShowResponse): LibraryAgentManifest {
  if (shown.version.agent) return shown.version.agent;
  const raw = shown.version.files.find((file) => file.path === AGENT_MANIFEST_FILE)?.content;
  const empty: LibraryAgentManifest = { provider: null, model: null, profile: null, skills: [] };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
    return {
      provider: text(parsed.provider),
      model: text(parsed.model),
      profile: text(parsed.profile),
      skills: Array.isArray(parsed.skills)
        ? [...new Set(parsed.skills.filter((ref): ref is string => typeof ref === "string" && ref.trim() !== ""))]
        : [],
    };
  } catch {
    return empty;
  }
}

function definitionOf(shown: LibraryShowResponse, stale: boolean): LibraryAgentDefinition {
  const instructions = shown.version.files.find((file) => file.path === AGENT_INSTRUCTIONS_FILE)?.content;
  if (instructions === undefined) {
    throw new LibraryCommandError(
      "LIBRARY_PACKAGE_INVALID",
      `Library agent ${itemRef(shown.item)} v${shown.version.number} has no AGENTS.md.`,
      1,
      { suggestedAction: "Ask a publisher of that scope to publish a version with AGENTS.md" },
    );
  }
  return {
    ref: itemRef(shown.item),
    item: shown.item,
    version: shown.version.number,
    contentHash: shown.version.contentHash,
    note: shown.version.note,
    publishedAt: shown.version.publishedAt,
    agent: manifestOf(shown),
    instructions,
    heartbeat: shown.version.files.find((file) => file.path === AGENT_HEARTBEAT_FILE)?.content ?? null,
    files: shown.version.files.map((file) => ({ file: file.path, bytes: file.bytes })),
    stale,
  };
}

async function fetchDefinition(
  session: LibrarySession,
  ref: LibraryRef,
  deps: LibraryAgentServiceDeps,
  options: { allowCache: boolean },
): Promise<LibraryAgentDefinition> {
  try {
    const shown = await session.client.forAgents().showRef(ref);
    writeLibrarySkill(session.orgId, shown, agentCache(deps));
    return definitionOf(shown, false);
  } catch (error) {
    if (isLibraryNotFoundError(error)) throw agentNotFound(ref.ref);
    if (!options.allowCache || !isLibraryOfflineError(error)) throw error;
    const cached = readCachedLibrarySkill(session.orgId, ref.ref, agentCache(deps));
    if (!cached) throw error;
    return definitionOf({ item: cached.item, version: cached.version }, true);
  }
}

/** `ravi agents show <ref>`: read-only; answers from the cache with `stale: true` when offline. */
export async function showLibraryAgent(
  ref: LibraryRef,
  deps: LibraryAgentServiceDeps = {},
): Promise<LibraryAgentDefinition> {
  const session = await openSession({ resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  const definition = await fetchDefinition(session, ref, deps, { allowCache: true });
  if (!definition.item.externalAllowed && !isOperatorOwnTurn(deps.turn)) throw externalDenied(definition.ref);
  return definition;
}

// ---------------------------------------------------------------------------
// Profile and skills: what the local Ravi grants for a definition

export interface PlannedProfile {
  /** What `agent.json` suggests. */
  suggested: string | null;
  /** The profile this command sets, or null when it leaves the agent's profile as it is. */
  apply: AgentRuntimePermissionProfile | null;
  /** Adds authority above what the agent has (above the bootstrap floor for a new agent). */
  raises: boolean;
  /** Why a suggestion is not applied. */
  note?: string;
}

export interface PlannedSkill {
  ref: string;
  kind: "library" | "ravi";
  /** The grant stored (`org:<slug>`, `project:<p>:<slug>` or a skill name). */
  grant: string | null;
  status: "grant" | "granted" | "missing";
  reason?: string;
}

function planProfile(suggested: string | null, currentProfile: string | null): PlannedProfile {
  if (!suggested) return { suggested: null, apply: null, raises: false };
  const normalized = normalizeAgentRuntimePermissionProfile(suggested);
  if (!normalized || normalized === "none") {
    return {
      suggested,
      apply: null,
      raises: false,
      note: `'${suggested}' is not a permission profile of this Ravi; the agent keeps its profile.`,
    };
  }
  const current = currentProfile ?? BOOTSTRAP_PROFILE;
  if (normalized === current) return { suggested, apply: null, raises: false };
  // chat-only and explicit-only sit below the bootstrap floor; full-access above it.
  const raises =
    normalized === "full-access" ||
    ((current === "chat-only" || current === "explicit-only") && normalized !== "chat-only");
  return { suggested, apply: normalized, raises };
}

async function planSkills(
  session: LibrarySession,
  refs: readonly string[],
  agentId: string | null,
): Promise<PlannedSkill[]> {
  const granted = new Set(agentId ? dbListSkillGrantsForAgent(agentId).map((grant) => grant.skillName) : []);
  const catalog = listCatalogSkills();
  const installed = listInstalledSkills({ includeCodex: false });
  return Promise.all(
    refs.map(async (raw): Promise<PlannedSkill> => {
      const ref = raw.trim();
      const library = parseLibraryRef(ref);
      if (library) {
        if (granted.has(library.id)) return { ref: library.ref, kind: "library", grant: library.id, status: "granted" };
        try {
          await session.client.showRef(library);
          return { ref: library.ref, kind: "library", grant: library.id, status: "grant" };
        } catch (error) {
          if (isLibraryOfflineError(error)) throw error;
          const code = (error as { code?: unknown })?.code;
          return {
            ref: library.ref,
            kind: "library",
            grant: null,
            status: "missing",
            reason: typeof code === "string" ? code : "UNKNOWN",
          };
        }
      }
      const skill = findSkillByName(catalog, ref) ?? findSkillByName(installed, ref);
      if (!skill) return { ref, kind: "ravi", grant: null, status: "missing", reason: "SKILL_NOT_FOUND" };
      return { ref, kind: "ravi", grant: skill.name, status: granted.has(skill.name) ? "granted" : "grant" };
    }),
  );
}

function applyProfile(agentId: string, profile: AgentRuntimePermissionProfile): void {
  const agent = getAgent(agentId);
  const before = getAgentRuntimePermissionsConfigFromDefaults(agent?.defaults);
  const next = profile === "chat-only" ? { profile } : { ...(before ?? {}), profile };
  updateAgent(agentId, { defaults: buildAgentRuntimePermissionsDefaults(agent?.defaults, next) });
}

function applyGrants(agentId: string, skills: readonly PlannedSkill[], origin: string): string[] {
  const granted: string[] = [];
  for (const skill of skills) {
    if (skill.status !== "grant" || !skill.grant) continue;
    dbUpsertSkillGrant({ agentId, skillName: skill.grant, note: `required by Library agent ${origin}` });
    granted.push(skill.grant);
  }
  return granted;
}

function currentProfileOf(agent: AgentConfig | null | undefined): string | null {
  return getAgentRuntimePermissionsConfigFromDefaults(agent?.defaults)?.profile ?? null;
}

// ---------------------------------------------------------------------------
// Install

export interface LibraryAgentInstallPlan {
  ref: string;
  version: number;
  contentHash: string;
  agent: { id: string; cwd: string; provider: string | null; model: string | null };
  files: Array<{ file: string; bytes: number }>;
  heartbeat: boolean;
  profile: PlannedProfile;
  skills: PlannedSkill[];
  /** Whether `--execute` is required (a profile above the bootstrap floor, or a skill grant). */
  requiresExecute: boolean;
  effect: string[];
}

export interface PreparedLibraryAgentInstall {
  plan: LibraryAgentInstallPlan;
  definition: LibraryAgentDefinition;
  session: LibrarySession;
}

function defaultAgentCwd(agentId: string, deps: LibraryAgentServiceDeps): string {
  return join(deps.home ?? homedir(), "ravi", agentId);
}

function expandCwd(cwd: string, deps: LibraryAgentServiceDeps): string {
  return cwd.startsWith("~") ? join(deps.home ?? homedir(), cwd.slice(1)) : cwd;
}

function checkLocalAgentId(id: string): string {
  const value = id.trim().toLowerCase();
  if (!LOCAL_AGENT_ID_PATTERN.test(value)) {
    throw new LibraryCommandError(
      "USAGE_ERROR",
      `'${id.slice(0, 80)}' is not a valid agent id (a-z, 0-9, - and _, at most 64 characters).`,
      2,
      { suggestedAction: "Pass another id with --id <id>" },
    );
  }
  return value;
}

export async function prepareLibraryAgentInstall(
  input: { ref: LibraryRef; id?: string; cwd?: string },
  deps: LibraryAgentServiceDeps = {},
): Promise<PreparedLibraryAgentInstall> {
  const agentId = checkLocalAgentId(input.id?.trim() || input.ref.slug);
  if (getAgent(agentId)) {
    throw new LibraryCommandError("AGENT_ALREADY_EXISTS", `A local agent '${agentId}' already exists.`, 1, {
      suggestedAction: `Install under another id (--id <id>), or update an installed agent with: ravi agents update ${agentId}`,
    });
  }
  const cwd = expandCwd(input.cwd?.trim() || defaultAgentCwd(agentId, deps), deps);
  if (existsSync(join(cwd, AGENT_INSTRUCTIONS_FILE))) {
    throw new LibraryCommandError("AGENT_CWD_IN_USE", `${join(cwd, AGENT_INSTRUCTIONS_FILE)} already exists.`, 1, {
      suggestedAction: "Pick an empty folder with --cwd <dir>",
    });
  }
  const session = await openSession({ resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  const definition = await fetchDefinition(session, input.ref, deps, { allowCache: false });
  const profile = planProfile(definition.agent.profile, null);
  const skills = await planSkills(session, definition.agent.skills, null);
  const grants = skills.filter((skill) => skill.status === "grant");
  const requiresExecute = profile.raises || grants.length > 0;
  const effect = [
    `create local agent '${agentId}' in ${cwd}`,
    `write AGENTS.md${definition.heartbeat !== null ? " and HEARTBEAT.md" : ""} from ${definition.ref} v${definition.version}`,
    ...(definition.agent.provider ? [`provider ${definition.agent.provider}`] : []),
    ...(definition.agent.model ? [`model ${definition.agent.model}`] : []),
    ...(profile.apply
      ? [`permission profile ${profile.apply}${profile.raises ? " (above the bootstrap floor)" : ""}`]
      : []),
    ...grants.map((skill) => `grant ${skill.grant}`),
    ...skills
      .filter((skill) => skill.status === "missing")
      .map((skill) => `skip ${skill.ref} (${skill.reason ?? "missing"})`),
  ];
  return {
    session,
    definition,
    plan: {
      ref: definition.ref,
      version: definition.version,
      contentHash: definition.contentHash,
      agent: { id: agentId, cwd, provider: definition.agent.provider, model: definition.agent.model },
      files: definition.files,
      heartbeat: definition.heartbeat !== null,
      profile,
      skills,
      requiresExecute,
      effect,
    },
  };
}

export interface LibraryAgentInstallResult {
  ref: string;
  version: number;
  agent: { id: string; cwd: string; provider: string | null; model: string | null };
  profile: string | null;
  granted: string[];
  skipped: Array<{ ref: string; reason: string }>;
  next: string[];
}

export function executeLibraryAgentInstall(prepared: PreparedLibraryAgentInstall): LibraryAgentInstallResult {
  const { plan, definition } = prepared;
  const agentId = plan.agent.id;
  if (getAgent(agentId)) {
    throw new LibraryCommandError("AGENT_ALREADY_EXISTS", `A local agent '${agentId}' already exists.`, 1, {
      suggestedAction: "Install under another id with --id <id>",
    });
  }
  mkdirSync(plan.agent.cwd, { recursive: true });
  writeFileSync(join(plan.agent.cwd, AGENT_INSTRUCTIONS_FILE), definition.instructions);
  if (definition.heartbeat !== null) writeFileSync(join(plan.agent.cwd, AGENT_HEARTBEAT_FILE), definition.heartbeat);
  createAgent({
    id: agentId,
    cwd: plan.agent.cwd,
    ...(plan.agent.provider ? { provider: plan.agent.provider } : {}),
    ...(plan.agent.model ? { model: plan.agent.model } : {}),
  });
  ensureAgentDirs(loadRouterConfig());
  ensureAgentInstructionFiles(plan.agent.cwd);
  if (plan.profile.apply) applyProfile(agentId, plan.profile.apply);
  const granted = applyGrants(agentId, plan.skills, `${definition.ref}@${definition.version}`);
  dbSetLibraryAgentOrigin(agentId, {
    ref: definition.ref,
    version: definition.version,
    contentHash: definition.contentHash || null,
    agentsMdSha256: sha256(definition.instructions),
    heartbeatMdSha256: definition.heartbeat !== null ? sha256(definition.heartbeat) : null,
    profile: definition.agent.profile,
    skills: definition.agent.skills,
    installedAt: Date.now(),
  });
  // A reused id never inherits an earlier agent's listing or openness to requests.
  dbSetLibraryAgentListed(agentId, false);
  dbSetLibraryAgentDescription(agentId, definition.item.description.slice(0, LIBRARY_AGENT_DESCRIPTION_MAX) || null);
  return {
    ref: definition.ref,
    version: definition.version,
    agent: plan.agent,
    profile: plan.profile.apply,
    granted,
    skipped: plan.skills
      .filter((skill) => skill.status === "missing")
      .map((skill) => ({ ref: skill.ref, reason: skill.reason ?? "missing" })),
    next: [`ravi agents show ${agentId}`, `ravi sessions send ${agentId} "hi" -a ${agentId} -w`],
  };
}

// ---------------------------------------------------------------------------
// Update

export interface LibraryAgentFileChange {
  file: string;
  /** The file differs from what was installed. */
  editedLocally: boolean;
  /** The new version differs from what was installed. */
  changedInLibrary: boolean;
  /** `--keep-local` keeps it, `--take-library` overwrites it; untouched files follow the Library. */
  action: "write" | "keep" | "unchanged" | "remove";
  diff?: string;
}

export interface LibraryAgentUpdatePlan {
  agent: string;
  ref: string;
  installedVersion: number;
  version: number;
  upToDate: boolean;
  files: LibraryAgentFileChange[];
  editedLocally: boolean;
  resolution: "keep-local" | "take-library" | null;
  profile: PlannedProfile;
  skills: PlannedSkill[];
  requiresExecute: boolean;
  effect: string[];
}

export interface PreparedLibraryAgentUpdate {
  plan: LibraryAgentUpdatePlan;
  definition: LibraryAgentDefinition;
  state: LibraryAgentState;
  cwd: string;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export async function prepareLibraryAgentUpdate(
  input: { agentId: string; keepLocal?: boolean; takeLibrary?: boolean },
  deps: LibraryAgentServiceDeps = {},
): Promise<PreparedLibraryAgentUpdate> {
  if (input.keepLocal && input.takeLibrary) {
    throw new LibraryCommandError("USAGE_ERROR", "Pass --keep-local or --take-library, not both.", 2, {
      suggestedAction: "Choose one: --keep-local keeps your edits, --take-library overwrites them",
    });
  }
  const agent = getAgent(input.agentId);
  if (!agent) {
    throw new LibraryCommandError("AGENT_NOT_FOUND", `Agent not found: ${input.agentId}`, 1, {
      suggestedAction: "Check the agent id with: ravi agents list --json",
    });
  }
  const state = dbGetLibraryAgentState(agent.id);
  const origin = state?.origin;
  const originRef = origin ? parseLibraryRef(origin.ref) : null;
  if (!state || !origin || !originRef) {
    throw new LibraryCommandError(
      LIBRARY_AGENT_NO_ORIGIN,
      `Agent '${agent.id}' was not installed from the Library, so it has nothing to update from.`,
      1,
      { suggestedAction: "Install a Library agent with: ravi agents install <ref> --execute" },
    );
  }
  const session = await openSession({ resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  const definition = await fetchDefinition(session, originRef, deps, { allowCache: false });
  const cwd = expandCwd(agent.cwd, deps);

  const files: LibraryAgentFileChange[] = [];
  const compare = (file: string, installedHash: string | null, next: string | null) => {
    const local = readOptional(join(cwd, file));
    const localHash = local === null ? null : sha256(local);
    const nextHash = next === null ? null : sha256(next);
    const editedLocally = localHash !== installedHash;
    const changedInLibrary = nextHash !== installedHash;
    let action: LibraryAgentFileChange["action"];
    if (localHash === nextHash) action = "unchanged";
    else if (editedLocally && !input.takeLibrary) action = "keep";
    else action = next === null ? "remove" : "write";
    files.push({
      file,
      editedLocally,
      changedInLibrary,
      action,
      ...(editedLocally && changedInLibrary && localHash !== nextHash
        ? {
            diff: lineDiff(
              local ?? "",
              next ?? "",
              `${file} (local)`,
              `${file} (${definition.ref} v${definition.version})`,
            ),
          }
        : {}),
    });
  };
  compare(AGENT_INSTRUCTIONS_FILE, origin.agentsMdSha256, definition.instructions);
  compare(AGENT_HEARTBEAT_FILE, origin.heartbeatMdSha256, definition.heartbeat);

  // A file both edited here and changed in the Library needs a decision.
  const conflicting = files.some((file) => file.editedLocally && file.changedInLibrary && file.action !== "unchanged");
  const resolution = input.keepLocal ? "keep-local" : input.takeLibrary ? "take-library" : null;
  if (conflicting && !resolution) {
    throw new LibraryCommandError(
      LIBRARY_AGENT_EDITED_LOCALLY,
      `${agent.id}'s instructions were edited here and changed in ${definition.ref} v${definition.version}.`,
      2,
      {
        suggestedAction: `Keep your edits (ravi agents update ${agent.id} --keep-local) or replace them (ravi agents update ${agent.id} --take-library)`,
        files: files.map(({ diff: _diff, ...rest }) => rest),
        diff: files.flatMap((file) => (file.diff ? [file.diff] : [])).join("\n"),
      },
    );
  }

  // Only a suggestion that changed in the Library is applied: a profile the
  // operator set here is not reverted by an update that did not touch it.
  const profileChanged = (definition.agent.profile ?? null) !== (origin.profile ?? null);
  const profile = profileChanged
    ? planProfile(definition.agent.profile, currentProfileOf(agent))
    : { suggested: definition.agent.profile, apply: null, raises: false };
  const newRefs = definition.agent.skills.filter((ref) => !origin.skills.includes(ref));
  const skills = await planSkills(session, newRefs, agent.id);
  const grants = skills.filter((skill) => skill.status === "grant");
  const upToDate =
    definition.version === origin.version &&
    files.every((file) => file.action === "unchanged" || file.action === "keep") &&
    !profile.apply &&
    grants.length === 0;
  const requiresExecute = profile.raises || grants.length > 0;
  const effect = [
    ...files.filter((file) => file.action === "write").map((file) => `write ${file.file}`),
    ...files.filter((file) => file.action === "remove").map((file) => `remove ${file.file}`),
    ...files.filter((file) => file.action === "keep").map((file) => `keep local ${file.file}`),
    ...(profile.apply ? [`permission profile ${profile.apply}${profile.raises ? " (raises authority)" : ""}`] : []),
    ...grants.map((skill) => `grant ${skill.grant}`),
    `record ${definition.ref} v${definition.version}`,
  ];
  return {
    definition,
    state,
    cwd,
    plan: {
      agent: agent.id,
      ref: definition.ref,
      installedVersion: origin.version,
      version: definition.version,
      upToDate,
      files: files.map(({ diff, ...rest }) => (resolution ? { ...rest, ...(diff ? { diff } : {}) } : rest)),
      editedLocally: files.some((file) => file.editedLocally),
      resolution,
      profile,
      skills,
      requiresExecute,
      effect,
    },
  };
}

export interface LibraryAgentUpdateResult {
  agent: string;
  ref: string;
  version: number;
  previousVersion: number;
  written: string[];
  kept: string[];
  profile: string | null;
  granted: string[];
}

export function executeLibraryAgentUpdate(prepared: PreparedLibraryAgentUpdate): LibraryAgentUpdateResult {
  const { plan, definition, state, cwd } = prepared;
  const origin = state.origin!;
  const written: string[] = [];
  const kept: string[] = [];
  const contentOf = (file: string) =>
    file === AGENT_INSTRUCTIONS_FILE ? definition.instructions : definition.heartbeat;
  for (const file of plan.files) {
    if (file.action === "write") {
      const content = contentOf(file.file);
      if (content !== null) {
        writeFileSync(join(cwd, file.file), content);
        written.push(file.file);
      }
    } else if (file.action === "remove") {
      rmSync(join(cwd, file.file), { force: true });
      written.push(file.file);
    } else if (file.action === "keep") {
      kept.push(file.file);
    }
  }
  if (plan.profile.apply) applyProfile(plan.agent, plan.profile.apply);
  const granted = applyGrants(plan.agent, plan.skills, `${definition.ref}@${definition.version}`);
  // A kept file keeps the hash it was installed with, so the next update still sees the local edit.
  const keptFile = (file: string) => kept.includes(file);
  dbSetLibraryAgentOrigin(plan.agent, {
    ref: definition.ref,
    version: definition.version,
    contentHash: definition.contentHash || null,
    agentsMdSha256: keptFile(AGENT_INSTRUCTIONS_FILE) ? origin.agentsMdSha256 : sha256(definition.instructions),
    heartbeatMdSha256: keptFile(AGENT_HEARTBEAT_FILE)
      ? origin.heartbeatMdSha256
      : definition.heartbeat !== null
        ? sha256(definition.heartbeat)
        : null,
    profile: definition.agent.profile,
    skills: definition.agent.skills,
    installedAt: origin.installedAt,
  });
  return {
    agent: plan.agent,
    ref: definition.ref,
    version: definition.version,
    previousVersion: plan.installedVersion,
    written,
    kept,
    profile: plan.profile.apply,
    granted,
  };
}

// ---------------------------------------------------------------------------
// Publish

export interface LibraryAgentPublishPlan {
  agent: string;
  ref: string;
  scope: "org" | "project";
  project: string | null;
  slug: string;
  name: string | null;
  description: string;
  note: string | null;
  manifest: LibraryAgentManifest;
  files: Array<{ file: string; bytes: number }>;
  contentHash: string;
  /** Skills of the agent left out of `agent.json` (not Library refs, or outside the scope). */
  leftOut: Array<{ skill: string; reason: string }>;
  propose: boolean;
  currentVersion: number;
  nextVersion: number;
  unchanged: boolean;
}

export interface PreparedLibraryAgentPublish {
  plan: LibraryAgentPublishPlan;
  files: Array<{ path: string; content: string }>;
  session: LibrarySession;
  target: LibraryRef;
}

export async function prepareLibraryAgentPublish(
  input: {
    agentId: string;
    scope: string;
    slug?: string;
    description?: string;
    note?: string;
    propose?: boolean;
  },
  deps: LibraryAgentServiceDeps = {},
): Promise<PreparedLibraryAgentPublish> {
  const agent = getAgent(input.agentId);
  if (!agent) {
    throw new LibraryCommandError("AGENT_NOT_FOUND", `Agent not found: ${input.agentId}`, 1, {
      suggestedAction: "Check the agent id with: ravi agents list --json",
    });
  }
  const scope = parsePublishScope(input.scope);
  const slug = (input.slug?.trim() || agent.id).toLowerCase();
  if (!isLibrarySlug(slug)) {
    throw new LibraryCommandError(
      "LIBRARY_REF_INVALID",
      `'${slug.slice(0, 80)}' is not a valid Library slug (a-z, 0-9 and -, at most 64 characters).`,
      2,
      { suggestedAction: "Pass a slug with --slug <slug>" },
    );
  }
  const note = checkLibraryNote(input.note);
  const state = dbGetLibraryAgentState(agent.id);
  const description = (input.description?.trim() || state?.description?.trim() || "").slice(
    0,
    LIBRARY_LIMITS.maxDescriptionLength,
  );
  if (!description) {
    throw new LibraryCommandError("USAGE_ERROR", "A Library agent needs a description.", 2, {
      suggestedAction: `Pass --description "<what the agent does>" (or set one: ravi agents set ${agent.id} description "<text>")`,
    });
  }

  const cwd = expandCwd(agent.cwd, deps);
  const instructions = readOptional(join(cwd, AGENT_INSTRUCTIONS_FILE));
  if (instructions === null || !instructions.trim()) {
    throw new LibraryCommandError(
      "LIBRARY_PACKAGE_INVALID",
      `${join(cwd, AGENT_INSTRUCTIONS_FILE)} is missing or empty.`,
      2,
      {
        suggestedAction: "Write the agent's instructions in AGENTS.md first",
      },
    );
  }
  const heartbeat = readOptional(join(cwd, AGENT_HEARTBEAT_FILE));

  // agent.json: the local provider, model and profile as suggestions, and the
  // Library skills the agent is granted that the scope's agents can see. No
  // local skill names, routes, instances, contacts, paths or credentials.
  const leftOut: LibraryAgentPublishPlan["leftOut"] = [];
  const skills: string[] = [];
  for (const grant of dbListSkillGrantsForAgent(agent.id)) {
    const ref = parseLibraryRef(grant.skillName);
    if (!ref) {
      leftOut.push({ skill: grant.skillName, reason: "not a Library skill" });
      continue;
    }
    const visible = ref.scope === "org" || (scope.scope === "project" && ref.project === scope.project);
    if (!visible) {
      leftOut.push({
        skill: ref.ref,
        reason: `outside ${scope.scope === "org" ? "the organization's" : `project ${scope.project}'s`} view`,
      });
      continue;
    }
    if (!skills.includes(ref.ref)) skills.push(ref.ref);
  }
  const profile = currentProfileOf(agent);
  const manifest: LibraryAgentManifest = {
    provider: agent.provider?.trim() || null,
    model: agent.model?.trim() || null,
    profile: profile && profile !== BOOTSTRAP_PROFILE ? profile : null,
    skills: skills.slice(0, 50),
  };
  const manifestJson = `${JSON.stringify(
    Object.fromEntries(
      Object.entries({
        provider: manifest.provider,
        model: manifest.model,
        profile: manifest.profile,
        skills: manifest.skills.length > 0 ? manifest.skills : undefined,
      }).filter(([, value]) => value !== null && value !== undefined),
    ),
    null,
    2,
  )}\n`;
  const files = [
    { path: AGENT_INSTRUCTIONS_FILE, content: instructions },
    ...(heartbeat !== null ? [{ path: AGENT_HEARTBEAT_FILE, content: heartbeat }] : []),
    { path: AGENT_MANIFEST_FILE, content: manifestJson },
  ];
  for (const file of files) {
    if (Buffer.byteLength(file.content, "utf8") > LIBRARY_LIMITS.maxFileBytes) {
      throw new LibraryCommandError(
        "LIBRARY_PACKAGE_INVALID",
        `${file.path} is larger than ${LIBRARY_LIMITS.maxFileBytes / 1024} KiB.`,
        2,
        { suggestedAction: "Shorten it before publishing" },
      );
    }
  }
  const hashed = files.map((file) => ({ path: file.path, sha256: sha256(file.content) }));
  const contentHash = libraryContentHash(hashed);
  const target = libraryRef(scope.scope, scope.project, slug);

  const session = await openSession({ resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  let current: LibraryShowResponse | null = null;
  try {
    current = await session.client.forAgents().showRef(target);
  } catch (error) {
    if (!isLibraryNotFoundError(error)) throw error;
  }
  const currentVersion = current?.version.number ?? 0;
  const unchanged = current !== null && current.version.contentHash === contentHash;
  return {
    session,
    target,
    files,
    plan: {
      agent: agent.id,
      ref: target.ref,
      scope: target.scope,
      project: target.project,
      slug,
      name: agent.name?.trim() || null,
      description,
      note: note ?? null,
      manifest,
      files: files.map((file) => ({ file: file.path, bytes: Buffer.byteLength(file.content, "utf8") })),
      contentHash,
      leftOut,
      propose: input.propose === true,
      currentVersion,
      nextVersion: unchanged ? currentVersion : currentVersion + 1,
      unchanged,
    },
  };
}

export type LibraryAgentPublishResult =
  | (LibraryPublishResponse & { ref: string; proposal: null })
  | { ref: string; proposal: LibraryProposal; unchanged: false };

export async function executeLibraryAgentPublish(
  prepared: PreparedLibraryAgentPublish,
): Promise<LibraryAgentPublishResult> {
  const { plan, files, session } = prepared;
  const client = session.client.forAgents();
  const content = {
    ...(plan.name ? { name: plan.name.slice(0, LIBRARY_LIMITS.maxNameLength) } : {}),
    description: plan.description,
    externalAllowed: false,
    ...(plan.note ? { note: plan.note } : {}),
    baseVersion: plan.currentVersion,
    files,
  };
  const where = { scope: plan.scope, ...(plan.project ? { project: plan.project } : {}), slug: plan.slug };
  if (plan.propose) {
    const proposal = await client.createProposal({ ...where, ...content, submit: true });
    return { ref: plan.ref, proposal, unchanged: false };
  }
  const result = await client.publish({ ...where, ...content });
  return { ...result, ref: itemRef(result.item), proposal: null };
}

// ---------------------------------------------------------------------------

/** A small line diff (longest common subsequence), `-` local and `+` Library lines. */
export function lineDiff(before: string, after: string, beforeLabel: string, afterLabel: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const header = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  if (a.length * b.length > 4_000_000) {
    return [...header, `(${a.length} lines here, ${b.length} lines in the Library: too long to compare)`].join("\n");
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      lines.push(`+ ${b[j]}`);
      j++;
    } else {
      lines.push(`- ${a[i]}`);
      i++;
    }
  }
  return [...header, ...lines].join("\n");
}
