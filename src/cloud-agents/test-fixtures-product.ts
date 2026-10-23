/** Test-only fake of the Console cloud agents product routes (F1-F4), layered over the base fake. */

import { CLOUD_AGENTS_PATH } from "./client.js";
import {
  createFakeCloudConsole,
  type FakeCloudConsole,
  type FakeCloudRequest,
  fakeCloudAgent,
} from "./test-fixtures.js";

type Json = Record<string, unknown>;

export interface FakeProductConsole extends FakeCloudConsole {
  secrets: Json[];
  triggers: Json[];
  credits: Json;
  settings: Json;
  catalog: { entries: Json[]; packs: Json[] };
  workers: Json[];
  webhook: Json;
  /** Last body each worker heartbeat sent. */
  heartbeats: Array<{ id: string; body: Json | null }>;
}

export function fakeCloudSecret(overrides: Json = {}): Json {
  return {
    id: "sec_1",
    projectId: null,
    name: "STRIPE_API_KEY",
    valueHint: "9z9z",
    allowedHosts: ["api.stripe.com"],
    updatedAt: "2026-10-18T10:00:00.000Z",
    updatedBy: { id: "user-1", name: "Op" },
    lastUsedAt: null,
    ...overrides,
  };
}

export function fakeCloudTrigger(overrides: Json = {}): Json {
  return {
    id: "trg_1",
    projectId: "p-clinica",
    agentId: "ca_1",
    agentName: "triage",
    actor: { id: "user-1", name: "Op" },
    source: "bases",
    filter: { baseId: "base_1", events: ["row.created"] },
    prompt: "Triage this request: {{event}}",
    delivery: null,
    enabled: true,
    dailyCap: 20,
    batchWindowSeconds: 60,
    dedupeWindowSeconds: 600,
    budgetUsd: null,
    firedToday: 2,
    lastFiredAt: "2026-10-18T10:00:00.000Z",
    lastRunId: "run_9",
    pausedReason: null,
    pendingEvents: 1,
    ...overrides,
  };
}

