/**
 * Remote skills of MCP servers (spec mcp, Remote Skills): list manifests,
 * pin a skill to an agent, read it on demand.
 *
 * - `list` reads manifests only (`skills/list`), never a file, for the
 *   operator's own turn, and reconciles every agent's pins with the listing
 *   (as the daemon's refresh tick does for servers with pins).
 * - `pin` reads one manifest (`skills/get`) and binds the approval to the
 *   sha256 of its canonical form. It fetches no file: the skills extension
 *   says hosts must not fetch ahead of need (not on connect, listing or
 *   approval). A dynamic resource list is refused.
 * - `read` re-reads the manifest, refuses (and marks the pin stale) when it
 *   no longer matches the approved digest, then serves the file from the
 *   digest-keyed cache or fetches it through `SkillsClient.read`, which checks
 *   size, digest and, for `SKILL.md`, the frontmatter. A file that fails a
 *   check is never used, and its pin goes stale.
 *
 * Every server use goes through `McpGateway.withServer` (authorizeMcpUse,
 * surface `skill`). Skill text is remote content: it is printed for the model
 * and never logged, and it decides nothing here.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProtocolError } from "@modelcontextprotocol/client";
import { type Skill, SkillsClient, SkillVerificationError } from "@modelcontextprotocol/client/ext/skills";

import { dbListLibraryPins } from "../library/pins-db.js";
import { rebuildLibraryPluginGeneration } from "../library/pins.js";
import { isOperatorOwnTurn } from "../library/turn.js";
import type { ContextRecord } from "../router/router-db.js";
import { getRaviStateDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";
import type { McpDenialCode } from "./authorize.js";
import { mcpServerDeclaresSkills } from "./extensions.js";
import type { McpCallScope, McpGateway, McpServerUse } from "./gateway.js";
import { mcpTokenScopes } from "./oauth-provider.js";
import { getMcpAttachment, getMcpServer } from "./registry-db.js";
import { type McpServerSecret, readMcpServerSecret } from "./secrets.js";
import {
  assignMcpSkillPluginName,
  canonicalMcpSkillManifest,
  cleanMcpSkillText,
  MCP_SKILL_DESCRIPTION_MAX,
  MCP_SKILL_ENTRY_FILE,
  MCP_SKILL_NAME_MAX,
  mcpSkillDigestHex,
  mcpSkillFileUri,
  mcpSkillId,
  mcpSkillLibraryRef,
  mcpSkillManifestDigest,
  mcpSkillPathOfUri,
  mcpSkillUriFromArg,
  normalizeMcpSkillFileRef,
  parseMcpSkillId,
  type McpSkillEntryLike,
} from "./skill-ids.js";
import {
  deleteMcpSkillPin,
  deleteMcpSkillPinsForServer,
  getMcpSkillPin,
  listMcpSkillPins,
  markMcpSkillPinsStale,
  type McpSkillManifest,
  type McpSkillPinRecord,
  type McpSkillStaleReason,
  settleGoneMcpSkillPins,
  upsertMcpSkillPin,
} from "./skill-pins-db.js";
import { MCP_SKILL_READ_TEXT_CAP_BYTES, MCP_SKILLS_LIST_MAX, McpSkillsError } from "./skills-common.js";
import { recordMcpSkillTrace } from "./trace.js";

const log = logger.child("mcp:skills");

/** One skills request (list page walk, get, read). */
export const MCP_SKILL_REQUEST_TIMEOUT_MS = 30_000;
export { MCP_SKILL_READ_TEXT_CAP_BYTES, MCP_SKILLS_LIST_MAX, McpSkillsError } from "./skills-common.js";

export interface McpSkillsDeps {
  /** Whether the turn is the operator's own (default: the Library classification on the context record). */
  operatorOwnTurn?: (context: ContextRecord | null | undefined) => boolean;
  /** Rebuild the generated plugin after a pin change (default: `rebuildLibraryPluginGeneration`). */
  rebuildPlugin?: () => void;
  stateDir?: () => string;
  now?: () => number;
  /** Read a server's stored secret, for the skills scope of its login (default: the credentials store). */
  readSecret?: (server: string) => Promise<McpServerSecret | null>;
}

function defaultOwnTurn(context: ContextRecord | null | undefined): boolean {
  return isOperatorOwnTurn({ turn: { runtimeContext: { present: true, record: context ?? null } } });
}

function ownTurn(deps: McpSkillsDeps, context: ContextRecord | null | undefined): boolean {
  try {
    return (deps.operatorOwnTurn ?? defaultOwnTurn)(context) === true;
  } catch {
    // no-cause: a turn that cannot be classified is not the operator's own (fail closed).
    return false;
  }
}

