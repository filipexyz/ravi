/**
 * The agent directory and requests between agents behind `ravi agents
 * directory|ask|requests` (spec skills/library, "Directory and requests").
 *
 * The Console keeps the directory (what each linked installation reports with
 * its pin sync) and relays requests; it decides who may ask and which agents
 * a member sees. This side resolves `<machine>/<agent>` from the directory,
 * sends and lists requests, remembers which local session asked, and keeps the
 * per-agent switches: listed in the directory (default not, so an agent is
 * reported only once its operator lists it) and open to requests (default
 * closed; opening one lists it).
 */

import { getAgent } from "../router/config.js";
import {
  dbGetLibraryAgentState,
  dbListLocalAgentRequests,
  dbSetLibraryAgentAcceptsRequests,
  dbSetLibraryAgentListed,
  dbSetLocalAgentRequestStatus,
  dbUpsertLocalAgentRequest,
  type LocalAgentRequest,
} from "./agents-db.js";
import {
  isLibraryOfflineError,
  LIBRARY_REQUEST_MESSAGE_MAX,
  libraryLoginRequiredError,
  openLibrarySession,
  type LibrarySession,
  type LibrarySessionDeps,
  type LibrarySessionOptions,
} from "./client.js";
import { LIBRARY_PIN_SYNC_SCOPE, syncLibraryPins, type LibraryPinDeps } from "./pins.js";
import { LibraryCommandError } from "./service.js";
import { isOperatorOwnTurn, type LibraryTurnDeps } from "./turn.js";
import type { LibraryAgentRequest, LibraryDirectoryAgent, LibraryDirectoryResponse } from "./types.js";

export const LIBRARY_TARGET_AMBIGUOUS = "LIBRARY_TARGET_AMBIGUOUS";
export const LIBRARY_AGENT_CANNOT_OPEN_REQUESTS = "LIBRARY_AGENT_CANNOT_OPEN_REQUESTS";
export const LIBRARY_AGENT_CANNOT_LIST = "LIBRARY_AGENT_CANNOT_LIST";
export const LIBRARY_REQUEST_EXTERNAL_DENIED = "LIBRARY_REQUEST_EXTERNAL_DENIED";

export interface LibraryRequestServiceDeps {
  session?: LibrarySessionDeps;
  openSession?: (options: LibrarySessionOptions) => Promise<LibrarySession | null>;
  turn?: LibraryTurnDeps;
  pins?: LibraryPinDeps;
}

function openSession(options: LibrarySessionOptions, deps: LibraryRequestServiceDeps) {
  return deps.openSession ? deps.openSession(options) : openLibrarySession(options, deps.session);
}

async function requireSession(deps: LibraryRequestServiceDeps): Promise<LibrarySession> {
  const session = await openSession({ resolveProject: false }, deps);
  if (!session) throw libraryLoginRequiredError();
  return session;
}

function peerLabel(installation: { id: string; name: string | null } | null | undefined, agentId: string): string {
  return `${installation?.name || installation?.id || "?"}/${agentId}`;
}

// ---------------------------------------------------------------------------
// Directory

export interface LibraryDirectoryEntry extends LibraryDirectoryAgent {
  /** `<machine>/<agent>` to pass to `ravi agents ask`. */
  target: string;
}

export interface LibraryDirectoryPayload {
  query: string;
  project: string | null;
  total: number;
  can: LibraryDirectoryResponse["can"];
  agents: LibraryDirectoryEntry[];
}

/** `ravi agents directory [q]`: read-only. */
export async function listLibraryDirectory(
  input: { query?: string; project?: string | null },
  deps: LibraryRequestServiceDeps = {},
): Promise<LibraryDirectoryPayload> {
  const session = await requireSession(deps);
  const project = input.project?.trim() || null;
  const directory = await session.client.directory({ query: input.query ?? null, project });
  const agents = directory.agents.map((entry) => ({
    ...entry,
    target: `${entry.installation.name || entry.installation.id}/${entry.agent.id}`,
  }));
  return { query: input.query ?? "", project, total: agents.length, can: directory.can, agents };
}

/** Split `<machine>/<agent>` at the last slash (an installation name may hold one). */
export function parseRequestTarget(value: string): { machine: string; agentId: string } | null {
  const trimmed = value.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { machine: trimmed.slice(0, slash).trim(), agentId: trimmed.slice(slash + 1).trim() };
}

