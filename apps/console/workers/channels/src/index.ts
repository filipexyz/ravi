/**
 * `ravi-channel-control` Worker entrypoint.
 *
 * This Worker owns privileged communication with Omni. Vercel sends
 * authenticated user intent over HMAC; Omni keys never leave this boundary.
 */

import * as Sentry from "@sentry/cloudflare";

import { ChannelCryptoError, createDek, decryptPayload, encryptPayload, importRootWrapKey } from "./crypto";
import {
  completeIdempotencyRecord,
  ensureDefaultOmniHost,
  failIdempotencyRecord,
  findActiveChannelCredential,
  findActiveMembership,
  findChannelInstance,
  findIdempotencyRecord,
  insertAuditEvent,
  insertChannelCredential,
  insertChannelEvent,
  insertPendingChannelInstance,
  listChannelInstances,
  markChannelCredentialTampered,
  openChannelsDb,
  rotateChannelCredential,
  startIdempotencyRecord,
  updateChannelHostHealth,
  updateChannelInstanceProvisioned,
  updateChannelInstanceStatus,
  type ChannelHostRecord,
  type ChannelInstanceRecord,
  type ChannelInstanceStatus,
  type ChannelsDb,
  type JsonRecord,
} from "./db";
import type { ChannelsWorkerEnv } from "./env";
import { ChannelHttpError, jsonError, jsonSuccess } from "./errors";
import { HmacAuthError, verifyHmacRequest, type HmacKeyMaterial } from "./hmac";
import {
  commandOmniInstance,
  createOmniWhatsappInstance,
  createScopedOmniApiKey,
  getOmniInstanceStatus,
  getOmniQr,
  omniHealth,
  OmniClientError,
  pairOmniInstance,
  type OmniInstance,
} from "./omni";
import { captureChannelsWorkerError } from "./observability";

const channelsWorker = {
  async fetch(request: Request, env: ChannelsWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const db = openChannelsDb(env.RAVI_CONSOLE_DB);
    let response: Response;
    try {
      response = await route({ request, url, env, db, requestId });
    } catch (error) {
      response = handleError(error, {
        requestId,
        method: request.method,
        path: url.pathname,
        operation: "channels.worker.request",
      });
    }
    ctx.waitUntil(db.close().catch(() => {}));
    return response;
  },
} satisfies ExportedHandler<ChannelsWorkerEnv>;

export default Sentry.withSentry(
  (env: ChannelsWorkerEnv) => ({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? "production",
    release: env.SENTRY_RELEASE,
    tracesSampleRate: Number.parseFloat(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    enableLogs: true,
    sendDefaultPii: false,
  }),
  channelsWorker,
);

interface RouteContext {
  request: Request;
  url: URL;
  env: ChannelsWorkerEnv;
  db: ChannelsDb;
  requestId: string;
}

interface ActorContext {
  userId: string;
  organizationId: string;
}

async function route(ctx: RouteContext): Promise<Response> {
  const segments = ctx.url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return jsonSuccess({ ok: true, service: "ravi-channel-control" }, ctx.requestId);
  }
  const [namespace, ...rest] = segments;
  if (namespace === "ui") return routeUi(ctx, rest);
  if (namespace === "internal") return routeInternal(ctx, rest);
  throw new ChannelHttpError(404, "not_found", "Unknown namespace");
}

async function routeInternal(ctx: RouteContext, segments: string[]): Promise<Response> {
  if (segments[0] === "health") return jsonSuccess({ ok: true }, ctx.requestId);
  throw new ChannelHttpError(404, "not_found", `Unknown internal route: ${segments.join("/")}`);
}

