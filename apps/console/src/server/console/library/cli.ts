import { projectAuthorizationFromCli, type VerifiedCliProjectContext } from "@/server/cli/project-authorization";
// The Library's routes (`skills/...`, and the same under `agents/...`,
// `themes/...` and `widgets/...` for the other kinds), shared by the CLI
// envelope (`/api/cli/library/...`, bearer token) and the Console UI envelope
// (`/api/console/library/...`, session cookie):
//
//   GET  skills?q=&project=&limit=                      search
//   POST skills                                         publish (201 new version, 200 unchanged)
//   GET  skills/proposals?project=&state=&mine=          proposals the caller can see
//   POST skills/proposals                               create a draft or proposal
//   GET  skills/<slug>?project=                         show, resolved in the caller's view
//   GET  skills/<scope>/<slug>?version=                 show; <scope> is `org` or a project ref
//   GET  skills/<scope>/<slug>/versions                 versions, newest first
//   POST skills/<scope>/<slug>/archive                  archive (idempotent)
//   POST skills/<scope>/<slug>/versions/<n>/revert      publish version n's files again
//   POST widgets/<scope>/<slug>/versions/<n>/audit      store a widget.js accessibility audit (Console only)
//   GET  skills/<scope>/<slug>/proposals                the item's proposals
//   GET  skills/<scope>/<slug>/proposals/<n>            one proposal with files and comments
//   POST skills/<scope>/<slug>/proposals/<n>/<action>   update, submit, withdraw, publish, reject, comments
//   POST skills/<scope>/<slug>/proposals/<n>/comments/<id>/resolve|reopen
//   GET  skills/<scope>/<slug>/pins                     where the item is pinned (skills only)
//   POST skills/<scope>/<slug>/pin|unpin                pin to / unpin from an agent (skills only)
//   GET  themes/active?project=                         the org's and the project's theme pointers
//   POST themes/active                                  set or clear one (`dryRun` plans only)
//   ...  themes/default|check, widgets/catalog|check|preview|scaffold   tools (`widgets/library-tools`)
//   GET  pins                                           the caller installation's pins
//   POST pins/sync                                      report its agents, answer its pins
//   GET  installations?project=                         installations and their agents
//   GET  directory?q=&project=                          agents running in the org (phase 5)
//   POST requests                                       ask an agent on another installation
//   GET  requests?box=sent|received&state=              the caller installation's requests
//   GET  requests/<id>                                  one request
//   POST requests/pull                                  target: take requests for its agents
//   POST requests/<id>/reply                            target: answer or fail one
//   POST requests/<id>/cancel                           sender: withdraw a pending one
//   POST requests/replies/pull                          sender: take answers not yet handed back