/** The directory entry for `<machine>/<agent>`: machine by installation id or name (case-insensitive). */
export function resolveRequestTarget(
  directory: readonly LibraryDirectoryAgent[],
  target: { machine: string; agentId: string },
): LibraryDirectoryAgent {
  const machine = target.machine.toLowerCase();
  const sameAgent = directory.filter((entry) => entry.agent.id === target.agentId);
  const byId = sameAgent.filter((entry) => entry.installation.id.toLowerCase() === machine);
  const matches =
    byId.length > 0 ? byId : sameAgent.filter((entry) => (entry.installation.name ?? "").toLowerCase() === machine);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new LibraryCommandError(
      LIBRARY_TARGET_AMBIGUOUS,
      `${matches.length} machines named '${target.machine}' run an agent '${target.agentId}'.`,
      2,
      {
        suggestedAction: `Name the machine by its installation id: ravi agents ask <installation-id>/${target.agentId} "<message>"`,
        candidates: matches.map((entry) => ({
          installationId: entry.installation.id,
          name: entry.installation.name,
          online: entry.online,
          reportedAt: entry.reportedAt,
        })),
      },
    );
  }
  throw new LibraryCommandError(
    "NOT_FOUND",
    `No agent '${target.agentId}' on a machine '${target.machine}' in the directory.`,
    1,
    {
      suggestedAction: "List the agents you can ask with: ravi agents directory --json",
      suggestions: sameAgent.map((entry) => `${entry.installation.name || entry.installation.id}/${entry.agent.id}`),
    },
  );
}

// ---------------------------------------------------------------------------
// Ask

export interface LibraryAskCaller {
  agentId: string;
  sessionKey: string | null;
  sessionName: string | null;
}

export interface LibraryAskPlan {
  to: {
    target: string;
    installation: { id: string; name: string | null };
    agent: { id: string; name: string; description: string | null };
    online: boolean;
    acceptsRequests: boolean;
  };
  from: { agent: string | null; session: string | null };
  messageLength: number;
  effect: string;
}

export interface PreparedLibraryAsk {
  plan: LibraryAskPlan;
  message: string;
  caller: LibraryAskCaller | null;
  session: LibrarySession;
}

export async function prepareLibraryAsk(
  input: { target: string; message: string; caller: LibraryAskCaller | null },
  deps: LibraryRequestServiceDeps = {},
): Promise<PreparedLibraryAsk> {
  const parsed = parseRequestTarget(input.target);
  if (!parsed) {
    throw new LibraryCommandError("USAGE_ERROR", "Name the agent as <machine>/<agent>.", 2, {
      suggestedAction: "Copy a target from: ravi agents directory --json",
    });
  }
  const message = input.message.trim();
  if (!message || message.length > LIBRARY_REQUEST_MESSAGE_MAX) {
    throw new LibraryCommandError(
      "USAGE_ERROR",
      `The message must have 1 to ${LIBRARY_REQUEST_MESSAGE_MAX} characters.`,
      2,
      { suggestedAction: "Write a shorter message" },
    );
  }
  // An agent serving someone other than the operator does not send its
  // conversation to agents on other machines (same rule as Library items not
  // marked for outsiders).
  if (input.caller && !isOperatorOwnTurn(deps.turn)) {
    throw new LibraryCommandError(
      LIBRARY_REQUEST_EXTERNAL_DENIED,
      "This turn is not the operator's own, so it cannot ask agents on other machines.",
      3,
      { suggestedAction: "Answer without asking another machine, or ask the operator to send the request." },
    );
  }
  const session = await requireSession(deps);
  const directory = await session.client.directory({ query: parsed.agentId });
  const entry = resolveRequestTarget(directory.agents, parsed);
  const target = peerLabel(entry.installation, entry.agent.id);
  return {
    session,
    message,
    caller: input.caller,
    plan: {
      to: {
        target,
        installation: entry.installation,
        agent: { id: entry.agent.id, name: entry.agent.name, description: entry.agent.description },
        online: entry.online,
        acceptsRequests: entry.acceptsRequests,
      },
      from: { agent: input.caller?.agentId ?? null, session: input.caller?.sessionName ?? null },
      messageLength: message.length,
      effect: `send the message to ${target}; its answer comes back ${
        input.caller?.sessionName
          ? `to session ${input.caller.sessionName} as a [System] Inform`
          : "to 'ravi agents requests list'"
      }`,
    },
  };
}

export interface LibraryAskResult {
  request: LibraryAgentRequest;
  target: string;
  next: string;
}

export async function executeLibraryAsk(prepared: PreparedLibraryAsk): Promise<LibraryAskResult> {
  const { plan, caller, session } = prepared;
  const request = await session.client.sendRequest({
    to: { installationId: plan.to.installation.id, agentId: plan.to.agent.id },
    message: prepared.message,
    ...(caller ? { agent: { id: caller.agentId } } : {}),
  });
  dbUpsertLocalAgentRequest({
    requestId: request.id,
    direction: "sent",
    agentId: caller?.agentId ?? null,
    peer: plan.to.target,
    sessionKey: caller?.sessionKey ?? null,
    sessionName: caller?.sessionName ?? null,
    status: "open",
  });
  return { request, target: plan.to.target, next: "ravi agents requests list" };
}

// ---------------------------------------------------------------------------
// List and cancel

export interface LibraryRequestView extends LibraryAgentRequest {
  /** The local session that asked (sent requests asked from an agent). */
  session: string | null;
}

export interface LibraryRequestListPayload {
  box: "sent" | "received";
  state: "open" | "all";
  stale: boolean;
  hint?: string;
  installation: { id: string; name: string | null } | null;
  total: number;
  requests: LibraryRequestView[];
  /** When the Console could not be reached: what this machine remembers. */
  local?: LocalAgentRequest[];
}

