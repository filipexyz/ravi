import { resolveSlackInstanceAliases, resolveScopedSlackIdentity } from "../../channels/slack/instance-alias.js";
import { getContext } from "../../cli/context.js";
import { configStore } from "../../config-store.js";
import { getContactById, resolvePlatformIdentity } from "../../contacts.js";
import { getCredentialConnection } from "../../credentials/store.js";
import { resolveCredentialSecret } from "../../credentials/broker.js";
import { dbGetContext, dbGetChat, dbFindChatMessage } from "../../router/router-db.js";
import { resolveRuntimeContext } from "../../runtime/context-registry.js";
import { canWithCapabilityContext } from "../../permissions/provider-runtime.js";
import { SlackWebApiClient } from "../../channels/slack/client.js";
import { resolveSlackCredentialConfigFromEnv } from "../../channels/slack/credentials.js";
import { SCOPE, type VerifiedIdentity } from "./access.js";
import { createOmieHostAction, type ProtectedRuntime } from "./adapter.js";
import { AppError } from "./domain.js";
import { parseProtectedOmieConnection } from "./connection.js";
import { findOperation, publicResult } from "./catalogue.js";
import { prepare, type ApiInput } from "./provider.js";
import { verifiedCaller, type IdentityStore } from "./identity.js";

const store: IdentityStore = {
  canonicalInstance: (id) => resolveSlackInstanceAliases(configStore.getConfig(), id).canonical,
  current: () => getContext({ localOnly: true })?.context,
  live: (id) => {
    const ctx = dbGetContext(id);
    return ctx ? resolveRuntimeContext(ctx.contextKey, { touch: false }) : null;
  },
  chat: dbGetChat,
  message: (chatId, providerMessageId) => scopedMessage(chatId, providerMessageId),
  platform: (userId) => scopedPlatform(userId),
  contactActive: (id) => {
    const contact = getContactById(id);
    return Boolean(contact && contact.status !== "blocked" && !contact.opt_out);
  },
};

export function scopedMessage(chatId: string, providerMessageId: string, chat = dbGetChat, find = dbFindChatMessage) {
  const source = chat(chatId);
  return source ? find({ channel: "slack", instanceId: source.instanceId, chatId, providerMessageId }) : null;
}
export function scopedPlatform(userId: string, config = configStore.getConfig(), lookup = resolvePlatformIdentity) {
  const aliases = resolveSlackInstanceAliases(config, SCOPE.account);
  return resolveScopedSlackIdentity(
    aliases,
    (instanceId) => (instanceId ? lookup({ channel: "slack", instanceId, platformUserId: userId }) : null),
    (identity) => `${identity.ownerType}:${identity.ownerId}`,
  ).identity;
}

export interface MemberClient {
  conversationsMembers(input: {
    channel: string;
    limit: number;
    cursor?: string;
  }): Promise<{ members?: unknown; response_metadata?: { next_cursor?: string } }>;
}
/** Paginate completely, fail closed on malformed pages, loops or unavailable Slack. No membership cache. */
export async function currentMember(client: MemberClient, userId: string): Promise<boolean> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const result = await client.conversationsMembers({ channel: SCOPE.channel, limit: 200, cursor });
    if (!Array.isArray(result.members) || !result.members.every((x) => typeof x === "string")) return false;
    if (result.members.includes(userId)) return true;
    const next = result.response_metadata?.next_cursor;
    if (!next) return false;
    if (typeof next !== "string" || seen.has(next)) return false;
    seen.add(next);
    cursor = next;
  }
  return false;
}

async function slackClient(fetchImpl: typeof fetch) {
  const channel = configStore.getConfig().channels?.[SCOPE.account];
  if (!channel || channel.enabled === false || channel.provider !== "slack")
    throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Conta Slack indisponível.");
  const config = await resolveSlackCredentialConfigFromEnv(process.env, { channel, action: "conversations.members" });
  if (!config) throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Verificação Slack indisponível.");
  return new SlackWebApiClient({
    appToken: config.appToken,
    botToken: config.botToken,
    apiBaseUrl: config.apiBaseUrl,
    defaultHeaders: config.requestHeaders,
    fetchImpl,
  });
}

function allowed(permission: string, objectType: string, objectId: string): boolean {
  const current = store.current();
  const context = current && store.live(current.contextId);
  return Boolean(context && canWithCapabilityContext(context, permission, objectType, objectId));
}
function sameActor(expected: VerifiedIdentity, identities: IdentityStore = store): void {
  const now = verifiedCaller(identities);
  if (JSON.stringify(now) !== JSON.stringify(expected))
    throw new AppError("OMIE_IDENTITY_CHANGED", "Identidade mudou durante a operação.");
}
function unsupported(): never {
  throw new AppError(
    "OMIE_READ_ONLY_HOST",
    "Este executor permite apenas consultas de pedidos; escrita e gestão de tokens não estão habilitadas.",
  );
}

