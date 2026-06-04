import { agentCan } from "../permissions/engine.js";
import { getScopeContext, type ScopeContext } from "../permissions/scope.js";
import type { MailMailbox } from "./types.js";

export type MailboxRebacPermission = "read" | "search" | "send" | "manage";
export type MailProviderRebacPermission = "sync" | "manage";
export type MailScopeContext = ScopeContext;

export function getMailScopeContext(): MailScopeContext {
  return getScopeContext();
}

export function canUseMailMailbox(
  ctx: MailScopeContext,
  permission: MailboxRebacPermission,
  mailbox: Pick<MailMailbox, "id" | "address" | "normalizedAddress">,
): boolean {
  if (!ctx.agentId) return true;
  return (
    agentCan(ctx.agentId, permission, "mailbox", mailbox.id) ||
    agentCan(ctx.agentId, permission, "mailbox", mailbox.normalizedAddress) ||
    agentCan(ctx.agentId, permission, "mailbox", mailbox.address)
  );
}

export function canUseAnyMailbox(ctx: MailScopeContext, permission: MailboxRebacPermission): boolean {
  if (!ctx.agentId) return true;
  return agentCan(ctx.agentId, permission, "mailbox", "*");
}

export function canUseMailProvider(
  ctx: MailScopeContext,
  permission: MailProviderRebacPermission,
  provider: string,
): boolean {
  if (!ctx.agentId) return true;
  return (
    agentCan(ctx.agentId, permission, "mail-provider", provider) ||
    agentCan(ctx.agentId, permission, "mail-provider", "*")
  );
}
