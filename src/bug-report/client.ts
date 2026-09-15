import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import {
  BUG_STATUS_WATCH_TOPIC,
  type BugFollowTriggerDeps,
  type BugReportFollowResult,
  bugFollowFilter,
  bugReportSubscribeApiPath,
  ensureBugFollowTrigger,
} from "./follow.js";
import { type BugReportDossier, requireCompleteBugReportDossier } from "./schema.js";

export const BUG_REPORT_API_PATH = "/api/cli/bugs";
export { bugReportSubscribeApiPath } from "./follow.js";

export interface BugReportClientOptions {
  console?: string;
}

export interface BugReportClientDeps extends BugFollowTriggerDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface BugReportSubmitOptions extends BugReportClientOptions {
  dossier: BugReportDossier;
  source?: "cli" | "agent";
}

export interface BugReportSubmitResult {
  success: true;
  consoleUrl: string;
  bug: Record<string, unknown>;
  id: string;
  url: string;
  follow?: BugReportFollowResult;
}

export interface BugReportStatusResult {
  success: true;
  consoleUrl: string;
  bug: Record<string, unknown>;
  id: string;
  url: string;
}

export interface BugReportListResult {
  success: true;
  consoleUrl: string;
  bugs: Record<string, unknown>[];
}

export class RaviBugReportClient {
  constructor(private readonly client: ConsoleApiClient) {}

  async submit(accessToken: string, options: BugReportSubmitOptions): Promise<Record<string, unknown>> {
    const dossier = requireCompleteBugReportDossier(options.dossier);
    try {
      return await this.client.requestJson<Record<string, unknown>>(
        "POST",
        BUG_REPORT_API_PATH,
        toConsoleBugCreateBody(dossier, options.source),
        accessToken,
      );
    } catch (error) {
      throw normalizeBugReportError(error);
    }
  }

  async status(accessToken: string, id: string): Promise<Record<string, unknown>> {
    const bugId = requireBugId(id);
    try {
      return await this.client.requestJson<Record<string, unknown>>(
        "GET",
        `${BUG_REPORT_API_PATH}/${encodeURIComponent(bugId)}`,
        undefined,
        accessToken,
      );
    } catch (error) {
      throw normalizeBugReportError(error);
    }
  }

  async subscribe(
    accessToken: string,
    id: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const bugId = requireBugId(id);
    try {
      return await this.client.requestJson<Record<string, unknown>>(
        "POST",
        bugReportSubscribeApiPath(bugId),
        body,
        accessToken,
      );
    } catch (error) {
      throw normalizeBugReportError(error);
    }
  }

  async list(
    accessToken: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    try {
      const payload = await this.client.requestJson<unknown>(
        "GET",
        withQuery(BUG_REPORT_API_PATH, { limit: options.limit, offset: options.offset }),
        undefined,
        accessToken,
      );
      return extractBugList(payload);
    } catch (error) {
      throw normalizeBugReportError(error);
    }
  }
}

export async function submitBugReport(
  options: BugReportSubmitOptions,
  deps: BugReportClientDeps = {},
): Promise<BugReportSubmitResult> {
  const auth = await createAuthenticatedBugReportContext(options.console, deps);
  const api = new RaviBugReportClient(auth.client);
  const bug = await api.submit(auth.accessToken, options);
  const id = bugIdFromPayload(bug) ?? "submitted";
  const url = trackingUrl(auth.consoleUrl, bug, id);
  const follow = await followSubmittedBugReport(
    {
      accessToken: auth.accessToken,
      api,
      installationId: auth.installationId,
      bugId: id,
    },
    deps,
  );
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    bug,
    id,
    url,
    follow,
  };
}

/**
 * Post-create hook: subscribe this installation to the bug and arm a
 * per-bugId trigger. Failures are returned as `follow.warning` and MUST NOT
 * fail the create that already succeeded.
 */