export async function listLibraryRequests(
  input: { received?: boolean; all?: boolean },
  deps: LibraryRequestServiceDeps = {},
): Promise<LibraryRequestListPayload> {
  const box = input.received ? "received" : "sent";
  const state = input.all ? "all" : "open";
  const local = dbListLocalAgentRequests({ direction: box });
  const sessionOf = new Map(local.map((row) => [row.requestId, row.sessionName]));
  const session = await requireSession(deps);
  try {
    const list = await session.client.listRequests({ box, state });
    const requests = list.requests.map((request) => ({ ...request, session: sessionOf.get(request.id) ?? null }));
    return { box, state, stale: false, installation: list.installation, total: requests.length, requests };
  } catch (error) {
    if (!isLibraryOfflineError(error)) throw error;
    const rows = input.all ? local : local.filter((row) => row.status === "open" || row.status === "running");
    return {
      box,
      state,
      stale: true,
      hint: "The Console could not be reached: these are the requests this machine remembers.",
      installation: null,
      total: rows.length,
      requests: [],
      local: rows,
    };
  }
}

export async function cancelLibraryRequest(
  input: { id: string },
  deps: LibraryRequestServiceDeps = {},
): Promise<LibraryAgentRequest> {
  const id = input.id.trim();
  if (!id) {
    throw new LibraryCommandError("USAGE_ERROR", "Pass the request id.", 2, {
      suggestedAction: "List your requests with: ravi agents requests list",
    });
  }
  const session = await requireSession(deps);
  const request = await session.client.cancelRequest(id);
  dbSetLocalAgentRequestStatus(request.id, "sent", request.status);
  return request;
}

// ---------------------------------------------------------------------------
// Listing an agent and opening it to requests

export interface LibraryAcceptsRequestsResult {
  agent: string;
  /** Listed in the org directory (opening an agent to requests lists it). */
  listed: boolean;
  acceptsRequests: boolean;
  changed: boolean;
  /** Whether the directory heard about it now (a pin sync), or will at the next one. */
  reported: boolean;
  hint?: string;
}

export interface LibraryListingResult {
  agent: string;
  listed: boolean;
  /** Listing off also closes the agent to requests. */
  acceptsRequests: boolean;
  changed: boolean;
  /** Whether the directory heard about it now (a pin sync), or will at the next one. */
  reported: boolean;
  hint?: string;
}

export function readAcceptsRequests(agentId: string): boolean {
  return dbGetLibraryAgentState(agentId)?.acceptsRequests === true;
}

export function readListed(agentId: string): boolean {
  return dbGetLibraryAgentState(agentId)?.listed === true;
}

export function requireLocalAgent(agentId: string): void {
  if (!getAgent(agentId)) {
    throw new LibraryCommandError("AGENT_NOT_FOUND", `Agent not found: ${agentId}`, 1, {
      suggestedAction: "Check the agent id with: ravi agents list --json",
    });
  }
}

/** Report the listed agents now so the directory follows (best effort). */
async function reportNow(deps: LibraryRequestServiceDeps): Promise<{ reported: boolean; hint?: string }> {
  try {
    const session = await openSession({ resolveProject: false }, deps);
    if (session?.scopes.includes(LIBRARY_PIN_SYNC_SCOPE)) {
      await syncLibraryPins(session, { report: true }, deps.pins);
      return { reported: true };
    }
    return {
      reported: false,
      hint: "Not reported yet: the daemon reports it with its next pin sync once `ravi login` is linked.",
    };
  } catch {
    return { reported: false, hint: "Not reported yet: the daemon reports it with its next pin sync." };
  }
}

/** Store the switch, then report the agents now so the directory follows (best effort). */
export async function setAcceptsRequests(
  input: { agentId: string; accepts: boolean },
  deps: LibraryRequestServiceDeps = {},
): Promise<LibraryAcceptsRequestsResult> {
  requireLocalAgent(input.agentId);
  const before = readAcceptsRequests(input.agentId);
  dbSetLibraryAgentAcceptsRequests(input.agentId, input.accepts);
  const { reported, hint } = await reportNow(deps);
  return {
    agent: input.agentId,
    listed: readListed(input.agentId),
    acceptsRequests: input.accepts,
    changed: before !== input.accepts,
    reported,
    ...(hint ? { hint } : {}),
  };
}

/**
 * List or unlist an agent in the org directory, then report now (best
 * effort). Unlisting also closes it to requests; the Console drops an agent
 * the sync no longer reports.
 */
export async function setListed(
  input: { agentId: string; listed: boolean },
  deps: LibraryRequestServiceDeps = {},
): Promise<LibraryListingResult> {
  requireLocalAgent(input.agentId);
  const before = readListed(input.agentId);
  dbSetLibraryAgentListed(input.agentId, input.listed);
  const { reported, hint } = await reportNow(deps);
  return {
    agent: input.agentId,
    listed: input.listed,
    acceptsRequests: readAcceptsRequests(input.agentId),
    changed: before !== input.listed,
    reported,
    ...(hint ? { hint } : {}),
  };
}