import type { CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { routeWidgetsToolsRequest } from "@/server/console/widgets/library-tools";
import { parseConsoleRole } from "@/server/console/workspace";

import { kindFromSegment } from "./kinds";

import {
  commentOnLibraryProposal,
  createLibraryProposal,
  listItemProposals,
  listLibraryProposals,
  publishLibraryProposal,
  rejectLibraryProposal,
  revertLibraryItem,
  setLibraryCommentResolved,
  showLibraryProposal,
  submitLibraryProposal,
  updateLibraryProposal,
  withdrawLibraryProposal,
} from "./proposals";
import {
  cancelAgentRequest,
  listAgentDirectory,
  listAgentRequests,
  pullAgentReplies,
  pullAgentRequests,
  replyAgentRequest,
  sendAgentRequest,
  showAgentRequest,
} from "./directory";
import {
  listInstallationPins,
  listItemPins,
  listLibraryInstallations,
  pinLibraryItem,
  syncInstallationPins,
  unpinLibraryItem,
} from "./pins";
import {
  archiveLibraryItem,
  listLibraryVersions,
  publishLibraryItem,
  searchLibrary,
  showLibraryItem,
  type LibraryActor,
  type LibraryWorkspace,
} from "./service";
import { recordWidgetScriptAudit } from "./script-audit";
import { getActiveTheme, setActiveTheme } from "./themes";

/** The scopes every CLI session already has, so no daemon needs a new `ravi login`. */
export const LIBRARY_CLI_READ_SCOPES = ["console.projects.read"] as const;
export const LIBRARY_CLI_WRITE_SCOPES = ["console.projects.link"] as const;
/** JSON escaping can roughly double a 1 MiB version. */
export const LIBRARY_MAX_BODY_BYTES = 3 * 1024 * 1024;

export type LibraryCliRequest = {
  auth: Pick<CliAuthContext, "membership" | "organization" | "scopes" | "user"> & VerifiedCliProjectContext;
  requestId: string;
  origin: string;
  method: string;
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
};

export type LibraryResult = { status: number; payload: unknown };

export async function handleLibraryCliRequest(request: LibraryCliRequest): Promise<LibraryResult> {
  const method = request.method.toUpperCase();
  const scopes = method === "GET" ? LIBRARY_CLI_READ_SCOPES : LIBRARY_CLI_WRITE_SCOPES;
  for (const scope of scopes) {
    if (!request.auth.scopes.includes(scope)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Log in again to grant it.`);
    }
  }
  const role = parseConsoleRole(request.auth.membership.role);
  if (!role) throw cliApiError(403, "ORG_ACCESS_DENIED");
  return routeLibraryRequest({
    workspace: {
      authorization: projectAuthorizationFromCli(request.auth),
      user: { id: request.auth.user.id },
      organization: { id: request.auth.organization.id, slug: request.auth.organization.slug },
      membership: { role },
    },
    actor: {
      surface: "cli",
      requestId: request.requestId,
      localInstallationId: request.auth.localInstallation?.id ?? null,
      origin: request.origin,
    },
    method,
    segments: request.segments,
    body: request.body,
    searchParams: request.searchParams,
  });
}

export type LibraryRouteRequest = {
  workspace: LibraryWorkspace;
  actor: LibraryActor;
  method: string;
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
};

export async function routeLibraryRequest(request: LibraryRouteRequest): Promise<LibraryResult> {
  const method = request.method.toUpperCase();
  const [kindSegment, ...rest] = request.segments;
  const { workspace, actor, searchParams } = request;
  const project = optionalParam(searchParams, "project");

  if (kindSegment === "pins") {
    if (rest.length === 0 && method === "GET") return { status: 200, payload: await listInstallationPins({ workspace, actor }) };
    if (rest.length === 1 && rest[0] === "sync" && method === "POST") return syncInstallationPins({ workspace, actor, body: request.body });
    throw unknownRoute();
  }
  if (kindSegment === "installations" && rest.length === 0 && method === "GET") {
    return { status: 200, payload: await listLibraryInstallations({ workspace, projectRef: project }) };
  }
  if (kindSegment === "directory" && rest.length === 0 && method === "GET") {
    return {
      status: 200,
      payload: await listAgentDirectory({ workspace, actor, query: optionalParam(searchParams, "q"), projectRef: project }),
    };
  }
  if (kindSegment === "requests") {
    const body = request.body;
    if (rest.length === 0 && method === "POST") return sendAgentRequest({ workspace, actor, body });
    if (rest.length === 0 && method === "GET") {
      return {
        status: 200,
        payload: await listAgentRequests({
          workspace,
          actor,
          box: optionalParam(searchParams, "box"),
          state: optionalParam(searchParams, "state"),
        }),
      };
    }
    if (rest.length === 1 && rest[0] === "pull" && method === "POST") {
      return { status: 200, payload: await pullAgentRequests({ workspace, actor, body }) };
    }
    if (rest.length === 2 && rest[0] === "replies" && rest[1] === "pull" && method === "POST") {
      return { status: 200, payload: await pullAgentReplies({ workspace, actor, body }) };
    }
    const id = rest[0] ?? "";
    if (rest.length === 1 && method === "GET") return { status: 200, payload: await showAgentRequest({ workspace, actor, id }) };
    if (rest.length === 2 && rest[1] === "reply" && method === "POST") {
      return { status: 200, payload: await replyAgentRequest({ workspace, actor, id, body }) };
    }
    if (rest.length === 2 && rest[1] === "cancel" && method === "POST") {
      return { status: 200, payload: await cancelAgentRequest({ workspace, actor, id, body }) };
    }
    throw unknownRoute();
  }

  const kind = kindFromSegment(kindSegment);
  if (!kind) throw unknownRoute();

  if (rest.length === 0) {
    if (method === "GET") {
      const limit = Number(searchParams.get("limit") ?? "");
      return {
        status: 200,
        payload: await searchLibrary({
          workspace,
          kind,
          query: (searchParams.get("q") ?? "").slice(0, 500),
          projectRef: project,
          limit: limit || undefined,
        }),
      };
    }
    if (method === "POST") return publishLibraryItem({ workspace, actor, kind, body: request.body });
  }

  if (rest[0] === "proposals" && rest.length === 1) {
    if (method === "GET") {
      return {
        status: 200,
        payload: await listLibraryProposals({
          workspace,
          kind,
          projectRef: project,
          state: parseState(searchParams.get("state")),
          mine: searchParams.get("mine") === "1" || searchParams.get("mine") === "true",
        }),
      };
    }
    if (method === "POST") return createLibraryProposal({ workspace, actor, kind, body: request.body });
  }

  if (kind === "theme" && rest.length === 1 && rest[0] === "active") {
    if (method === "GET") return { status: 200, payload: await getActiveTheme({ workspace, projectRef: project }) };
    if (method === "POST") return setActiveTheme({ workspace, actor, body: request.body });
    throw unknownRoute();
  }
  if (kind === "theme" || kind === "widget") {
    const tools = await routeWidgetsToolsRequest(request);
    if (tools) return tools;
  }

  if (rest.length === 1 && method === "GET") {
    return {
      status: 200,
      payload: await showLibraryItem({ workspace, kind, scopeRef: null, slug: rest[0] ?? "", projectRef: project }),
    };
  }

  const [scopeRef = "", slug = "", section, ...tail] = rest;
  const item = { workspace, kind, scopeRef, slug };
  if (rest.length === 2 && method === "GET") {
    const version = parseVersion(searchParams.get("version"));
    return { status: 200, payload: await showLibraryItem({ ...item, version }) };
  }
  if (section === "versions" && tail.length === 0 && method === "GET") {
    return { status: 200, payload: await listLibraryVersions(item) };
  }
  if (section === "archive" && tail.length === 0 && method === "POST") {
    return { status: 200, payload: await archiveLibraryItem({ ...item, actor }) };
  }
  if (kind !== "skill" && (section === "pins" || section === "pin" || section === "unpin")) throw unknownRoute();
  if (section === "pins" && tail.length === 0 && method === "GET") {
    return { status: 200, payload: await listItemPins(item) };
  }
  if (section === "pin" && tail.length === 0 && method === "POST") return pinLibraryItem({ ...item, actor, body: request.body });
  if (section === "unpin" && tail.length === 0 && method === "POST") return unpinLibraryItem({ ...item, actor, body: request.body });
  if (section === "versions" && tail.length === 2 && tail[1] === "revert" && method === "POST") {
    return revertLibraryItem({ ...item, actor, version: parseNumber(tail[0], "version"), body: request.body });
  }
  if (kind === "widget" && section === "versions" && tail.length === 2 && tail[1] === "audit" && method === "POST") {
    return recordWidgetScriptAudit({ workspace, actor, scopeRef, slug, version: parseNumber(tail[0], "version"), body: request.body });
  }
  if (section === "proposals") {
    if (tail.length === 0 && method === "GET") return { status: 200, payload: await listItemProposals(item) };
    if (tail.length === 0) throw unknownRoute();
    const proposal = { ...item, actor, number: parseNumber(tail[0], "proposal"), body: request.body };
    const [, action, commentId, commentAction] = tail;
    if (tail.length === 1 && method === "GET") return { status: 200, payload: await showLibraryProposal(proposal) };
    if (method !== "POST") throw unknownRoute();
    if (tail.length === 2) {
      switch (action) {
        case "update":
          return updateLibraryProposal(proposal);
        case "submit":
          return submitLibraryProposal(proposal);
        case "withdraw":
          return withdrawLibraryProposal(proposal);
        case "publish":
          return publishLibraryProposal(proposal);
        case "reject":
          return rejectLibraryProposal(proposal);
        case "comments":
          return commentOnLibraryProposal(proposal);
      }
    }
    if (tail.length === 4 && action === "comments" && commentId && (commentAction === "resolve" || commentAction === "reopen")) {
      return setLibraryCommentResolved({ ...proposal, commentId, resolved: commentAction === "resolve" });
    }
  }
  throw unknownRoute();
}

function optionalParam(params: URLSearchParams, key: string) {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

function parseVersion(value: string | null) {
  if (value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw cliApiError(400, "PAYLOAD_INVALID", "version must be a positive integer.");
  return number;
}

function parseNumber(value: string | undefined, what: string) {
  const number = Number(value);
  if (!value || !Number.isInteger(number) || number < 1) throw cliApiError(404, "NOT_FOUND", `Unknown ${what} number.`);
  return number;
}

function parseState(value: string | null): "open" | "closed" | "all" {
  if (value === null || value === "" || value === "open") return "open";
  if (value === "closed" || value === "all") return value;
  throw cliApiError(400, "PAYLOAD_INVALID", "state is open, closed or all.");
}

/** The Console's public origin for links, falling back to the request's. */
export function libraryOrigin(requestUrl: string) {
  const configured = process.env.NEXT_PUBLIC_CONSOLE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request's origin
    }
  }
  return new URL(requestUrl).origin;
}

function unknownRoute() {
  return cliApiError(404, "NOT_FOUND", "Unknown library route.");
}
