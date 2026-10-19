/** Test-only fake Console cloud agents API (spec `cloud/agents`, routes of the Console contract). */

import { ConsoleApiClient } from "../cloud-auth/client.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { FAKE_CONSOLE_URL, fakeCredentials } from "../library/test-fixtures.js";
import {
  CLOUD_AGENTS_PATH,
  CloudAgentsClient,
  type CloudAgentsSession,
  type CloudAgentsSessionOptions,
} from "./client.js";

export { FAKE_CONSOLE_URL };

type Json = Record<string, unknown>;

export interface FakeCloudRequest {
  method: string;
  /** Path below `/api/cli/cloud-agents`, without the query. */
  path: string;
  query: URLSearchParams;
  body: Json | null;
  authorization: string | null;
}

export interface FakeCloudFailure {
  method?: string;
  path: string | RegExp;
  status: number;
  body: unknown;
  /** How many calls fail (default: every call). */
  times?: number;
}

export interface FakeCloudConsole {
  fetch: typeof globalThis.fetch;
  requests: FakeCloudRequest[];
  credential: Json;
  agents: Json[];
  runs: Map<string, Json>;
  events: Map<string, Json[]>;
  outputs: Map<string, Uint8Array>;
  schedules: Json[];
  failures: FakeCloudFailure[];
  /** Requests other than reads (`GET`). */
  writes(): FakeCloudRequest[];
  /** Access token the fake accepts (others get AUTH_EXPIRED); null accepts any. */
  validToken: string | null;
}

export function fakeCloudAgent(overrides: Json = {}): Json {
  return {
    id: "ca_1",
    projectId: "p-clinica",
    name: "triage",
    library: { itemId: "item-triage", slug: "triage", scope: "clinica", version: 3 },
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    status: "ready",
    deployedAt: "2026-10-18T10:00:00.000Z",
    deployedBy: { id: "user-1", name: "Op" },
    lastError: null,
    config: {
      budgetUsd: 5,
      networking: "limited",
      webSearch: false,
      writes: "ask",
      raviMcp: true,
      mcpServers: [],
      repositories: [],
      schedule: null,
    },
    ...overrides,
  };
}

export function fakeCloudApproval(overrides: Json = {}): Json {
  return {
    id: "ap_1",
    tool: "create_issue",
    server: "github",
    inputPreview: '{"title":"Fix"}',
    status: "pending",
    requestedAt: "2026-10-18T10:05:00.000Z",
    decidedAt: null,
    decidedBy: null,
    ...overrides,
  };
}

export function fakeCloudRun(overrides: Json = {}): Json {
  return {
    id: "run_1",
    agentId: "ca_1",
    agentName: "triage",
    projectId: "p-clinica",
    status: "running",
    trigger: "manual",
    actor: { id: "user-1", name: "Op" },
    prompt: "Summarize the open tickets",
    result: null,
    budgetUsd: 5,
    costUsd: 0.42,
    runningSeconds: 61,
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
    approvals: [],
    outputs: [],
    startedAt: "2026-10-18T10:00:00.000Z",
    endedAt: null,
    error: null,
    origin: null,
    url: "/acme/p/p-clinica/cloud/runs/run_1",
    ...overrides,
  };
}

