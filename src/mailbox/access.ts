import { authorizationAgentId, authorizationContext } from "../permissions/authorization-agent.js";
import { agentCan, canWithCapabilityContext, localOperatorCan } from "../permissions/provider-runtime.js";
import { getScopeContext, isLocalOperatorScope, type ScopeContext } from "../permissions/scope.js";
import type { MailMailbox } from "./types.js";

export type MailboxPermission = "read" | "search" | "send" | "manage";
export type MailProviderPermission = "sync" | "manage";
export type MailScopeContext = ScopeContext;

export function getMailScopeContext(): MailScopeContext {
  return getScopeContext();
}

export function canUseMailMailbox(
  ctx: MailScopeContext,
  permission: MailboxPermission,
  mailbox: Pick<MailMailbox, "id" | "address" | "normalizedAddress">,
): boolean {
  if (isLocalOperatorScope(ctx)) return localOperatorCan(permission, "mailbox", mailbox.id);
  return (
    scopeCan(ctx, permission, "mailbox", mailbox.id) ||
    scopeCan(ctx, permission, "mailbox", mailbox.normalizedAddress) ||
    scopeCan(ctx, permission, "mailbox", mailbox.address)
  );
}

export function canUseAnyMailbox(ctx: MailScopeContext, permission: MailboxPermission): boolean {
  if (isLocalOperatorScope(ctx)) return localOperatorCan(permission, "mailbox", "*");
  return scopeCan(ctx, permission, "mailbox", "*");
}

export function canUseMailProvider(
  ctx: MailScopeContext,
  permission: MailProviderPermission,
  provider: string,
): boolean {
  if (isLocalOperatorScope(ctx)) return localOperatorCan(permission, "mail-provider", provider);
  return scopeCan(ctx, permission, "mail-provider", provider) || scopeCan(ctx, permission, "mail-provider", "*");
}

function scopeCan(ctx: MailScopeContext, permission: string, objectType: string, objectId: string): boolean {
  if (isLocalOperatorScope(ctx)) return localOperatorCan(permission, objectType, objectId);
  if (ctx.context) {
    return canWithCapabilityContext(authorizationContext(ctx.context, ctx.agentId), permission, objectType, objectId);
  }
  return agentCan(authorizationAgentId(ctx.agentId), permission, objectType, objectId);
}
