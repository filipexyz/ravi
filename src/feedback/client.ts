import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";

export type FeedbackKind = "bug" | "idea" | "ux" | "docs" | "performance" | "security" | "other";
export type FeedbackSeverity = "low" | "medium" | "high" | "critical";
export type FeedbackSource = "console" | "cli" | "agent";

export interface FeedbackSubmitOptions {
  console?: string;
  kind?: string;
  message: string;
  metadata?: Record<string, unknown>;
  project?: string;
  severity?: string;
  source?: FeedbackSource;
  surface?: string;
  tags?: string[];
  title?: string;
  url?: string;
}

export interface FeedbackClientDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface FeedbackSubmitResult {
  success: true;
  consoleUrl: string;
  feedback: Record<string, unknown>;
  url: string;
}

export class RaviFeedbackClient {
  constructor(private readonly client: ConsoleApiClient) {}

  async submit(accessToken: string, options: FeedbackSubmitOptions): Promise<Record<string, unknown>> {
    try {
      return await this.client.requestJson<Record<string, unknown>>(
        "POST",
        "/api/cli/feedback",
        {
          kind: normalizeFeedbackKind(options.kind),
          severity: normalizeFeedbackSeverity(options.severity),
          title: nullableText(options.title),
          message: requireText(options.message, "message"),
          surface: nullableText(options.surface),
          projectRef: nullableText(options.project),
          url: nullableText(options.url),
          tags: normalizeTags(options.tags ?? []),
          source: options.source ?? "cli",
          ...(options.metadata ? { metadata: options.metadata } : {}),
        },
        accessToken,
      );
    } catch (error) {
      throw normalizeFeedbackError(error);
    }
  }
}

export async function submitFeedback(
  options: FeedbackSubmitOptions,
  deps: FeedbackClientDeps = {},
): Promise<FeedbackSubmitResult> {
  const auth = await createAuthenticatedFeedbackContext(options.console, deps);
  const feedback = await new RaviFeedbackClient(auth.client).submit(auth.accessToken, options);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    feedback,
    url: `${auth.consoleUrl}/org/feedback`,
  };
}

async function createAuthenticatedFeedbackContext(consoleUrl: string | undefined, deps: FeedbackClientDeps) {
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

export function normalizeFeedbackKind(value: string | undefined): FeedbackKind {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "other";
  if (
    normalized === "bug" ||
    normalized === "idea" ||
    normalized === "ux" ||
    normalized === "docs" ||
    normalized === "performance" ||
    normalized === "security" ||
    normalized === "other"
  ) {
    return normalized;
  }
  throw new CloudAuthError(
    "PAYLOAD_INVALID",
    "--kind must be one of: bug, idea, ux, docs, performance, security, other.",
  );
}

export function normalizeFeedbackSeverity(value: string | undefined): FeedbackSeverity {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "medium";
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "critical") {
    return normalized;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", "--severity must be one of: low, medium, high, critical.");
}

export function normalizeTags(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map(normalizeTag)
        .filter(Boolean),
    ),
  ].slice(0, 12);
}

function normalizeTag(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function nullableText(value: string | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function requireText(value: string | undefined, label: string) {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function normalizeFeedbackError(error: unknown): CloudAuthError {
  if (error instanceof CloudAuthError) return error;
  return new CloudAuthError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}