async function routeUi(ctx: RouteContext, segments: string[]): Promise<Response> {
  const bodyText = await ctx.request.text();
  await verifyHmac(ctx, bodyText);
  const body = bodyText.trim() ? parseBody(bodyText) : {};

  if (!matches(ctx, segments.slice(0, 3), "POST", ["channels", "whatsapp", "instances"])
    && !matches(ctx, segments.slice(0, 2), "POST", ["channels", "hosts"])) {
    throw new ChannelHttpError(404, "not_found", `Unknown UI route: ${segments.join("/")}`);
  }

  const actor = actorFromBody(body);
  await assertChannelAdmin(ctx.db, actor);

  // POST /ui/channels/whatsapp/instances/list
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", "list"])) {
    const instances = await listChannelInstances(ctx.db, actor.organizationId);
    return jsonSuccess({ instances: instances.map(safeInstance) }, ctx.requestId);
  }

  // POST /ui/channels/whatsapp/instances
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances"])) {
    const response = await withIdempotency(ctx, actor, "channels.whatsapp.instances.create", bodyText, async () => {
      const result = await createChannelInstance(ctx, actor, {
        displayName: stringField(body, "displayName") ?? "WhatsApp",
      });
      return { instance: safeInstance(result) };
    });
    return jsonSuccess(response, ctx.requestId, { status: 201 });
  }

  // POST /ui/channels/whatsapp/instances/:id/show
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", ":id", "show"])) {
    const instance = await requireInstance(ctx.db, actor, segments[3]!, { allowDisabled: true });
    if (instance.status === "disabled") {
      return jsonSuccess({ instance: safeInstance(instance) }, ctx.requestId);
    }
    const refreshed = await refreshInstanceStatus(ctx, actor, instance);
    return jsonSuccess({ instance: safeInstance(refreshed) }, ctx.requestId);
  }

  // POST /ui/channels/whatsapp/instances/:id/qr
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", ":id", "qr"])) {
    const instance = await requireInstance(ctx.db, actor, segments[3]!);
    const apiKey = await decryptInstanceApiKey(ctx, actor, instance);
    const qr = await getOmniQr(ctx.env, { omniInstanceId: instance.externalInstanceId, apiKey });
    await updateChannelInstanceStatus(ctx.db, {
      id: instance.id,
      organizationId: actor.organizationId,
      status: "qr_pending",
      connectionState: "qr_pending",
    });
    await audit(ctx, actor, instance, "channel.instance.qr_requested", "channel.instance.qr_requested", {});
    return jsonSuccess({ channelInstanceId: instance.id, status: "qr_pending", qr }, ctx.requestId);
  }

  // POST /ui/channels/whatsapp/instances/:id/pair
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", ":id", "pair"])) {
    const instance = await requireInstance(ctx.db, actor, segments[3]!);
    const response = await withIdempotency(
      ctx,
      actor,
      "channels.whatsapp.instances.pair",
      bodyText,
      async () => {
        const apiKey = await decryptInstanceApiKey(ctx, actor, instance);
        const result = await pairOmniInstance(ctx.env, {
          omniInstanceId: instance.externalInstanceId,
          apiKey,
          phoneNumber: stringField(body, "phoneNumber") ?? undefined,
        });
        await audit(ctx, actor, instance, "channel.instance.pair_requested", "channel.instance.pair_requested", {});
        return { channelInstanceId: instance.id, pairing: result };
      },
      {
        storeResponse: (responsePayload) => ({
          channelInstanceId: responsePayload.channelInstanceId,
          pairing: { redacted: true },
        }),
      },
    );
    return jsonSuccess(response, ctx.requestId);
  }

  for (const action of ["connect", "disconnect", "restart", "logout"] as const) {
    if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", ":id", action])) {
      const instance = await requireInstance(ctx.db, actor, segments[3]!);
      const response = await withIdempotency(ctx, actor, `channels.whatsapp.instances.${action}`, bodyText, async () => {
        const apiKey = await decryptInstanceApiKey(ctx, actor, instance);
        const result = await commandOmniInstance(ctx.env, {
          omniInstanceId: instance.externalInstanceId,
          apiKey,
          action,
        });
        const nextStatus = action === "disconnect" || action === "logout" ? "disconnected" : "provisioning";
        const updated = await updateChannelInstanceStatus(ctx.db, {
          id: instance.id,
          organizationId: actor.organizationId,
          status: nextStatus,
          connectionState: action,
          metadata: { lastCommand: action, provider: result },
        });
        await audit(ctx, actor, updated, `channel.instance.${action}_requested`, `channel.instance.${action}_requested`, {});
        return { instance: safeInstance(updated), provider: result };
      });
      return jsonSuccess(response, ctx.requestId);
    }
  }

  // POST /ui/channels/whatsapp/instances/:id/rotate-key
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", ":id", "rotate-key"])) {
    const instance = await requireInstance(ctx.db, actor, segments[3]!);
    const response = await withIdempotency(ctx, actor, "channels.whatsapp.instances.rotate-key", bodyText, async () => {
      await rotateInstanceKey(ctx, actor, instance);
      await audit(ctx, actor, instance, "channel.instance.key_rotated", "channel.instance.key_rotated", {});
      return { instance: safeInstance(instance), rotated: true };
    });
    return jsonSuccess(response, ctx.requestId);
  }

  // POST /ui/channels/whatsapp/instances/:id/disable
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", ":id", "disable"])) {
    const instance = await requireInstance(ctx.db, actor, segments[3]!);
    const response = await withIdempotency(ctx, actor, "channels.whatsapp.instances.disable", bodyText, async () => {
      const updated = await updateChannelInstanceStatus(ctx.db, {
        id: instance.id,
        organizationId: actor.organizationId,
        status: "disabled",
        connectionState: "disabled",
      });
      await audit(ctx, actor, updated, "channel.instance.disabled", "channel.instance.disabled", {});
      return { instance: safeInstance(updated) };
    });
    return jsonSuccess(response, ctx.requestId);
  }

  // POST /ui/channels/whatsapp/instances/:id/delete
  if (matches(ctx, segments, "POST", ["channels", "whatsapp", "instances", ":id", "delete"])) {
    const instance = await requireInstance(ctx.db, actor, segments[3]!, { allowDisabled: true });
    const response = await withIdempotency(ctx, actor, "channels.whatsapp.instances.delete", bodyText, async () => {
      const apiKey = await decryptInstanceApiKey(ctx, actor, instance).catch(() => null);
      if (apiKey) {
        await commandOmniInstance(ctx.env, {
          omniInstanceId: instance.externalInstanceId,
          apiKey,
          action: "logout",
        }).catch(() => ({}));
      }
      const updated = await updateChannelInstanceStatus(ctx.db, {
        id: instance.id,
        organizationId: actor.organizationId,
        status: "deleted",
        connectionState: "deleted",
      });
      await audit(ctx, actor, updated, "channel.instance.deleted", "channel.instance.deleted", {});
      return { instance: safeInstance(updated), deleted: true };
    });
    return jsonSuccess(response, ctx.requestId);
  }

  // POST /ui/channels/hosts/health
  if (matches(ctx, segments, "POST", ["channels", "hosts", "health"])) {
    const host = await ensureDefaultOmniHost(ctx.db);
    const health = await omniHealth(ctx.env);
    const updated = await updateChannelHostHealth(ctx.db, { id: host.id, status: "active", health });
    await insertChannelEvent(ctx.db, {
      organizationId: actor.organizationId,
      hostId: updated.id,
      eventType: "channel.host.health_checked",
      requestId: ctx.requestId,
      actorType: "user",
      actorId: actor.userId,
      metadata: { provider: "omni" },
    });
    return jsonSuccess({ host: safeHost(updated), health }, ctx.requestId);
  }

  throw new ChannelHttpError(404, "not_found", `Unknown UI route: ${segments.join("/")}`);
}

