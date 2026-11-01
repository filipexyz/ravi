/**
 * Library pins on the local runtime (spec skills/library).
 *
 * The Console decides who may pin what to which agent; this side reports the
 * installation's agents, reads the pins, keeps a copy of each pinned version
 * in the Library cache, stores the pins in `ravi.db`, and generates the
 * `ravi-library` plugin the runtimes load. A failed sync never removes pins.
 */

import { LIBRARY_AGENT_DESCRIPTION_MAX, readLibraryAgentState } from "./agents-db.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { isCloudAuthError } from "../cloud-auth/errors.js";
import type { listCloudProjects } from "../cloud-projects/client.js";
import { resolveConsoleScope, type ConsoleScopeResolverDeps } from "../console-scope/resolver.js";
import { publish } from "../nats.js";
import { getAllAgents } from "../router/index.js";
import type { AgentConfig } from "../router/types.js";
import { logger } from "../utils/logger.js";
import { libraryVersionDir, writeLibrarySkill, type LibraryCacheOptions } from "./cache.js";
import {
  isLibraryNotFoundError,
  isLibraryOfflineError,
  libraryLoginRequiredError,
  LIBRARY_PIN_SYNC_MAX_AGENTS,
  openLibrarySession,
  type LibrarySession,
  type LibrarySessionDeps,
  type LibrarySessionOptions,
} from "./client.js";
import {
  dbGetLibraryPinState,
  dbListLibraryPins,
  dbRecordLibraryPinError,
  dbReplaceLibraryPins,
  dbTouchLibraryPinState,
  type LibraryPinRow,
  type LibraryPinState,
} from "./pins-db.js";
import {
  assignLibrarySkillNames,
  baseLibrarySkillName,
  pruneLibraryPluginGenerations,
  writeLibraryPluginGeneration,
  type LibraryPluginOptions,
} from "./plugin.js";
import { libraryRef, type LibraryRef } from "./refs.js";
import { LibraryCommandError } from "./service.js";
import { isOperatorOwnTurn, type LibraryTurnDeps } from "./turn.js";
import type {
  LibraryInstallationPinsResponse,
  LibraryItem,
  LibraryItemPin,
  LibraryItemPinsResponse,
  LibraryPinAgentReport,
} from "./types.js";

const log = logger.child("library:pins");

/** CLI scope `POST /pins/sync` needs (it writes the installation's agent report). */
export const LIBRARY_PIN_SYNC_SCOPE = "console.projects.link";

export const LIBRARY_AGENT_NOT_LISTED = "LIBRARY_AGENT_NOT_LISTED";

export interface LibraryPinDeps {
  cache?: LibraryCacheOptions;
  plugins?: LibraryPluginOptions;
  /** The agents this installation reports (default: the listed local agents). */
  collectAgents?: () => Promise<LibraryPinAgentReport[]>;
  /** Notify the daemon that configuration changed (default: `ravi.config.changed`). */
  emitConfigChanged?: () => void;
  now?: () => number;
}

let configChangedEmitterForTests: (() => void) | null = null;

/** Tests: replace the `ravi.config.changed` emitter (null restores it). */
export function setLibraryConfigChangedEmitterForTests(emitter: (() => void) | null): void {
  configChangedEmitterForTests = emitter;
}

function emitConfigChanged(deps: LibraryPinDeps): void {
  const emit =
    deps.emitConfigChanged ??
    configChangedEmitterForTests ??
    (() => {
      publish("ravi.config.changed", { reason: "library_pins" }, { quietConnect: true }).catch(() => {});
    });
  try {
    emit();
  } catch {
    // Best effort: new sessions read the pins from the database anyway.
  }
}

export function refForLibraryItem(item: Pick<LibraryItem, "scope" | "project" | "slug">): LibraryRef {
  return item.scope === "org"
    ? libraryRef("org", null, item.slug)
    : libraryRef("project", item.project?.slug ?? "", item.slug);
}