export async function followSubmittedBugReport(
  input: {
    accessToken: string;
    api: RaviBugReportClient;
    installationId: string;
    bugId: string;
  },
  deps: BugFollowTriggerDeps = {},
): Promise<BugReportFollowResult> {
  const filter = bugFollowFilter(input.bugId);
  const topic = BUG_STATUS_WATCH_TOPIC;
  const warnings: string[] = [];
  let subscribed = false;
  let triggerId: string | undefined;
  let reused = false;

  try {
    await input.api.subscribe(input.accessToken, input.bugId, {
      installationId: input.installationId,
    });
    subscribed = true;
  } catch (error) {
    warnings.push(`Console subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const ensured = await ensureBugFollowTrigger(input.bugId, deps);
    triggerId = ensured.trigger.id;
    reused = ensured.reused;
  } catch (error) {
    warnings.push(`Follow trigger failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const warning = warnings.length > 0 ? warnings.join(" ") : undefined;
  return {
    ok: subscribed && Boolean(triggerId),
    subscribed,
    ...(triggerId ? { triggerId } : {}),
    reused,
    topic,
    filter,
    session: "main",
    ...(warning ? { warning } : {}),
  };
}

export async function getBugReportStatus(
  id: string,
  options: BugReportClientOptions = {},
  deps: BugReportClientDeps = {},
): Promise<BugReportStatusResult> {
  const auth = await createAuthenticatedBugReportContext(options.console, deps);
  const bug = await new RaviBugReportClient(auth.client).status(auth.accessToken, id);
  const resolvedId = bugIdFromPayload(bug) ?? requireBugId(id);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    bug,
    id: resolvedId,
    url: trackingUrl(auth.consoleUrl, bug, resolvedId),
  };
}

export async function listBugReports(
  options: BugReportClientOptions & { limit?: number; offset?: number } = {},
  deps: BugReportClientDeps = {},
): Promise<BugReportListResult> {
  const auth = await createAuthenticatedBugReportContext(options.console, deps);
  const bugs = await new RaviBugReportClient(auth.client).list(auth.accessToken, {
    limit: options.limit,
    offset: options.offset,
  });
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    bugs,
  };
}

async function createAuthenticatedBugReportContext(consoleUrl: string | undefined, deps: BugReportClientDeps) {
  const credentials = requireStoredCredentials((deps.readCredentials ?? readCloudCredentials)(), consoleUrl);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const auth = await getMeWithAutoRefresh({
    client,
    credentials,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });
  return {
    accessToken: auth.credentials.accessToken,
    client,
    consoleUrl: auth.credentials.consoleUrl,
    installationId: auth.credentials.installationId,
  };
}

function requireStoredCredentials(credentials: CloudCredentials | null, consoleUrl?: string): CloudCredentials {
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== credentials.consoleUrl) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalizeConsoleUrl(consoleUrl)}. Run \`ravi login --console ${normalizeConsoleUrl(
        consoleUrl,
      )}\`.`,
    );
  }
  return credentials;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a local `ravi.bug_report/v1` dossier onto Console `createBodySchema`.
 * Unknown top-level keys (including `source`) are stripped; the full dossier
 * is preserved under required `payload`. organizationId/projectId are sent
 * only when the dossier refs parse as UUIDs.
 */
export function toConsoleBugCreateBody(
  dossier: BugReportDossier,
  source: BugReportSubmitOptions["source"] = "cli",
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: dossier.schemaVersion,
    title: dossier.title,
    summary: dossier.summary,
    severity: dossier.severity,
    payload: {
      ...dossier,
      source: source ?? "cli",
    },
  };
  if (dossier.surface?.trim()) {
    body.surface = dossier.surface.trim();
  }
  const organizationId = asUuid(dossier.context?.organizationRef);
  const projectId = asUuid(dossier.context?.projectRef);
  if (organizationId) body.organizationId = organizationId;
  if (projectId) body.projectId = projectId;
  return body;
}

export function asUuid(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text || !UUID_PATTERN.test(text)) return undefined;
  return text.toLowerCase();
}

function requireBugId(value: string): string {
  const id = value.trim();
  if (!id) throw new CloudAuthError("PAYLOAD_INVALID", "Missing bug id.");
  return id;
}

function extractBugList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  const raw = payload.items ?? payload.bugs ?? payload.reports;
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function bugIdFromPayload(payload: Record<string, unknown>): string | null {
  return stringValue(payload.id) ?? stringValue(payload.bugId) ?? stringValue(payload.targetId);
}

function trackingUrl(consoleUrl: string, payload: Record<string, unknown>, id: string): string {
  return (
    stringValue(payload.url) ??
    stringValue(payload.trackingUrl) ??
    stringValue(payload.consoleUrl) ??
    `${consoleUrl}/bugs/${id}`
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withQuery(path: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

function normalizeBugReportError(error: unknown): CloudAuthError {
  if (error instanceof CloudAuthError) return error;
  return new CloudAuthError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}