export function fakeCloudSchedule(overrides: Json = {}): Json {
  return {
    id: "sch_1",
    agentId: "ca_1",
    agentName: "triage",
    cron: "0 9 * * 1-5",
    timezone: "America/Sao_Paulo",
    prompt: null,
    budgetUsd: null,
    enabled: true,
    actor: { id: "user-1", name: "Op" },
    nextRunAt: "2026-10-20T12:00:00.000Z",
    lastRunAt: null,
    lastRunId: null,
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function notFound(what: string): Response {
  return json(404, { error: { code: "not_found", message: `${what} not found` } });
}

/** A Console that answers the cloud agents routes from in-memory state. */
export function createFakeCloudConsole(
  input: { agents?: Json[]; runs?: Json[]; schedules?: Json[]; credential?: Json } = {},
): FakeCloudConsole {
  const state: FakeCloudConsole = {
    fetch: undefined as unknown as typeof globalThis.fetch,
    requests: [],
    credential: input.credential ?? {
      provider: "anthropic",
      configured: true,
      keyHint: "a1b2",
      status: "active",
      verifiedAt: "2026-10-18T09:00:00.000Z",
      monthlyAlertUsd: null,
      monthCostUsd: 3.5,
    },
    agents: input.agents ?? [fakeCloudAgent()],
    runs: new Map((input.runs ?? []).map((run) => [String(run.id), run])),
    events: new Map(),
    outputs: new Map(),
    schedules: input.schedules ?? [],
    failures: [],
    writes: () => state.requests.filter((request) => request.method !== "GET"),
    validToken: null,
  };
  let runSeq = state.runs.size;
  let scheduleSeq = state.schedules.length;

  const handle = (request: FakeCloudRequest): Response => {
    const { method, path, body } = request;
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    // credential
    if (parts[0] === "credential") {
      if (method === "GET" && parts.length === 1) return json(200, { credential: state.credential });
      if (method === "POST" && parts.length === 1) {
        const apiKey = String(body?.apiKey ?? "");
        state.credential = {
          ...state.credential,
          configured: true,
          keyHint: apiKey.slice(-4),
          status: "active",
          monthlyAlertUsd: body?.monthlyAlertUsd ?? state.credential.monthlyAlertUsd ?? null,
        };
        return json(200, { credential: state.credential });
      }
      if (method === "POST" && parts[1] === "remove") {
        state.credential = { ...state.credential, configured: false, keyHint: null, status: "missing" };
        return json(200, { credential: state.credential });
      }
    }
    // agents
    if (parts[0] === "agents") {
      if (method === "GET" && parts.length === 1) return json(200, { agents: state.agents });
      if (method === "POST" && parts[1] === "deploy") {
        const slug = String(body?.agent ?? "");
        const existing = state.agents.find((agent) => (agent.library as Json).slug === slug);
        if (existing) return json(200, { agent: existing, changed: false, warnings: [] });
        const agent = fakeCloudAgent({
          id: `ca_${slug}`,
          name: slug,
          library: { itemId: `item-${slug}`, slug, scope: "clinica", version: body?.version ?? 1 },
        });
        state.agents.push(agent);
        return json(201, { agent, changed: true, warnings: [] });
      }
      const agent = state.agents.find((entry) => entry.id === parts[1]);
      if (!agent) return notFound("agent");
      if (method === "GET" && parts.length === 2) return json(200, { agent });
      if (method === "POST" && parts[2] === "archive") {
        agent.status = "archived";
        return json(200, { agent });
      }
    }
    // runs
    if (parts[0] === "runs") {
      if (method === "POST" && parts.length === 1) {
        // The Console's start body is strict; a task origin needs sessionName and taskId, and the
        // installation comes from the login session (never from the body).
        const allowed = [
          "project",
          "agent",
          "prompt",
          "budgetUsd",
          "repositories",
          "trigger",
          "origin",
          "idempotencyKey",
        ];
        const origin = (body?.origin ?? null) as Json | null;
        const trigger = body?.trigger ?? (origin?.kind === "task" ? "task" : "manual");
        if (
          Object.keys(body ?? {}).some((key) => !allowed.includes(key)) ||
          (origin &&
            Object.keys(origin).some((key) => !["kind", "installationId", "sessionName", "taskId"].includes(key))) ||
          (trigger === "task" && (!origin?.sessionName || !origin.taskId))
        ) {
          return json(400, { error: { code: "validation_failed", message: "Send { project, agent, prompt, ... }." } });
        }
        runSeq += 1;
        const agent = state.agents.find((entry) => (entry.library as Json).slug === body?.agent);
        const run = fakeCloudRun({
          id: `run_${runSeq}`,
          agentId: agent?.id ?? `ca_${body?.agent}`,
          agentName: agent?.name ?? body?.agent,
          status: "starting",
          trigger,
          prompt: body?.prompt ?? "",
          budgetUsd: body?.budgetUsd ?? 5,
          costUsd: 0,
          runningSeconds: 0,
          origin:
            trigger === "task"
              ? {
                  kind: "task",
                  installationId: "inst-1",
                  sessionName: origin?.sessionName,
                  taskId: origin?.taskId,
                  delivery: "pending",
                }
              : null,
          url: `/acme/p/p-clinica/cloud/runs/run_${runSeq}`,
        });
        state.runs.set(String(run.id), run);
        return json(201, { run });
      }
      if (method === "GET" && parts.length === 1) {
        const limit = Math.min(Math.max(Number(request.query.get("limit") ?? 25), 1), 100);
        const all = [...state.runs.values()].filter(
          (run) => !request.query.get("agent") || run.agentId === request.query.get("agent"),
        );
        return json(200, { runs: all.slice(0, limit), cursor: all.length > limit ? `c${limit}` : null });
      }
      const run = state.runs.get(parts[1] ?? "");
      if (!run) return notFound("run");
      if (method === "GET" && parts.length === 2) return json(200, { run });
      if (method === "GET" && parts[2] === "events") {
        const all = state.events.get(String(run.id)) ?? [];
        const after = Number(request.query.get("after") ?? 0);
        const events = all.filter((event) => Number(event.seq) > after);
        const last = events.at(-1);
        return json(200, { events, cursor: last ? String(last.seq) : request.query.get("after") });
      }
      if (method === "GET" && parts[2] === "outputs") {
        const bytes = state.outputs.get(`${run.id}/${parts[3]}`);
        if (!bytes) return notFound("output");
        return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      if (method === "POST" && parts[2] === "messages") return json(200, { run });
      if (method === "POST" && parts[2] === "stop") {
        run.status = "stopped";
        return json(200, { run });
      }
      if (method === "POST" && parts[2] === "approvals") {
        const approvals = run.approvals as Json[];
        const approval = approvals.find((entry) => entry.id === parts[3]);
        if (!approval) return notFound("approval");
        approval.status = body?.decision === "approve" ? "approved" : "denied";
        approval.decidedAt = "2026-10-18T10:06:00.000Z";
        run.status = "running";
        return json(200, { run });
      }
      if (method === "POST" && parts[2] === "delivered") {
        run.origin = {
          ...((run.origin as Json | null) ?? {}),
          delivery: "delivered",
          deliveredAt: "2026-10-18T11:00:00.000Z",
        };
        return json(200, { run });
      }
    }
    // schedules
    if (parts[0] === "schedules") {
      if (method === "GET" && parts.length === 1) return json(200, { schedules: state.schedules });
      if (method === "POST" && parts.length === 1) {
        scheduleSeq += 1;
        const schedule = fakeCloudSchedule({
          id: `sch_${scheduleSeq}`,
          agentName: body?.agent,
          cron: body?.cron,
          timezone: body?.timezone,
          prompt: body?.prompt ?? null,
          budgetUsd: body?.budgetUsd ?? null,
          enabled: body?.enabled !== false,
        });
        state.schedules.push(schedule);
        return json(201, { schedule });
      }
      const schedule = state.schedules.find((entry) => entry.id === parts[1]);
      if (!schedule) return notFound("schedule");
      if (method === "POST" && parts[2] === "delete") {
        state.schedules = state.schedules.filter((entry) => entry !== schedule);
        return json(200, { deleted: true, id: schedule.id });
      }
      if (method === "POST" && parts.length === 2) {
        const changes = body ?? {};
        if (Object.keys(changes).some((key) => !["cron", "timezone", "prompt", "budgetUsd", "enabled"].includes(key))) {
          return json(400, { error: { code: "validation_failed", message: "Unknown schedule field." } });
        }
        Object.assign(schedule, changes);
        return json(200, { schedule });
      }
    }
    return json(404, { error: { code: "not_found", message: `no route ${method} ${path}` } });
  };

  state.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url instanceof Request ? url.url : url));
    const method = (init?.method ?? "GET").toUpperCase();
    if (!parsed.pathname.startsWith(CLOUD_AGENTS_PATH)) {
      return json(404, { error: { code: "not_found", message: `no route ${parsed.pathname}` } });
    }
    const path = parsed.pathname.slice(CLOUD_AGENTS_PATH.length) || "/";
    const request: FakeCloudRequest = {
      method,
      path,
      query: parsed.searchParams,
      body: init?.body ? (JSON.parse(String(init.body)) as Json) : null,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    state.requests.push(request);
    if (state.validToken !== null && request.authorization !== `Bearer ${state.validToken}`) {
      return json(401, { error: { code: "AUTH_EXPIRED", message: "expired" } });
    }
    const failure = state.failures.find(
      (entry) =>
        (entry.method === undefined || entry.method === method) &&
        (typeof entry.path === "string" ? entry.path === path : entry.path.test(path)) &&
        (entry.times === undefined || entry.times > 0),
    );
    if (failure) {
      if (failure.times !== undefined) failure.times -= 1;
      return json(failure.status, failure.body);
    }
    return handle(request);
  }) as typeof globalThis.fetch;

  return state;
}