async function createChannelInstance(
  ctx: RouteContext,
  actor: ActorContext,
  input: { displayName: string },
): Promise<ChannelInstanceRecord> {
  const host = await ensureDefaultOmniHost(ctx.db);
  const channelInstanceId = crypto.randomUUID();
  const externalInstanceName = `ravi-channel-${channelInstanceId}`;
  const pending = await insertPendingChannelInstance(ctx.db, {
    id: channelInstanceId,
    organizationId: actor.organizationId,
    hostId: host.id,
    displayName: input.displayName,
    externalInstanceName,
    createdByUserId: actor.userId,
    metadata: { provider: "omni", requestedBy: "console" },
  });
  await audit(ctx, actor, pending, "channel.instance.create_requested", "channel.instance.create_requested", {
    hostId: host.id,
  });

  try {
    const omniInstance = await createOmniWhatsappInstance(ctx.env, { name: externalInstanceName });
    const status = normalizeOmniStatus(omniInstance);
    const provisioned = await updateChannelInstanceProvisioned(ctx.db, {
      id: pending.id,
      organizationId: actor.organizationId,
      externalInstanceId: omniInstance.id,
      status,
      connectionState: omniInstance.status,
      phoneE164: omniInstance.phone,
      phoneDisplay: omniInstance.displayPhone,
      metadata: { omni: omniInstance.raw },
    });
    await persistNewInstanceKey(ctx, provisioned);
    await audit(ctx, actor, provisioned, "channel.instance.provisioned", "channel.instance.provisioned", {
      hostId: host.id,
      externalInstanceId: omniInstance.id,
    });
    return provisioned;
  } catch (error) {
    captureChannelsWorkerError(error, {
      requestId: ctx.requestId,
      method: ctx.request.method,
      path: ctx.url.pathname,
      operation: "channels.whatsapp.instances.create",
      organizationId: actor.organizationId,
      channelInstanceId: pending.id,
      hostId: host.id,
      provider: "omni",
      status: "provision_failed",
    });
    await updateChannelInstanceStatus(ctx.db, {
      id: pending.id,
      organizationId: actor.organizationId,
      status: "degraded",
      connectionState: "provision_failed",
    }).catch(() => pending);
    await audit(ctx, actor, pending, "channel.instance.provision_failed", "channel.instance.provision_failed", {
      hostId: host.id,
      error: error instanceof Error ? error.name : "unknown",
      errorCode: error instanceof OmniClientError ? error.code : undefined,
      errorStatus: error instanceof OmniClientError ? error.status : undefined,
    });
    throw error;
  }
}

