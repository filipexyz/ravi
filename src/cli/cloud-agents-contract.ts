/**
 * Contract helpers for `ravi cloud key|agents|runs|schedules` and
 * `ravi tasks dispatch --cloud`: the error envelope for Console cloud agents
 * failures, argument checks shared by the commands, and their return schemas.
 * Kept out of `src/cli/commands/` because every file there is re-exported by
 * the generated barrel.
 *
 * spec: cloud/agents, cli
 */

import { z } from "zod";

import {
  cloudAgentsLoginRequiredError,
  openCloudAgentsSession,
  type CloudAgentsSession,
  type CloudAgentsSessionOptions,
} from "../cloud-agents/client.js";
import {
  CLOUD_BUDGET_MAX_USD,
  CLOUD_BUDGET_MIN_USD,
  isCloudBudget,
  isCloudRepository,
} from "../cloud-agents/definition.js";
import { CloudAuthError, isCloudAuthError } from "../cloud-auth/errors.js";
import { LibraryCommandError } from "../library/service.js";
import {
  CONTRACT_EXIT_ERROR,
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  ContractError,
  contractFail,
  renderContractError,
  sanitizePublicContractMessage,
} from "./agent-contract.js";
import { cloudErrorToContractError } from "./cloud-error-contract.js";

export type OpenCloudAgentsSession = (options: CloudAgentsSessionOptions) => Promise<CloudAgentsSession | null>;

/** Longest prompt or reply the CLI sends (characters). */
export const CLOUD_PROMPT_MAX_CHARS = 50_000;

interface ConsoleCodeCopy {
  code: string;
  exitCode: number;
  message: string;
  suggestedAction: string;
  retryable?: boolean;
}

/** Console cloud agents codes (lowercase or uppercase on the wire) and what each means here. */
const CONSOLE_CODES: Record<string, ConsoleCodeCopy> = {
  CLOUD_AGENTS_UNCONFIGURED: {
    code: "CLOUD_AGENTS_UNCONFIGURED",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "Cloud agents are not configured on this Console yet.",
    suggestedAction: "Ask whoever runs the Console to configure cloud agents, then retry",
  },
  CLOUD_AGENTS_NOT_ENABLED: {
    code: "CLOUD_AGENTS_NOT_ENABLED",
    exitCode: CONTRACT_EXIT_POLICY,
    message: "Cloud agents are not enabled for this organization.",
    suggestedAction: "Ask an owner or admin of the organization to have cloud agents enabled",
  },
  CLOUD_CREDENTIAL_MISSING: {
    code: "CLOUD_CREDENTIAL_MISSING",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "The organization has no Anthropic API key for cloud agents.",
    suggestedAction:
      "An owner or admin sets it: ravi cloud key set --stdin --execute < <file-with-the-key> (or in the Console settings)",
  },
  CLOUD_CREDENTIAL_INVALID: {
    code: "CLOUD_CREDENTIAL_INVALID",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "Anthropic refused the organization's API key.",
    suggestedAction: "An owner or admin replaces it: ravi cloud key set --stdin --execute < <file-with-the-key>",
  },
  CLOUD_AGENT_DEFINITION_INVALID: {
    code: "CLOUD_AGENT_DEFINITION_INVALID",
    exitCode: CONTRACT_EXIT_USAGE,
    message: "The Library agent cannot run in the cloud as published.",
    suggestedAction: "Fix the cloud block in the agent's agent.json and publish it again (ravi agents publish)",
  },
  CLOUD_AGENT_PROVIDER_UNSUPPORTED: {
    code: "CLOUD_AGENT_PROVIDER_UNSUPPORTED",
    exitCode: CONTRACT_EXIT_USAGE,
    message: "The Library agent's provider or model cannot run in the cloud.",
    suggestedAction: "Set cloud.model to opus, sonnet, haiku or a claude-* id in agent.json and publish again",
  },
  CLOUD_AGENT_REPOSITORY_UNAVAILABLE: {
    code: "CLOUD_AGENT_REPOSITORY_UNAVAILABLE",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "A repository is not covered by the organization's GitHub App.",
    suggestedAction: "Add the repository to the organization's GitHub App in the Console, or drop --repo",
  },
  CLOUD_RUN_NOT_ACTIVE: {
    code: "CLOUD_RUN_NOT_ACTIVE",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "The run is no longer active.",
    suggestedAction: "Check it with: ravi cloud runs show <run>",
  },
  FORBIDDEN: {
    code: "CLOUD_AGENTS_FORBIDDEN",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "Your role in the organization does not allow this.",
    suggestedAction: "Owners, admins and developers run and deploy; only owners and admins set the key",
  },
  VALIDATION_FAILED: {
    code: "VALIDATION_FAILED",
    exitCode: CONTRACT_EXIT_USAGE,
    message: "The Console refused the input.",
    suggestedAction: "Correct the command input and retry",
  },
  IDEMPOTENCY_CONFLICT: {
    code: "IDEMPOTENCY_CONFLICT",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "A run with this idempotency key already exists with different input.",
    suggestedAction: "Use another --idempotency-key, or read the existing run",
  },
  PROVIDER_ERROR: {
    code: "CLOUD_PROVIDER_ERROR",
    exitCode: CONTRACT_EXIT_ERROR,
    message: "The cloud provider failed.",
    suggestedAction: "Retry in a moment; ravi cloud runs show <run> has the details",
    retryable: true,
  },
};

