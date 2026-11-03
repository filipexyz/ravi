// Claude Managed Agents behind `CloudAgentProvider`. The only file that
// imports `@anthropic-ai/sdk`; the beta header lives in one constant.

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";

import {
  type CloudAgentProvider,
  CloudProviderError,
  type ProviderAgentSpec,
  type ProviderEvent,
  type ProviderMcpCredential,
  type ProviderStopReason,
  type CloudProviderLimits,
} from "./types";

export const ANTHROPIC_MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

const REQUEST_TIMEOUT_MS = 15_000;
// A provider event's processed_at can trail its created_at; re-reading this
// window and skipping ids already seen keeps late events from being missed.
const CURSOR_OVERLAP_MS = 60_000;
const CURSOR_MAX_SEEN = 500;

type EventCursor = {
  since: string | null;
  latest: string | null;
  seen: string[];
  page: string | null;
  pageSince: string | null;
};

export function anthropicCloudProvider(input: { apiKey: string; client?: Anthropic; limits?: CloudProviderLimits }): CloudAgentProvider {
  const client =
    input.client ??
    new Anthropic({ apiKey: input.apiKey, timeout: input.limits?.timeoutMs ?? REQUEST_TIMEOUT_MS, maxRetries: input.limits?.maxRetries ?? 1 });
  const betas = [ANTHROPIC_MANAGED_AGENTS_BETA];

  return {
    name: "anthropic",

    verifyKey: () =>
      call(async () => {
        await client.models.list({ limit: 1 });
      }),

    ensureSkill: (skill) =>
      call(async () => {
        const uploads = await Promise.all(
          skill.files.map((file) => toFile(Buffer.from(file.content, "utf8"), `${skill.directory}/${file.path}`)),
        );
        if (skill.existingSkillId) {
          try {
            const version = await client.beta.skills.versions.create(skill.existingSkillId, { files: uploads });
            return { skillId: skill.existingSkillId, version: version.id };
          } catch (error) {
            // A skill whose SKILL.md name changed cannot take the new files as a
            // version; it becomes a new provider skill below.
            if (!(error instanceof Anthropic.BadRequestError) && !(error instanceof Anthropic.NotFoundError)) throw error;
          }
        }
        const created = await client.beta.skills.create({ files: uploads, display_name: skill.displayTitle });
        return { skillId: created.id, version: created.latest_version_id };
      }),

    upsertAgent: (spec, existing) =>
      call(async () => {
        const body = agentBody(spec);
        const agent = existing
          ? await client.beta.agents.update(existing.agentId, { ...body, version: existing.version, betas })
          : await client.beta.agents.create({ ...body, betas });
        return { agentId: agent.id, version: agent.version };
      }),

    ensureEnvironment: (spec, existingId) =>
      call(async () => {
        const config = {
          type: "cloud" as const,
          networking:
            spec.networking === "unrestricted"
              ? { type: "unrestricted" as const }
              : {
                  type: "limited" as const,
                  allow_mcp_servers: true,
                  allow_package_managers: true,
                  allowed_hosts: spec.allowedHosts,
                },
          packages: spec.packages,
        };
        if (existingId) {
          const updated = await client.beta.environments.update(existingId, { config, metadata: spec.metadata, betas });
          return { environmentId: updated.id };
        }
        const created = await client.beta.environments.create({ name: spec.name, config, metadata: spec.metadata, betas });
        return { environmentId: created.id };
      }),

    createVault: (vault) =>
      call(async () => {
        const created = await client.beta.vaults.create({ display_name: vault.displayName, metadata: vault.metadata, betas });
        return { vaultId: created.id };
      }),

    addMcpCredential: (vaultId, credential) =>
      call(async () => {
        const created = await client.beta.vaults.credentials.create(vaultId, {
          display_name: "Ravi run token",
          auth: {
            type: "mcp_oauth",
            mcp_server_url: credential.serverUrl,
            access_token: credential.accessToken,
            expires_at: credential.accessTokenExpiresAt.toISOString(),
            refresh: refreshParams(credential),
          },
          betas,
        });
        return { credentialId: created.id };
      }),

    updateMcpCredential: (vaultId, credentialId, credential) =>
      call(async () => {
        await client.beta.vaults.credentials.update(credentialId, {
          vault_id: vaultId,
          auth: {
            type: "mcp_oauth",
            access_token: credential.accessToken,
            expires_at: credential.accessTokenExpiresAt.toISOString(),
            refresh: { refresh_token: credential.refreshToken },
          },
          betas,
        });
      }),

    deleteVault: (vaultId) =>
      call(async () => {
        await ignoreNotFound(() => client.beta.vaults.delete(vaultId, { betas }));
      }),

    createSession: (session) =>
      call(async () => {
        const created = await client.beta.sessions.create({
          agent: { type: "agent", id: session.agentId, version: session.agentVersion },
          environment_id: session.environmentId,
          vault_ids: session.vaultIds,
          budget: { type: "limit", max_list_cost: { amount: String(Math.max(1, Math.round(session.budgetCents))), currency: "USD" } },
          resources: session.resources.map((resource) => ({
            type: "github_repository" as const,
            url: resource.url,
            authorization_token: resource.authorizationToken,
            ...(resource.branch ? { checkout: { type: "branch" as const, name: resource.branch } } : {}),
          })),
          title: session.title.slice(0, 200),
          metadata: session.metadata,
          betas,
        });
        return { sessionId: created.id };
      }),

    sendMessage: (sessionId, text) =>
      call(async () => {
        await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text }] }], betas });
      }),

    confirmTool: (sessionId, toolUseId, decision) =>
      call(async () => {
        await client.beta.sessions.events.send(sessionId, {
          events: [
            {
              type: "user.tool_confirmation",
              tool_use_id: toolUseId,
              result: decision.allow ? "allow" : "deny",
              ...(decision.allow || !decision.message ? {} : { deny_message: decision.message }),
            },
          ],
          betas,
        });
      }),

    interrupt: (sessionId) =>
      call(async () => {
        await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }], betas });
      }),

    getSession: (sessionId) =>
      call(async () => {
        let session;
        try {
          session = await client.beta.sessions.retrieve(sessionId, { betas });
        } catch (error) {
          if (error instanceof Anthropic.NotFoundError) return null;
          throw error;
        }
        const usage = session.usage ?? {};
        const listCost = usage.list_cost?.currency === "USD" ? Number(usage.list_cost.amount) : null;
        return {
          id: session.id,
          status: session.status,
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) + (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
            listCostCents: listCost !== null && Number.isFinite(listCost) ? listCost : null,
            activeSeconds: Math.round(usage.active_seconds ?? session.stats?.active_seconds ?? 0),
          },
        };
      }),

    listEvents: (sessionId, rawCursor, limit) =>
      call(async () => {
        const cursor = parseCursor(rawCursor);
        // Inside a long read, follow the provider's page token; after the last
        // page, start the next read from the newest processed_at minus the overlap.
        const querySince = cursor?.page ? cursor.pageSince : (cursor?.since ?? null);
        const page = await client.beta.sessions.events.list(sessionId, {
          limit,
          order: "asc",
          ...(querySince ? { "created_at[gte]": querySince } : {}),
          ...(cursor?.page ? { page: cursor.page } : {}),
          betas,
        });
        const seen = new Set(cursor?.seen ?? []);
        const events: ProviderEvent[] = [];
        let latest = cursor?.latest ? Date.parse(cursor.latest) : 0;
        for (const raw of page.data) {
          const processedAt = "processed_at" in raw ? raw.processed_at : null;
          // A queued user event has no processed_at yet: read it on a later pass.
          if (!processedAt || !raw.id || seen.has(raw.id)) continue;
          seen.add(raw.id);
          const at = new Date(processedAt);
          latest = Math.max(latest, at.getTime());
          events.push(normalizeEvent(raw, at));
        }
        const latestIso = latest ? new Date(latest).toISOString() : null;
        const next: EventCursor = {
          since: latest ? new Date(Math.max(0, latest - CURSOR_OVERLAP_MS)).toISOString() : (cursor?.since ?? null),
          latest: latestIso,
          seen: [...seen].slice(-CURSOR_MAX_SEEN),
          page: page.next_page ?? null,
          pageSince: page.next_page ? querySince : null,
        };
        return { events, cursor: JSON.stringify(next), hasMore: Boolean(page.next_page) };
      }),

    listOutputs: (sessionId) =>
      call(async () => {
        const page = await client.beta.files.list({ scope_id: sessionId, limit: 100, betas });
        return page.data.map((file) => ({ id: file.id, name: file.filename, size: file.size_bytes, mimeType: file.mime_type ?? null }));
      }),

    downloadOutput: (sessionId, outputId) =>
      call(async () => {
        const page = await client.beta.files.list({ scope_id: sessionId, ids: [outputId], limit: 1, betas });
        const file = page.data.find((candidate) => candidate.id === outputId);
        if (!file) throw new CloudProviderError("not_found", "The output does not exist in this run.", 404);
        const response = await client.beta.files.download(outputId, { betas });
        return {
          body: response.body,
          contentType: file.mime_type || "application/octet-stream",
          name: file.filename,
          size: file.size_bytes,
        };
      }),

    deleteSession: (sessionId) =>
      call(async () => {
        await ignoreNotFound(() => client.beta.sessions.delete(sessionId, { betas }));
      }),
  };
}

