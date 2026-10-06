type JsonObject = Record<string, unknown>;

export class OmniApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = "OmniApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

type PaginatedResponse<T> = {
  items: T[];
  meta?: JsonObject;
};

type InstanceRecord = {
  id?: string;
  name?: string;
  channel?: string;
  isActive?: boolean;
  isConnected?: boolean;
  profileName?: string | null;
  state?: string;
};

type OmniGroupRecord = {
  id?: string;
  externalId?: string;
  subject?: string;
  name?: string;
  owner?: string;
  creation?: number;
  participants?: Array<{ id: string; admin: string | null }>;
  memberCount?: number;
  isCommunity?: boolean;
};

type OmniChatRecord = {
  id?: string;
  instanceId?: string;
  externalId?: string;
  chatType?: string;
  channel?: string;
  name?: string | null;
  participantCount?: number | null;
  [key: string]: unknown;
};

type OmniChatParticipantRecord = {
  id?: string;
  chatId?: string;
  platformUserId?: string;
  displayName?: string | null;
  role?: string | null;
  [key: string]: unknown;
};

type OmniGroupParticipantAction = "remove" | "promote" | "demote";

type OmniGroupInviteRecord = {
  groupJid?: string;
  chatId?: string;
  code?: string;
  inviteLink?: string;
  link?: string;
  [key: string]: unknown;
};

type OmniGroupJoinRecord = {
  groupJid?: string;
  groupId?: string;
  joined?: boolean;
  [key: string]: unknown;
};

type RequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
};

type RequestAttempt = RequestOptions & {
  path: string;
};