/** A cloud agents client bound to the fake. */
export function fakeCloudClient(
  fake: FakeCloudConsole,
  credentials: CloudCredentials = fakeCredentials(),
): CloudAgentsClient {
  return new CloudAgentsClient({
    client: new ConsoleApiClient({ consoleUrl: FAKE_CONSOLE_URL, fetch: fake.fetch, actorContact: () => null }),
    credentials,
    write: () => {},
    delete: () => {},
    read: () => null,
  });
}

/** `openSession` for commands, the watcher and dispatch: the fake, with `defaultProject` when none is given. */
export function fakeCloudSessionOpener(
  fake: FakeCloudConsole,
  input: { defaultProject?: string | null; loggedIn?: boolean; installationId?: string } = {},
): ((options: CloudAgentsSessionOptions) => Promise<CloudAgentsSession | null>) & {
  calls: CloudAgentsSessionOptions[];
} {
  const calls: CloudAgentsSessionOptions[] = [];
  const open = async (options: CloudAgentsSessionOptions): Promise<CloudAgentsSession | null> => {
    calls.push(options);
    if (input.loggedIn === false) return null;
    const explicit = options.project?.trim() || null;
    const project =
      explicit ??
      (options.resolveProject === false ? null : input.defaultProject === undefined ? "clinica" : input.defaultProject);
    return {
      client: fakeCloudClient(fake),
      consoleUrl: FAKE_CONSOLE_URL,
      installationId: input.installationId ?? "inst-1",
      project,
      projectSource: explicit ? "explicit" : project ? "cwd" : null,
      organization: "acme",
    };
  };
  return Object.assign(open, { calls });
}
