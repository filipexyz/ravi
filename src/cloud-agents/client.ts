// Console cloud agents client: transport only. The Console owns the provider,
// the org's key, budgets, approvals and who may do what (spec `cloud/agents`
// here, `console/managed-runtime/claude-managed-agents` in the Console); this
// side calls it with the `ravi login` credentials.
//
//   GET  /api/cli/cloud-agents/credential
//   POST /api/cli/cloud-agents/credential
//   POST /api/cli/cloud-agents/credential/remove
//   GET  /api/cli/cloud-agents/agents?project=
//   POST /api/cli/cloud-agents/agents/deploy
//   GET  /api/cli/cloud-agents/agents/<id>
//   POST /api/cli/cloud-agents/agents/<id>/archive
//   POST /api/cli/cloud-agents/runs
//   GET  /api/cli/cloud-agents/runs?project=&agent=&status=&cursor=&origin=installation
//   GET  /api/cli/cloud-agents/runs/<id>
//   GET  /api/cli/cloud-agents/runs/<id>/events?after=
//   POST /api/cli/cloud-agents/runs/<id>/messages
//   POST /api/cli/cloud-agents/runs/<id>/stop
//   POST /api/cli/cloud-agents/runs/<id>/approvals/<approvalId>
//   GET  /api/cli/cloud-agents/runs/<id>/outputs/<outputId>   (bytes)
//   POST /api/cli/cloud-agents/runs/<id>/delivered            { kind?: "result" }
//   POST /api/cli/cloud-agents/runs/<id>/questions/<questionId> { answer }
//   GET  /api/cli/cloud-agents/runs/by-thread?key=
//   POST /api/cli/cloud-agents/runs/by-thread/messages        { key, text }
//   GET  /api/cli/cloud-agents/schedules?project=
//   POST /api/cli/cloud-agents/schedules
//   POST /api/cli/cloud-agents/schedules/<id>
//   POST /api/cli/cloud-agents/schedules/<id>/delete