/** The contract error for a Console cloud agents failure (`notFoundCode` names the missing thing). */
export function cloudAgentsErrorToContract(
  op: string,
  error: CloudAuthError,
  options: { notFoundCode?: string } = {},
): ContractError {
  const consoleCode = error.consoleCode ?? error.code;
  const copy = CONSOLE_CODES[consoleCode];
  if (copy) {
    return new ContractError(
      op,
      copy.code,
      sanitizePublicContractMessage(error.message) ?? copy.message,
      copy.exitCode,
      {
        retryable: copy.retryable ?? false,
        suggestedAction: copy.suggestedAction,
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.issues ? { issues: error.issues } : (consoleIssues(error) ?? {})),
        ...(typeof error.details?.runId === "string" ? { runId: error.details.runId.slice(0, 80) } : {}),
      },
    );
  }
  if (error.code === "NOT_FOUND" && options.notFoundCode) {
    return new ContractError(
      op,
      options.notFoundCode,
      sanitizePublicContractMessage(error.message) ?? "Not found.",
      CONTRACT_EXIT_ERROR,
      { suggestedAction: notFoundAction(options.notFoundCode) },
    );
  }
  return cloudErrorToContractError(op, error);
}

/** `validation_failed` and `cloud_agent_definition_invalid` carry `details.issues: [{ path, message }]`. */
function consoleIssues(error: CloudAuthError): { issues: Array<{ path: string; message: string }> } | null {
  const raw = error.details?.issues;
  if (!Array.isArray(raw)) return null;
  const issues = raw.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const issue = entry as { path?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path.join(".") : typeof issue.path === "string" ? issue.path : "";
    return typeof issue.message === "string"
      ? [{ path: path.slice(0, 200), message: issue.message.slice(0, 300) }]
      : [];
  });
  return issues.length > 0 ? { issues } : null;
}

function notFoundAction(code: string): string {
  if (code === "CLOUD_RUN_NOT_FOUND") return "List runs with: ravi cloud runs list --json";
  if (code === "CLOUD_SCHEDULE_NOT_FOUND") return "List schedules with: ravi cloud schedules list --json";
  if (code === "CLOUD_APPROVAL_NOT_FOUND") return "Read the run's approvals with: ravi cloud runs show <run> --json";
  return "List deployed agents with ravi cloud agents list, or Library agents with ravi agents search";
}

