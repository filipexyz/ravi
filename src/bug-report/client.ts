import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { type BugReportDossier, requireCompleteBugReportDossier } from "./schema.js";

export const BUG_REPORT_API_PATH = "/api/cli/bugs";

export interface BugReportClientOptions {
  console?: string;
}

export interface BugReportClientDeps {
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
        {
          ...dossier,
          source: options.source ?? "cli",
        },
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
  const bug = await new RaviBugReportClient(auth.client).submit(auth.accessToken, options);
  const id = bugIdFromPayload(bug) ?? "submitted";
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    bug,
    id,
    url: trackingUrl(auth.consoleUrl, bug, id),
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
  return stringValue(payload.url) ?? stringValue(payload.trackingUrl) ?? `${consoleUrl}/bugs/${id}`;
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