// ---------------------------------------------------------------------------
// Agent report
// ---------------------------------------------------------------------------

export interface CollectAgentReportsDeps extends Pick<ConsoleScopeResolverDeps, "readCredentials" | "client"> {
  agents?: () => AgentConfig[];
  listProjects?: typeof listCloudProjects;
  env?: NodeJS.ProcessEnv;
}

/** Env keys that carry one session's Console scope: never an agent's own. */
const SESSION_SCOPE_ENV = ["RAVI_CONSOLE_PROJECT_REF", "RAVI_CONSOLE_PROJECT_ID", "RAVI_CONTEXT_KEY"];

/**
 * The local agents the operator listed (`ravi agents listing <id> on`) as the
 * sync reports them: id, name, provider, model, and the Console project its
 * cloud scope resolves to (agent default, its workspace, the install default,
 * or the single visible project), else null. An unlisted agent is never
 * reported, so the Console drops it from the directory.
 */
export async function collectLocalAgentReports(deps: CollectAgentReportsDeps = {}): Promise<LibraryPinAgentReport[]> {
  const agents = (deps.agents ?? getAllAgents)()
    .filter((agent) => readLibraryAgentState(agent.id)?.listed === true)
    .slice(0, LIBRARY_PIN_SYNC_MAX_AGENTS);
  const env = { ...(deps.env ?? process.env) };
  for (const key of SESSION_SCOPE_ENV) delete env[key];
  // One project listing per report, shared by every agent's resolution.
  let projects: ReturnType<typeof listCloudProjects> | null = null;
  const listProjects: typeof listCloudProjects = (options, projectDeps) => {
    projects ??= (deps.listProjects ?? defaultListProjects)(options, projectDeps);
    return projects;
  };
  const reports: LibraryPinAgentReport[] = [];
  for (const agent of agents) {
    let project: string | null = null;
    try {
      const scope = await resolveConsoleScope(
        {},
        {
          env,
          cwd: agent.cwd,
          getContext: () => ({ agentId: agent.id }),
          listProjects,
          ...(deps.readCredentials ? { readCredentials: deps.readCredentials } : {}),
          ...(deps.client ? { client: deps.client } : {}),
        },
      );
      project = scope.project?.ref?.trim() || null;
    } catch {
      project = null;
    }
    // The directory text and whether the operator opened the agent to requests
    // from other installations (default closed).
    const library = readLibraryAgentState(agent.id);
    reports.push({
      id: agent.id,
      name: agent.name?.trim() || null,
      provider: agent.provider ?? null,
      model: agent.model?.trim() || null,
      project,
      description: library?.description?.trim().slice(0, LIBRARY_AGENT_DESCRIPTION_MAX) || null,
      acceptsRequests: library?.acceptsRequests === true,
    });
  }
  return reports;
}

const defaultListProjects: typeof listCloudProjects = async (options, projectDeps) => {
  const { listCloudProjects: list } = await import("../cloud-projects/client.js");
  return list(options, projectDeps);
};

// ---------------------------------------------------------------------------
// Sync and apply
// ---------------------------------------------------------------------------

export interface LibraryPinSyncOutcome {
  installation: { id: string; name: string | null };
  revision: string;
  /** The pins applied (or kept unchanged) on this installation. */
  pins: LibraryPinRow[];
  /** Pins of the Console answer whose files could not be read (not loaded). */
  unavailable: Array<{ agentId: string; ref: string; code: string }>;
  /** Whether the local pins or plugin changed. */
  changed: boolean;
  /** Agents reported (`POST /pins/sync`), or null for a read (`GET /pins`). */
  reported: number | null;
}

/**
 * Read the installation's pins and apply them. With `report` (and the write
 * scope) it posts the local agents first (`POST /pins/sync`); otherwise it
 * only reads (`GET /pins`). Throws on Console errors; the pins stay as they were.
 */
