import { AppError } from "./domain.js";
import type { Operation } from "./catalogue.js";

export const SCOPE = Object.freeze({
  app: "convit-omie",
  account: "cassia-slack",
  channel: "C0CERF5T3BM",
  canonicalChat: "chat_3e333ef80e70d6b4f53ed56f",
  executor: "cassia",
});
export interface VerifiedIdentity {
  verified: true;
  contextId: string;
  source: { channel: string; account: string; rootChannel: string };
  actor: { kind: "human" | "service"; id: string; slackUserId?: string };
}
export interface AccessBoundary {
  identity(): Promise<VerifiedIdentity>;
  // Implement with the native Slack/provider membership, never a user-supplied list.
  isMember(userId: string, channel: string, account: string): Promise<boolean>;
  canInvokeApp(identity: VerifiedIdentity, mutating: boolean): Promise<boolean>;
  hasSpecificWriteIntent(identity: VerifiedIdentity, operation: Operation, digest: string): Promise<boolean>;
  approvedServiceRead?(identity: VerifiedIdentity, operation: Operation): Promise<boolean>;
}
export async function authorizeChannel(boundary: AccessBoundary, operation: Operation, digest: string) {
  const identity = await boundary.identity();
  if (identity?.verified !== true || !identity.contextId || !identity.actor?.id)
    throw new AppError("OMIE_IDENTITY_REQUIRED", "Identidade autenticada do host é obrigatória.");
  if (
    identity.source?.channel !== "slack" ||
    identity.source.account !== SCOPE.account ||
    identity.source.rootChannel !== SCOPE.channel
  )
    throw new AppError("OMIE_CHANNEL_DENIED", "Operação restrita ao canal convit-pedidos.");
  const write = operation.classification !== "read";
  if (!(await boundary.canInvokeApp(identity, write)))
    throw new AppError("OMIE_OPERATION_DENIED", "O contexto não permite invocar esta operação do app.");
  if (identity.actor.kind === "human") {
    const user = identity.actor.slackUserId;
    if (!user || !/^[UW][A-Z0-9]+$/.test(user) || !(await boundary.isMember(user, SCOPE.channel, SCOPE.account)))
      throw new AppError("OMIE_MEMBERSHIP_REQUIRED", "Solicitante não confirmado como participante do canal.");
    if (write && !(await boundary.hasSpecificWriteIntent(identity, operation, digest)))
      throw new AppError(
        "OMIE_SPECIFIC_WRITE_REQUIRED",
        "Liberação do app não autoriza uma alteração comercial específica.",
      );
  } else if (identity.actor.kind === "service") {
    if (write || !boundary.approvedServiceRead || !(await boundary.approvedServiceRead(identity, operation)))
      throw new AppError("OMIE_SERVICE_ACTION_DENIED", "Serviço sem autorização específica para esta leitura.");
  } else throw new AppError("OMIE_IDENTITY_REQUIRED", "Ator não reconhecido.");
  return identity;
}
