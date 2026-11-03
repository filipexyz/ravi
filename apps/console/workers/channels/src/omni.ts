import type { ChannelsWorkerEnv } from "./env";

export class OmniClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "omni_unauthorized" | "omni_not_found" | "omni_rate_limited" | "omni_unavailable" | "omni_error",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OmniClientError";
  }
}

export interface OmniInstance {
  id: string;
  name: string | null;
  status: string | null;
  isConnected: boolean | null;
  phone: string | null;
  displayPhone: string | null;
  raw: Record<string, unknown>;
}

export interface OmniApiKeyResult {
  plainTextKey: string;
  keyPrefix: string;
  raw: Record<string, unknown>;
}

export async function omniHealth(env: ChannelsWorkerEnv): Promise<Record<string, unknown>> {
  return omniRequest<Record<string, unknown>>(env, "/health", {
    method: "GET",
    apiKey: env.RAVI_CHANNELS_OMNI_SERVICE_API_KEY,
  });
}

export async function createOmniWhatsappInstance(
  env: ChannelsWorkerEnv,
  input: { name: string },
): Promise<OmniInstance> {
  const payload = await omniRequest<Record<string, unknown>>(env, "/instances", {
    method: "POST",
    apiKey: env.RAVI_CHANNELS_OMNI_SERVICE_API_KEY,
    body: {
      name: input.name,
      channel: "whatsapp-baileys",
    },
  });
  return extractInstance(payload);
}

export async function createScopedOmniApiKey(
  env: ChannelsWorkerEnv,
  input: { channelInstanceId: string; omniInstanceId: string; includeSendScope?: boolean },
): Promise<OmniApiKeyResult> {
  const scopes = [
    "instances:read",
    "instances:write",
    ...(input.includeSendScope === false ? [] : ["messages:send"]),
    "chats:read",
    "events:read",
    "persons:read",
  ];
  const payload = await omniRequest<Record<string, unknown>>(env, "/keys", {
    method: "POST",
    apiKey: env.RAVI_CHANNELS_OMNI_SERVICE_API_KEY,
    body: {
      name: `ravi-channel-instance-${input.channelInstanceId}`,
      description: "Ravi Console scoped key for one WhatsApp channel instance",
      scopes,
      instanceIds: [input.omniInstanceId],
    },
  });
  const source = objectValue(payload.data) ?? payload;
  const plainTextKey = stringValue(source.plainTextKey)
    ?? stringValue(source.plaintextKey)
    ?? stringValue(source.apiKey)
    ?? stringValue(source.key);
  if (!plainTextKey) {
    throw new OmniClientError(502, "omni_error", "Omni did not return a plaintext API key.");
  }
  return {
    plainTextKey,
    keyPrefix: keyPrefix(plainTextKey),
    raw: sanitizeProviderPayload(source),
  };
}

export async function getOmniInstanceStatus(
  env: ChannelsWorkerEnv,
  input: { omniInstanceId: string; apiKey: string },
): Promise<OmniInstance> {
  const payload = await omniRequest<Record<string, unknown>>(
    env,
    `/instances/${encodeURIComponent(input.omniInstanceId)}/status`,
    { method: "GET", apiKey: input.apiKey },
  );
  return extractInstance(payload);
}

export async function getOmniQr(
  env: ChannelsWorkerEnv,
  input: { omniInstanceId: string; apiKey: string },
): Promise<Record<string, unknown>> {
  return sanitizeProviderPayload(await omniRequest<Record<string, unknown>>(
    env,
    `/instances/${encodeURIComponent(input.omniInstanceId)}/qr`,
    { method: "GET", apiKey: input.apiKey },
  ), { allowQr: true });
}

export async function pairOmniInstance(
  env: ChannelsWorkerEnv,
  input: { omniInstanceId: string; apiKey: string; phoneNumber?: string },
): Promise<Record<string, unknown>> {
  return sanitizeProviderPayload(await omniRequest<Record<string, unknown>>(
    env,
    `/instances/${encodeURIComponent(input.omniInstanceId)}/pair`,
    { method: "POST", apiKey: input.apiKey, body: { phoneNumber: input.phoneNumber } },
  ), { allowPairingCode: true });
}

export async function commandOmniInstance(
  env: ChannelsWorkerEnv,
  input: {
    omniInstanceId: string;
    apiKey: string;
    action: "connect" | "disconnect" | "restart" | "logout";
  },
): Promise<Record<string, unknown>> {
  return sanitizeProviderPayload(await omniRequest<Record<string, unknown>>(
    env,
    `/instances/${encodeURIComponent(input.omniInstanceId)}/${input.action}`,
    { method: "POST", apiKey: input.apiKey },
  ));
}