/** Run a command body; Console failures become one rendered contract error. */
export async function withCloudAgentsContract<T>(
  op: string,
  asJson: boolean | undefined,
  run: () => Promise<T>,
  options: { notFoundCode?: string } = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (error instanceof LibraryCommandError) {
      contractFail(op, error.code, error.message, { asJson, exitCode: error.exitCode, details: error.details });
    }
    if (isCloudAuthError(error)) {
      const contract = cloudAgentsErrorToContract(op, error, options);
      renderContractError(contract, asJson);
      throw contract;
    }
    throw error;
  }
}

/** The login's session, or the AUTH_REQUIRED failure. */
export async function requireCloudAgentsSession(
  options: CloudAgentsSessionOptions,
  open: OpenCloudAgentsSession = (sessionOptions) => openCloudAgentsSession(sessionOptions),
): Promise<CloudAgentsSession> {
  const session = await open(options);
  if (!session) throw cloudAgentsLoginRequiredError();
  return session;
}

export function requireCloudProject(op: string, session: CloudAgentsSession, asJson?: boolean): string {
  if (session.project) return session.project;
  contractFail(op, "CLOUD_PROJECT_REQUIRED", "No Console project resolved for this command.", {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: { suggestedAction: "Pass --project <project-slug> (list them with: ravi projects list)" },
  });
}

export function usageError(op: string, message: string, asJson: boolean | undefined, suggestedAction?: string): never {
  contractFail(op, "USAGE_ERROR", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    ...(suggestedAction ? { details: { suggestedAction } } : {}),
  });
}

/** Offset paging over a list the Console returns whole (agents and schedules of a project are few). */
export const cloudPaginationReturnSchema = z
  .object({
    limit: z.number(),
    offset: z.number(),
    returned: z.number(),
    total: z.number(),
    hasMore: z.boolean(),
    nextOffset: z.number().nullable(),
    nextCommand: z.string().nullable(),
  })
  .strict();

export function pageCloudList<T>(
  op: string,
  items: readonly T[],
  input: { limit?: string; offset?: string; command: string },
  asJson?: boolean,
): { items: T[]; pagination: z.infer<typeof cloudPaginationReturnSchema> } {
  const parse = (flag: string, value: string | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined || value.trim() === "") return fallback;
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      usageError(op, `${flag} must be an integer from ${min} to ${max}.`, asJson);
    }
    return parsed;
  };
  const limit = parse("--limit", input.limit, 50, 1, 200);
  const offset = parse("--offset", input.offset, 0, 0, 1_000_000);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < items.length ? offset + page.length : null;
  return {
    items: page,
    pagination: {
      limit,
      offset,
      returned: page.length,
      total: items.length,
      hasMore: nextOffset !== null,
      nextOffset,
      nextCommand: nextOffset !== null ? `${input.command} --limit ${limit} --offset ${nextOffset} --json` : null,
    },
  };
}

export function parseCloudBudget(op: string, value: string | undefined, asJson?: boolean): number | undefined {
  if (value === undefined) return undefined;
  const budget = Number(String(value).trim().replace(/^\$/, ""));
  if (!isCloudBudget(budget)) {
    usageError(
      op,
      `--budget must be a number of US dollars from ${CLOUD_BUDGET_MIN_USD} to ${CLOUD_BUDGET_MAX_USD}.`,
      asJson,
    );
  }
  return budget;
}