export function fakeCloudWorker(overrides: Json = {}): Json {
  return {
    id: "wrk_1",
    agentId: "ca_1",
    agentName: "triage",
    projectId: "p-clinica",
    installationId: "inst-1",
    providerEnvironmentId: "env_self_1",
    status: "waiting_key",
    lastSeenAt: null,
    lastError: null,
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function notFound(what: string): Response {
  return json(404, { error: { code: "not_found", message: `${what} not found` } });
}

const PRODUCT_GROUPS = new Set(["secrets", "triggers", "credits", "settings", "catalog", "workers"]);

function isProductPath(parts: string[]): boolean {
  if (PRODUCT_GROUPS.has(parts[0] ?? "")) return true;
  if (parts[0] === "credential" && parts[1] === "webhook") return true;
  return parts[0] === "agents" && ["approve", "cap", "memory"].includes(parts[2] ?? "");
}

/** The base fake plus in-memory product state. */
export function createFakeProductConsole(input: { agents?: Json[]; workers?: Json[] } = {}): FakeProductConsole {
  const base = createFakeCloudConsole({ agents: input.agents ?? [fakeCloudAgent()] });
  const state = base as FakeProductConsole;
  state.secrets = [fakeCloudSecret()];
  state.triggers = [fakeCloudTrigger()];
  state.credits = {
    mode: "credits",
    balanceBrl: 120.5,
    fxRate: "5.40",
    monthSpentBrl: 30.25,
    entries: [
      {
        id: "cr_1",
        kind: "run",
        amountBrl: -2.27,
        usd: 0.42,
        fxRate: "5.40",
        runId: "run_1",
        status: "posted",
        paymentUrl: null,
        pixCopyPaste: null,
        createdAt: "2026-10-18T10:00:00.000Z",
        postedAt: "2026-10-18T10:00:00.000Z",
      },
    ],
  };
  state.settings = {
    billingMode: "byok",
    monthlyCapUsd: 100,
    monthSpentUsd: 12.5,
    pausedAt: null,
    pausedReason: null,
    dailyEventRunsCap: 200,
    webhook: { url: null, configured: false, lastEventAt: null },
    gatewayAvailable: true,
  };
  state.catalog = {
    entries: [
      {
        id: "cat_1",
        slug: "clinic-triage",
        name: "Clinic triage",
        summary: "Sorts incoming requests",
        sector: "health",
        publisher: { id: "org-pub", name: "Agency" },
        manifest: { writes: "ask", secrets: [] },
        manifestHash: "h1",
        status: "listed",
        installed: false,
      },
    ],
    packs: [
      {
        id: "pack_1",
        slug: "clinic",
        name: "Clinic pack",
        summary: "Front desk agents",
        sector: "health",
        publisher: { id: "org-pub", name: "Agency" },
        entries: [{ id: "cat_1", slug: "clinic-triage", name: "Clinic triage" }],
        revenueShareBps: 1500,
        status: "listed",
      },
    ],
  };
  state.workers = input.workers ?? [fakeCloudWorker()];
  state.webhook = {
    url: "https://console.example.test/api/cloud-agents/webhooks/tok",
    configured: false,
    lastEventAt: null,
  };
  state.heartbeats = [];
  let seq = 1;

  const agentOf = (id: string | undefined) => state.agents.find((agent) => agent.id === id);

  const handle = (request: FakeCloudRequest): Response => {
    const { method, body } = request;
    const parts = request.path.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "secrets") {
      if (method === "GET" && parts.length === 1) return json(200, { secrets: state.secrets });
      if (method === "POST" && parts.length === 1) {
        seq += 1;
        const value = String(body?.value ?? "");
        const secret = fakeCloudSecret({
          id: `sec_${seq}`,
          projectId: body?.project ?? null,
          name: body?.name,
          valueHint: value.slice(-4),
          allowedHosts: body?.allowedHosts ?? [],
        });
        state.secrets.push(secret);
        return json(201, { secret });
      }
      const secret = state.secrets.find((entry) => entry.id === parts[1]);
      if (!secret) return notFound("secret");
      if (method === "POST" && parts[2] === "remove") {
        state.secrets = state.secrets.filter((entry) => entry !== secret);
        return json(200, { removed: true, id: secret.id });
      }
    }
    if (parts[0] === "triggers") {
      if (method === "GET" && parts.length === 1) return json(200, { triggers: state.triggers });
      if (method === "POST" && parts.length === 1) {
        seq += 1;
        const agent = state.agents.find((entry) => (entry.library as Json).slug === body?.agent);
        const trigger = fakeCloudTrigger({
          id: `trg_${seq}`,
          agentId: agent?.id ?? `ca_${body?.agent}`,
          agentName: agent?.name ?? body?.agent,
          source: body?.source,
          filter: body?.filter ?? {},
          prompt: body?.prompt,
          delivery: body?.delivery ?? null,
          enabled: body?.enabled !== false,
          dailyCap: body?.dailyCap ?? 20,
          batchWindowSeconds: body?.batchWindowSeconds ?? 60,
          dedupeWindowSeconds: body?.dedupeWindowSeconds ?? 600,
          budgetUsd: body?.budgetUsd ?? null,
          firedToday: 0,
          lastFiredAt: null,
          lastRunId: null,
          pendingEvents: 0,
        });
        state.triggers.push(trigger);
        return json(201, { trigger });
      }
      const trigger = state.triggers.find((entry) => entry.id === parts[1]);
      if (!trigger) return notFound("trigger");
      if (method === "POST" && parts.length === 2) {
        Object.assign(trigger, body ?? {});
        return json(200, { trigger });
      }
      if (method === "POST" && parts[2] === "remove") {
        state.triggers = state.triggers.filter((entry) => entry !== trigger);
        return json(200, { removed: true, id: trigger.id });
      }
      if (method === "POST" && parts[2] === "test") {
        return json(200, {
          test: {
            prompt: String(trigger.prompt).replace("{{event}}", "<event>row 12 created</event>"),
            eventCount: Number(trigger.pendingEvents ?? 0),
            sample: Number(trigger.pendingEvents ?? 0) === 0,
          },
        });
      }
    }
    if (parts[0] === "credits") {
      if (method === "GET" && parts.length === 1) return json(200, { credits: state.credits });
      if (method === "POST" && parts[1] === "topup") {
        seq += 1;
        const entry = {
          id: `cr_${seq}`,
          kind: "topup",
          amountBrl: body?.amountBrl,
          usd: null,
          fxRate: null,
          runId: null,
          status: "pending",
          paymentUrl: "https://pay.example.test/pix/abc",
          pixCopyPaste: "00020126580014br.gov.bcb.pix0136fake",
          createdAt: "2026-10-18T10:00:00.000Z",
          postedAt: null,
        };
        (state.credits.entries as Json[]).unshift(entry);
        return json(201, { entry, credits: state.credits });
      }
    }
    if (parts[0] === "settings" && parts.length === 1) {
      if (method === "GET") return json(200, { settings: state.settings });
      if (method === "POST") {
        Object.assign(state.settings, body ?? {});
        return json(200, { settings: state.settings });
      }
    }
    if (parts[0] === "catalog") {
      if (method === "GET" && parts.length === 1) return json(200, state.catalog);
      if (method === "POST" && parts[1] === "packs" && parts[3] === "install") {
        const pack = state.catalog.packs.find((entry) => entry.id === parts[2]);
        if (!pack) return notFound("pack");
        const agents = (pack.entries as Json[]).map((entry) =>
          fakeCloudAgent({
            id: `ca_${entry.slug}`,
            name: entry.slug,
            status: "awaiting_approval",
            catalogEntryId: entry.id,
          }),
        );
        return json(201, { agents });
      }
      if (method === "POST" && parts[2] === "install") {
        const entry = state.catalog.entries.find((item) => item.id === parts[1]);
        if (!entry) return notFound("catalog entry");
        const agent = fakeCloudAgent({
          id: `ca_${entry.slug}`,
          name: entry.slug,
          status: "awaiting_approval",
          catalogEntryId: entry.id,
          manifest: { hash: "h1", approved: false, approvedAt: null, value: entry.manifest },
        });
        return json(201, { agent });
      }
    }
    if (parts[0] === "workers") {
      if (method === "GET" && parts.length === 1) return json(200, { workers: state.workers });
      const worker = state.workers.find((entry) => entry.id === parts[1]);
      if (!worker) return notFound("worker");
      if (method === "POST" && parts[2] === "heartbeat") {
        state.heartbeats.push({ id: String(worker.id), body });
        worker.status = body?.status ?? "online";
        worker.lastSeenAt = "2026-10-18T10:00:00.000Z";
        worker.lastError = body?.error ?? null;
        return json(200, { worker });
      }
    }
    if (parts[0] === "credential" && parts[1] === "webhook") {
      if (method === "GET" && parts.length === 2) return json(200, { webhook: state.webhook });
      if (method === "POST" && parts.length === 2) {
        state.webhook = { ...state.webhook, configured: true };
        return json(200, { webhook: state.webhook });
      }
      if (method === "POST" && parts[2] === "remove") {
        state.webhook = { ...state.webhook, configured: false };
        return json(200, { webhook: state.webhook });
      }
    }
    if (parts[0] === "agents") {
      const agent = agentOf(parts[1]);
      if (!agent) return notFound("agent");
      if (method === "POST" && parts[2] === "approve") {
        agent.status = "ready";
        agent.manifest = { hash: "h1", approved: true, approvedAt: "2026-10-18T10:00:00.000Z", value: {} };
        return json(200, { agent });
      }
      if (method === "POST" && parts[2] === "cap") {
        const cap = (agent.cap as Json | undefined) ?? { monthSpentUsd: 3, pausedAt: null, pausedReason: null };
        agent.cap = { ...cap, monthlyCapUsd: body?.monthlyCapUsd ?? null };
        return json(200, { agent });
      }
      if (method === "POST" && parts[2] === "memory" && parts[3] === "reset") {
        agent.memory = { scope: "agent", storeCount: 0 };
        return json(200, { agent, memory: agent.memory });
      }
    }
    return json(404, { error: { code: "not_found", message: `no route ${method} ${request.path}` } });
  };

  const baseFetch = base.fetch;
  state.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url instanceof Request ? url.url : url));
    const path = parsed.pathname.startsWith(CLOUD_AGENTS_PATH) ? parsed.pathname.slice(CLOUD_AGENTS_PATH.length) : "";
    const parts = path.split("/").filter(Boolean);
    if (!isProductPath(parts)) return baseFetch(url, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const request: FakeCloudRequest = {
      method,
      path,
      query: parsed.searchParams,
      body: init?.body ? (JSON.parse(String(init.body)) as Json) : null,
      authorization: new Headers(init?.headers).get("authorization"),
    };
    state.requests.push(request);
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
