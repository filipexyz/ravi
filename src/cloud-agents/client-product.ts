// Console cloud agents product routes (F1-F4), transport only: secrets,
// triggers, credits, settings, catalog, workers, webhook secret, memory, agent
// approval and caps. The Console decides who may do what; this side calls it
// with the `ravi login` credentials through `CloudAgentsClient.request`.
//
//   GET  secrets?project=                 POST secrets                 POST secrets/<id>/remove
//   GET  triggers?project=                POST triggers                POST triggers/<id>
//   POST triggers/<id>/remove             POST triggers/<id>/test
//   GET  credits                          POST credits/topup
//   GET  settings                         POST settings
//   GET  catalog                          POST catalog/<entryId>/install
//   POST catalog/packs/<packId>/install
//   GET  workers                          POST workers/<id>/heartbeat
//   GET  credential/webhook               POST credential/webhook      POST credential/webhook/remove
//   POST agents/<id>/approve              POST agents/<id>/cap         POST agents/<id>/memory/reset

import {
  type CloudAgentsClient,
  consoleLink,
  numberOr,
  numberOrNull,
  objectValue,
  query,
  requireAgent,
  segment,
  stringArray,
  stringOr,
  stringOrNull,
  unexpected,
  userRef,
} from "./client.js";
import {
  CLOUD_TRIGGER_SOURCES,
  CLOUD_WORKER_STATUSES,
  type CloudAgent,
  type CloudAgentMemorySummary,
  type CloudCatalogEntry,
  type CloudCatalogPack,
  type CloudCreditEntry,
  type CloudCredits,
  type CloudDelivery,
  type CloudOrgSettings,
  type CloudOrgSettingsBody,
  type CloudSecret,
  type CloudTrigger,
  type CloudTriggerFilter,
  type CloudTriggerSource,
  type CloudTriggerTest,
  type CloudWebhook,
  type CloudWorker,
  type CloudWorkerStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Secrets (names and hints only; a value goes up once and never comes back)

export async function listCloudSecrets(client: CloudAgentsClient, project?: string | null): Promise<CloudSecret[]> {
  const payload = objectValue(
    await client.request<unknown>("GET", `/secrets${query({ project: project ?? undefined })}`),
  );
  if (!payload || !Array.isArray(payload.secrets)) throw unexpected("secret list");
  return payload.secrets.flatMap((entry) => {
    const secret = normalizeSecret(entry);
    return secret ? [secret] : [];
  });
}

export async function setCloudSecret(
  client: CloudAgentsClient,
  body: { project?: string; name: string; value: string; allowedHosts: string[] },
): Promise<CloudSecret> {
  const secret = normalizeSecret(objectValue(await client.request<unknown>("POST", "/secrets", body))?.secret);
  if (!secret) throw unexpected("secret");
  return secret;
}

export async function removeCloudSecret(client: CloudAgentsClient, id: string): Promise<void> {
  await client.request<unknown>("POST", `/secrets/${segment(id)}/remove`, {});
}

// ---------------------------------------------------------------------------
// Event triggers

export interface CloudTriggerBody {
  source?: CloudTriggerSource;
  filter?: CloudTriggerFilter;
  prompt?: string;
  delivery?: { kind: "session" | "none"; sessionName?: string } | null;
  enabled?: boolean;
  dailyCap?: number;
  batchWindowSeconds?: number;
  dedupeWindowSeconds?: number;
  budgetUsd?: number | null;
}

export async function listCloudTriggers(client: CloudAgentsClient, project: string): Promise<CloudTrigger[]> {
  const payload = objectValue(await client.request<unknown>("GET", `/triggers${query({ project })}`));
  if (!payload || !Array.isArray(payload.triggers)) throw unexpected("trigger list");
  return payload.triggers.flatMap((entry) => {
    const trigger = normalizeTrigger(entry);
    return trigger ? [trigger] : [];
  });
}

export async function createCloudTrigger(
  client: CloudAgentsClient,
  body: CloudTriggerBody & { project: string; agent: string; source: CloudTriggerSource; prompt: string },
): Promise<CloudTrigger> {
  return requireTrigger(objectValue(await client.request<unknown>("POST", "/triggers", body))?.trigger);
}

export async function updateCloudTrigger(
  client: CloudAgentsClient,
  id: string,
  body: CloudTriggerBody,
): Promise<CloudTrigger> {
  return requireTrigger(objectValue(await client.request<unknown>("POST", `/triggers/${segment(id)}`, body))?.trigger);
}

export async function removeCloudTrigger(client: CloudAgentsClient, id: string): Promise<void> {
  await client.request<unknown>("POST", `/triggers/${segment(id)}/remove`, {});
}

/** The dry run: the prompt the trigger would send now; no run starts. */
export async function testCloudTrigger(client: CloudAgentsClient, id: string): Promise<CloudTriggerTest> {
  const payload = objectValue(await client.request<unknown>("POST", `/triggers/${segment(id)}/test`, {}));
  if (!payload) throw unexpected("trigger test");
  const test = objectValue(payload.test) ?? payload;
  const events = test.events;
  return {
    prompt: stringOrNull(test.prompt),
    eventCount: Array.isArray(events) ? events.length : numberOr(test.eventCount, numberOr(events, 0)),
    sample: test.sample === true,
    blockedBy: stringOrNull(test.blockedBy) ?? stringOrNull(test.reason),
  };
}

// ---------------------------------------------------------------------------
// Credits (BRL) and organization settings

export async function getCloudCredits(client: CloudAgentsClient): Promise<CloudCredits> {
  return requireCredits(objectValue(await client.request<unknown>("GET", "/credits"))?.credits);
}

/** A Pix charge: the entry carries the payment link and the copy-paste code. */
export async function topupCloudCredits(
  client: CloudAgentsClient,
  amountBrl: number,
): Promise<{ entry: CloudCreditEntry; credits: CloudCredits | null }> {
  const payload = objectValue(await client.request<unknown>("POST", "/credits/topup", { amountBrl }));
  const entry = normalizeCreditEntry(payload?.entry ?? payload?.topup, client.consoleUrl);
  if (!entry) throw unexpected("top-up");
  return { entry, credits: payload?.credits ? requireCredits(payload.credits, client.consoleUrl) : null };
}

export async function getCloudSettings(client: CloudAgentsClient): Promise<CloudOrgSettings> {
  return requireSettings(objectValue(await client.request<unknown>("GET", "/settings"))?.settings);
}

export async function updateCloudSettings(
  client: CloudAgentsClient,
  body: CloudOrgSettingsBody,
): Promise<CloudOrgSettings> {
  return requireSettings(objectValue(await client.request<unknown>("POST", "/settings", body))?.settings);
}

// ---------------------------------------------------------------------------
// Catalog

export async function listCloudCatalog(
  client: CloudAgentsClient,
): Promise<{ entries: CloudCatalogEntry[]; packs: CloudCatalogPack[] }> {
  const payload = objectValue(await client.request<unknown>("GET", "/catalog"));
  if (!payload || !Array.isArray(payload.entries)) throw unexpected("catalog");
  return {
    entries: payload.entries.flatMap((entry) => {
      const normalized = normalizeCatalogEntry(entry);
      return normalized ? [normalized] : [];
    }),
    packs: Array.isArray(payload.packs)
      ? payload.packs.flatMap((entry) => {
          const normalized = normalizeCatalogPack(entry);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

/** The agents an install created in the project (each awaits an admin's approval unless an admin installed it). */
export async function installCloudCatalogEntry(
  client: CloudAgentsClient,
  entryId: string,
  project: string,
): Promise<{ agents: CloudAgent[] }> {
  return installResult(await client.request<unknown>("POST", `/catalog/${segment(entryId)}/install`, { project }));
}

export async function installCloudCatalogPack(
  client: CloudAgentsClient,
  packId: string,
  project: string,
): Promise<{ agents: CloudAgent[] }> {
  return installResult(await client.request<unknown>("POST", `/catalog/packs/${segment(packId)}/install`, { project }));
}

function installResult(value: unknown): { agents: CloudAgent[] } {
  const payload = objectValue(value);
  const raw = Array.isArray(payload?.agents) ? payload.agents : payload?.agent ? [payload.agent] : null;
  if (!raw) throw unexpected("catalog install");
  return { agents: raw.map(requireProductAgent) };
}

// ---------------------------------------------------------------------------
// Workers (self-hosted environments this installation serves)

export async function listCloudWorkers(client: CloudAgentsClient): Promise<CloudWorker[]> {
  const payload = objectValue(await client.request<unknown>("GET", "/workers"));
  if (!payload || !Array.isArray(payload.workers)) throw unexpected("worker list");
  return payload.workers.flatMap((entry) => {
    const worker = normalizeWorker(entry);
    return worker ? [worker] : [];
  });
}

/**
 * The daemon serves this worker: `online` (its environment worker runs) or `disabled` (the operator turned the
 * runner off on this machine, so the Console refuses its runs at once). A worker that fails or has no key sends
 * nothing and goes offline after 120 s.
 */
export async function heartbeatCloudWorker(
  client: CloudAgentsClient,
  id: string,
  body: { status: "online" | "disabled"; error?: string | null },
): Promise<CloudWorker | null> {
  const payload = objectValue(await client.request<unknown>("POST", `/workers/${segment(id)}/heartbeat`, body));
  return normalizeWorker(payload?.worker);
}

// ---------------------------------------------------------------------------
// Provider webhook signing secret

export async function getCloudWebhook(client: CloudAgentsClient): Promise<CloudWebhook> {
  return normalizeWebhook(objectValue(await client.request<unknown>("GET", "/credential/webhook"))?.webhook);
}

export async function setCloudWebhook(client: CloudAgentsClient, secret: string): Promise<CloudWebhook> {
  return normalizeWebhook(
    objectValue(await client.request<unknown>("POST", "/credential/webhook", { secret }))?.webhook,
  );
}

export async function removeCloudWebhook(client: CloudAgentsClient): Promise<CloudWebhook> {
  const payload = objectValue(await client.request<unknown>("POST", "/credential/webhook/remove", {}));
  return payload?.webhook ? normalizeWebhook(payload.webhook) : { url: null, configured: false, lastEventAt: null };
}

// ---------------------------------------------------------------------------
// Agent administration: manifest approval, monthly cap, memory

/** `GET agents/<id>` with the product fields (manifest, cap, placement) and the memory summary. */
export async function getCloudProductAgentDetail(
  client: CloudAgentsClient,
  agentId: string,
): Promise<{ agent: CloudAgent; memory: CloudAgentMemorySummary | null }> {
  const raw = objectValue(await client.request<unknown>("GET", `/agents/${segment(agentId)}`))?.agent;
  return { agent: requireProductAgent(raw), memory: normalizeMemorySummary(objectValue(raw)?.memory) };
}

export async function getCloudProductAgent(client: CloudAgentsClient, agentId: string): Promise<CloudAgent> {
  return (await getCloudProductAgentDetail(client, agentId)).agent;
}

export async function approveCloudAgent(client: CloudAgentsClient, agentId: string): Promise<CloudAgent> {
  return requireProductAgent(
    objectValue(await client.request<unknown>("POST", `/agents/${segment(agentId)}/approve`, {}))?.agent,
  );
}

/** `null` removes the admin's cap (the definition's `monthlyCapUsd`, if any, applies again). */
export async function setCloudAgentCap(
  client: CloudAgentsClient,
  agentId: string,
  monthlyCapUsd: number | null,
): Promise<CloudAgent> {
  return requireProductAgent(
    objectValue(await client.request<unknown>("POST", `/agents/${segment(agentId)}/cap`, { monthlyCapUsd }))?.agent,
  );
}

/** Archives the agent's memory stores; the answer carries the agent and its memory summary after the reset. */
export async function resetCloudAgentMemory(
  client: CloudAgentsClient,
  agentId: string,
): Promise<{ agentId: string; archivedStores: number | null; memory: CloudAgentMemorySummary | null }> {
  const payload = objectValue(await client.request<unknown>("POST", `/agents/${segment(agentId)}/memory/reset`, {}));
  const agent = objectValue(payload?.agent);
  return {
    agentId: stringOr(agent?.id, stringOr(payload?.agentId, agentId)),
    archivedStores: numberOrNull(payload?.archivedStores),
    memory: normalizeMemorySummary(payload?.memory),
  };
}

function normalizeMemorySummary(value: unknown): CloudAgentMemorySummary | null {
  const memory = objectValue(value);
  if (!memory) return null;
  return {
    scope: memory.scope === "agent" || memory.scope === "person" ? memory.scope : null,
    storeCount: numberOr(memory.storeCount, 0),
  };
}

// ---------------------------------------------------------------------------
// Normalizers: only the contract's fields, typed

/** A deployed agent with the product fields (manifest, cap, placement, catalog). */
export function requireProductAgent(value: unknown): CloudAgent {
  const agent = requireAgent(value);
  const raw = objectValue(value) ?? {};
  const config = objectValue(raw.config);
  const manifest = objectValue(raw.manifest);
  const cap = objectValue(raw.cap);
  const outcome = objectValue(config?.outcome);
  const web = objectValue(config?.web);
  return {
    ...agent,
    config: {
      ...agent.config,
      webFetch: config?.webFetch === true || web?.fetch === true,
      office: stringArray(config?.office),
      askHuman: config?.askHuman !== false,
      workflows: config?.workflows === true,
      secrets: stringArray(config?.secrets),
      memory: config?.memory === "agent" || config?.memory === "person" ? config.memory : null,
      outcome:
        outcome && typeof outcome.rubric === "string"
          ? { rubric: outcome.rubric, maxIterations: numberOr(outcome.maxIterations, 3) }
          : null,
      placement: config?.placement === "installation" ? "installation" : "cloud",
      provider: config?.provider === "ravi" ? "ravi" : "anthropic",
    },
    manifest: manifest
      ? {
          hash: stringOrNull(manifest.hash),
          approved: manifest.approved === true,
          approvedAt: stringOrNull(manifest.approvedAt),
          value: objectValue(manifest.value),
        }
      : null,
    cap: cap
      ? {
          monthlyCapUsd: numberOrNull(cap.monthlyCapUsd),
          monthSpentUsd: numberOr(cap.monthSpentUsd, 0),
          pausedAt: stringOrNull(cap.pausedAt),
          pausedReason: stringOrNull(cap.pausedReason),
        }
      : null,
    placementInstallationId: stringOrNull(raw.placementInstallationId),
    catalogEntryId: stringOrNull(raw.catalogEntryId),
  };
}

function normalizeSecret(value: unknown): CloudSecret | null {
  const secret = objectValue(value);
  if (!secret || typeof secret.id !== "string" || !secret.id || typeof secret.name !== "string") return null;
  return {
    id: secret.id,
    projectId: stringOrNull(secret.projectId),
    name: secret.name,
    valueHint: stringOrNull(secret.valueHint),
    allowedHosts: stringArray(secret.allowedHosts),
    updatedAt: stringOrNull(secret.updatedAt) ?? stringOrNull(secret.createdAt),
    updatedBy: userRef(secret.updatedBy),
    lastUsedAt: stringOrNull(secret.lastUsedAt),
  };
}

function normalizeDelivery(value: unknown): CloudDelivery | null {
  const delivery = objectValue(value);
  if (!delivery) return null;
  const kind = delivery.kind === "session" || delivery.kind === "page_room" ? delivery.kind : "none";
  const chat = objectValue(delivery.chat);
  return {
    kind,
    ...(typeof delivery.installationId === "string" ? { installationId: delivery.installationId } : {}),
    ...(typeof delivery.sessionName === "string" ? { sessionName: delivery.sessionName } : {}),
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
    ...(typeof delivery.roomId === "string" ? { roomId: delivery.roomId } : {}),
    ...(typeof delivery.siteId === "string" ? { siteId: delivery.siteId } : {}),
  };
}

function normalizeTrigger(value: unknown): CloudTrigger | null {
  const trigger = objectValue(value);
  if (!trigger || typeof trigger.id !== "string" || !trigger.id) return null;
  const filter = objectValue(trigger.filter) ?? {};
  const source = (CLOUD_TRIGGER_SOURCES as readonly string[]).includes(String(trigger.source))
    ? (trigger.source as CloudTriggerSource)
    : "bases";
  return {
    id: trigger.id,
    projectId: stringOr(trigger.projectId, ""),
    agentId: stringOr(trigger.agentId, ""),
    agentName: stringOr(trigger.agentName, stringOr(trigger.agentId, "")),
    actor: userRef(trigger.actor) ?? { id: "", name: null },
    source,
    filter: {
      ...(typeof filter.baseId === "string" ? { baseId: filter.baseId } : {}),
      ...(typeof filter.viewId === "string" ? { viewId: filter.viewId } : {}),
      ...(Array.isArray(filter.events) ? { events: stringArray(filter.events) } : {}),
      ...(typeof filter.mailboxId === "string" ? { mailboxId: filter.mailboxId } : {}),
      ...(typeof filter.siteId === "string" ? { siteId: filter.siteId } : {}),
    },
    prompt: stringOr(trigger.prompt, ""),
    delivery: normalizeDelivery(trigger.delivery),
    enabled: trigger.enabled === true,
    dailyCap: numberOr(trigger.dailyCap, 20),
    batchWindowSeconds: numberOr(trigger.batchWindowSeconds, 60),
    dedupeWindowSeconds: numberOr(trigger.dedupeWindowSeconds, 600),
    budgetUsd: numberOrNull(trigger.budgetUsd),
    firedToday: numberOr(trigger.firedToday, 0),
    lastFiredAt: stringOrNull(trigger.lastFiredAt),
    lastRunId: stringOrNull(trigger.lastRunId),
    pausedReason: stringOrNull(trigger.pausedReason),
    pendingEvents: numberOr(trigger.pendingEvents, 0),
  };
}

function requireTrigger(value: unknown): CloudTrigger {
  const trigger = normalizeTrigger(value);
  if (!trigger) throw unexpected("trigger");
  return trigger;
}

/** A decimal FX rate as text (`"5.4321"`); numbers are accepted from older Consoles. */
function fxRateOf(value: unknown): string | null {
  if (typeof value === "string" && /^\d{1,6}(?:\.\d{1,10})?$/.test(value.trim())) return value.trim();
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : null;
}

/** A Pix payment link: https only (the charge's checkout page). */
function paymentLink(consoleUrl: string | null, value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
  } catch {
    // A relative Console path.
  }
  return consoleUrl ? consoleLink(consoleUrl, value) : null;
}

function normalizeCreditEntry(value: unknown, consoleUrl: string | null = null): CloudCreditEntry | null {
  const entry = objectValue(value);
  if (!entry || typeof entry.id !== "string" || !entry.id) return null;
  const kinds = ["topup", "run", "adjustment", "refund"] as const;
  const statuses = ["pending", "posted", "void"] as const;
  return {
    id: entry.id,
    kind: (kinds as readonly string[]).includes(String(entry.kind))
      ? (entry.kind as CloudCreditEntry["kind"])
      : "adjustment",
    amountBrl: numberOr(entry.amountBrl, 0),
    usd: numberOrNull(entry.usd),
    fxRate: fxRateOf(entry.fxRate),
    runId: stringOrNull(entry.runId),
    status: (statuses as readonly string[]).includes(String(entry.status))
      ? (entry.status as CloudCreditEntry["status"])
      : "pending",
    paymentUrl: paymentLink(consoleUrl, entry.paymentUrl),
    pixCopyPaste: stringOrNull(entry.pixCopyPaste),
    createdAt: stringOrNull(entry.createdAt),
    postedAt: stringOrNull(entry.postedAt),
  };
}

function requireCredits(value: unknown, consoleUrl: string | null = null): CloudCredits {
  const credits = objectValue(value);
  if (!credits) throw unexpected("credits");
  return {
    mode: credits.mode === "credits" ? "credits" : "byok",
    balanceBrl: numberOr(credits.balanceBrl, 0),
    fxRate: fxRateOf(credits.fxRate),
    monthSpentBrl: numberOr(credits.monthSpentBrl, 0),
    entries: Array.isArray(credits.entries)
      ? credits.entries.flatMap((entry) => {
          const normalized = normalizeCreditEntry(entry, consoleUrl);
          return normalized ? [normalized] : [];
        })
      : [],
  };
}

function normalizeWebhook(value: unknown): CloudWebhook {
  const webhook = objectValue(value);
  if (!webhook) throw unexpected("webhook");
  const url = stringOrNull(webhook.url);
  return {
    url: url && /^https:\/\//.test(url) ? url : null,
    configured: webhook.configured === true,
    lastEventAt: stringOrNull(webhook.lastEventAt),
  };
}

function requireSettings(value: unknown): CloudOrgSettings {
  const settings = objectValue(value);
  if (!settings) throw unexpected("settings");
  return {
    billingMode: settings.billingMode === "credits" ? "credits" : "byok",
    monthlyCapUsd: numberOrNull(settings.monthlyCapUsd),
    monthSpentUsd: numberOr(settings.monthSpentUsd, 0),
    pausedAt: stringOrNull(settings.pausedAt),
    pausedReason: stringOrNull(settings.pausedReason),
    dailyEventRunsCap: numberOr(settings.dailyEventRunsCap, 200),
    webhook: settings.webhook
      ? normalizeWebhook(settings.webhook)
      : { url: null, configured: false, lastEventAt: null },
    gatewayAvailable: settings.gatewayAvailable === true,
  };
}

function publisherOf(value: unknown): { id: string; name: string | null } {
  const publisher = objectValue(value);
  return { id: stringOr(publisher?.id, ""), name: stringOrNull(publisher?.name) };
}

function normalizeCatalogEntry(value: unknown): CloudCatalogEntry | null {
  const entry = objectValue(value);
  if (!entry || typeof entry.id !== "string" || !entry.id) return null;
  return {
    id: entry.id,
    slug: stringOr(entry.slug, entry.id),
    name: stringOr(entry.name, stringOr(entry.slug, entry.id)),
    summary: stringOr(entry.summary, ""),
    sector: stringOrNull(entry.sector),
    publisher: publisherOf(entry.publisher),
    manifest: objectValue(entry.manifest),
    manifestHash: stringOrNull(entry.manifestHash),
    status: entry.status === "unlisted" ? "unlisted" : "listed",
    installed: entry.installed === true,
  };
}

function normalizeCatalogPack(value: unknown): CloudCatalogPack | null {
  const pack = objectValue(value);
  if (!pack || typeof pack.id !== "string" || !pack.id) return null;
  return {
    id: pack.id,
    slug: stringOr(pack.slug, pack.id),
    name: stringOr(pack.name, stringOr(pack.slug, pack.id)),
    summary: stringOr(pack.summary, ""),
    sector: stringOrNull(pack.sector),
    publisher: publisherOf(pack.publisher),
    entries: Array.isArray(pack.entries)
      ? pack.entries.flatMap((entry) => {
          const item = objectValue(entry);
          if (!item || typeof item.id !== "string" || !item.id) return [];
          return [{ id: item.id, slug: stringOr(item.slug, item.id), name: stringOr(item.name, item.id) }];
        })
      : [],
    revenueShareBps: numberOr(pack.revenueShareBps, 0),
    status: pack.status === "unlisted" ? "unlisted" : "listed",
  };
}

function normalizeWorker(value: unknown): CloudWorker | null {
  const worker = objectValue(value);
  if (!worker || typeof worker.id !== "string" || !worker.id) return null;
  const status = (CLOUD_WORKER_STATUSES as readonly string[]).includes(String(worker.status))
    ? (worker.status as CloudWorkerStatus)
    : "offline";
  return {
    id: worker.id,
    agentId: stringOr(worker.agentId, ""),
    agentName: stringOr(worker.agentName, stringOr(worker.agentId, "")),
    projectId: stringOr(worker.projectId, ""),
    installationId: stringOr(worker.installationId, ""),
    providerEnvironmentId: stringOr(worker.providerEnvironmentId, ""),
    status,
    lastSeenAt: stringOrNull(worker.lastSeenAt),
    lastError: stringOrNull(worker.lastError),
  };
}