/** Rebuild the plugin after pins changed. Never throws: the pins table is the authority, the gate reads it. */
function rebuildPlugin(deps: McpSkillsDeps): boolean {
  try {
    (deps.rebuildPlugin ?? (() => rebuildLibraryPluginGeneration()))();
    return true;
  } catch (error) {
    log.warn("Library plugin not rebuilt after a remote skill pin change", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

/** A gateway outcome that is not a value, as a command error. */
function serverFailure(use: Exclude<McpServerUse<unknown>, { ok: true }>, server: string): McpSkillsError {
  if (use.outcome === "denied") {
    const exit = denialExit(use.code);
    return new McpSkillsError(
      exit.code,
      use.reason,
      exit.exitCode,
      use.code === "needs_login" ? `Ask the operator to sign in: ravi mcp login ${server} --execute` : undefined,
    );
  }
  if (use.outcome === "needs_login") {
    return new McpSkillsError(
      "MCP_NEEDS_LOGIN",
      use.reason,
      1,
      `Ask the operator to sign in: ravi mcp login ${server} --execute`,
    );
  }
  if (use.outcome === "insufficient_scope") {
    // The login lacks the skills scope only: the server's row and its tool calls are left as they are.
    return new McpSkillsError(
      "MCP_SKILLS_SCOPE_MISSING",
      use.reason,
      1,
      `Ask the operator to sign in again with the skills scope: ravi mcp login ${server} --execute`,
    );
  }
  if (use.outcome === "rate_limited") return new McpSkillsError("MCP_SKILLS_RATE_LIMITED", use.reason, 1);
  if (use.outcome === "timeout") return new McpSkillsError("MCP_SKILLS_TIMEOUT", use.reason, 1);
  return new McpSkillsError("MCP_SKILLS_FAILED", use.reason, 1);
}

function denialExit(code: McpDenialCode): { code: string; exitCode: 1 | 2 | 3 } {
  switch (code) {
    case "not_registered":
      return { code: "MCP_SERVER_NOT_FOUND", exitCode: 1 };
    case "invalid_request":
      return { code: "MCP_INVALID_REQUEST", exitCode: 2 };
    case "needs_login":
      return { code: "MCP_NEEDS_LOGIN", exitCode: 1 };
    case "error":
      return { code: "MCP_AUTHORIZATION_FAILED", exitCode: 1 };
    default:
      return { code: `MCP_${code.toUpperCase()}`, exitCode: 3 };
  }
}

function unsupported(server: string): McpSkillsError {
  return new McpSkillsError("MCP_SKILLS_UNSUPPORTED", `MCP server ${server} does not declare the skills extension.`, 1);
}

function isNotFound(error: unknown): boolean {
  return ProtocolError.isInstance(error) && (error as ProtocolError).code === -32602;
}

function skillsClient(lease: { client: ConstructorParameters<typeof SkillsClient>[0] }): SkillsClient {
  return new SkillsClient(lease.client, { skipInvalid: true });
}

function totalBytes(manifest: McpSkillManifest): number {
  return manifest.resources.reduce((sum, resource) => sum + (Number.isFinite(resource.size) ? resource.size : 0), 0);
}

// ============================================================================
// the skills scope of the stored login
// ============================================================================

/** A scope name with a `skills` segment (the Console's `mcp.console.skills.read`). */
const SKILLS_SCOPE_PATTERN = /(^|[.:/_-])skills([.:/_-]|$)/;

export interface McpSkillsScopeStatus {
  /** The stored grant names its scopes and holds none of the skills scopes the server advertises. */
  missing: boolean;
  /** The advertised skills scope (when one is advertised). */
  scope: string | null;
}

/**
 * Whether the stored OAuth grant lacks the skills scope. Known only when the
 * server's authorization metadata (kept from discovery) advertises a scope
 * whose name has a `skills` segment and the token response named the scopes
 * it granted; anything else (bearer, no metadata, a grant that names no
 * scope) is not reported missing. A Console answers `skills/list` without
 * that scope with an empty list, the same answer as an organization whose
 * skills are off.
 */
export async function mcpSkillsScopeStatus(server: string, deps: McpSkillsDeps = {}): Promise<McpSkillsScopeStatus> {
  const none: McpSkillsScopeStatus = { missing: false, scope: null };
  let secret: McpServerSecret | null;
  try {
    secret = await (deps.readSecret ?? readMcpServerSecret)(server);
  } catch {
    // no-cause: an unreadable secret says nothing about the grant; the listing itself reports any failure.
    return none;
  }
  const oauth = secret?.oauth;
  const metadata = oauth?.discovery?.authorizationServerMetadata;
  const supported =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).scopes_supported
      : undefined;
  if (!Array.isArray(supported)) return none;
  const advertised = supported.filter(
    (scope): scope is string => typeof scope === "string" && scope.length <= 200 && SKILLS_SCOPE_PATTERN.test(scope),
  );
  if (!advertised.length) return { ...none };
  if (typeof oauth?.tokens?.scope !== "string") return { missing: false, scope: advertised[0]! };
  const granted = new Set(mcpTokenScopes(oauth));
  const missing = !advertised.some((scope) => granted.has(scope));
  return { missing, scope: advertised[0]! };
}

// ============================================================================
// reconciling pins with a listing
// ============================================================================

export interface McpSkillPinChange {
  agent: string;
  id: string;
  /** `stale`: the pin stopped loading; `restored`: a `gone` pin is active again on its approved digest. */
  change: "stale" | "restored";
  /** Why it went stale (null for `restored`). */
  reason: McpSkillStaleReason | null;
}

/**
 * Whether a listing reconciled the pins: `done`; `empty_listing` (an empty
 * listing is read as nothing: a server answers it for no skills, for skills
 * switched off, for a login without the skills scope and for an agent
 * bridge, and Ravi cannot tell those apart); `scope_missing` (the stored
 * grant lacks the skills scope, so the listing says nothing about the pins).
 */
export type McpSkillPinCheck = "done" | "empty_listing" | "scope_missing";

interface SkillListingLike {
  skills: Skill[];
  invalid: Array<{ uri?: string }>;
}

function notePinChange(
  server: string,
  change: McpSkillPinChange,
  trace: { context: ContextRecord | null | undefined; agentId: string; source: "list" | "refresh" | "read" },
): void {
  log.info(change.change === "restored" ? "Remote skill pin restored" : "Remote skill pin went stale", {
    agentId: change.agent,
    server,
    skill: change.id,
    reason: change.reason ?? "listed_on_approved_digest",
    source: trace.source,
  });
  recordMcpSkillTrace({
    context: trace.context,
    agentId: trace.agentId || change.agent,
    server,
    op: "pin_state",
    skill: change.id,
    outcome: change.change,
    reason: change.reason ?? "listed_on_approved_digest",
    pinAgent: change.agent,
  });
}

/**
 * Reconcile every agent's pins of one server with a complete listing (spec
 * mcp, Remote Skills):
 *
 * - an active pin whose skill is listed on another manifest goes stale
 *   (`manifest_changed`, or `dynamic`);
 * - an active pin whose skill is not listed goes stale (`gone`), unless the
 *   listing is empty (`empty_listing`, nothing changes);
 * - a pin stale only because it was `gone` becomes active again when the
 *   skill is listed with exactly the approved digest; listed on another
 *   manifest it becomes `manifest_changed` (only a new pin clears that);
 * - an entry the client refused as invalid changes nothing.
 *
 * Each change is logged and traced (`mcp.skill`, `op: "pin_state"`) with its
 * reason. Rebuilds the plugin when anything changed.
 */
export function reconcileMcpSkillPins(
  server: string,
  listing: SkillListingLike,
  trace: { context: ContextRecord | null | undefined; agentId: string; source: "list" | "refresh" },
  deps: McpSkillsDeps = {},
): { check: McpSkillPinCheck; changes: McpSkillPinChange[] } {
  if (listing.skills.length === 0 && listing.invalid.length === 0) return { check: "empty_listing", changes: [] };
  const now = deps.now?.() ?? Date.now();
  const listed = new Map<string, string | null>();
  for (const entry of listing.skills) {
    const manifest = canonicalMcpSkillManifest(entry as McpSkillEntryLike);
    listed.set(entry.uri, manifest ? mcpSkillManifestDigest(manifest) : null);
  }
  const invalid = new Set(listing.invalid.map((entry) => entry.uri).filter((uri): uri is string => Boolean(uri)));
  const changes: McpSkillPinChange[] = [];
  const pins = listMcpSkillPins({ server });
  for (const uri of new Set(pins.map((pin) => pin.skillUri))) {
    if (invalid.has(uri)) continue;
    if (listed.has(uri)) {
      const digest = listed.get(uri) ?? null;
      for (const pin of markMcpSkillPinsStale({
        server,
        skillUri: uri,
        reason: digest === null ? "dynamic" : "manifest_changed",
        ...(digest !== null ? { unlessDigest: digest } : {}),
        now,
      })) {
        changes.push({ agent: pin.agentId, id: pin.skillId, change: "stale", reason: pin.staleReason });
      }
      for (const settled of settleGoneMcpSkillPins({ server, skillUri: uri, listedDigest: digest, now })) {
        changes.push({
          agent: settled.pin.agentId,
          id: settled.pin.skillId,
          change: settled.change === "restored" ? "restored" : "stale",
          reason: settled.change === "restored" ? null : settled.change,
        });
      }
      continue;
    }
    for (const pin of markMcpSkillPinsStale({ server, skillUri: uri, reason: "gone", now })) {
      changes.push({ agent: pin.agentId, id: pin.skillId, change: "stale", reason: "gone" });
    }
  }
  for (const change of changes) notePinChange(server, change, trace);
  if (changes.length) rebuildPlugin(deps);
  return { check: "done", changes };
}

// ============================================================================
// list
// ============================================================================

export interface McpSkillPinView {
  agent: string;
  skill: string;
  state: McpSkillPinRecord["state"];
  staleReason: McpSkillStaleReason | null;
  externalAllowed: boolean;
}

export interface McpSkillListItem {
  uri: string;
  /** `mcp:<server>:<path>`; null for a URI Ravi does not pin (not `skill://<path>/SKILL.md`). */
  id: string | null;
  name: string;
  description: string;
  dynamic: boolean;
  files: number | null;
  bytes: number | null;
  manifestDigest: string | null;
  libraryRef: string | null;
  pins: McpSkillPinView[];
}

/** A pin of this server whose skill the listing does not show. */
export interface McpSkillUnlistedPin extends McpSkillPinView {
  id: string;
}

export interface McpSkillListResult {
  server: string;
  agentId: string;
  supported: boolean;
  /** Skills the server listed (every page walked). */
  total: number;
  /** This page of them (`offset`, `limit`). */
  skills: McpSkillListItem[];
  /** Entries the server sent that do not validate (left out). */
  invalid: number;
  /** Pins this listing marked stale (another manifest, dynamic, or no longer listed). */
  stalePins: Array<{ agent: string; id: string; reason: McpSkillStaleReason }>;
  /** Pins stale only as `gone` that this listing found again on their approved digest: active again. */
  restoredPins: Array<{ agent: string; id: string }>;
  /** Pins of this server whose skill the listing does not show (every page; any state). */
  unlistedPins: McpSkillUnlistedPin[];
  /** Whether the pins were reconciled with this listing. */
  pinCheck: McpSkillPinCheck;
  /** The stored login lacks the skills scope the server advertises: its listing is empty whatever it holds. */
  scopeMissing: boolean;
  /** What to do about it (null when nothing is missing). */
  suggestedAction: string | null;
}

function pinView(pin: McpSkillPinRecord): McpSkillPinView {
  return {
    agent: pin.agentId,
    skill: pin.skillName,
    state: pin.state,
    staleReason: pin.staleReason,
    externalAllowed: pin.externalAllowed,
  };
}

/**
 * The skills of one server, from manifests only, for the operator's own turn
 * (`OPERATOR_TURN_REQUIRED`, exit 3, for any other turn, before anything is
 * sent: the listing is the organization's catalog). The walk covers every
 * page; `page` cuts what is returned. The pins of every agent are reconciled
 * with the listing (`reconcileMcpSkillPins`) unless the stored grant lacks
 * the skills scope.
 */
export async function listMcpServerSkills(
  gateway: Pick<McpGateway, "withServer">,
  scope: McpCallScope,
  server: string,
  deps: McpSkillsDeps = {},
  page: { limit?: number; offset?: number } = {},
): Promise<McpSkillListResult> {
  if (!ownTurn(deps, scope.context)) {
    throw new McpSkillsError(
      "OPERATOR_TURN_REQUIRED",
      "Only the operator lists the skills of an MCP server (the organization's catalog), from their terminal or their own direct chat.",
      3,
      "Do not retry from this turn",
    );
  }
  const scopeStatus = await mcpSkillsScopeStatus(server, deps);
  const use = await gateway.withServer(
    scope,
    server,
    async (lease) => {
      const client = skillsClient(lease);
      if (!client.supported) return null;
      return client.list(undefined, { timeout: MCP_SKILL_REQUEST_TIMEOUT_MS });
    },
    "skills/list",
  );
  if (!use.ok) throw serverFailure(use, server);
  const listing = use.value;
  const scopeAdvice = scopeStatus.missing
    ? `The stored login of ${server} lacks ${scopeStatus.scope ?? "the skills scope"}, so the server lists no skills to it. Sign in again and allow it: ravi mcp login ${server} --execute`
    : null;
  const allPins = listMcpSkillPins({ server });
  const unlisted = (uris: ReadonlySet<string>): McpSkillUnlistedPin[] =>
    allPins.filter((pin) => !uris.has(pin.skillUri)).map((pin) => ({ id: pin.skillId, ...pinView(pin) }));
  if (!listing) {
    return {
      server,
      agentId: scope.agentId,
      supported: false,
      total: 0,
      skills: [],
      invalid: 0,
      stalePins: [],
      restoredPins: [],
      unlistedPins: unlisted(new Set()),
      pinCheck: "done",
      scopeMissing: false,
      suggestedAction: null,
    };
  }
  const reconciled: { check: McpSkillPinCheck; changes: McpSkillPinChange[] } = scopeStatus.missing
    ? { check: "scope_missing", changes: [] }
    : reconcileMcpSkillPins(server, listing, { context: scope.context, agentId: scope.agentId, source: "list" }, deps);
  const pins = listMcpSkillPins({ server });
  const offset = Math.max(0, Math.trunc(page.offset ?? 0));
  const limit = Math.min(MCP_SKILLS_LIST_MAX, Math.max(1, Math.trunc(page.limit ?? MCP_SKILLS_LIST_MAX)));
  const skills = listing.skills.slice(offset, offset + limit).map((entry): McpSkillListItem => {
    const manifest = canonicalMcpSkillManifest(entry as McpSkillEntryLike);
    const path = mcpSkillPathOfUri(entry.uri);
    return {
      uri: entry.uri,
      id: path ? mcpSkillId(server, path) : null,
      name: cleanMcpSkillText(entry.frontmatter.name, MCP_SKILL_NAME_MAX),
      description: cleanMcpSkillText(entry.frontmatter.description, MCP_SKILL_DESCRIPTION_MAX),
      dynamic: manifest === null,
      files: manifest ? manifest.resources.length : null,
      bytes: manifest ? totalBytes(manifest) : null,
      manifestDigest: manifest ? mcpSkillManifestDigest(manifest) : null,
      libraryRef: mcpSkillLibraryRef(entry as McpSkillEntryLike),
      pins: pins.filter((pin) => pin.skillUri === entry.uri).map(pinView),
    };
  });
  const listedUris = new Set(listing.skills.map((entry) => entry.uri));
  return {
    server,
    agentId: scope.agentId,
    supported: true,
    total: listing.skills.length,
    skills,
    invalid: listing.invalid.length,
    stalePins: reconciled.changes
      .filter((change) => change.change === "stale" && change.reason !== null)
      .map((change) => ({ agent: change.agent, id: change.id, reason: change.reason! })),
    restoredPins: reconciled.changes
      .filter((change) => change.change === "restored")
      .map((change) => ({ agent: change.agent, id: change.id })),
    unlistedPins: pins
      .filter((pin) => !listedUris.has(pin.skillUri))
      .map((pin) => ({ id: pin.skillId, ...pinView(pin) })),
    pinCheck: reconciled.check,
    scopeMissing: scopeStatus.missing,
    suggestedAction: scopeAdvice,
  };
}

// ============================================================================
// the refresh tick
// ============================================================================

/**
 * The refresh tick's reconciliation: for each enabled server that declares
 * the skills extension and has a pin that is active or stale only as `gone`,
 * one `skills/list` walk (`withServerUnattended`, which honours the server's
 * back-off), then `reconcileMcpSkillPins`. A server whose stored grant lacks
 * the skills scope, or that needs a login, is not walked. `signal` (the
 * gateway's own, aborted when it stops) ends the walk: no server after it is
 * walked, and a listing in flight is aborted. Never throws.
 */
export async function refreshMcpSkillPins(
  gateway: Pick<McpGateway, "withServerUnattended">,
  deps: McpSkillsDeps = {},
  signal?: AbortSignal,
): Promise<{ walked: string[]; changes: McpSkillPinChange[] }> {
  const walked: string[] = [];
  const changes: McpSkillPinChange[] = [];
  let names: string[];
  try {
    names = [
      ...new Set(
        listMcpSkillPins()
          .filter((pin) => pin.state === "active" || pin.staleReason === "gone")
          .map((pin) => pin.server),
      ),
    ];
  } catch {
    // no-cause: an unreadable pin table is retried on the next tick.
    log.warn("Remote skill pins could not be read for the refresh");
    return { walked, changes };
  }
  for (const name of names) {
    if (signal?.aborted) break;
    try {
      const server = getMcpServer(name);
      if (!server?.enabled || server.status === "needs_login" || !mcpServerDeclaresSkills(server)) continue;
      const scope = await mcpSkillsScopeStatus(name, deps);
      if (scope.missing) {
        log.info("Remote skill pins not checked: the stored login lacks the skills scope", { server: name });
        continue;
      }
      walked.push(name);
      const use = await gateway.withServerUnattended(
        name,
        async (lease) => {
          const client = skillsClient(lease);
          if (!client.supported) return null;
          return client.list(undefined, { timeout: MCP_SKILL_REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) });
        },
        "skills/list",
      );
      if (signal?.aborted) break;
      if (!use.ok) {
        log.info("Remote skill pins not checked: the listing failed", { server: name, outcome: use.outcome });
        continue;
      }
      if (!use.value) continue;
      const result = reconcileMcpSkillPins(name, use.value, { context: null, agentId: "", source: "refresh" }, deps);
      changes.push(...result.changes);
    } catch {
      // no-cause: one server's failure leaves its pins as they are; reads still check every manifest.
      log.warn("Remote skill pins of a server could not be reconciled", { server: name });
    }
  }
  return { walked, changes };
}

// ============================================================================
// pin
// ============================================================================

export interface McpSkillPinPlan {
  server: string;
  agent: string;
  uri: string;
  id: string;
  /** Plugin skill name the runtimes will know the stub by. */
  skill: string;
  name: string;
  description: string;
  files: number;
  bytes: number;
  manifestDigest: string;
  libraryRef: string | null;
  externalAllowed: boolean;
  alreadyPinned: boolean;
  /** Always false: a pin reads the manifest only. */
  fetchesFiles: false;
  effect: string[];
  /** What will not work as pinned (an external pin on an operator-audience attachment). Nothing is refused. */
  warnings: string[];
}

export interface PreparedMcpSkillPin {
  plan: McpSkillPinPlan;
  manifest: McpSkillManifest;
}

/**
 * Read one manifest (`skills/get`) and build the plan of a pin. No file is
 * fetched. Refuses a dynamic skill, a URI Ravi does not pin, and a skill the
 * agent already gets from a Library pin (`_meta["bot.ravi/library"].ref`).
 */
export async function prepareMcpSkillPin(
  gateway: Pick<McpGateway, "withServer">,
  scope: McpCallScope,
  input: { server: string; skill: string; externalAllowed: boolean },
): Promise<PreparedMcpSkillPin> {
  let uri: string;
  try {
    uri = mcpSkillUriFromArg(input.server, input.skill);
  } catch (error) {
    throw new McpSkillsError("MCP_SKILL_ID_INVALID", (error as Error).message, 2);
  }
  const use = await gateway.withServer(
    scope,
    input.server,
    async (lease) => {
      const client = skillsClient(lease);
      if (!client.supported) return { kind: "unsupported" as const };
      try {
        const got = await client.get(uri, { timeout: MCP_SKILL_REQUEST_TIMEOUT_MS });
        return { kind: "entry" as const, skill: got.skill };
      } catch (error) {
        if (isNotFound(error)) return { kind: "not_found" as const };
        throw error;
      }
    },
    "skills/get",
  );
  if (!use.ok) throw serverFailure(use, input.server);
  if (use.value.kind === "unsupported") throw unsupported(input.server);
  if (use.value.kind === "not_found") {
    throw new McpSkillsError(
      "MCP_SKILL_NOT_FOUND",
      `MCP server ${input.server} has no skill ${JSON.stringify(uri.slice(0, 200))}.`,
      1,
      `List its skills with: ravi mcp skills list ${input.server} --json`,
    );
  }
  const entry = use.value.skill as Skill;
  const path = mcpSkillPathOfUri(entry.uri);
  if (entry.uri !== uri || !path) {
    throw new McpSkillsError("MCP_SKILL_NOT_FOUND", `MCP server ${input.server} answered for another skill.`, 1);
  }
  const manifest = canonicalMcpSkillManifest(entry as McpSkillEntryLike);
  if (!manifest) {
    throw new McpSkillsError(
      "MCP_SKILL_DYNAMIC",
      `Skill ${mcpSkillId(input.server, path)} has a dynamic file list; Ravi pins only skills whose files a manifest lists.`,
      1,
    );
  }
  if (!manifest.resources.some((resource) => resource.uri === uri)) {
    throw new McpSkillsError("MCP_SKILL_MANIFEST_INVALID", "The skill's manifest does not list its SKILL.md.", 1);
  }
  const libraryRef = mcpSkillLibraryRef(entry as McpSkillEntryLike);
  const libraryPins = dbListLibraryPins();
  if (libraryRef && libraryPins.some((pin) => pin.agentId === scope.agentId && pin.ref.toLowerCase() === libraryRef)) {
    throw new McpSkillsError(
      "MCP_SKILL_LIBRARY_DUPLICATE",
      `Agent ${scope.agentId} already loads Library skill ${libraryRef} from the Console sync; this remote copy is not pinned.`,
      1,
    );
  }

  const id = mcpSkillId(input.server, path);
  const existing = getMcpSkillPin(scope.agentId, input.server, uri);
  const skill =
    existing?.skillName ??
    pluginNameFor(
      input.server,
      uri,
      libraryPins.map((pin) => pin.skillName),
    );
  const manifestDigest = mcpSkillManifestDigest(manifest);
  const description = cleanMcpSkillText(manifest.description, MCP_SKILL_DESCRIPTION_MAX);
  const warnings = mcpSkillPinWarnings(scope.agentId, input.server, input.externalAllowed);
  const effect = [
    `Agent ${scope.agentId} loads ravi-library:${skill} in new sessions: a stub that tells it to run ravi mcp skills read ${id}.`,
    `The approval binds to this manifest (${manifest.resources.length} files, digest ${manifestDigest}); no file is fetched now. A changed manifest stops it until it is pinned again.`,
    input.externalAllowed
      ? "It also loads in turns with people outside the organization (--external); reading it still needs a turn the server's audience allows."
      : "It loads only in the operator's own turns.",
  ];
  return {
    manifest,
    plan: {
      server: input.server,
      agent: scope.agentId,
      uri,
      id,
      skill,
      name: cleanMcpSkillText(manifest.name, MCP_SKILL_NAME_MAX),
      description,
      files: manifest.resources.length,
      bytes: totalBytes(manifest),
      manifestDigest,
      libraryRef,
      externalAllowed: input.externalAllowed,
      alreadyPinned: existing?.state === "active" && existing.manifestDigest === manifestDigest,
      fetchesFiles: false,
      effect,
      warnings,
    },
  };
}

/**
 * The warnings of a pin: `--external` on an attachment whose audience is
 * `operator` loads the stub on other people's turns, where every read fails
 * `MCP_AUDIENCE`. Never throws.
 */
export function mcpSkillPinWarnings(agentId: string, server: string, externalAllowed: boolean): string[] {
  if (!externalAllowed) return [];
  let audience: string | null = null;
  try {
    audience = getMcpAttachment(agentId, server)?.audience ?? null;
  } catch {
    // no-cause: an unreadable attachment gives no warning; the read's own authorization still decides.
    return [];
  }
  if (audience !== "operator") return [];
  return [
    `MCP server ${server} is attached to ${agentId} with audience operator: the stub loads on other people's turns (--external), but every read there fails MCP_AUDIENCE. To let those turns read it: ravi mcp set ${server} --audience any --agent ${agentId} --execute`,
  ];
}

/**
 * The plugin name of a new pin: the name another agent's pin of the same skill
 * already has, else `mcp-<server>-<slug>`, hashed when a Library pin or a pin
 * of another skill holds it (installation-wide, since Codex shares one skills
 * directory) or when it is longer than 64 characters.
 */
function pluginNameFor(server: string, uri: string, libraryNames: string[]): string {
  const library = new Set(libraryNames.map((name) => name.toLowerCase()));
  const pins = listMcpSkillPins();
  const same = pins.find((pin) => pin.server === server && pin.skillUri === uri && !library.has(pin.skillName));
  if (same) return same.skillName;
  const taken = new Set<string>([
    ...library,
    ...pins.filter((pin) => !(pin.server === server && pin.skillUri === uri)).map((pin) => pin.skillName),
  ]);
  return assignMcpSkillPluginName(server, uri, taken);
}

export interface McpSkillPinResult {
  pinned: true;
  created: boolean;
  id: string;
  agent: string;
  skill: string;
  manifestDigest: string;
  externalAllowed: boolean;
  /** Whether the generated plugin was rebuilt (new sessions load the stub). */
  pluginRebuilt: boolean;
  /** As in the plan: what will not work as pinned. */
  warnings: string[];
}

/** Store the pin on the approved manifest, then rebuild the generated plugin. */
export function executeMcpSkillPin(
  prepared: PreparedMcpSkillPin,
  input: { approvedBy: string | null },
  deps: McpSkillsDeps = {},
): McpSkillPinResult {
  const { plan, manifest } = prepared;
  const { created, pin } = upsertMcpSkillPin({
    agentId: plan.agent,
    server: plan.server,
    skillUri: plan.uri,
    skillId: plan.id,
    skillName: plan.skill,
    description: plan.description,
    manifest,
    manifestDigest: plan.manifestDigest,
    libraryRef: plan.libraryRef,
    externalAllowed: plan.externalAllowed,
    approvedBy: input.approvedBy,
    ...(deps.now ? { now: deps.now() } : {}),
  });
  const pluginRebuilt = rebuildPlugin(deps);
  log.info("Remote skill pinned", { agentId: pin.agentId, server: pin.server, skill: pin.skillName, created });
  return {
    pinned: true,
    created,
    id: pin.skillId,
    agent: pin.agentId,
    skill: pin.skillName,
    manifestDigest: pin.manifestDigest,
    externalAllowed: pin.externalAllowed,
    pluginRebuilt,
    warnings: mcpSkillPinWarnings(pin.agentId, pin.server, pin.externalAllowed),
  };
}

// ============================================================================
// unpin and drops
// ============================================================================

/** Remove one pin (reduces authority: applies at once). */
export function unpinMcpSkill(
  input: { agentId: string; id: string },
  deps: McpSkillsDeps = {},
): { removed: boolean; id: string; agent: string; pluginRebuilt: boolean } {
  let ref: ReturnType<typeof parseMcpSkillId>;
  try {
    ref = parseMcpSkillId(input.id);
  } catch (error) {
    throw new McpSkillsError("MCP_SKILL_ID_INVALID", (error as Error).message, 2);
  }
  const pin = getMcpSkillPin(input.agentId, ref.server, ref.uri);
  if (!pin) return { removed: false, id: ref.id, agent: input.agentId, pluginRebuilt: false };
  const removed = deleteMcpSkillPin(input.agentId, ref.server, ref.uri);
  const pluginRebuilt = removed ? rebuildPlugin(deps) : false;
  return { removed, id: ref.id, agent: input.agentId, pluginRebuilt };
}

/**
 * Drop a server's pins (`ravi mcp remove`: every agent; `detach`: one agent)
 * and rebuild the plugin. Returns how many went. Never throws.
 */
export function dropMcpSkillPinsForServer(server: string, agentId?: string, deps: McpSkillsDeps = {}): number {
  let dropped = 0;
  try {
    dropped = deleteMcpSkillPinsForServer(server, agentId);
  } catch {
    // no-cause: an unreadable pin table loads nothing for this server anyway (the gate needs it attached).
    log.warn("Remote skill pins of a server could not be dropped", { server });
    return 0;
  }
  if (dropped > 0) rebuildPlugin(deps);
  return dropped;
}

// ============================================================================
// read
// ============================================================================

export interface McpSkillReadResult {
  id: string;
  server: string;
  uri: string;
  /** The file read, relative to the skill root (`SKILL.md` by default). */
  file: string;
  digest: string;
  size: number;
  /** Served from the digest-keyed cache (re-verified) instead of the server. */
  cached: boolean;
  mimeType: string | null;
  /** The file as UTF-8 text, cut at the cap; null for a binary file. */
  text: string | null;
  truncated: boolean;
  binary: boolean;
}

function cacheDir(deps: McpSkillsDeps): string {
  return join(deps.stateDir?.() ?? getRaviStateDir(), "mcp", "skills", "cache");
}

/** A media type as the server gave it, kept only when it is a plain `type/subtype` (with parameters). */
function cleanMimeType(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 120) return null;
  return /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(value) ? value : null;
}

