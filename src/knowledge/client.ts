// Console Knowledge client: transport only (contract §10.4). The Console owns
// access, audiences, ranking and runs; this side sends the turn's exec context
// and reads with the `ravi login` credentials.
//
//   POST /api/cli/knowledge/search
//   POST /api/cli/knowledge/read
//   GET  /api/cli/knowledge/runs?turnKey=&session=&limit=
//   GET  /api/cli/knowledge/runs/<id>
//   GET  /api/cli/knowledge/sources?failing=1&limit=&cursor=
//   GET  /api/cli/knowledge/marks?url=
//   POST /api/cli/knowledge/proposals
//   GET  /api/cli/knowledge/proposals/<id>
//   GET  /api/cli/knowledge/digest?since=
//   POST /api/cli/knowledge/mirror
//
// A Console without these routes answers a 404 with no CLI error code; that
// arrives as `KNOWLEDGE_UNAVAILABLE` (src/cloud-auth/client.ts).

import { ConsoleApiClient, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, classifyConsoleNetworkError, isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { inspectExecutionPlane } from "../isolation/execution-plane.js";
import { EXEC_CONTEXT_HEADER, encodeExecContextHeader, type ExecContextV1 } from "../link/connector-turn.js";
import type {
  ConsoleDigest,
  ConsoleMarksResponse,
  ConsoleMirror,
  ConsoleProposalCreate,
  ConsoleProposalView,
  ConsoleReadResponse,
  ConsoleRunDetail,
  ConsoleRunSummary,
  ConsoleSearchRequest,
  ConsoleSearchResponse,
  ConsoleSourcesResponse,
  KnowledgeTurn,
} from "./types.js";

export const KNOWLEDGE_PATH = "/api/cli/knowledge";

/** Console failures that mean "could not reach Knowledge": local results may answer instead. */
export const KNOWLEDGE_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "SERVER_UNAVAILABLE",
  "HOST_UNREACHABLE",
  "RATE_LIMITED",
  "KNOWLEDGE_UNAVAILABLE",
]);

export function isConsoleUnavailable(error: unknown): error is CloudAuthError {
  return isCloudAuthError(error) && KNOWLEDGE_UNAVAILABLE_CODES.has(error.code);
}

/**
 * The installation's own jobs (mirror sync, gap upload, digest, inbox handler)
 * run outside any agent turn and send the terminal form.
 */
export const DAEMON_KNOWLEDGE_TURN: KnowledgeTurn = Object.freeze({
  audience: "operator",
  turnKey: null,
  sessionName: null,
  agentId: null,
  execContext: Object.freeze({
    v: 1,
    speaker: Object.freeze({ kind: "terminal" }),
    conversation: "terminal",
  }) as ExecContextV1,
}) as KnowledgeTurn;

export interface KnowledgeClient {
  consoleUrl: string;
  orgId: string;
  installationId: string;
  scopes: string[];
  search(body: ConsoleSearchRequest, ctx: KnowledgeTurn): Promise<ConsoleSearchResponse>;
  read(body: { ref: string; around?: number }, ctx: KnowledgeTurn): Promise<ConsoleReadResponse>;
  runs(
    query: { turnKey?: string; session?: string; limit?: number },
    ctx: KnowledgeTurn,
  ): Promise<{ runs: ConsoleRunSummary[] }>;
  run(id: string, ctx: KnowledgeTurn): Promise<ConsoleRunDetail>;
  sources(
    query: { failing?: boolean; limit?: number; cursor?: string },
    ctx: KnowledgeTurn,
  ): Promise<ConsoleSourcesResponse>;
  marks(query: { url?: string }, ctx: KnowledgeTurn): Promise<ConsoleMarksResponse>;
  createProposal(
    body: ConsoleProposalCreate,
    ctx: KnowledgeTurn,
  ): Promise<{ proposal: ConsoleProposalView; deduped: boolean }>;
  getProposal(id: string, ctx: KnowledgeTurn): Promise<{ proposal: ConsoleProposalView }>;
  digest(query: { since?: string }, ctx: KnowledgeTurn): Promise<ConsoleDigest>;
  mirror(
    body: { instances: Array<{ id: string; label: string; channel: string }> },
    ctx: KnowledgeTurn,
  ): Promise<ConsoleMirror>;
}

export interface KnowledgeClientDeps {
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  fetch?: typeof fetch;
  /** Overrides the transport entirely (tests). */
  client?: ConsoleApiClient;
}

/** A client bound to the `ravi login` session, or null when there is no login. */
export async function openKnowledgeClient(deps: KnowledgeClientDeps = {}): Promise<KnowledgeClient | null> {
  const readCredentials = deps.readCredentials ?? readCloudCredentials;
  let credentials: CloudCredentials | null;
  try {
    credentials = readCredentials();
  } catch {
    credentials = null;
  }
  if (!credentials?.accessToken) return null;
  const transport =
    deps.client ??
    new ConsoleApiClient({
      consoleUrl: credentials.consoleUrl,
      ...(deps.fetch ? { fetch: deps.fetch as (url: string, init?: RequestInit) => Promise<Response> } : {}),
    });
  return new ConsoleKnowledgeClient(transport, credentials, {
    read: () => readCredentials(),
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });
}

/** The exec context as sent: never a Console user id (contract §4.1). */
export function knowledgeExecContextHeader(context: ExecContextV1): string {
  const { consoleUserId: _ignored, ...speaker } = context.speaker;
  return encodeExecContextHeader({ ...context, speaker });
}