export interface NativeDependencies {
  identities?: IdentityStore;
  allowed?: typeof allowed;
  slack?: (fetchImpl: typeof fetch) => Promise<MemberClient>;
  resolve?: typeof resolveCredentialSecret;
  connection?: typeof getCredentialConnection;
  fetch?: typeof fetch;
}
export function nativeRuntime(operationId: string, dependencies: NativeDependencies = {}): ProtectedRuntime {
  const identities = dependencies.identities ?? store;
  const can = dependencies.allowed ?? allowed;
  const slack = dependencies.slack ?? slackClient;
  const resolve = dependencies.resolve ?? resolveCredentialSecret;
  const connection = dependencies.connection ?? getCredentialConnection;
  let consumed: { secretRef: string; updatedAt: number } | undefined;
  const operation = findOperation(operationId);
  if (operation.classification !== "read") unsupported();
  const canQuery = () => {
    const [permission, objectType, ...objectId] = operation.permission.split(":");
    return (
      can("use", "app", SCOPE.app) &&
      can(permission, objectType, objectId.join(":")) &&
      can("use", "credential", "omie:convit-pedidos") &&
      can("execute", "omie", operationId) &&
      can("use", "credential", "slack:cassia-slack") &&
      can("execute", "slack", "conversations.members")
    );
  };
  const deadline = Date.now() + 20_000;
  const boundedFetch = (async (url: string | URL | Request, options?: RequestInit) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError("OMIE_HOST_TIMEOUT", "Tempo de consulta esgotado.");
    return (dependencies.fetch ?? globalThis.fetch)(url, {
      ...options,
      signal: AbortSignal.timeout(Math.min(remaining, 12_000)),
    });
  }) as typeof fetch;
  const check = async () => {
    const identity = verifiedCaller(identities);
    if (!canQuery()) throw new AppError("OMIE_OPERATION_DENIED", "Consulta não autorizada.");
    if (!(await currentMember(await slack(boundedFetch), identity.actor.slackUserId!)))
      throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Participação atual no canal não confirmada.");
    sameActor(identity, identities);
    if (!canQuery()) throw new AppError("OMIE_OPERATION_DENIED", "Autorização mudou durante a consulta.");
    return identity;
  };
  const runtime: ProtectedRuntime = {
    identity: async () => verifiedCaller(identities),
    isMember: async (user, channel, account) =>
      channel === SCOPE.channel && account === SCOPE.account && currentMember(await slack(boundedFetch), user),
    canInvokeApp: async (_identity, mutating) => !mutating && canQuery(),
    hasSpecificWriteIntent: async () => false,
    withActiveOmieConnection: async (request, use) => {
      sameActor(request.identity, identities);
      if (request.connection !== "convit-pedidos" || request.action !== operationId)
        throw new AppError("OMIE_ACTION_SUBSTITUTION_DENIED", "Conexão ou operação diferente da autorizada.");
      const resolved = await resolve({
        provider: "omie",
        connection: "convit-pedidos",
        action: operationId,
        beforeResolve: async () => {
          sameActor(request.identity, identities);
          await check();
        },
      });
      consumed = { secretRef: resolved.connection.secretRef, updatedAt: resolved.connection.updatedAt };
      const parsed = parseProtectedOmieConnection(resolved.secret);
      if (!parsed.applicationHash) throw new AppError("OMIE_APPLICATION_SCOPE_DENIED", "A conexão exige appHash fixo.");
      sameActor(request.identity, identities);
      return redactValues(
        await use(parsed.auth),
        Object.values(parsed.auth).filter((x): x is string => typeof x === "string"),
      );
    },
    applicationHash: async () => unsupported(),
    withPortalSession: async () => unsupported(),
    withRefreshPair: async () => unsupported(),
    saveTokens: async () => unsupported(),
    checkRevision: async () => unsupported(),
    fetch: (async (url: string | URL | Request, options?: RequestInit) => {
      await check();
      const current = connection("omie", "convit-pedidos");
      if (
        !current ||
        current.status !== "active" ||
        !consumed ||
        current.secretRef !== consumed.secretRef ||
        current.updatedAt !== consumed.updatedAt
      )
        throw new AppError("OMIE_CONNECTION_CHANGED", "Conexão Omie mudou durante a consulta.");
      return boundedFetch(url, options);
    }) as typeof fetch,
  };
  return runtime;
}
export function redactValues<T>(value: T, secrets: string[]): T {
  let serialized = JSON.stringify(publicResult(value));
  for (const secret of secrets)
    if (secret) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join("[redacted]");
  return JSON.parse(serialized) as T;
}

/** Built-in allowlist entry; never imports code or URLs from an app manifest. */
export async function runConvitOmieHost(appId: string, mode: "read" | "write", args: string[]): Promise<unknown> {
  if (mode !== "read") unsupported();
  if (appId !== SCOPE.app || args.length !== 2 || args[1].length > 1_000_000)
    throw new AppError("OMIE_HOST_INPUT_INVALID", "Argumentos do executor inválidos.");
  let input: ApiInput;
  try {
    input = JSON.parse(args[1]);
  } catch {
    throw new AppError("OMIE_HOST_INPUT_INVALID", "JSON inválido.");
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["params", "confirmed", "idempotencyKey", "reviewDigest", "expectedRevision"].includes(key),
    )
  )
    throw new AppError("OMIE_HOST_INPUT_INVALID", "Envelope inválido.");
  const plan = prepare(args[0], input);
  if ((plan.op.classification === "read") !== (mode === "read"))
    throw new AppError("OMIE_OPERATION_CLASS_MISMATCH", "Classificação da operação não corresponde ao handler.");
  verifiedCaller(store);
  return createOmieHostAction(nativeRuntime(args[0]), { once: async () => unsupported() })(args[0], input);
}