import { ConsoleApiClient, normalizeConsoleUrl, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { CloudAuthError, classifyConsoleNetworkError, isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { resolveConsoleScope, type ConsoleScopeResolverDeps } from "../console-scope/resolver.js";
import { inspectExecutionPlane } from "../isolation/execution-plane.js";
import type {
  CloudAgent,
  CloudApproval,
  CloudCredential,
  CloudDelivery,
  CloudQuestion,
  CloudRun,
  CloudRunEvent,
  CloudRunOrigin,
  CloudRunOutcome,
  CloudRunStartBody,
  CloudSchedule,
  CloudScheduleBody,
  CloudUserRef,
} from "./types.js";

export const CLOUD_AGENTS_PATH = "/api/cli/cloud-agents";

interface CredentialHolder {
  current: CloudCredentials;
}

export interface CloudAgentsClientSession {
  client: ConsoleApiClient;
  credentials: CloudCredentials;
  write: typeof writeCloudCredentials;
  delete: typeof deleteCloudCredentials;
  /** Reads the stored login, to pick up a refresh done elsewhere before refreshing again. */
  read?: () => CloudCredentials | null;
}

export class CloudAgentsClient {
  private readonly holder: CredentialHolder;

  constructor(private readonly session: CloudAgentsClientSession) {
    this.holder = { current: session.credentials };
  }

  get consoleUrl(): string {
    return this.holder.current.consoleUrl;
  }

  // -------------------------------------------------------------------------
  // Credential (the org's Anthropic key; never returned, only its hint)

  async getCredential(): Promise<CloudCredential> {
    return requireCredential(objectValue(await this.request<unknown>("GET", "/credential"))?.credential);
  }

  async setCredential(body: {
    provider: "anthropic";
    apiKey: string;
    monthlyAlertUsd?: number;
  }): Promise<CloudCredential> {
    return requireCredential(objectValue(await this.request<unknown>("POST", "/credential", body))?.credential);
  }

  async removeCredential(): Promise<CloudCredential> {
    const payload = objectValue(await this.request<unknown>("POST", "/credential/remove", {}));
    return payload?.credential
      ? requireCredential(payload.credential)
      : {
          provider: "anthropic",
          configured: false,
          keyHint: null,
          status: "missing",
          verifiedAt: null,
          monthlyAlertUsd: null,
          monthCostUsd: 0,
        };
  }

  // -------------------------------------------------------------------------
  // Agents

  async listAgents(project: string): Promise<CloudAgent[]> {
    const payload = objectValue(await this.request<unknown>("GET", `/agents${query({ project })}`));
    if (!payload || !Array.isArray(payload.agents)) throw unexpected("agent list");
    return payload.agents.map(requireAgent);
  }

  async getAgent(id: string): Promise<CloudAgent> {
    return requireAgent(objectValue(await this.request<unknown>("GET", `/agents/${segment(id)}`))?.agent);
  }

  /** `201 { agent, changed: true, warnings }` when something changed, `200` with `changed: false` when not. */
  async deployAgent(body: { project: string; agent: string; version?: number }): Promise<{
    agent: CloudAgent;
    changed: boolean;
    warnings: string[];
  }> {
    const payload = objectValue(await this.request<unknown>("POST", "/agents/deploy", body));
    return {
      agent: requireAgent(payload?.agent),
      changed: payload?.changed !== false,
      warnings: stringArray(payload?.warnings).slice(0, 50),
    };
  }

  async archiveAgent(id: string): Promise<CloudAgent | null> {
    const payload = objectValue(await this.request<unknown>("POST", `/agents/${segment(id)}/archive`, {}));
    return payload?.agent ? requireAgent(payload.agent) : null;
  }

  // -------------------------------------------------------------------------
  // Runs

  async startRun(body: CloudRunStartBody): Promise<CloudRun> {
    return this.requireRunOf(await this.request<unknown>("POST", "/runs", body));
  }

  async listRuns(
    input: {
      project?: string | null;
      /** A cloud agent id (the Console filters by id only). */
      agent?: string;
      status?: string;
      cursor?: string;
      /** Page size, 1-100 (Console default 25). */
      limit?: number;
      origin?: "installation";
    } = {},
  ): Promise<{ runs: CloudRun[]; cursor: string | null }> {
    const payload = objectValue(
      await this.request<unknown>(
        "GET",
        `/runs${query({
          project: input.project ?? undefined,
          agent: input.agent,
          status: input.status,
          cursor: input.cursor,
          limit: input.limit !== undefined ? String(input.limit) : undefined,
          origin: input.origin,
        })}`,
      ),
    );
    if (!payload || !Array.isArray(payload.runs)) throw unexpected("run list");
    return {
      runs: payload.runs.map((run) => requireRun(run, this.consoleUrl)),
      cursor: stringOrNull(payload.cursor),
    };
  }

  async getRun(id: string): Promise<CloudRun> {
    return this.requireRunOf(await this.request<unknown>("GET", `/runs/${segment(id)}`));
  }

  async listEvents(id: string, after?: string | null): Promise<{ events: CloudRunEvent[]; cursor: string | null }> {
    const payload = objectValue(
      await this.request<unknown>("GET", `/runs/${segment(id)}/events${query({ after: after ?? undefined })}`),
    );
    if (!payload || !Array.isArray(payload.events)) throw unexpected("event list");
    const events = payload.events.flatMap((event) => {
      const normalized = normalizeEvent(event);
      return normalized ? [normalized] : [];
    });
    const cursor = stringOrNull(payload.cursor) ?? (typeof payload.cursor === "number" ? String(payload.cursor) : null);
    return { events, cursor };
  }

  async sendMessage(id: string, text: string): Promise<CloudRun | null> {
    return this.optionalRunOf(await this.request<unknown>("POST", `/runs/${segment(id)}/messages`, { text }));
  }

  async stopRun(id: string): Promise<CloudRun | null> {
    return this.optionalRunOf(await this.request<unknown>("POST", `/runs/${segment(id)}/stop`, {}));
  }

  async decideApproval(
    id: string,
    approvalId: string,
    body: { decision: "approve" | "deny"; reason?: string },
  ): Promise<{ run: CloudRun | null; approval: CloudApproval | null }> {
    const payload = await this.request<unknown>("POST", `/runs/${segment(id)}/approvals/${segment(approvalId)}`, body);
    const record = objectValue(payload);
    return {
      run: this.optionalRunOf(payload),
      approval: record?.approval ? normalizeApproval(record.approval) : null,
    };
  }

  /** The bytes of one output (the Console proxies them; never a provider URL). */
  async downloadOutput(id: string, outputId: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const path = `${CLOUD_AGENTS_PATH}/runs/${segment(id)}/outputs/${segment(outputId)}`;
    return this.withAuth((token) => this.session.client.requestBytes(path, token));
  }

  /**
   * This installation took a run's result (the Console stops offering it). A
   * task run sends `{}` as before; a run delivered to a session sends `kind: "result"`.
   */
  async markDelivered(id: string, kind?: "result"): Promise<void> {
    await this.request<unknown>("POST", `/runs/${segment(id)}/delivered`, kind ? { kind } : {});
  }

  /** The run's person answers a question the agent asked (`ask_human`). */
  async answerQuestion(id: string, questionId: string, answer: string): Promise<CloudRun | null> {
    return this.optionalRunOf(
      await this.request<unknown>("POST", `/runs/${segment(id)}/questions/${segment(questionId)}`, { answer }),
    );
  }

  /** The run bound to a conversation key (thread = run), or null when none is. */
  async getRunByThread(key: string): Promise<CloudRun | null> {
    try {
      return this.optionalRunOf(await this.request<unknown>("GET", `/runs/by-thread${query({ key })}`));
    } catch (error) {
      if (isCloudAuthError(error) && (error.code === "NOT_FOUND" || error.status === 404)) return null;
      throw error;
    }
  }

  /** A message from the bound conversation to its run (same authorization as `messages`). */
  async sendThreadMessage(key: string, text: string): Promise<CloudRun | null> {
    return this.optionalRunOf(await this.request<unknown>("POST", "/runs/by-thread/messages", { key, text }));
  }

  /**
   * The local contact a Console user linked on this installation (`ravi link`),
   * or null. The Console answers only for this login's installation.
   */
  async resolveLinkedContact(consoleUserId: string): Promise<string | null> {
    const binding = await this.withAuth((token) => this.session.client.resolveActorBinding({ consoleUserId }, token));
    return binding?.consoleUserId === consoleUserId ? binding.contactId : null;
  }

  // -------------------------------------------------------------------------
  // Schedules

  async listSchedules(project: string): Promise<CloudSchedule[]> {
    const payload = objectValue(await this.request<unknown>("GET", `/schedules${query({ project })}`));
    if (!payload || !Array.isArray(payload.schedules)) throw unexpected("schedule list");
    return payload.schedules.map(requireSchedule);
  }

  async createSchedule(
    body: CloudScheduleBody & { project: string; agent: string; cron: string; timezone: string },
  ): Promise<CloudSchedule> {
    return requireSchedule(objectValue(await this.request<unknown>("POST", "/schedules", body))?.schedule);
  }

  async updateSchedule(id: string, body: CloudScheduleBody): Promise<CloudSchedule> {
    return requireSchedule(
      objectValue(await this.request<unknown>("POST", `/schedules/${segment(id)}`, body))?.schedule,
    );
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.request<unknown>("POST", `/schedules/${segment(id)}/delete`, {});
  }

  // -------------------------------------------------------------------------

  private requireRunOf(payload: unknown): CloudRun {
    return requireRun(objectValue(payload)?.run, this.consoleUrl);
  }

  private optionalRunOf(payload: unknown): CloudRun | null {
    const run = objectValue(payload)?.run;
    return run ? requireRun(run, this.consoleUrl) : null;
  }

  /** One call under `/api/cli/cloud-agents`; the product clients (`client-product.ts`) use it too. */
  request<T>(method: string, relativePath: string, body?: unknown): Promise<T> {
    const path = `${CLOUD_AGENTS_PATH}${relativePath}`;
    return this.withAuth((token) => this.session.client.requestJson<T>(method, path, body, token));
  }

  /** One call with the current login; on `AUTH_EXPIRED`, a login refreshed elsewhere, else a refresh here. */
  private async withAuth<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      try {
        return await call(this.holder.current.accessToken);
      } catch (error) {
        if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
      }
      const stored = this.readStoredLogin();
      if (stored && stored.refreshToken !== this.holder.current.refreshToken) {
        this.holder.current = stored;
        try {
          return await call(stored.accessToken);
        } catch (error) {
          if (!isCloudAuthError(error) || error.code !== "AUTH_EXPIRED") throw error;
        }
      }
      this.holder.current = await refreshCredentialsForStore({
        client: this.session.client,
        credentials: this.holder.current,
        write: this.session.write,
        delete: this.session.delete,
      });
      return await call(this.holder.current.accessToken);
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      throw classifyConsoleNetworkError(error, inspectExecutionPlane());
    }
  }

  private readStoredLogin(): CloudCredentials | null {
    let stored: CloudCredentials | null;
    try {
      stored = this.session.read?.() ?? null;
    } catch {
      return null;
    }
    const current = this.holder.current;
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

// ---------------------------------------------------------------------------
// Session

export interface CloudAgentsSessionOptions {
  console?: string;
  /** Explicit project ref; otherwise the Console scope resolver decides. */
  project?: string | null;
  /** Skip project resolution (org-level calls such as the key). */
  resolveProject?: boolean;
  /**
   * The local contact the calls act for (`x-ravi-actor-contact`), for the
   * daemon acting on a person's own chat answer (an approval button or code).
   * null sends no contact; omitted keeps the turn's author.
   */
  actorContactId?: string | null;
}

export interface CloudAgentsSessionDeps extends ConsoleScopeResolverDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface CloudAgentsSession {
  client: CloudAgentsClient;
  consoleUrl: string;
  /** The linked installation (this daemon) of the `ravi login` session. */
  installationId: string;
  /** The Console project ref the calls use, or null when none resolved. */
  project: string | null;
  projectSource: string | null;
  organization: string | null;
  /** The organization id of the login (a task run is only watched by the same login). */
  organizationId: string | null;
  /** The Console user of the `ravi login` session (the operator). */
  userId?: string | null;
}

/** A client bound to the `ravi login` session, or null when there is none. */
export async function openCloudAgentsSession(
  options: CloudAgentsSessionOptions = {},
  deps: CloudAgentsSessionDeps = {},
): Promise<CloudAgentsSession | null> {
  const readCredentials = deps.readCredentials ?? readCloudCredentials;
  const credentials = readCredentials();
  if (!credentials) return null;
  if (options.console && normalizeConsoleUrl(options.console) !== credentials.consoleUrl) return null;
  let project: string | null = null;
  let projectSource: string | null = null;
  const explicit = options.project?.trim() || null;
  if (explicit) {
    project = explicit;
    projectSource = "explicit";
  } else if (options.resolveProject !== false) {
    try {
      const scope = await resolveConsoleScope(
        { consoleUrl: options.console, explicitProject: null },
        {
          ...deps,
          readCredentials,
        },
      );
      project = scope.project?.ref ?? null;
      projectSource = project ? scope.source : null;
    } catch {
      project = null;
    }
  }
  const actorContactId = options.actorContactId;
  return {
    client: new CloudAgentsClient({
      client:
        deps.client ??
        new ConsoleApiClient({
          consoleUrl: credentials.consoleUrl,
          ...(actorContactId !== undefined ? { actorContact: () => actorContactId } : {}),
        }),
      credentials,
      write: deps.writeCredentials ?? writeCloudCredentials,
      delete: deps.deleteCredentials ?? deleteCloudCredentials,
      read: () => readCredentials(),
    }),
    consoleUrl: credentials.consoleUrl,
    installationId: credentials.installationId,
    project,
    projectSource,
    organizationId: credentials.organization?.id?.trim() || null,
    userId: credentials.user?.id?.trim() || null,
    organization:
      credentials.organization?.slug?.trim() ||
      credentials.organization?.name?.trim() ||
      credentials.organization?.id?.trim() ||
      null,
  };
}

export function cloudAgentsLoginRequiredError(): CloudAuthError {
  return new CloudAuthError("AUTH_REQUIRED", "Cloud agents need a Ravi Cloud login. Run `ravi login`.");
}

// ---------------------------------------------------------------------------
// Normalizers: only the contract's fields, typed

function requireCredential(value: unknown): CloudCredential {
  const credential = objectValue(value);
  if (!credential) throw unexpected("credential");
  return {
    provider: stringOr(credential.provider, "anthropic"),
    configured: credential.configured === true,
    keyHint: stringOrNull(credential.keyHint),
    status: stringOr(credential.status, credential.configured === true ? "active" : "missing"),
    verifiedAt: stringOrNull(credential.verifiedAt),
    monthlyAlertUsd: numberOrNull(credential.monthlyAlertUsd),
    monthCostUsd: numberOr(credential.monthCostUsd, 0),
  };
}

function requireAgent(value: unknown): CloudAgent {
  const agent = objectValue(value);
  if (!agent || typeof agent.id !== "string" || !agent.id) throw unexpected("cloud agent");
  const library = objectValue(agent.library);
  const config = objectValue(agent.config);
  const schedule = objectValue(config?.schedule);
  return {
    id: agent.id,
    projectId: stringOr(agent.projectId, ""),
    name: stringOr(agent.name, stringOr(library?.slug, agent.id)),
    library: {
      itemId: stringOr(library?.itemId, ""),
      slug: stringOr(library?.slug, ""),
      scope: stringOr(library?.scope, ""),
      version: numberOrNull(library?.version),
    },
    provider: stringOr(agent.provider, "anthropic"),
    model: stringOrNull(agent.model),
    status: stringOr(agent.status, "unknown"),
    deployedAt: stringOrNull(agent.deployedAt),
    deployedBy: userRef(agent.deployedBy),
    lastError: stringOrNull(agent.lastError) ?? stringOrNull(objectValue(agent.lastError)?.message),
    config: {
      budgetUsd: numberOr(config?.budgetUsd, 5),
      networking: stringOr(config?.networking, "limited"),
      webSearch: config?.webSearch === true,
      writes: stringOr(config?.writes, "ask"),
      raviMcp: config?.raviMcp !== false,
      mcpServers: stringArray(config?.mcpServers),
      repositories: stringArray(config?.repositories),
      schedule:
        schedule && typeof schedule.cron === "string"
          ? { cron: schedule.cron, timezone: stringOr(schedule.timezone, "UTC") }
          : null,
    },
  };
}

export function requireRun(value: unknown, consoleUrl: string): CloudRun {
  const run = objectValue(value);
  if (!run || typeof run.id !== "string" || !run.id || typeof run.status !== "string") throw unexpected("run");
  const tokens = objectValue(run.tokens);
  const error = objectValue(run.error);
  return {
    id: run.id,
    agentId: stringOr(run.agentId, ""),
    agentName: stringOr(run.agentName, stringOr(run.agentId, "")),
    projectId: stringOr(run.projectId, ""),
    status: run.status,
    trigger: stringOr(run.trigger, "manual"),
    actor: userRef(run.actor) ?? { id: "", name: null },
    prompt: stringOr(run.prompt, ""),
    result: stringOrNull(run.result),
    budgetUsd: numberOrNull(run.budgetUsd),
    costUsd: numberOr(run.costUsd, 0),
    runningSeconds: numberOr(run.runningSeconds, 0),
    tokens: {
      input: numberOr(tokens?.input, 0),
      output: numberOr(tokens?.output, 0),
      cacheRead: numberOr(tokens?.cacheRead, 0),
      cacheWrite: numberOr(tokens?.cacheWrite, 0),
    },
    approvals: Array.isArray(run.approvals)
      ? run.approvals.flatMap((entry) => {
          const approval = normalizeApproval(entry);
          return approval ? [approval] : [];
        })
      : [],
    outputs: Array.isArray(run.outputs)
      ? run.outputs.flatMap((entry) => {
          const output = objectValue(entry);
          if (!output || typeof output.id !== "string" || !output.id) return [];
          return [{ id: output.id, name: stringOr(output.name, output.id), size: numberOr(output.size, 0) }];
        })
      : [],
    startedAt: stringOrNull(run.startedAt),
    endedAt: stringOrNull(run.endedAt),
    error:
      error && (typeof error.code === "string" || typeof error.message === "string")
        ? { code: stringOr(error.code, "unknown"), message: stringOr(error.message, "") }
        : null,
    origin: normalizeOrigin(run.origin),
    url: consoleLink(consoleUrl, run.url),
    questions: Array.isArray(run.questions)
      ? run.questions.flatMap((entry) => {
          const question = normalizeQuestion(entry);
          return question ? [question] : [];
        })
      : [],
    delivery: normalizeDelivery(run.delivery),
    deliveredAt: stringOrNull(run.deliveredAt),
    files: Array.isArray(run.files)
      ? run.files.flatMap((entry) => {
          const file = objectValue(entry);
          if (!file || typeof file.fileId !== "string" || !file.fileId) return [];
          return [{ fileId: file.fileId, name: stringOr(file.name, file.fileId), size: numberOr(file.size, 0) }];
        })
      : [],
    outcome: normalizeOutcome(run.outcome),
    threadKey: stringOrNull(run.threadKey),
    triggerId: stringOrNull(run.triggerId),
    billingMode: run.billingMode === "credits" ? "credits" : "byok",
    chargedBrl: numberOrNull(run.chargedBrl),
    costBrl: numberOrNull(run.costBrl),
  };
}

const DELIVERY_KINDS: ReadonlySet<string> = new Set(["session", "page_room", "none"]);

/** A delivery target: only its contract fields, and only when its kind is one the contract names. */
export function normalizeDelivery(value: unknown): CloudDelivery | null {
  const delivery = objectValue(value);
  if (!delivery || typeof delivery.kind !== "string" || !DELIVERY_KINDS.has(delivery.kind)) return null;
  const chat = objectValue(delivery.chat);
  const optional = (key: string) => {
    const field = delivery[key];
    return typeof field === "string" && field ? { [key]: field } : {};
  };
  return {
    kind: delivery.kind as CloudDelivery["kind"],
    ...optional("installationId"),
    ...optional("sessionName"),
    ...optional("roomId"),
    ...optional("siteId"),
    ...(chat && typeof chat.channel === "string" && typeof chat.chatId === "string"
      ? {
          chat: {
            channel: chat.channel,
            chatId: chat.chatId,
            threadId: stringOrNull(chat.threadId),
            instanceId: stringOrNull(chat.instanceId),
          },
        }
      : {}),
  };
}

export function normalizeQuestion(value: unknown): CloudQuestion | null {
  const question = objectValue(value);
  if (!question || typeof question.id !== "string" || !question.id) return null;
  const status = question.status === "answered" || question.status === "expired" ? question.status : "pending";
  return {
    id: question.id,
    question: stringOr(question.question, ""),
    options: stringArray(question.options).slice(0, 6),
    status,
    answer: stringOrNull(question.answer),
    askedAt: stringOrNull(question.askedAt),
    answeredAt: stringOrNull(question.answeredAt),
    answeredBy: userRef(question.answeredBy),
  };
}

function normalizeOutcome(value: unknown): CloudRunOutcome | null {
  const outcome = objectValue(value);
  if (!outcome || typeof outcome.rubric !== "string") return null;
  return {
    rubric: outcome.rubric,
    maxIterations: numberOr(outcome.maxIterations, 1),
    iterations: numberOr(outcome.iterations, 0),
    lastResult: stringOrNull(outcome.lastResult),
    feedback: stringOrNull(outcome.feedback),
  };
}

function normalizeOrigin(value: unknown): CloudRunOrigin | null {
  const origin = objectValue(value);
  if (!origin) return null;
  const delivery = objectValue(origin.delivery);
  return {
    kind: stringOr(origin.kind, "unknown"),
    installationId: stringOrNull(origin.installationId),
    sessionName: stringOrNull(origin.sessionName),
    taskId: stringOrNull(origin.taskId),
    delivery: stringOrNull(origin.delivery) ?? stringOrNull(delivery?.status),
    deliveredAt: stringOrNull(origin.deliveredAt) ?? stringOrNull(delivery?.deliveredAt),
  };
}

function normalizeApproval(value: unknown): CloudApproval | null {
  const approval = objectValue(value);
  if (!approval || typeof approval.id !== "string" || !approval.id) return null;
  return {
    id: approval.id,
    tool: stringOr(approval.tool, ""),
    server: stringOrNull(approval.server),
    inputPreview: stringOrNull(approval.inputPreview),
    status: stringOr(approval.status, "pending"),
    requestedAt: stringOrNull(approval.requestedAt),
    decidedAt: stringOrNull(approval.decidedAt),
    decidedBy: userRef(approval.decidedBy),
  };
}

function normalizeEvent(value: unknown): CloudRunEvent | null {
  const event = objectValue(value);
  if (!event || typeof event.type !== "string") return null;
  return {
    seq: numberOr(event.seq, 0),
    at: stringOrNull(event.at),
    type: event.type,
    role: stringOrNull(event.role),
    text: stringOrNull(event.text),
    tool: stringOrNull(event.tool),
    status: stringOrNull(event.status),
  };
}

function requireSchedule(value: unknown): CloudSchedule {
  const schedule = objectValue(value);
  if (!schedule || typeof schedule.id !== "string" || !schedule.id) throw unexpected("schedule");
  return {
    id: schedule.id,
    agentId: stringOr(schedule.agentId, ""),
    agentName: stringOr(schedule.agentName, stringOr(schedule.agentId, "")),
    cron: stringOr(schedule.cron, ""),
    timezone: stringOr(schedule.timezone, "UTC"),
    prompt: stringOrNull(schedule.prompt),
    budgetUsd: numberOrNull(schedule.budgetUsd),
    enabled: schedule.enabled === true,
    actor: userRef(schedule.actor) ?? { id: "", name: null },
    nextRunAt: stringOrNull(schedule.nextRunAt),
    lastRunAt: stringOrNull(schedule.lastRunAt),
    lastRunId: stringOrNull(schedule.lastRunId),
    delivery: normalizeDelivery(schedule.delivery),
  };
}

export function userRef(value: unknown): CloudUserRef | null {
  if (typeof value === "string" && value) return { id: "", name: value };
  const user = objectValue(value);
  if (!user || (typeof user.id !== "string" && typeof user.name !== "string")) return null;
  return { id: stringOr(user.id, ""), name: stringOrNull(user.name) };
}

/** A Console page link: a same-origin path or URL, never another origin. */
export function consoleLink(consoleUrl: string, value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const base = new URL(consoleUrl);
    if (value.startsWith("//")) return null;
    const url = new URL(value, base);
    return url.origin === base.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

export function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export function segment(value: string): string {
  return encodeURIComponent(value.trim());
}

export function unexpected(what: string): CloudAuthError {
  return new CloudAuthError("SERVER_UNAVAILABLE", `The Console returned an unexpected ${what}.`);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