/**
 * The cached bytes of a file digest and the media type the server gave them,
 * re-verified on every read (a mismatch drops the copy). The type is kept
 * beside the bytes (`<hex>.type`); a copy without one reads as null.
 */
function readCached(
  deps: McpSkillsDeps,
  hex: string,
  size: number,
): { bytes: Uint8Array; mimeType: string | null } | null {
  const path = join(cacheDir(deps), hex);
  if (!existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    if (bytes.length === size && createHash("sha256").update(bytes).digest("hex") === hex) {
      let mimeType: string | null = null;
      try {
        if (existsSync(`${path}.type`)) mimeType = cleanMimeType(readFileSync(`${path}.type`, "utf8").trim());
      } catch {
        // no-cause: an unreadable type reads as unknown; the verified bytes are still served.
        mimeType = null;
      }
      return { bytes: new Uint8Array(bytes), mimeType };
    }
  } catch {
    // no-cause: an unreadable cache entry is fetched again below.
  }
  try {
    rmSync(path, { force: true });
    rmSync(`${path}.type`, { force: true });
  } catch {
    // no-cause: a copy that cannot be removed is overwritten by the next verified fetch.
  }
  return null;
}

function writeCached(deps: McpSkillsDeps, hex: string, bytes: Uint8Array, mimeType: string | null): void {
  try {
    const dir = cacheDir(deps);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const suffix = randomBytes(6).toString("hex");
    const type = cleanMimeType(mimeType);
    if (type) {
      const tmpType = join(dir, `.tmp-${suffix}.type`);
      writeFileSync(tmpType, type, { mode: 0o600 });
      renameSync(tmpType, join(dir, `${hex}.type`));
    } else {
      rmSync(join(dir, `${hex}.type`), { force: true });
    }
    const tmp = join(dir, `.tmp-${suffix}`);
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, join(dir, hex));
  } catch {
    // no-cause: the cache is an optimisation; the verified bytes are still returned.
    log.warn("Remote skill file not cached");
  }
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // no-cause: bytes that are not UTF-8 are reported as binary.
    return null;
  }
}

