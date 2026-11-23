import { AppError } from "./domain.js";
import type { Operation } from "./catalogue.js";

import type { OmieScope } from "./scope.js";
export interface VerifiedIdentity {
  verified: true;
  contactGoverned?: boolean;
  contextId: string;
  source: { channel: string; account: string; rootChannel: string };
  /** `platformUserId`: the verified sender on the channel, used only for the channel's own membership check. */
  actor: { kind: "human" | "service"; id: string; platformUserId?: string };
}
export interface AccessBoundary {
  scope: OmieScope;
  identity(): Promise<VerifiedIdentity>;
  // Implement with the channel adapter's native membership, never a user-supplied list.
  isMember(userId: string, channel: string, account: string): Promise<boolean>;
  canInvokeApp(identity: VerifiedIdentity, mutating: boolean): Promise<boolean>;
  hasSpecificWriteIntent(identity: VerifiedIdentity, operation: Operation, digest: string): Promise<boolean>;
  approvedServiceRead?(identity: VerifiedIdentity, operation: Operation): Promise<boolean>;
}
export async function authorizeChannel(boundary: AccessBoundary, operation: Operation, digest: string) {
  const SCOPE = boundary.scope;
  const identity = await boundary.identity();
  if (identity?.verified !== true || !identity.contextId || !identity.actor?.id)
    throw new AppError("OMIE_IDENTITY_REQUIRED", "Identidade autenticada do host é obrigatória.");
  if (
    identity.source?.channel !== SCOPE.channelType ||
    identity.source.account !== SCOPE.account ||
    identity.source.rootChannel !== SCOPE.channel
  )
    throw new AppError("OMIE_CHANNEL_DENIED", "Operação restrita ao canal configurado.");
  const write = operation.classification !== "read";
  if (!(await boundary.canInvokeApp(identity, write)))
    throw new AppError("OMIE_OPERATION_DENIED", "O contexto não permite invocar esta operação do app.");
  if (identity.actor.kind === "human") {
    const user = identity.actor.platformUserId;
    if (!user || typeof user !== "string" || !(await boundary.isMember(user, SCOPE.channel, SCOPE.account)))
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