async function persistNewInstanceKey(ctx: RouteContext, instance: ChannelInstanceRecord): Promise<void> {
  const key = await createScopedOmniApiKey(ctx.env, {
    channelInstanceId: instance.id,
    omniInstanceId: instance.externalInstanceId,
  });
  const rootWrapKey = await importRootWrapKey(ctx.env.RAVI_CHANNELS_ROOT_WRAP_KEY_BASE64);
  const dekKeyVersion = Number.parseInt(ctx.env.RAVI_CHANNELS_KEY_VERSION, 10) || 1;
  const dek = await createDek(rootWrapKey);
  const cipher = await encryptPayload({
    plaintext: key.plainTextKey,
    dek: dek.key,
    aad: {
      organizationId: instance.organizationId,
      channelInstanceId: instance.id,
      credentialKind: "omni_instance_api_key",
      dekKeyVersion,
      payloadKeyVersion: 1,
      schemaVersion: 1,
    },
  });
  await insertChannelCredential(ctx.db, {
    channelInstanceId: instance.id,
    organizationId: instance.organizationId,
    keyPrefix: key.keyPrefix,
    ciphertext: cipher.ciphertextBase64,
    nonce: cipher.nonceBase64,
    aadHash: cipher.aadHash,
    wrappedDek: dek.wrappedDekBase64,
    dekKeyVersion,
    payloadKeyVersion: 1,
  });
}