function capText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MCP_SKILL_READ_TEXT_CAP_BYTES) return { text, truncated: false };
  let cut = Buffer.from(text, "utf8").subarray(0, MCP_SKILL_READ_TEXT_CAP_BYTES).toString("utf8");
  if (cut.endsWith("\ufffd")) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

function markStale(
  pin: McpSkillPinRecord,
  reason: McpSkillStaleReason,
  deps: McpSkillsDeps,
  trace: { context: ContextRecord | null | undefined; agentId: string },
  unlessDigest?: string,
) {
  const changed = markMcpSkillPinsStale({
    server: pin.server,
    skillUri: pin.skillUri,
    reason,
    ...(unlessDigest ? { unlessDigest } : {}),
    ...(deps.now ? { now: deps.now() } : {}),
  });
  for (const stale of changed) {
    notePinChange(
      pin.server,
      { agent: stale.agentId, id: stale.skillId, change: "stale", reason },
      { ...trace, source: "read" },
    );
  }
  if (changed.length) rebuildPlugin(deps);
}

/** The refusal of a read of a stale pin, worded by why it went stale. */
function staleError(id: string, server: string, agentId: string, reason: McpSkillStaleReason | null): McpSkillsError {
  const repin = `ravi mcp skills pin ${server} ${id} --agent ${agentId} --execute`;
  if (reason === "gone") {
    return new McpSkillsError(
      "MCP_SKILL_STALE",
      `MCP server ${server} no longer serves remote skill ${id} (gone: unpublished, or the organization's skills are off); it is not read. The pin comes back by itself when the server lists the skill again on the approved manifest.`,
      1,
      `Wait for the server to list it again, or the operator pins it again with: ${repin}`,
      "gone",
    );
  }
  if (reason === "digest_mismatch") {
    return new McpSkillsError(
      "MCP_SKILL_STALE",
      `A file of remote skill ${id} did not match its manifest digest; it is not read until the operator pins it again.`,
      1,
      `The operator reviews and pins it again with: ${repin}`,
      "digest_mismatch",
    );
  }
  return new McpSkillsError(
    "MCP_SKILL_STALE",
    `Remote skill ${id} changed on its server since it was approved (${reason ?? "stale"}); it is not read until the operator pins it again.`,
    1,
    `The operator reviews and pins it again with: ${repin}`,
    reason ?? "stale",
  );
}