function agentBody(spec: ProviderAgentSpec) {
  return {
    name: spec.name.slice(0, 200),
    description: spec.description.slice(0, 2000),
    system: spec.system,
    model: spec.effort ? { id: spec.model, effort: spec.effort } : spec.model,
    metadata: spec.metadata,
    mcp_servers: spec.mcpServers.map((server) => ({ type: "url" as const, name: server.name, url: server.url })),
    skills: spec.skills.map((skill) => ({ type: "custom" as const, skill_id: skill.skillId, ...(skill.version ? { version: skill.version } : {}) })),
    tools: [
      {
        type: "agent_toolset_20260401" as const,
        // Built-in tools act only inside the disposable container (D9).
        default_config: { enabled: true, permission_policy: { type: "always_allow" as const } },
        configs: [
          { name: "web_search" as const, enabled: spec.webSearch },
          { name: "web_fetch" as const, enabled: spec.webSearch },
        ],
      },
      ...spec.mcpServers.map((server) => ({
        type: "mcp_toolset" as const,
        mcp_server_name: server.name,
        default_config: {
          enabled: true,
          permission_policy: { type: server.permission === "ask" ? ("always_ask" as const) : ("always_allow" as const) },
        },
        configs:
          server.permission === "ask"
            ? server.allowTools.map((name) => ({ name, permission_policy: { type: "always_allow" as const } }))
            : [],
      })),
    ],
  };
}