async function rotateInstanceKey(
  ctx: RouteContext,
  actor: ActorContext,
  instance: ChannelInstanceRecord,
): Promise<void> {
  const key = await createScopedOmniApiKey(ctx.env, {
    channelInstanceId: instance.id,
    omniInstanceId: instance.externalInstanceId,
  });
  const rootWrapKey = await importRootWrapKey(ctx.env.RAVI_CHANNELS_ROOT_WRAP_KEY_BASE64);
  const dekKeyVersion = Number.parseInt(ctx.env.RAVI_CHANNELS_KEY_VERSION, 10) || 1;
  const dek = await createDek(rootWrapKey);
  const cipher = await encryptPayload({
    plaintext: key.plainTextKey,
    dek: dek.key,
    aad: {
      organizationId: actor.organizationId,
      channelInstanceId: instance.id,
      credentialKind: "omni_instance_api_key",
      dekKeyVersion,
      payloadKeyVersion: 1,
      schemaVersion: 1,
    },
  });
  await rotateChannelCredential(ctx.db, {
    channelInstanceId: instance.id,
    organizationId: actor.organizationId,
    keyPrefix: key.keyPrefix,
    ciphertext: cipher.ciphertextBase64,
    nonce: cipher.nonceBase64,
    aadHash: cipher.aadHash,
    wrappedDek: dek.wrappedDekBase64,
    dekKeyVersion,
    payloadKeyVersion: 1,
  });
}

async function refreshInstanceStatus(
  ctx: RouteContext,
  actor: ActorContext,
  instance: ChannelInstanceRecord,
): Promise<ChannelInstanceRecord> {
  const apiKey = await decryptInstanceApiKey(ctx, actor, instance);
  const status = await getOmniInstanceStatus(ctx.env, {
    omniInstanceId: instance.externalInstanceId,
    apiKey,
  });
  return updateChannelInstanceProvisioned(ctx.db, {
    id: instance.id,
    organizationId: actor.organizationId,
    externalInstanceId: instance.externalInstanceId,
    status: normalizeOmniStatus(status),
    connectionState: status.status,
    phoneE164: status.phone,
    phoneDisplay: status.displayPhone,
    metadata: { omni: status.raw },
  });
}

async function decryptInstanceApiKey(
  ctx: RouteContext,
  actor: ActorContext,
  instance: ChannelInstanceRecord,
): Promise<string> {
  const credential = await findActiveChannelCredential(ctx.db, {
    channelInstanceId: instance.id,
    organizationId: actor.organizationId,
  });
  if (!credential) {
    throw new ChannelHttpError(503, "channel_instance_unavailable", "No active channel credential.");
  }
  const rootWrapKey = await importRootWrapKey(ctx.env.RAVI_CHANNELS_ROOT_WRAP_KEY_BASE64);
  try {
    return await decryptPayload({
      ciphertextBase64: credential.ciphertext,
      nonceBase64: credential.nonce,
      aadHash: credential.aadHash,
      wrappedDekBase64: credential.wrappedDek,
      rootWrapKey,
      aad: {
        organizationId: actor.organizationId,
        channelInstanceId: instance.id,
        credentialKind: "omni_instance_api_key",
        dekKeyVersion: credential.dekKeyVersion,
        payloadKeyVersion: credential.payloadKeyVersion,
        schemaVersion: credential.schemaVersion,
      },
    });
  } catch (error) {
    if (error instanceof ChannelCryptoError && error.code === "aad_mismatch") {
      await markChannelCredentialTampered(ctx.db, { id: credential.id });
      await audit(ctx, actor, instance, "channel.credential.tamper_detected", "channel.credential.tamper_detected", {
        keyPrefix: credential.keyPrefix,
      });
    }
    throw error;
  }
}

async function assertChannelAdmin(db: ChannelsDb, actor: ActorContext): Promise<void> {
  const membership = await findActiveMembership(db, actor);
  if (!membership || !["owner", "admin"].includes(membership.role)) {
    throw new ChannelHttpError(403, "channel_permission_required", "Organization admin permission is required.");
  }
}