export async function syncLibraryPins(
  session: LibrarySession,
  options: { report: boolean },
  deps: LibraryPinDeps = {},
): Promise<LibraryPinSyncOutcome> {
  const canReport = options.report && session.scopes.includes(LIBRARY_PIN_SYNC_SCOPE);
  let response: LibraryInstallationPinsResponse;
  let reported: number | null = null;
  try {
    if (canReport) {
      const agents = await (deps.collectAgents ?? (() => collectLocalAgentReports()))();
      response = await session.client.syncPins(agents);
      reported = agents.length;
    } else {
      response = await session.client.listInstallationPins();
    }
  } catch (error) {
    recordError(error, deps);
    throw error;
  }
  const applied = await applyLibraryPins(session, response, deps);
  return { ...applied, reported };
}

/**
 * Store a Console answer locally: cache each pinned version, generate the
 * plugin, replace the pins, then tell the daemon. Unchanged pins (same
 * agents, ids, versions, content and `externalAllowed`) only touch the state.
 */
export async function applyLibraryPins(
  session: Pick<LibrarySession, "client" | "orgId" | "consoleUrl">,
  response: LibraryInstallationPinsResponse,
  deps: LibraryPinDeps = {},
): Promise<Omit<LibraryPinSyncOutcome, "reported">> {
  const now = deps.now?.() ?? Date.now();
  const entries = response.pins.map((pin) => {
    const ref = refForLibraryItem(pin.item);
    return { agentId: pin.agentId, item: pin.item, ref };
  });
  const fingerprint = pinsFingerprint(session.orgId, entries);
  const state = safeState();
  if (
    state &&
    state.fingerprint === fingerprint &&
    state.installationId === response.installation.id &&
    (entries.length === 0 || (state.pluginDir !== null && existsSync(state.pluginDir)))
  ) {
    dbTouchLibraryPinState({ installationName: response.installation.name, now });
    return {
      installation: response.installation,
      revision: response.revision,
      pins: dbListLibraryPins(),
      unavailable: [],
      changed: false,
    };
  }

  // Each pinned version once, from the cache or the Console. An item the
  // Console will not show this login is left out (and reported); a Console
  // that cannot be reached aborts the whole apply.
  const sources = new Map<string, string>();
  const unavailable: LibraryPinSyncOutcome["unavailable"] = [];
  for (const entry of entries) {
    if (sources.has(entry.ref.id)) continue;
    const cached = libraryVersionDir(session.orgId, entry.item, entry.item.version, deps.cache);
    if (existsSync(join(cached, "item.json"))) {
      sources.set(entry.ref.id, cached);
      continue;
    }
    try {
      const shown = await session.client.showRef(entry.ref, { version: entry.item.version });
      const dir = writeLibrarySkill(session.orgId, shown, deps.cache);
      if (!dir) throw new Error(`Could not cache ${entry.ref.ref}@${entry.item.version}.`);
      sources.set(entry.ref.id, dir);
    } catch (error) {
      if (isLibraryOfflineError(error) || !isCloudAuthError(error)) throw error;
      const code = error.code;
      if (code !== "ORG_ACCESS_DENIED" && !isLibraryNotFoundError(error)) throw error;
      log.warn("Pinned Library skill could not be read; it is not loaded", {
        ref: entry.ref.ref,
        version: entry.item.version,
        code,
      });
      sources.set(entry.ref.id, "");
    }
  }

  const loadable = entries.filter((entry) => sources.get(entry.ref.id));
  for (const entry of entries) {
    if (!sources.get(entry.ref.id)) {
      unavailable.push({ agentId: entry.agentId, ref: entry.ref.ref, code: "LIBRARY_PIN_UNAVAILABLE" });
    }
  }
  const names = assignLibrarySkillNames(
    loadable.map((entry) => ({ libraryId: entry.ref.id, baseName: baseLibrarySkillName(entry.item) })),
  );
  const rows = dedupeRows(
    loadable.map((entry) => ({
      agentId: entry.agentId,
      libraryId: entry.ref.id,
      ref: entry.ref.ref,
      skillName: names.get(entry.ref.id)!,
      version: entry.item.version,
      contentHash: entry.item.contentHash || null,
      externalAllowed: entry.item.externalAllowed === true,
      item: entry.item,
    })),
  );
  const storedFingerprint = unavailable.length > 0 ? `${fingerprint}:partial` : fingerprint;
  if (
    state &&
    state.fingerprint === storedFingerprint &&
    state.installationId === response.installation.id &&
    (rows.length === 0 || (state.pluginDir !== null && existsSync(state.pluginDir)))
  ) {
    // Same partial answer as last time: nothing new to load.
    dbTouchLibraryPinState({ installationName: response.installation.name, now });
    return {
      installation: response.installation,
      revision: response.revision,
      pins: dbListLibraryPins(),
      unavailable,
      changed: false,
    };
  }
  const pluginDir = writeLibraryPluginGeneration(
    fingerprint,
    rows.map((row) => ({
      agentId: row.agentId,
      skillName: row.skillName,
      externalAllowed: row.externalAllowed,
      sourceDir: sources.get(row.libraryId)!,
      ref: row.ref,
      version: row.version,
    })),
    deps.plugins,
  );
  dbReplaceLibraryPins({
    consoleUrl: session.consoleUrl,
    organizationId: session.orgId,
    installationId: response.installation.id,
    installationName: response.installation.name,
    revision: response.revision,
    // An apply that left pins out tries the missing ones again on the next sync.
    fingerprint: storedFingerprint,
    pluginDir,
    pins: rows,
    now,
  });
  pruneLibraryPluginGenerations(pluginDir, deps.plugins);
  log.info("Library pins applied", {
    installation: response.installation.id,
    revision: response.revision,
    pins: rows.length,
    unavailable: unavailable.length,
  });
  emitConfigChanged(deps);
  return {
    installation: response.installation,
    revision: response.revision,
    pins: dbListLibraryPins(),
    unavailable,
    changed: true,
  };
}

