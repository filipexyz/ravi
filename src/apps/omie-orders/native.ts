import { loadOmieScope, OMIE_APP_ACCESS, type OmieScope } from "./scope.js";
import { resolveContactChatOverlay } from "../../permissions/contact-policy-permissions-provider.js";
import { getContext } from "../../cli/context.js";
import { getContactById } from "../../contacts.js";
import { getCredentialConnection } from "../../credentials/store.js";
import { resolveCredentialSecret } from "../../credentials/broker.js";
import { registerOmieProviderReads } from "./provider-reads.js";
import { dbGetContext } from "../../router/router-db.js";
import { resolveRuntimeContext } from "../../runtime/context-registry.js";
import { canWithCapabilities, canWithCapabilityContext } from "../../permissions/provider-runtime.js";
import { type VerifiedIdentity } from "./access.js";
import { createOmieHostAction, type ProtectedRuntime } from "./adapter.js";
import { AppError } from "./domain.js";
import { parseProtectedOmieConnection } from "./connection.js";
import { findOperation, publicResult } from "./catalogue.js";
import { prepare, type ApiInput } from "./provider.js";
import { verifiedCaller, type IdentityStore } from "./identity.js";
import {
  parseOmieCapability,
  resolveOmieConversationAuthority,
  type ConversationAuthority,
} from "./conversation-authority.js";

registerOmieProviderReads();

/** The adapter for the configured channel, checked against the configured conversation id. Missing fails closed. */
function conversationAuthority(scope: OmieScope): ConversationAuthority {
  const authority = resolveOmieConversationAuthority(scope.channelType);
  if (!authority.isValidConversation(scope.channel))
    throw new AppError("OMIE_HOST_CONFIG_REQUIRED", "Configuração privada válida do executor é obrigatória.");
  return authority;
}

function identityStore(
  SCOPE: OmieScope,
  authority: ConversationAuthority = conversationAuthority(SCOPE),
): IdentityStore {
  return {
    scope: SCOPE,
    authority,
    current: () => getContext({ localOnly: true })?.context,
    live: (id) => {
      const ctx = dbGetContext(id);
      return ctx ? resolveRuntimeContext(ctx.contextKey, { touch: false }) : null;
    },
    contactActive: (id) => {
      const contact = getContactById(id);
      return Boolean(contact && contact.status !== "blocked" && !contact.opt_out);
    },
  };
}

function allowed(permission: string, objectType: string, objectId: string): boolean {
  const current = getContext({ localOnly: true })?.context;
  const context = current && resolveRuntimeContext(current.contextKey, { touch: false });
  return Boolean(context && canWithCapabilityContext(context, permission, objectType, objectId));
}
function sameActor(expected: VerifiedIdentity, identities: IdentityStore): void {
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
  scope?: OmieScope;
  contactOverlay?: typeof resolveContactChatOverlay;
  identities?: IdentityStore;
  allowed?: typeof allowed;
  /** Overrides the registered adapter for `scope.channelType` (tests). */
  authority?: ConversationAuthority;
  resolve?: typeof resolveCredentialSecret;
  connection?: typeof getCredentialConnection;
  fetch?: typeof fetch;
}
export function nativeRuntime(operationId: string, dependencies: NativeDependencies = {}): ProtectedRuntime {
  const operation = findOperation(operationId);
  if (operation.classification !== "read") unsupported();
  const SCOPE = dependencies.scope ?? loadOmieScope();
  const authority = dependencies.authority ?? dependencies.identities?.authority ?? conversationAuthority(SCOPE);
  const identities = dependencies.identities ?? identityStore(SCOPE, authority);
  const contactOverlay = dependencies.contactOverlay ?? resolveContactChatOverlay;
  const can = dependencies.allowed ?? allowed;
  const resolve = dependencies.resolve ?? resolveCredentialSecret;
  const connection = dependencies.connection ?? getCredentialConnection;
  let consumed: { secretRef: string; updatedAt: number } | undefined;
  let contactGoverned = false;
  const canQuery = () => {
    const [permission, objectType, ...objectId] = operation.permission.split(":");
    if (!dependencies.scope && JSON.stringify(loadOmieScope()) !== JSON.stringify(SCOPE))
      throw new AppError("OMIE_HOST_CONFIG_CHANGED", "Configuração mudou durante a consulta.");
    const identity = verifiedCaller(identities);
    const overlay = contactOverlay({ contactId: identity.actor.id, chatId: SCOPE.canonicalChat });
    const requirements: Array<[string, string, string]> = [
      ["use", "app", SCOPE.app],
      [permission, objectType, objectId.join(":")],
      ["use", "credential", `omie:${SCOPE.connection}`],
      ["execute", "omie", operationId],
      ...authority.capabilities(SCOPE).map(parseOmieCapability),
    ];
    contactGoverned ||= Boolean(identity.contactGoverned || overlay.active);
    const holds = ([permission, type, id]: readonly [string, string, string]) =>
      can(permission, type, id) &&
      (!contactGoverned || (overlay.eligible && canWithCapabilities(overlay.capabilities, permission, type, id)));
    // Access to `apps run`: the run-specific form or the legacy Apps group, exactly as the gateway admits it.
    return OMIE_APP_ACCESS.some((access) => holds(parseOmieCapability(access))) && requirements.every(holds);
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
    const member =
      typeof identity.actor.platformUserId === "string" &&
      (await authority.isCurrentMember({
        scope: SCOPE,
        platformUserId: identity.actor.platformUserId,
        fetch: boundedFetch,
      }));
    if (!member) throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Participação atual no canal não confirmada.");
    sameActor(identity, identities);
    if (!canQuery()) throw new AppError("OMIE_OPERATION_DENIED", "Autorização mudou durante a consulta.");
    return identity;
  };
  const runtime: ProtectedRuntime = {
    scope: SCOPE,
    identity: async () => verifiedCaller(identities),
    isMember: async (user, channel, account) =>
      channel === SCOPE.channel &&
      account === SCOPE.account &&
      authority.isCurrentMember({ scope: SCOPE, platformUserId: user, fetch: boundedFetch }),
    canInvokeApp: async (_identity, mutating) => !mutating && canQuery(),
    hasSpecificWriteIntent: async () => false,
    withActiveOmieConnection: async (request, use) => {
      sameActor(request.identity, identities);
      if (request.connection !== SCOPE.connection || request.action !== operationId)
        throw new AppError("OMIE_ACTION_SUBSTITUTION_DENIED", "Conexão ou operação diferente da autorizada.");
      const resolved = await resolve({
        provider: "omie",
        connection: SCOPE.connection,
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
      const current = connection("omie", SCOPE.connection);
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
export async function runOmieOrdersHost(appId: string, mode: "read" | "write", args: string[]): Promise<unknown> {
  if (mode !== "read") unsupported();
  if (appId !== "omie-orders" || args.length !== 2 || args[1].length > 1_000_000)
    throw new AppError("OMIE_HOST_INPUT_INVALID", "Argumentos do executor inválidos.");
  let input: ApiInput;
  try {
    input = JSON.parse(args[1]);
  } catch {
    // no-cause: Invalid input JSON can contain rejected credentials; expose only the fixed validation code.
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
  verifiedCaller(identityStore(loadOmieScope()));
  return createOmieHostAction(nativeRuntime(args[0]), { once: async () => unsupported() })(args[0], input);
}
