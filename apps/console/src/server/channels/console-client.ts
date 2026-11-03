import {
  channelHmacRequest,
  ChannelHmacError,
  getChannelHmacConfig,
} from "./link-hmac-client";

export interface ChannelActorContext {
  userId: string;
  organizationId: string;
}

export interface ConsoleChannelInstance {
  id: string;
  organizationId: string;
  hostId: string;
  channel: "whatsapp";
  provider: "omni";
  displayName: string;
  phoneE164: string | null;
  phoneDisplay: string | null;
  status: string;
  connectionState: string | null;
  externalInstanceId: string | null;
  externalInstanceName: string;
  createdByUserId: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastHealthAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ConsoleChannelClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ConsoleChannelClientError";
  }
}

function requireConfig() {
  const config = getChannelHmacConfig();
  if (!config) {
    throw new ConsoleChannelClientError(
      503,
      "server_not_configured",
      "RAVI_CHANNELS HMAC keys are not configured.",
    );
  }
  return config;
}

export async function listWhatsappInstances(actor: ChannelActorContext): Promise<ConsoleChannelInstance[]> {
  const result = await call<{ instances: ConsoleChannelInstance[] }>(
    "/ui/channels/whatsapp/instances/list",
    actor,
  );
  return result.instances;
}

export async function createWhatsappInstance(
  actor: ChannelActorContext,
  input: { displayName?: string; clientRequestId?: string },
): Promise<ConsoleChannelInstance> {
  const result = await call<{ instance: ConsoleChannelInstance }>(
    "/ui/channels/whatsapp/instances",
    actor,
    input,
  );
  return result.instance;
}

export async function showWhatsappInstance(
  actor: ChannelActorContext,
  id: string,
): Promise<ConsoleChannelInstance> {
  const result = await call<{ instance: ConsoleChannelInstance }>(
    `/ui/channels/whatsapp/instances/${encodeURIComponent(id)}/show`,
    actor,
  );
  return result.instance;
}

export async function requestWhatsappQr(
  actor: ChannelActorContext,
  id: string,
): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(
    `/ui/channels/whatsapp/instances/${encodeURIComponent(id)}/qr`,
    actor,
  );
}

export async function pairWhatsappInstance(
  actor: ChannelActorContext,
  id: string,
  input: { clientRequestId?: string; phoneNumber?: string },
): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(
    `/ui/channels/whatsapp/instances/${encodeURIComponent(id)}/pair`,
    actor,
    input,
  );
}

export async function commandWhatsappInstance(
  actor: ChannelActorContext,
  id: string,
  action: "connect" | "disconnect" | "restart" | "logout" | "disable" | "delete" | "rotate-key",
  input: { clientRequestId?: string } = {},
): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>(
    `/ui/channels/whatsapp/instances/${encodeURIComponent(id)}/${action}`,
    actor,
    input,
  );
}

export async function checkChannelsHealth(actor: ChannelActorContext): Promise<Record<string, unknown>> {
  return call<Record<string, unknown>>("/ui/channels/hosts/health", actor);
}

async function call<T>(
  path: string,
  actor: ChannelActorContext,
  body: Record<string, unknown> = {},
): Promise<T> {
  const config = requireConfig();
  try {
    return await channelHmacRequest<T>(config, {
      method: "POST",
      path,
      body: { ...body, ...actor },
    });
  } catch (error) {
    throw normalizeError(error);
  }
}

function normalizeError(error: unknown): ConsoleChannelClientError {
  if (error instanceof ConsoleChannelClientError) return error;
  if (error instanceof ChannelHmacError) {
    return new ConsoleChannelClientError(error.status, error.code, error.message, error.details);
  }
  return new ConsoleChannelClientError(500, "internal_error", "Unexpected channels error");
}
