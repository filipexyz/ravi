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

type RequestOptions = {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
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

export function createOmniClient(config: { baseUrl: string; apiKey: string; cliVersion?: string }) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    const headers = new Headers();
    headers.set("x-api-key", config.apiKey);
    headers.set("Accept-Encoding", "identity");
    if (config.cliVersion) headers.set("x-omni-cli-version", config.cliVersion);
    if (options.body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(buildUrl(baseUrl, path, options.query), {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
    if (!response.ok) throw parseApiError(payload, response.status);
    return payload;
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
      async sendMedia(body: JsonObject): Promise<{ messageId?: string; status?: string }> {
        const payload = await request<{ messageId?: string; status?: string }>("/messages/send/media", {
          method: "POST",
          body,
        });
        return payload.data ?? {};
      },
      async sendSticker(body: JsonObject): Promise<{ messageId?: string; status?: string }> {
        const payload = await request<{ messageId?: string; status?: string }>("/messages/send/sticker", {
          method: "POST",
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