async function requireInstance(
  db: ChannelsDb,
  actor: ActorContext,
  id: string,
  options: { allowDisabled?: boolean } = {},
): Promise<ChannelInstanceRecord> {
  const instance = await findChannelInstance(db, { id, organizationId: actor.organizationId });
  if (!instance || instance.status === "deleted") {
    throw new ChannelHttpError(404, "channel_instance_not_found", "Channel instance not found.");
  }
  if (instance.status === "disabled" && !options.allowDisabled) {
    throw new ChannelHttpError(409, "channel_instance_unavailable", "Channel instance is disabled.");
  }
  return instance;
}

async function withIdempotency(
  ctx: RouteContext,
  actor: ActorContext,
  operation: string,
  bodyText: string,
  run: () => Promise<JsonRecord>,
  options: { storeResponse?: (response: JsonRecord) => JsonRecord } = {},
): Promise<JsonRecord> {
  const body = bodyText.trim() ? parseBody(bodyText) : {};
  const key = stringField(body, "clientRequestId") ?? ctx.request.headers.get("idempotency-key")?.trim();
  if (!key) {
    throw new ChannelHttpError(400, "channel_idempotency_required", "Idempotency key is required for this operation.");
  }
  const requestHash = await sha256Hex(bodyText);
  const existing = await findIdempotencyRecord(ctx.db, {
    organizationId: actor.organizationId,
    idempotencyKey: key,
    operation,
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ChannelHttpError(409, "channel_operation_conflict", "Idempotency key was reused with a different payload.");
    }
    if (existing.status === "completed" && existing.responseJson) return existing.responseJson;
    throw new ChannelHttpError(409, "channel_operation_conflict", "Operation is already in progress.");
  }
  const started = await startIdempotencyRecord(ctx.db, {
    organizationId: actor.organizationId,
    idempotencyKey: key,
    operation,
    requestHash,
  });
  if (!started) throw new ChannelHttpError(409, "channel_operation_conflict", "Operation is already in progress.");
  try {
    const response = await run();
    const channelInstanceId = objectValue(response.instance)?.id ?? response.channelInstanceId;
    const storedResponse = options.storeResponse ? options.storeResponse(response) : response;
    await completeIdempotencyRecord(ctx.db, {
      organizationId: actor.organizationId,
      idempotencyKey: key,
      operation,
      channelInstanceId: typeof channelInstanceId === "string" ? channelInstanceId : null,
      response: storedResponse,
    });
    return response;
  } catch (error) {
    await failIdempotencyRecord(ctx.db, {
      organizationId: actor.organizationId,
      idempotencyKey: key,
      operation,
    }).catch(() => {});
    throw error;
  }
}

async function audit(
  ctx: RouteContext,
  actor: ActorContext,
  instance: ChannelInstanceRecord,
  eventType: string,
  action: string,
  metadata: JsonRecord,
): Promise<void> {
  await insertChannelEvent(ctx.db, {
    organizationId: actor.organizationId,
    channelInstanceId: instance.id,
    hostId: instance.hostId,
    eventType,
    requestId: ctx.requestId,
    actorType: "user",
    actorId: actor.userId,
    metadata,
  });
  await insertAuditEvent(ctx.db, {
    organizationId: actor.organizationId,
    actorType: "user",
    actorId: actor.userId,
    targetType: "channel_instance",
    targetId: instance.id,
    action,
    requestId: ctx.requestId,
    metadata,
  });
}

function normalizeOmniStatus(instance: OmniInstance): ChannelInstanceStatus {
  const raw = (instance.status ?? "").toLowerCase();
  if (instance.isConnected === true || raw === "connected") return "connected";
  if (raw.includes("qr")) return "qr_pending";
  if (raw.includes("connect")) return "provisioning";
  if (raw.includes("logout") || raw.includes("disconnect")) return "disconnected";
  if (!raw) return "provisioning";
  return "degraded";
}