function refreshParams(credential: ProviderMcpCredential) {
  return {
    client_id: credential.clientId,
    refresh_token: credential.refreshToken,
    token_endpoint: credential.tokenEndpoint,
    token_endpoint_auth: { type: "none" as const },
  };
}

function normalizeEvent(raw: BetaManagedAgentsSessionEvent, at: Date): ProviderEvent {
  const base = { id: raw.id, at };
  switch (raw.type) {
    case "agent.message":
      return { ...base, kind: "message", role: "agent", text: textOf(raw.content) };
    case "user.message":
      return { ...base, kind: "message", role: "user", text: textOf(raw.content) };
    case "agent.mcp_tool_use":
      return {
        ...base,
        kind: "tool_use",
        tool: raw.name,
        server: raw.mcp_server_name,
        input: raw.input,
        permission: raw.evaluated_permission ?? null,
      };
    case "agent.tool_use":
      return { ...base, kind: "tool_use", tool: raw.name, server: null, input: raw.input, permission: raw.evaluated_permission ?? null };
    case "agent.tool_result":
      return { ...base, kind: "tool_result", toolUseId: raw.tool_use_id, isError: Boolean(raw.is_error), text: textOf(raw.content ?? []) };
    case "agent.mcp_tool_result":
      return {
        ...base,
        kind: "tool_result",
        toolUseId: raw.mcp_tool_use_id,
        isError: Boolean(raw.is_error),
        text: textOf(raw.content ?? []),
      };
    case "session.status_idle":
      return { ...base, kind: "status", status: "idle", stopReason: stopReason(raw.stop_reason) };
    case "session.status_running":
      return { ...base, kind: "status", status: "running", stopReason: null };
    case "session.status_rescheduled":
      return { ...base, kind: "status", status: "rescheduling", stopReason: null };
    case "session.status_terminated":
      return { ...base, kind: "status", status: "terminated", stopReason: null };
    case "session.error":
      return {
        ...base,
        kind: "error",
        errorType: raw.error.type,
        message: raw.error.message,
        retrying: raw.error.retry_status?.type === "retrying",
      };
    default:
      return { ...base, kind: "other", type: raw.type };
  }
}

function stopReason(raw: { type: string; event_ids?: string[] } | null | undefined): ProviderStopReason | null {
  if (!raw) return null;
  switch (raw.type) {
    case "end_turn":
    case "budget_reached":
    case "retries_exhausted":
    case "refusal":
      return { type: raw.type };
    case "requires_action":
      return { type: "requires_action", eventIds: raw.event_ids ?? [] };
    default:
      return { type: "other", raw: raw.type };
  }
}

function textOf(content: readonly unknown[]) {
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "",
    )
    .filter(Boolean)
    .join("\n");
}

function parseCursor(raw: string | null): EventCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<EventCursor>;
    const text = (field: unknown) => (typeof field === "string" ? field : null);
    return {
      since: text(value.since),
      latest: text(value.latest),
      seen: Array.isArray(value.seen) ? value.seen.filter((id): id is string => typeof id === "string") : [],
      page: text(value.page),
      pageSince: text(value.pageSince),
    };
  } catch {
    // An unreadable cursor restarts from the first event; mirrored events dedupe by id.
    return null;
  }
}

async function ignoreNotFound(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof Anthropic.NotFoundError)) throw error;
  }
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw normalizeError(error);
  }
}

function normalizeError(error: unknown): CloudProviderError {
  if (error instanceof CloudProviderError) return error;
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : null;
    const message = providerMessage(error);
    if (status === 401) return new CloudProviderError("auth", message, status);
    if (status === 403) return new CloudProviderError("permission", message, status);
    if (status === 404) return new CloudProviderError("not_found", message, status);
    if (status === 429) return new CloudProviderError("rate_limited", message, status);
    if (status !== null && status >= 400 && status < 500) return new CloudProviderError("invalid_request", message, status);
    return new CloudProviderError("unavailable", message, status);
  }
  return new CloudProviderError("unknown", error instanceof Error ? error.message.slice(0, 300) : "Unknown provider error.");
}

/** The provider's own error message, never the request (which may carry a token). */
function providerMessage(error: InstanceType<typeof Anthropic.APIError>) {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = typeof body?.error?.message === "string" ? body.error.message : `Anthropic API error ${error.status ?? ""}`.trim();
  return message.slice(0, 300);
}