/**
 * Read one file of a skill pinned to the turn's agent. Checks, in order: the
 * id and `--file` (usage), the pin (active), the per-turn gate
 * (`externalAllowed` or the operator's own turn), that the file is in the
 * approved manifest, then `authorizeMcpUse` (surface `skill`) and the live
 * manifest digest. Fetches only the file asked for. Every read, refused or
 * not, writes an `mcp.skill` trace event (never the content).
 */
export async function readMcpSkill(
  gateway: Pick<McpGateway, "withServer">,
  scope: McpCallScope,
  input: { id: string; file?: string },
  deps: McpSkillsDeps = {},
): Promise<McpSkillReadResult> {
  const started = deps.now?.() ?? Date.now();
  let skill = typeof input.id === "string" ? input.id.trim().slice(0, 240) : "";
  let server = "";
  try {
    const ref = parseMcpSkillId(input.id);
    skill = ref.id;
    server = ref.server;
  } catch {
    // no-cause: the read below refuses the id with its own usage error, which the trace records.
  }
  const file = typeof input.file === "string" ? input.file.trim().slice(0, 300) : MCP_SKILL_ENTRY_FILE;
  const traceBase = { context: scope.context, agentId: scope.agentId, server, op: "read" as const, skill };
  try {
    const result = await readPinnedMcpSkill(gateway, scope, input, deps);
    recordMcpSkillTrace({
      ...traceBase,
      file: result.file,
      bytes: result.size,
      source: result.cached ? "cached" : "fetched",
      outcome: "ok",
      durationMs: (deps.now?.() ?? Date.now()) - started,
    });
    return result;
  } catch (error) {
    const known = error instanceof McpSkillsError ? error : null;
    recordMcpSkillTrace({
      ...traceBase,
      file,
      bytes: 0,
      outcome: known?.exitCode === 3 ? "denied" : "error",
      reason: known ? (known.detail ? `${known.code}:${known.detail}` : known.code) : "MCP_SKILLS_FAILED",
      durationMs: (deps.now?.() ?? Date.now()) - started,
    });
    throw error;
  }
}