async function omniRequest<T>(
  env: ChannelsWorkerEnv,
  path: string,
  input: { method: "GET" | "POST" | "PATCH" | "DELETE"; apiKey: string; body?: unknown },
): Promise<T> {
  const baseUrl = normalizeOmniBaseUrl(env.RAVI_CHANNELS_OMNI_BASE_URL);
  const apiPath = path.startsWith("/") ? path : `/${path}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "x-api-key": input.apiKey,
  };
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  if (env.RAVI_CHANNELS_OMNI_ACCESS_CLIENT_ID && env.RAVI_CHANNELS_OMNI_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.RAVI_CHANNELS_OMNI_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.RAVI_CHANNELS_OMNI_ACCESS_CLIENT_SECRET;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${apiPath}`, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
  } catch (error) {
    throw new OmniClientError(503, "omni_unavailable", error instanceof Error ? error.message : undefined);
  }

  const text = await response.text();
  const payload = text.trim() ? safeJson(text) : {};
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403
      ? "omni_unauthorized"
      : response.status === 404
        ? "omni_not_found"
        : response.status === 429
          ? "omni_rate_limited"
          : response.status >= 500
            ? "omni_unavailable"
            : "omni_error";
    throw new OmniClientError(response.status, code, omniErrorMessage(payload));
  }
  return payload as T;
}

function normalizeOmniBaseUrl(rawBaseUrl: string): string {
  const baseUrl = rawBaseUrl.replace(/\/$/, "");
  if (baseUrl.endsWith("/api/v2")) return baseUrl;
  return `${baseUrl}/api/v2`;
}

function omniErrorMessage(payload: unknown): string | undefined {
  const error = objectValue(objectValue(payload)?.error);
  return stringValue(error?.message) ?? stringValue(error?.code) ?? undefined;
}

export function extractInstance(payload: Record<string, unknown>): OmniInstance {
  const source = objectValue(payload.instance)
    ?? objectValue(payload.data)
    ?? payload;
  const id = stringValue(source.id)
    ?? stringValue(source.instanceId)
    ?? stringValue(source.uuid);
  if (!id) throw new OmniClientError(502, "omni_error", "Omni response did not include an instance id.");

  const profile = objectValue(source.profile) ?? objectValue(source.owner) ?? {};
  const rawStatus = stringValue(source.status)
    ?? stringValue(source.state)
    ?? stringValue(source.connectionState)
    ?? null;
  return {
    id,
    name: stringValue(source.name) ?? stringValue(source.instanceName),
    status: rawStatus,
    isConnected: booleanValue(source.isConnected)
      ?? booleanValue(source.connected)
      ?? (rawStatus ? rawStatus.toLowerCase() === "connected" : null),
    phone: stringValue(source.phone)
      ?? stringValue(source.phoneNumber)
      ?? stringValue(source.ownerIdentifier)
      ?? stringValue(profile.phone)
      ?? null,
    displayPhone: stringValue(source.displayPhone)
      ?? stringValue(source.phoneDisplay)
      ?? stringValue(profile.name)
      ?? null,
    raw: sanitizeProviderPayload(source),
  };
}

export function sanitizeProviderPayload(
  value: unknown,
  options: { allowQr?: boolean; allowPairingCode?: boolean } = {},
): Record<string, unknown> {
  const sanitized = sanitize(value, options);
  return objectValue(sanitized) ?? {};
}

function sanitize(
  value: unknown,
  options: { allowQr?: boolean; allowPairingCode?: boolean },
): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, options));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (options.allowQr && (lowered === "qr" || lowered === "qrcode" || lowered === "qr_code")) {
      result[key] = item;
      continue;
    }
    if (options.allowPairingCode && (lowered === "pairingcode" || lowered === "pairing_code")) {
      result[key] = item;
      continue;
    }
    if (
      lowered.includes("apikey")
      || lowered.includes("api_key")
      || lowered.includes("token")
      || lowered.includes("secret")
      || lowered.includes("credential")
      || lowered.includes("qrcode")
      || lowered === "qr"
      || lowered === "qr_code"
      || lowered === "pairingcode"
      || lowered === "pairing_code"
      || lowered === "pairing"
    ) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = sanitize(item, options);
  }
  return result;
}

function keyPrefix(key: string): string {
  if (key.startsWith("omni_sk_")) return key.slice("omni_sk_".length, "omni_sk_".length + 8);
  return key.slice(0, 8);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { body: text };
  }
}
