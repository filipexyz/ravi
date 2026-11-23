import type { ContextRecord } from "../../router/router-db.js";
import { AppError } from "./domain.js";
import type { OmieScope } from "./scope.js";

/** What the live human turn claims about its author. Proven against persisted state, never trusted as is. */
export interface ConversationActorClaim {
  readonly contactId: string;
  readonly sourceMessageId: string;
  readonly platformIdentityId: string;
}

export type ConversationTurnVerdict =
  | { readonly ok: true; readonly platformUserId: string }
  /** `channel`: the turn did not come from the configured conversation. `identity`: it did, but its author is not proven. */
  | { readonly ok: false; readonly reason: "channel" | "identity" };

/**
 * The one thing the executor asks of a messaging channel. The executor itself never knows which
 * channel it is talking to: a channel package implements this port and the daemon registers it.
 * Every method fails closed; an adapter that cannot prove something answers "no".
 */
export interface ConversationAuthority {
  /** The `channelType` this adapter serves, as written in the operator's private configuration. */
  readonly channelType: string;
  /** Whether `conversation` has the shape of a conversation id on this channel. */
  isValidConversation(conversation: string): boolean;
  /**
   * Prove that the live turn comes from a persisted human message in the configured conversation (its root or one
   * of its threads) and that the message and the platform identity belong to the claimed contact.
   */
  verifyTurn(input: {
    readonly scope: OmieScope;
    readonly source: NonNullable<ContextRecord["source"]>;
    readonly actor: ConversationActorClaim;
  }): ConversationTurnVerdict;
  /** Current, uncached membership of `platformUserId` in the configured conversation. Any doubt answers false. */
  isCurrentMember(input: {
    readonly scope: OmieScope;
    readonly platformUserId: string;
    readonly fetch: typeof fetch;
  }): Promise<boolean>;
  /** Exact capabilities the channel needs on each call (`permission:objectType:objectId`), e.g. its membership read. */
  capabilities(scope: OmieScope): readonly string[];
}

const authorities = new Map<string, ConversationAuthority>();

/** Composition (the daemon) registers one adapter per channel type. Re-registering the same type replaces it. */
export function registerOmieConversationAuthority(authority: ConversationAuthority): void {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(authority.channelType))
    throw new AppError("OMIE_CHANNEL_UNAVAILABLE", "Tipo de canal inválido para o executor.");
  authorities.set(authority.channelType, authority);
}

export function unregisterOmieConversationAuthority(channelType: string): void {
  authorities.delete(channelType);
}

export function resetOmieConversationAuthoritiesForTest(): void {
  authorities.clear();
}

/** The adapter for the configured channel type. No adapter fails closed: the core contract does not change. */
export function resolveOmieConversationAuthority(channelType: string): ConversationAuthority {
  const authority = authorities.get(channelType);
  if (!authority)
    throw new AppError(
      "OMIE_CHANNEL_UNAVAILABLE",
      "O canal configurado para o executor não tem adaptador ativo neste processo.",
    );
  return authority;
}

/** Split `permission:objectType:objectId` (the object id may itself contain colons). */
export function parseOmieCapability(capability: string): [string, string, string] {
  const [permission, objectType, ...objectId] = capability.split(":");
  if (!permission || !objectType || objectId.length === 0 || !objectId.join(":"))
    throw new AppError("OMIE_DELEGATION_MISSING", "Capability de canal malformada.");
  return [permission, objectType, objectId.join(":")];
}