/** The local pins without one (agent, item): applied right away when the Console could not be read after an unpin. */
export async function removeLocalLibraryPin(
  session: Pick<LibrarySession, "client" | "orgId" | "consoleUrl">,
  input: { agentId: string; libraryId: string },
  deps: LibraryPinDeps = {},
): Promise<boolean> {
  const state = safeState();
  const pins = dbListLibraryPins();
  const remaining = pins.filter((pin) => !(pin.agentId === input.agentId && pin.libraryId === input.libraryId));
  if (remaining.length === pins.length || !state?.installationId) return false;
  await applyLibraryPins(
    session,
    {
      installation: { id: state.installationId, name: state.installationName },
      revision: `${state.revision ?? ""}~local`,
      pins: remaining.map((pin) => ({ agentId: pin.agentId, ref: pin.ref, item: pin.item })),
    },
    deps,
  );
  return true;
}

function dedupeRows(rows: Array<Omit<LibraryPinRow, "syncedAt">>): Array<Omit<LibraryPinRow, "syncedAt">> {
  const byKey = new Map<string, Omit<LibraryPinRow, "syncedAt">>();
  for (const row of rows) byKey.set(`${row.agentId}\0${row.libraryId}`, row);
  return [...byKey.values()];
}

function pinsFingerprint(
  orgId: string,
  entries: ReadonlyArray<{ agentId: string; item: LibraryItem; ref: LibraryRef }>,
): string {
  const lines = entries
    .map((entry) =>
      [
        entry.agentId,
        entry.ref.id,
        entry.item.version,
        entry.item.contentHash,
        entry.item.externalAllowed ? 1 : 0,
        entry.item.name,
        entry.item.description,
      ].join("\0"),
    )
    .sort();
  return createHash("sha256")
    .update(`library-pins-v1\0${orgId}\n${lines.join("\n")}`, "utf8")
    .digest("hex");
}