class ConsoleKnowledgeClient implements KnowledgeClient {
  readonly consoleUrl: string;
  readonly orgId: string;
  readonly installationId: string;
  readonly scopes: string[];
  private credentials: CloudCredentials;

  constructor(
    private readonly transport: ConsoleApiClient,
    credentials: CloudCredentials,
    private readonly store: {
      read: () => CloudCredentials | null;
      write: (credentials: CloudCredentials) => void;
      delete: () => void;
    },
  ) {
    this.credentials = credentials;
    this.consoleUrl = credentials.consoleUrl;
    this.orgId = credentials.organization?.id?.trim() || credentials.organization?.slug?.trim() || "default";
    this.installationId = credentials.installationId;
    this.scopes = Array.isArray(credentials.scopes) ? [...credentials.scopes] : [];
  }

  search(body: ConsoleSearchRequest, ctx: KnowledgeTurn): Promise<ConsoleSearchResponse> {
    return this.request<ConsoleSearchResponse>("POST", "/search", body, ctx);
  }

  read(body: { ref: string; around?: number }, ctx: KnowledgeTurn): Promise<ConsoleReadResponse> {
    return this.request<ConsoleReadResponse>("POST", "/read", body, ctx);
  }

  runs(
    query: { turnKey?: string; session?: string; limit?: number },
    ctx: KnowledgeTurn,
  ): Promise<{ runs: ConsoleRunSummary[] }> {
    return this.request<{ runs: ConsoleRunSummary[] }>(
      "GET",
      `/runs${queryString({ turnKey: query.turnKey, session: query.session, limit: query.limit })}`,
      undefined,
      ctx,
    );
  }

  run(id: string, ctx: KnowledgeTurn): Promise<ConsoleRunDetail> {
    return this.request<ConsoleRunDetail>("GET", `/runs/${encodeURIComponent(id)}`, undefined, ctx);
  }

  sources(
    query: { failing?: boolean; limit?: number; cursor?: string },
    ctx: KnowledgeTurn,
  ): Promise<ConsoleSourcesResponse> {
    return this.request<ConsoleSourcesResponse>(
      "GET",
      `/sources${queryString({ failing: query.failing ? "1" : undefined, limit: query.limit, cursor: query.cursor })}`,
      undefined,
      ctx,
    );
  }

  marks(query: { url?: string }, ctx: KnowledgeTurn): Promise<ConsoleMarksResponse> {
    return this.request<ConsoleMarksResponse>("GET", `/marks${queryString({ url: query.url })}`, undefined, ctx);
  }

  createProposal(
    body: ConsoleProposalCreate,
    ctx: KnowledgeTurn,
  ): Promise<{ proposal: ConsoleProposalView; deduped: boolean }> {
    return this.request<{ proposal: ConsoleProposalView; deduped: boolean }>("POST", "/proposals", body, ctx);
  }

  getProposal(id: string, ctx: KnowledgeTurn): Promise<{ proposal: ConsoleProposalView }> {
    return this.request<{ proposal: ConsoleProposalView }>(
      "GET",
      `/proposals/${encodeURIComponent(id)}`,
      undefined,
      ctx,
    );
  }

  digest(query: { since?: string }, ctx: KnowledgeTurn): Promise<ConsoleDigest> {
    return this.request<ConsoleDigest>("GET", `/digest${queryString({ since: query.since })}`, undefined, ctx);
  }

  mirror(
    body: { instances: Array<{ id: string; label: string; channel: string }> },
    ctx: KnowledgeTurn,
  ): Promise<ConsoleMirror> {
    return this.request<ConsoleMirror>("POST", "/mirror", body, ctx);
  }

  private async request<T>(method: string, relativePath: string, body: unknown, ctx: KnowledgeTurn): Promise<T> {
    const path = `${KNOWLEDGE_PATH}${relativePath}`;
    const headers = { [EXEC_CONTEXT_HEADER]: knowledgeExecContextHeader(ctx.execContext) };
    const send = (token: string) => this.transport.requestJson<T>(method, path, body, token, headers);
    try {
      try {
        return await send(this.credentials.accessToken);
      } catch (error) {
        if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
      }
      // Another process may have refreshed (and rotated the refresh token)
      // since this client read the login: use what is stored first.
      const stored = this.readStoredLogin();
      if (stored && stored.refreshToken !== this.credentials.refreshToken) {
        this.credentials = stored;
        try {
          return await send(stored.accessToken);
        } catch (error) {
          if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
        }
      }
      this.credentials = await refreshCredentialsForStore({
        client: this.transport,
        credentials: this.credentials,
        write: this.store.write,
        delete: this.store.delete,
      });
      return await send(this.credentials.accessToken);
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      throw classifyConsoleNetworkError(error, inspectExecutionPlane());
    }
  }

  /** The stored login when it is this same login (Console, installation, user); otherwise null. */
  private readStoredLogin(): CloudCredentials | null {
    let stored: CloudCredentials | null;
    try {
      stored = this.store.read();
    } catch {
      return null;
    }
    const current = this.credentials;
    if (
      !stored?.refreshToken ||
      stored.consoleUrl !== current.consoleUrl ||
      stored.installationId !== current.installationId ||
      (stored.user?.id ?? null) !== (current.user?.id ?? null)
    ) {
      return null;
    }
    return stored;
  }
}

function queryString(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}
