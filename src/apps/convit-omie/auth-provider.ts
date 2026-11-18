/** Trusted credential-service code. It must never run in the app child with
 * exported raw credentials; the host imports it at its own protected boundary.
 */
import { findOperation, rejectCredentials, publicResult, type Operation } from "./catalogue.js";
import { AppError } from "./domain.js";

export interface ManagedBoundary {
  authorize(op: Operation): Promise<boolean>;
  withPortalSession<T>(use: (headers: Record<string, string>) => Promise<T>): Promise<T>;
  withRefreshPair<T>(
    appHash: string | null,
    use: (pair: { token: string; refresh_token: string }) => Promise<T>,
  ): Promise<T>;
  saveTokens(appHash: string | null, pair: { token: string; refresh_token: string }): Promise<void>;
  fetch: typeof fetch;
}
export async function executeManagedAuthentication(host: ManagedBoundary, id: string, params: Record<string, any>) {
  const op = findOperation(id);
  if (op.classification !== "managed-auth")
    throw new AppError("OMIE_OPERATION_CLASS_MISMATCH", "Operação fora do serviço de autenticação.");
  rejectCredentials(params);
  try {
    if (!(await host.authorize(op)))
      throw new AppError("OMIE_OPERATION_DENIED", "Operação administrativa não autorizada.");
    const needsApp = op.path.includes("{appHash}");
    const appHash = needsApp ? params.appHash : null;
    if (needsApp && (typeof appHash !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(appHash)))
      throw new AppError("INVALID_INPUT", "appHash do aplicativo é obrigatório.", 2);
    const path = op.path.replace("{appHash}", appHash ?? "");
    const renew = op.method.startsWith("RenovarToken"),
      obtain = op.method.startsWith("ObterToken");
    const send = async (headers: Record<string, string>, body?: any) => {
      let res: Response, data: any;
      try {
        res = await host.fetch("https://app.omie.com.br" + path, {
          method: op.http,
          redirect: "error",
          headers: { ...headers, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(20000),
        });
        data = await res.json();
      } catch {
        throw new AppError(
          "OMIE_AUTH_OUTCOME_UNKNOWN",
          "Falha no serviço de autenticação; não repetir renovação sem verificar o estado protegido.",
        );
      }
      if (!res.ok) throw new AppError("OMIE_AUTH_REJECTED", "Sessão ou permissão administrativa recusada.");
      if (renew || obtain) {
        if (
          typeof data?.token !== "string" ||
          !data.token ||
          typeof data?.refresh_token !== "string" ||
          !data.refresh_token
        )
          throw new AppError("OMIE_AUTH_RESPONSE_INVALID", "Resposta de credenciais incompleta.");
        await host.saveTokens(appHash, { token: data.token, refresh_token: data.refresh_token });
        return { success: true, operation: op.id, credentialsStored: true, secretsReturned: false };
      }
      return { success: true, operation: op.id, data: publicResult(data) };
    };
    if (renew)
      return await host.withRefreshPair(appHash, (pair) =>
        send({}, { token: pair.token, refresh_token: pair.refresh_token }),
      );
    return await host.withPortalSession((headers) => {
      const body =
        op.http === "POST" ? Object.fromEntries(Object.entries(params).filter(([k]) => k !== "appHash")) : undefined;
      return send(headers, body);
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      "OMIE_AUTH_BOUNDARY_UNAVAILABLE",
      "Sessão administrativa ou armazenamento protegido indisponível.",
    );
  }
}