function safeState(): LibraryPinState | null {
  try {
    return dbGetLibraryPinState();
  } catch {
    return null;
  }
}

function recordError(error: unknown, deps: LibraryPinDeps): void {
  try {
    dbRecordLibraryPinError(isCloudAuthError(error) ? error.code : "UNKNOWN", deps.now?.() ?? Date.now());
  } catch {
    // Best effort.
  }
}

// ---------------------------------------------------------------------------
// Commands: pin, unpin, pins
// ---------------------------------------------------------------------------

export const LIBRARY_AGENT_CANNOT_PIN = "LIBRARY_AGENT_CANNOT_PIN";

export interface LibraryPinCommandDeps extends LibraryPinDeps {
  openSession?: (options: LibrarySessionOptions) => Promise<LibrarySession | null>;
  session?: LibrarySessionDeps;
  turn?: LibraryTurnDeps;
}

function openPinSession(deps: LibraryPinCommandDeps): Promise<LibrarySession | null> {
  const options: LibrarySessionOptions = { resolveProject: false };
  return deps.openSession ? deps.openSession(options) : openLibrarySession(options, deps.session);
}

export interface LibraryPinPlan {
  ref: string;
  /** `org:<slug>` or `project:<projectSlug>:<slug>`. */
  id: string;
  agent: string;
  /** This installation (the daemon the agent runs on). */
  installationId: string;
  item: {
    name: string;
    description: string;
    scope: "org" | "project";
    project: string | null;
    version: number;
    externalAllowed: boolean;
  };
  /** Pinned already, as of the last local sync. */
  alreadyPinned: boolean;
  /** What the pin does once executed. */
  effect: string[];
}

export interface PreparedLibraryPin {
  plan: LibraryPinPlan;
  session: LibrarySession;
  ref: LibraryRef;
}

/** Read the item and build the plan of `ravi skills pin` (no write). */
export async function prepareLibraryPin(
  input: { ref: LibraryRef; agentId: string },
  deps: LibraryPinCommandDeps = {},
): Promise<PreparedLibraryPin> {
  // The Console pins only agents this installation reports, and it reports
  // only the agents the operator listed.
  if (readLibraryAgentState(input.agentId)?.listed !== true) {
    throw new LibraryCommandError(
      LIBRARY_AGENT_NOT_LISTED,
      `Agent ${input.agentId} is not listed in the organization's directory, so the Console cannot pin to it.`,
      1,
      { suggestedAction: `List it first with: ravi agents listing ${input.agentId} on --execute` },
    );
  }
  const session = await openPinSession(deps);
  if (!session) throw libraryLoginRequiredError();
  let item: LibraryItem;
  try {
    item = (await session.client.showRef(input.ref)).item;
  } catch (error) {
    if (isLibraryNotFoundError(error)) {
      throw new LibraryCommandError("SKILL_NOT_FOUND", `Library skill not found: ${input.ref.ref}`, 1, {
        suggestedAction: "Search for it with: ravi skills search <words> --json",
      });
    }
    throw error;
  }
  const ref = refForLibraryItem(item);
  const alreadyPinned = safeListPins().some((pin) => pin.agentId === input.agentId && pin.libraryId === ref.id);
  const effect = [
    `Agent ${input.agentId} loads ${ref.ref} natively in every new session, at the latest published version (now ${item.version}).`,
    `The pin authorizes ${ref.ref} for agent ${input.agentId} on this installation; no grant is needed.`,
    item.externalAllowed
      ? "It also loads in conversations with people outside the organization (externalAllowed)."
      : "It loads only in the operator's own turns: the item is not marked externalAllowed.",
  ];
  return {
    session,
    ref,
    plan: {
      ref: ref.ref,
      id: ref.id,
      agent: input.agentId,
      installationId: session.installationId,
      item: {
        name: item.name,
        description: item.description,
        scope: item.scope,
        project: item.project?.slug ?? null,
        version: item.version,
        externalAllowed: item.externalAllowed,
      },
      alreadyPinned,
      effect,
    },
  };
}