async function readPinnedMcpSkill(
  gateway: Pick<McpGateway, "withServer">,
  scope: McpCallScope,
  input: { id: string; file?: string },
  deps: McpSkillsDeps,
): Promise<McpSkillReadResult> {
  let ref: ReturnType<typeof parseMcpSkillId>;
  let file: string;
  try {
    ref = parseMcpSkillId(input.id);
  } catch (error) {
    throw new McpSkillsError("MCP_SKILL_ID_INVALID", (error as Error).message, 2);
  }
  try {
    file = normalizeMcpSkillFileRef(input.file);
  } catch (error) {
    throw new McpSkillsError("MCP_SKILL_FILE_INVALID", (error as Error).message, 2);
  }
  const pin = getMcpSkillPin(scope.agentId, ref.server, ref.uri);
  if (!pin) {
    throw new McpSkillsError(
      "MCP_SKILL_NOT_PINNED",
      `Remote skill ${ref.id} is not pinned to agent ${scope.agentId}.`,
      1,
      `The operator pins it with: ravi mcp skills pin ${ref.server} ${ref.id} --agent ${scope.agentId} --execute`,
    );
  }
  if (pin.state !== "active") throw staleError(ref.id, ref.server, scope.agentId, pin.staleReason);
  if (!pin.externalAllowed && !ownTurn(deps, scope.context)) {
    throw new McpSkillsError(
      "MCP_SKILL_EXTERNAL_DENIED",
      `Remote skill ${ref.id} is pinned for the operator's own turns only, and this turn is not one.`,
      3,
      "Do not retry from this turn",
    );
  }
  const fileUri = file === MCP_SKILL_ENTRY_FILE ? pin.skillUri : mcpSkillFileUri(pin.skillUri, file);
  const resource = pin.manifest.resources.find((entry) => entry.uri === fileUri);
  const hex = resource ? mcpSkillDigestHex(resource.digest) : null;
  if (!resource || !hex) {
    throw new McpSkillsError(
      "MCP_SKILL_FILE_NOT_FOUND",
      `Remote skill ${ref.id} has no file ${JSON.stringify(file)} in its approved manifest.`,
      1,
      `Files: ${pin.manifest.resources
        .map((entry) => entry.uri.slice(pin.skillUri.length - MCP_SKILL_ENTRY_FILE.length))
        .slice(0, 20)
        .join(", ")}`,
    );
  }

  type Read =
    | { kind: "unsupported" }
    | { kind: "gone" }
    | { kind: "changed"; digest: string }
    | { kind: "mismatch" }
    | { kind: "file"; bytes: Uint8Array; mimeType: string | null; cached: boolean };
  const use = await gateway.withServer<Read>(
    scope,
    ref.server,
    async (lease) => {
      const client = skillsClient(lease);
      if (!client.supported) return { kind: "unsupported" };
      let entry: Skill;
      try {
        entry = (await client.get(ref.uri, { timeout: MCP_SKILL_REQUEST_TIMEOUT_MS })).skill;
      } catch (error) {
        if (isNotFound(error)) return { kind: "gone" };
        throw error;
      }
      const manifest = entry.uri === ref.uri ? canonicalMcpSkillManifest(entry as McpSkillEntryLike) : null;
      const digest = manifest ? mcpSkillManifestDigest(manifest) : "dynamic";
      if (digest !== pin.manifestDigest) return { kind: "changed", digest };
      const cached = readCached(deps, hex, resource.size);
      if (cached) return { kind: "file", bytes: cached.bytes, mimeType: cached.mimeType, cached: true };
      try {
        const read = await client.read(entry, file === MCP_SKILL_ENTRY_FILE ? undefined : file, {
          timeout: MCP_SKILL_REQUEST_TIMEOUT_MS,
          cacheMode: "bypass",
        });
        // Belt and braces: the bytes the client verified are the ones the approved manifest lists.
        if (read.bytes.length !== resource.size || createHash("sha256").update(read.bytes).digest("hex") !== hex) {
          return { kind: "mismatch" };
        }
        return { kind: "file", bytes: read.bytes, mimeType: cleanMimeType(read.mimeType), cached: false };
      } catch (error) {
        if (error instanceof SkillVerificationError) return { kind: "mismatch" };
        throw error;
      }
    },
    "skills/get, resources/read",
  );
  if (!use.ok) throw serverFailure(use, ref.server);
  const value = use.value;
  const trace = { context: scope.context, agentId: scope.agentId };
  if (value.kind === "unsupported") throw unsupported(ref.server);
  if (value.kind === "gone") {
    markStale(pin, "gone", deps, trace);
    throw staleError(ref.id, ref.server, scope.agentId, "gone");
  }
  if (value.kind === "changed") {
    const reason = value.digest === "dynamic" ? "dynamic" : "manifest_changed";
    markStale(pin, reason, deps, trace, value.digest);
    throw staleError(ref.id, ref.server, scope.agentId, reason);
  }
  if (value.kind === "mismatch") {
    markStale(pin, "digest_mismatch", deps, trace);
    throw new McpSkillsError(
      "MCP_SKILL_DIGEST_MISMATCH",
      `A file of remote skill ${ref.id} does not match its manifest digest; it was not used and the pin is now stale.`,
      1,
    );
  }
  if (!value.cached) writeCached(deps, hex, value.bytes, value.mimeType);
  const decoded = decodeText(value.bytes);
  const capped = decoded === null ? null : capText(decoded);
  log.info("Remote skill read", {
    agentId: scope.agentId,
    server: ref.server,
    skill: pin.skillName,
    cached: value.cached,
  });
  return {
    id: ref.id,
    server: ref.server,
    uri: fileUri,
    file,
    digest: resource.digest,
    size: resource.size,
    cached: value.cached,
    mimeType: value.mimeType,
    text: capped ? capped.text : null,
    truncated: capped ? capped.truncated : false,
    binary: decoded === null,
  };
}