function safeInstance(instance: ChannelInstanceRecord): JsonRecord {
  return {
    id: instance.id,
    organizationId: instance.organizationId,
    hostId: instance.hostId,
    channel: instance.channel,
    provider: instance.provider,
    displayName: instance.displayName,
    phoneE164: instance.phoneE164,
    phoneDisplay: instance.phoneDisplay,
    status: instance.status,
    connectionState: instance.connectionState,
    externalInstanceId: instance.externalInstanceId.startsWith("pending:") ? null : instance.externalInstanceId,
    externalInstanceName: instance.externalInstanceName,
    createdByUserId: instance.createdByUserId,
    lastConnectedAt: instance.lastConnectedAt?.toISOString() ?? null,
    lastDisconnectedAt: instance.lastDisconnectedAt?.toISOString() ?? null,
    lastHealthAt: instance.lastHealthAt?.toISOString() ?? null,
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

function safeHost(host: ChannelHostRecord): JsonRecord {
  return {
    id: host.id,
    provider: host.provider,
    displayName: host.displayName,
    environment: host.environment,
    region: host.region,
    tenantMode: host.tenantMode,
    status: host.status,
    capacity: host.capacityJson,
    health: host.healthJson,
    lastHealthAt: host.lastHealthAt?.toISOString() ?? null,
  };
}

async function verifyHmac(ctx: RouteContext, bodyText: string): Promise<void> {
  const keys: HmacKeyMaterial = {
    currentId: ctx.env.RAVI_CHANNELS_VERCEL_HMAC_KEY_CURRENT_ID,
    currentKey: ctx.env.RAVI_CHANNELS_VERCEL_HMAC_KEY_CURRENT,
    previousId: ctx.env.RAVI_CHANNELS_VERCEL_HMAC_KEY_PREVIOUS_ID,
    previousKey: ctx.env.RAVI_CHANNELS_VERCEL_HMAC_KEY_PREVIOUS,
  };
  try {
    await verifyHmacRequest({ request: ctx.request, bodyText, keys });
  } catch (error) {
    if (error instanceof HmacAuthError) {
      throw new ChannelHttpError(401, "channel_unauthorized", "HMAC rejected.");
    }
    throw error;
  }
}

function matches(ctx: RouteContext, segments: string[], method: string, pattern: string[]): boolean {
  if (ctx.request.method !== method) return false;
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}

function parseBody(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return objectValue(value) ?? {};
  } catch {
    throw new ChannelHttpError(400, "channel_payload_invalid", "Body is not valid JSON.");
  }
}

function actorFromBody(body: Record<string, unknown>): ActorContext {
  const userId = stringField(body, "userId");
  const organizationId = stringField(body, "organizationId");
  if (!userId || !organizationId) {
    throw new ChannelHttpError(400, "channel_payload_invalid", "Missing userId/organizationId.");
  }
  return { userId, organizationId };
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message) as BufferSource);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.byteLength; i += 1) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function handleError(error: unknown, context: {
  requestId: string;
  method: string;
  path: string;
  operation: string;
}): Response {
  captureChannelsWorkerError(error, context);
  if (error instanceof ChannelHttpError) {
    return jsonError(error.status, error.code, context.requestId, error.details);
  }
  if (error instanceof OmniClientError) {
    const status = error.code === "omni_not_found" ? 404
      : error.code === "omni_rate_limited" ? 429
      : error.code === "omni_unavailable" ? 503
      : error.code === "omni_unauthorized" ? 502
      : 502;
    const code = error.code === "omni_not_found" ? "channel_instance_not_found"
      : error.code === "omni_rate_limited" ? "channel_rate_limited"
      : error.code === "omni_unavailable" ? "channel_host_unavailable"
      : "channel_provider_error";
    return jsonError(status, code, context.requestId);
  }
  if (error instanceof ChannelCryptoError) {
    return jsonError(503, "channel_instance_unavailable", context.requestId);
  }
  console.error("ravi-channel-control unexpected error", {
    requestId: context.requestId,
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
  });
  return jsonError(500, "internal_error", context.requestId);
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ExportedHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
}