export interface LibraryLocalPinView {
  agent: string;
  ref: string;
  id: string;
  skill: string;
  name: string;
  description: string;
  version: number;
  externalAllowed: boolean;
}

export interface LibraryPinResult {
  ref: string;
  agent: string;
  /** False when the agent already had the pin. */
  created: boolean;
  pin: LibraryItemPin;
  /** The local state after the refresh. */
  local: {
    pinned: boolean;
    refreshed: boolean;
    revision: string | null;
    /** Plugin skill name the runtimes know it by (`ravi-library:<skill>`). */
    skill: string | null;
  };
}

/** Report the agents, pin on this installation, then refresh the local pins. */
export async function executeLibraryPin(
  prepared: PreparedLibraryPin,
  deps: LibraryPinCommandDeps = {},
): Promise<LibraryPinResult> {
  const { session, ref, plan } = prepared;
  // The Console pins only agents this installation reported.
  const synced = await syncLibraryPins(session, { report: true }, deps);
  const already = synced.pins.some((pin) => pin.agentId === plan.agent && pin.libraryId === ref.id);
  let pin: LibraryItemPin;
  try {
    pin = await session.client.pin(ref, { agentId: plan.agent });
  } catch (error) {
    if (isLibraryNotFoundError(error)) {
      throw new LibraryCommandError(
        "NOT_FOUND",
        `The Console does not know agent '${plan.agent}' on this installation, or cannot see ${ref.ref}.`,
        1,
        {
          suggestedAction:
            "Check the agent id (ravi agents list), that it is listed (ravi agents listing <id>) and that this login reports agents (ravi login with the link scope), then run the same command again",
        },
      );
    }
    throw error;
  }
  const local = await refreshAfterChange(session, deps);
  const row = local.pins.find((entry) => entry.agentId === plan.agent && entry.libraryId === ref.id);
  return {
    ref: ref.ref,
    agent: plan.agent,
    created: !already,
    pin,
    local: {
      pinned: Boolean(row),
      refreshed: local.refreshed,
      revision: local.revision,
      skill: row?.skillName ?? null,
    },
  };
}

export interface LibraryUnpinResult {
  ref: string;
  agent: string;
  removed: boolean;
  local: { pinned: boolean; refreshed: boolean; revision: string | null };
}

/** Unpin on this installation (reduces authority: no brake), then refresh the local pins. */
export async function executeLibraryUnpin(
  input: { ref: LibraryRef; agentId: string },
  deps: LibraryPinCommandDeps = {},
): Promise<LibraryUnpinResult> {
  const session = await openPinSession(deps);
  if (!session) throw libraryLoginRequiredError();
  const { removed } = await session.client.unpin(input.ref, { agentId: input.agentId });
  let local = await refreshAfterChange(session, deps);
  if (!local.refreshed) {
    // The Console said it is gone: stop loading it here now, not at the next sync.
    await removeLocalLibraryPin(session, { agentId: input.agentId, libraryId: input.ref.id }, deps);
    local = { ...local, pins: safeListPins() };
  }
  return {
    ref: input.ref.ref,
    agent: input.agentId,
    removed,
    local: {
      pinned: local.pins.some((pin) => pin.agentId === input.agentId && pin.libraryId === input.ref.id),
      refreshed: local.refreshed,
      revision: local.revision,
    },
  };
}

async function refreshAfterChange(
  session: LibrarySession,
  deps: LibraryPinDeps,
): Promise<{ pins: LibraryPinRow[]; refreshed: boolean; revision: string | null }> {
  try {
    const outcome = await syncLibraryPins(session, { report: false }, deps);
    return { pins: outcome.pins, refreshed: true, revision: outcome.revision };
  } catch (error) {
    log.warn("Library pins not refreshed after a pin change", {
      code: isCloudAuthError(error) ? error.code : "UNKNOWN",
    });
    return { pins: safeListPins(), refreshed: false, revision: safeState()?.revision ?? null };
  }
}