type ApiEnvelope<T> = {
  data?: T;
  items?: T extends Array<infer U> ? U[] : never;
  meta?: JsonObject;
  error?: unknown;
  message?: string;
};

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`/api/v2${path}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseApiError(payload: unknown, status: number): OmniApiError {
  if (payload && typeof payload === "object") {
    const body = payload as JsonObject;
    const raw = body.error;
    if (typeof raw === "string") return new OmniApiError(raw, { status });
    if (raw && typeof raw === "object") {
      const error = raw as JsonObject;
      return new OmniApiError(String(error.message ?? `API error (${status})`), {
        status,
        code: typeof error.code === "string" ? error.code : undefined,
        details: error.details,
      });
    }
    if (typeof body.message === "string") return new OmniApiError(body.message, { status });
  }
  return new OmniApiError(`API error (${status})`, { status });
}

/** Bounds every Omni API call so a response that never completes cannot freeze the caller. */
export const DEFAULT_OMNI_REQUEST_TIMEOUT_MS = 15_000;
/** Media and sticker sends upload to the channel before Omni answers, so they get more room. */
export const OMNI_MEDIA_REQUEST_TIMEOUT_MS = 120_000;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function createOmniClient(config: { baseUrl: string; apiKey: string; cliVersion?: string; timeoutMs?: number }) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const defaultTimeoutMs = config.timeoutMs ?? DEFAULT_OMNI_REQUEST_TIMEOUT_MS;

  async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    const headers = new Headers();
    headers.set("x-api-key", config.apiKey);
    headers.set("Accept-Encoding", "identity");
    if (config.cliVersion) headers.set("x-omni-cli-version", config.cliVersion);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");

    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let payload: ApiEnvelope<T>;
    try {
      response = await fetch(buildUrl(baseUrl, path, options.query), {
        method,
        headers,
        signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      payload = (await response.json().catch((error: unknown) => {
        // The body read shares the signal; a stalled body must still surface as a timeout.
        if (signal.aborted) throw error;
        return {};
      })) as ApiEnvelope<T>;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        throw new OmniApiError(`Omni API request timed out after ${timeoutMs}ms: ${method} ${path}`, {
          code: "TIMEOUT",
        });
      }
      throw error;
    }
    if (!response.ok) throw parseApiError(payload, response.status);
    return payload;
  }

  async function requestData<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const payload = await request<T>(path, options);
    return (payload.data ?? payload) as T;
  }

  async function requestFirstData<T>(
    attempts: RequestAttempt[],
    unavailable: { code: string; message: string },
  ): Promise<T> {
    let lastError: unknown;
    for (const { path, ...options } of attempts) {
      try {
        return await requestData<T>(path, options);
      } catch (err) {
        lastError = err;
        if (err instanceof OmniApiError && (err.status === 404 || err.code === "NOT_FOUND")) continue;
        throw err;
      }
    }
    throw new OmniApiError(unavailable.message, {
      status: 404,
      code: unavailable.code,
      details: lastError instanceof Error ? lastError.message : undefined,
    });
  }

  return {
    instances: {
      async list(params?: RequestOptions["query"]): Promise<PaginatedResponse<InstanceRecord>> {
        const payload = await request<InstanceRecord[]>("/instances", { query: params });
        return {
          items: payload.items ?? payload.data ?? [],
          meta: payload.meta,
        };
      },
      async create(body: { name: string; channel: string }): Promise<InstanceRecord> {
        const payload = await request<InstanceRecord>("/instances", { method: "POST", body });
        return payload.data ?? {};
      },
      async status(id: string): Promise<{ state: string; isConnected: boolean; profileName?: string | null }> {
        const payload = await request<{ state?: string; isConnected?: boolean; profileName?: string | null }>(
          `/instances/${encodeURIComponent(id)}/status`,
        );
        return {
          state: payload.data?.state ?? "unknown",
          isConnected: payload.data?.isConnected ?? false,
          profileName: payload.data?.profileName,
        };
      },
      async connect(id: string, body?: unknown): Promise<{ status: string; message: string }> {
        const payload = await request<{ status?: string; message?: string }>(
          `/instances/${encodeURIComponent(id)}/connect`,
          {
            method: "POST",
            body: body ?? {},
          },
        );
        return {
          status: payload.data?.status ?? "connecting",
          message: payload.data?.message ?? "Connection initiated",
        };
      },
      async disconnect(id: string): Promise<void> {
        await request(`/instances/${encodeURIComponent(id)}/disconnect`, { method: "POST" });
      },
      async listGroups(id: string, params?: RequestOptions["query"]): Promise<PaginatedResponse<OmniGroupRecord>> {
        const payload = await request<OmniGroupRecord[]>(`/instances/${encodeURIComponent(id)}/groups`, {
          query: params,
        });
        return {
          items: payload.items ?? payload.data ?? [],
          meta: payload.meta,
        };
      },
      async createGroup(id: string, body: { subject: string; participants: string[] }): Promise<OmniGroupRecord> {
        const payload = await request<OmniGroupRecord>(`/instances/${encodeURIComponent(id)}/groups`, {
          method: "POST",
          body,
        });
        return payload.data ?? {};
      },
      async addGroupParticipants(id: string, groupJid: string, body: { participants: string[] }): Promise<JsonObject> {
        const encodedInstance = encodeURIComponent(id);
        const encodedGroup = encodeURIComponent(groupJid);
        const paths = [
          `/instances/${encodedInstance}/groups/${encodedGroup}/participants`,
          `/groups/${encodedGroup}/participants`,
        ];
        let lastError: unknown;
        for (const path of paths) {
          try {
            return await requestData<JsonObject>(path, {
              method: "POST",
              body: {
                instanceId: id,
                groupId: groupJid,
                participants: body.participants,
              },
            });
          } catch (err) {
            lastError = err;
            if (err instanceof OmniApiError && (err.status === 404 || err.code === "NOT_FOUND")) continue;
            throw err;
          }
        }
        throw new OmniApiError("Omni group participant REST endpoint is not available", {
          status: 404,
          code: "GROUP_PARTICIPANTS_REST_UNAVAILABLE",
          details: lastError instanceof Error ? lastError.message : undefined,
        });
      },
      async updateGroupParticipants(
        id: string,
        groupJid: string,
        body: { action: OmniGroupParticipantAction; participants: string[] },
      ): Promise<JsonObject> {
        const encodedInstance = encodeURIComponent(id);
        const encodedGroup = encodeURIComponent(groupJid);
        const requestBody = {
          instanceId: id,
          groupId: groupJid,
          action: body.action,
          participants: body.participants,
        };
        return requestFirstData<JsonObject>(
          [
            {
              path: `/instances/${encodedInstance}/groups/${encodedGroup}/participants/${body.action}`,
              method: "POST",
              body: requestBody,
            },
            {
              path: `/groups/${encodedGroup}/participants/${body.action}`,
              method: "POST",
              body: requestBody,
            },
            {
              path: `/instances/${encodedInstance}/groups/${encodedGroup}/participants`,
              method: "PATCH",
              body: requestBody,
            },
            {
              path: `/groups/${encodedGroup}/participants`,
              method: "PATCH",
              body: requestBody,
            },
          ],
          {
            code: "GROUP_PARTICIPANTS_REST_UNAVAILABLE",
            message: `Omni group participant ${body.action} REST endpoint is not available`,
          },
        );
      },
      async getGroupInvite(id: string, groupJid: string): Promise<OmniGroupInviteRecord> {
        return requestData<OmniGroupInviteRecord>(
          `/instances/${encodeURIComponent(id)}/groups/${encodeURIComponent(groupJid)}/invite`,
        );
      },
      async revokeGroupInvite(id: string, groupJid: string): Promise<OmniGroupInviteRecord> {
        return requestData<OmniGroupInviteRecord>(
          `/instances/${encodeURIComponent(id)}/groups/${encodeURIComponent(groupJid)}/invite/revoke`,
          { method: "POST" },
        );
      },
      async joinGroup(id: string, body: { code: string }): Promise<OmniGroupJoinRecord> {
        return requestData<OmniGroupJoinRecord>(`/instances/${encodeURIComponent(id)}/groups/join`, {
          method: "POST",
          body,
        });
      },
      async leaveGroup(id: string, groupJid: string): Promise<JsonObject> {
        const encodedInstance = encodeURIComponent(id);
        const encodedGroup = encodeURIComponent(groupJid);
        const requestBody = { instanceId: id, groupId: groupJid };
        return requestFirstData<JsonObject>(
          [
            { path: `/instances/${encodedInstance}/groups/${encodedGroup}/leave`, method: "POST", body: requestBody },
            { path: `/groups/${encodedGroup}/leave`, method: "POST", body: requestBody },
          ],
          {
            code: "GROUP_LEAVE_REST_UNAVAILABLE",
            message: "Omni group leave REST endpoint is not available",
          },
        );
      },
      async renameGroup(id: string, groupJid: string, body: { subject: string }): Promise<JsonObject> {
        const encodedInstance = encodeURIComponent(id);
        const encodedGroup = encodeURIComponent(groupJid);
        const requestBody = { instanceId: id, groupId: groupJid, subject: body.subject };
        return requestFirstData<JsonObject>(
          [
            { path: `/instances/${encodedInstance}/groups/${encodedGroup}`, method: "PATCH", body: requestBody },
            { path: `/instances/${encodedInstance}/groups/${encodedGroup}/subject`, method: "PUT", body: requestBody },
            { path: `/instances/${encodedInstance}/groups/${encodedGroup}/subject`, method: "POST", body: requestBody },
            { path: `/groups/${encodedGroup}`, method: "PATCH", body: requestBody },
          ],
          {
            code: "GROUP_RENAME_REST_UNAVAILABLE",
            message: "Omni group rename REST endpoint is not available",
          },
        );
      },
      async setGroupDescription(id: string, groupJid: string, body: { description: string }): Promise<JsonObject> {
        const encodedInstance = encodeURIComponent(id);
        const encodedGroup = encodeURIComponent(groupJid);
        const requestBody = { instanceId: id, groupId: groupJid, description: body.description };
        return requestFirstData<JsonObject>(
          [
            { path: `/instances/${encodedInstance}/groups/${encodedGroup}`, method: "PATCH", body: requestBody },
            {
              path: `/instances/${encodedInstance}/groups/${encodedGroup}/description`,
              method: "PUT",
              body: requestBody,
            },
            {
              path: `/instances/${encodedInstance}/groups/${encodedGroup}/description`,
              method: "POST",
              body: requestBody,
            },
            { path: `/groups/${encodedGroup}`, method: "PATCH", body: requestBody },
          ],
          {
            code: "GROUP_DESCRIPTION_REST_UNAVAILABLE",
            message: "Omni group description REST endpoint is not available",
          },
        );
      },
      async setGroupSettings(id: string, groupJid: string, body: { setting: string }): Promise<JsonObject> {
        const encodedInstance = encodeURIComponent(id);
        const encodedGroup = encodeURIComponent(groupJid);
        const requestBody = { instanceId: id, groupId: groupJid, setting: body.setting };
        return requestFirstData<JsonObject>(
          [
            {
              path: `/instances/${encodedInstance}/groups/${encodedGroup}/settings`,
              method: "POST",
              body: requestBody,
            },
            { path: `/instances/${encodedInstance}/groups/${encodedGroup}`, method: "PATCH", body: requestBody },
            { path: `/groups/${encodedGroup}/settings`, method: "POST", body: requestBody },
          ],
          {
            code: "GROUP_SETTINGS_REST_UNAVAILABLE",
            message: "Omni group settings REST endpoint is not available",
          },
        );
      },
    },
    chats: {
      async list(params?: RequestOptions["query"]): Promise<PaginatedResponse<OmniChatRecord>> {
        const payload = await request<OmniChatRecord[]>("/chats", { query: params });
        return {
          items: payload.items ?? payload.data ?? [],
          meta: payload.meta,
        };
      },
      async listParticipants(id: string): Promise<PaginatedResponse<OmniChatParticipantRecord>> {
        const payload = await request<OmniChatParticipantRecord[]>(`/chats/${encodeURIComponent(id)}/participants`);
        return {
          items: payload.items ?? payload.data ?? [],
          meta: payload.meta,
        };
      },
      async addParticipant(
        id: string,
        body: { platformUserId: string; displayName?: string; role?: string },
      ): Promise<OmniChatParticipantRecord> {
        const payload = await request<OmniChatParticipantRecord>(`/chats/${encodeURIComponent(id)}/participants`, {
          method: "POST",
          body,
        });
        return payload.data ?? {};
      },
    },
    messages: {
      async send(body: JsonObject): Promise<{ messageId?: string; status?: string }> {
        const payload = await request<{ messageId?: string; status?: string }>("/messages/send", {
          method: "POST",
          body,
        });
        return payload.data ?? {};
      },
      async sendPresence(body: JsonObject): Promise<void> {
        await request("/messages/send/presence", { method: "POST", body });
      },
      async sendReaction(body: JsonObject): Promise<{ messageId?: string; success?: boolean }> {
        const payload = await request<{ messageId?: string }>("/messages/send/reaction", { method: "POST", body });
        return { messageId: payload.data?.messageId, success: true };
      },
      async deleteChannel(body: { instanceId: string; channelId: string; messageId: string }): Promise<void> {
        await request("/messages/delete-channel", { method: "POST", body });
      },
      async editChannel(body: {
        instanceId: string;
        channelId: string;
        messageId: string;
        text: string;
      }): Promise<void> {
        await request("/messages/edit-channel", { method: "POST", body });
      },
      async sendMedia(body: JsonObject): Promise<{ messageId?: string; status?: string }> {
        const payload = await request<{ messageId?: string; status?: string }>("/messages/send/media", {
          method: "POST",
          timeoutMs: OMNI_MEDIA_REQUEST_TIMEOUT_MS,
          body,
        });
        return payload.data ?? {};
      },
      async sendSticker(body: JsonObject): Promise<{ messageId?: string; status?: string }> {
        const payload = await request<{ messageId?: string; status?: string }>("/messages/send/sticker", {
          method: "POST",
          timeoutMs: OMNI_MEDIA_REQUEST_TIMEOUT_MS,
          body,
        });
        return payload.data ?? {};
      },
      async batchMarkRead(body: { instanceId: string; chatId: string; messageIds: string[] }): Promise<void> {
        await request("/messages/read", { method: "POST", body });
      },
    },
  };
}

export type OmniClient = ReturnType<typeof createOmniClient>;
