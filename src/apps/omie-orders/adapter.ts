import { executeApi, prepare, type ApiInput, type FullHost } from "./provider.js";
import { executeManagedAuthentication, type ManagedBoundary } from "./auth-provider.js";
import { AppError } from "./domain.js";
import type { Operation } from "./catalogue.js";
import { authorizeChannel, type AccessBoundary, type VerifiedIdentity } from "./access.js";
import { DurableLedger } from "./ledger.js";

export interface ProtectedRuntime extends AccessBoundary {
  // Native broker resolves active connection inside the host, never returns it
  // through argv/stdout or a CLI child, and audits provider/action use.
  withActiveOmieConnection<T>(
    request: { connection: string; action: string; identity: VerifiedIdentity },
    use: (secret: { bearer?: string; app_key?: string; app_secret?: string }) => Promise<T>,
  ): Promise<T>;
  withPortalSession<T>(identity: VerifiedIdentity, use: (headers: Record<string, string>) => Promise<T>): Promise<T>;
  withRefreshPair<T>(
    identity: VerifiedIdentity,
    appHash: string | null,
    use: (pair: { token: string; refresh_token: string }) => Promise<T>,
  ): Promise<T>;
  saveTokens(
    identity: VerifiedIdentity,
    appHash: string | null,
    pair: { token: string; refresh_token: string },
  ): Promise<void>;
  applicationHash(identity: VerifiedIdentity): Promise<string>;
  checkRevision(
    identity: VerifiedIdentity,
    operation: Operation,
    params: Record<string, any>,
    expected: string,
  ): Promise<void>;
  fetch: typeof fetch;
}
/** Host composition registered by the protected Apps builtin. This is not a remote
 * endpoint and never removes or replaces the caller context. Host supplies every
 * trusted identity/credential function; no direct access to keychain or vault.
 */
export function createOmieHostAction(runtime: ProtectedRuntime, ledger: Pick<DurableLedger, "once">) {
  const SCOPE = runtime.scope;
  return async (id: string, input: ApiInput) => {
    try {
      input = structuredClone(input);
      const plan = prepare(id, input);
      const identity = await authorizeChannel(runtime, plan.op, plan.digest);
      if (plan.op.classification === "managed-auth") {
        if (["ListarAplicativos", "ObterTokenDeUsuario", "RenovarTokenDeUsuario"].includes(plan.op.method))
          throw new AppError(
            "OMIE_OPERATOR_ACCOUNT_SCOPE_DENIED",
            "A conta pessoal do operador não é delegada ao canal. Gestão restrita ao aplicativo Omie.",
          );
        const appHash = await runtime.applicationHash(identity);
        if (!appHash || input.params.appHash !== appHash)
          throw new AppError(
            "OMIE_APPLICATION_SCOPE_DENIED",
            "Ação administrativa fora do aplicativo Omie configurado.",
          );
      }
      const guard = async (op: Operation) => {
        if (op.id !== plan.op.id)
          throw new AppError("OMIE_ACTION_SUBSTITUTION_DENIED", "Ação diferente da solicitação autenticada.");
        // Recheck membership/identity at each protected boundary to fail closed on revocation.
        const now = await authorizeChannel(runtime, op, plan.digest);
        if (now.contextId !== identity.contextId || now.actor.id !== identity.actor.id)
          throw new AppError("OMIE_IDENTITY_CHANGED", "Identidade mudou durante a operação.");
      };
      const management: ManagedBoundary = {
        authorize: async (op) => {
          await guard(op);
          return true;
        },
        withPortalSession: (use) => runtime.withPortalSession(identity, use),
        withRefreshPair: (app, use) => runtime.withRefreshPair(identity, app, use),
        saveTokens: (app, pair) => runtime.saveTokens(identity, app, pair),
        fetch: runtime.fetch,
      };
      const host: FullHost = {
        authorize: async (op) => {
          await guard(op);
          return { allowed: true, principal: identity.actor.id };
        },
        withApplication: async (op, use) => {
          await guard(op);
          return runtime.withActiveOmieConnection({ connection: SCOPE.connection, action: op.id, identity }, use);
        },
        once: (key, digest, effect) => ledger.once(`${SCOPE.channel}:${identity.actor.id}:${key}`, digest, effect),
        guardRevision: async (op, params, expected) => {
          await guard(op);
          await runtime.checkRevision(identity, op, params, expected);
        },
        manageAuthentication: async (op, params) => {
          await guard(op);
          return executeManagedAuthentication(management, op.id, params);
        },
        fetch: runtime.fetch,
      };
      return await executeApi(host, id, input);
    } catch (e) {
      // no-cause: Unknown host failures can contain broker secrets; expose only the fixed boundary code.
      if (e instanceof AppError) throw e;
      throw new AppError("OMIE_HOST_BOUNDARY_UNAVAILABLE", "Fronteira protegida do host indisponível.");
    }
  };
}