export interface LibraryLocalPinsOutcome {
  installation: { id: string | null; name: string | null };
  revision: string | null;
  syncedAt: string | null;
  /** The Console could not be read: the list is the last one synced. */
  stale: boolean;
  hint?: string;
  error?: { code: string; message: string };
  agent: string | null;
  total: number;
  pins: LibraryLocalPinView[];
  unavailable: Array<{ agentId: string; ref: string; code: string }>;
}

/**
 * This installation's pins: refreshed from the Console when logged in
 * (`GET /pins`), else the last synced list with `stale: true`. Inside an
 * agent runtime, a turn that is not the operator's own leaves out items not
 * marked `externalAllowed`.
 */
export async function listLocalLibraryPins(
  input: { agentId?: string | null; inRuntime?: boolean },
  deps: LibraryPinCommandDeps = {},
): Promise<LibraryLocalPinsOutcome> {
  let stale = true;
  let hint: string | undefined;
  let error: LibraryLocalPinsOutcome["error"];
  let unavailable: LibraryLocalPinsOutcome["unavailable"] = [];
  const session = await openPinSession(deps);
  if (!session) {
    hint = "No Ravi Cloud login: these are the pins of the last sync. Run `ravi login` to refresh them.";
  } else {
    try {
      const outcome = await syncLibraryPins(session, { report: false }, deps);
      unavailable = outcome.unavailable;
      stale = false;
    } catch (caught) {
      if (!isCloudAuthError(caught)) throw caught;
      error = { code: caught.code, message: caught.message };
      hint = isLibraryOfflineError(caught)
        ? "The Console could not be reached: these are the pins of the last sync."
        : "The Console refused the pin list: these are the pins of the last sync.";
    }
  }
  const state = safeState();
  const agent = input.agentId?.trim() || null;
  let rows = safeListPins().filter((pin) => !agent || pin.agentId === agent);
  if (input.inRuntime && rows.some((pin) => !pin.externalAllowed) && !isOperatorOwnTurn(deps.turn)) {
    rows = rows.filter((pin) => pin.externalAllowed);
  }
  const pins = rows.map((pin) => ({
    agent: pin.agentId,
    ref: pin.ref,
    id: pin.libraryId,
    skill: pin.skillName,
    name: pin.item.name,
    description: pin.item.description,
    version: pin.version,
    externalAllowed: pin.externalAllowed,
  }));
  return {
    installation: { id: state?.installationId ?? null, name: state?.installationName ?? null },
    revision: state?.revision ?? null,
    syncedAt: state?.syncedAt ? new Date(state.syncedAt).toISOString() : null,
    stale,
    ...(hint ? { hint } : {}),
    ...(error ? { error } : {}),
    agent,
    total: pins.length,
    pins,
    unavailable: unavailable.filter((entry) => !agent || entry.agentId === agent),
  };
}

export interface LibraryItemPinsOutcome extends LibraryItemPinsResponse {
  ref: string;
  installationId: string;
}

/** Where an item is pinned (`GET /skills/<scope>/<slug>/pins`). */
export async function listLibraryItemPins(
  ref: LibraryRef,
  deps: LibraryPinCommandDeps = {},
): Promise<LibraryItemPinsOutcome> {
  const session = await openPinSession(deps);
  if (!session) throw libraryLoginRequiredError();
  try {
    const listed = await session.client.listItemPins(ref);
    return { ref: ref.ref, installationId: session.installationId, ...listed };
  } catch (error) {
    if (isLibraryNotFoundError(error)) {
      throw new LibraryCommandError("SKILL_NOT_FOUND", `Library skill not found: ${ref.ref}`, 1, {
        suggestedAction: "Search for it with: ravi skills search <words> --json",
      });
    }
    throw error;
  }
}

function safeListPins(): LibraryPinRow[] {
  try {
    return dbListLibraryPins();
  } catch {
    return [];
  }
}