/** `--repo owner/name[@branch]`, repeatable or comma-separated. */
export function parseCloudRepos(
  op: string,
  values: string[] | string | undefined,
  asJson?: boolean,
): Array<{ repo: string; branch?: string }> | undefined {
  if (values === undefined) return undefined;
  const list = (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const repositories: Array<{ repo: string; branch?: string }> = [];
  for (const entry of list) {
    const [repo, branch] = entry.split("@", 2);
    if (!repo || !isCloudRepository(repo) || (branch !== undefined && !/^[A-Za-z0-9._/-]{1,200}$/.test(branch))) {
      usageError(op, `--repo takes owner/name or owner/name@branch, not '${entry.slice(0, 80)}'.`, asJson);
    }
    if (!repositories.some((existing) => existing.repo === repo)) {
      repositories.push({ repo, ...(branch ? { branch } : {}) });
    }
  }
  return repositories.length > 0 ? repositories : undefined;
}

export function requirePromptText(op: string, label: string, value: string | undefined, asJson?: boolean): string {
  const text = value?.trim() ?? "";
  if (!text) usageError(op, `${label} is empty.`, asJson);
  if (text.length > CLOUD_PROMPT_MAX_CHARS) {
    usageError(op, `${label} is longer than ${CLOUD_PROMPT_MAX_CHARS} characters.`, asJson);
  }
  return text;
}

export function formatUsd(value: number | null): string {
  if (value === null) return "-";
  return `US$ ${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${Math.round(seconds % 60)}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

// ---------------------------------------------------------------------------
// Return schemas

const userRefSchema = z.object({ id: z.string(), name: z.string().nullable() }).strict();

export const cloudCredentialReturnSchema = z
  .object({
    provider: z.string(),
    configured: z.boolean(),
    keyHint: z.string().nullable(),
    status: z.string(),
    verifiedAt: z.string().nullable(),
    monthlyAlertUsd: z.number().nullable(),
    monthCostUsd: z.number(),
  })
  .strict();

export const cloudAgentReturnSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    library: z
      .object({ itemId: z.string(), slug: z.string(), scope: z.string(), version: z.number().nullable() })
      .strict(),
    provider: z.string(),
    model: z.string().nullable(),
    status: z.string(),
    deployedAt: z.string().nullable(),
    deployedBy: userRefSchema.nullable(),
    lastError: z.string().nullable(),
    config: z
      .object({
        budgetUsd: z.number(),
        networking: z.string(),
        webSearch: z.boolean(),
        writes: z.string(),
        raviMcp: z.boolean(),
        mcpServers: z.array(z.string()),
        repositories: z.array(z.string()),
        schedule: z.object({ cron: z.string(), timezone: z.string() }).strict().nullable(),
      })
      .strict(),
  })
  .strict();

export const cloudApprovalReturnSchema = z
  .object({
    id: z.string(),
    tool: z.string(),
    server: z.string().nullable(),
    inputPreview: z.string().nullable(),
    status: z.string(),
    requestedAt: z.string().nullable(),
    decidedAt: z.string().nullable(),
    decidedBy: userRefSchema.nullable(),
  })
  .strict();

export const cloudRunReturnSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    projectId: z.string(),
    status: z.string(),
    trigger: z.string(),
    actor: userRefSchema,
    prompt: z.string(),
    result: z.string().nullable(),
    budgetUsd: z.number().nullable(),
    costUsd: z.number(),
    runningSeconds: z.number(),
    tokens: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }).strict(),
    approvals: z.array(cloudApprovalReturnSchema),
    outputs: z.array(z.object({ id: z.string(), name: z.string(), size: z.number() }).strict()),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
    origin: z
      .object({
        kind: z.string(),
        installationId: z.string().nullable(),
        sessionName: z.string().nullable(),
        taskId: z.string().nullable(),
        delivery: z.string().nullable(),
        deliveredAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
    url: z.string().nullable(),
  })
  .strict();

export const cloudRunEventReturnSchema = z
  .object({
    seq: z.number(),
    at: z.string().nullable(),
    type: z.string(),
    role: z.string().nullable(),
    text: z.string().nullable(),
    tool: z.string().nullable(),
    status: z.string().nullable(),
  })
  .strict();

export const cloudScheduleReturnSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    cron: z.string(),
    timezone: z.string(),
    prompt: z.string().nullable(),
    budgetUsd: z.number().nullable(),
    enabled: z.boolean(),
    actor: userRefSchema,
    nextRunAt: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    lastRunId: z.string().nullable(),
  })
  .strict();
