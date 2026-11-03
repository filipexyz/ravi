import type { AuthorizationActor } from "@/server/console/authorization/identity";
import { cliApiError } from "./errors";

export type VerifiedCliProjectContext = {
  localInstallation: { id: string };
  cliSession: { id: string };
  accessTokenJti: string;
  delegation?: { bindingId: string } | null;
};

/** Only call with the result of authenticateCliRequest, never a JSON body. */
export function projectAuthorizationFromCli(auth: VerifiedCliProjectContext): NonNullable<AuthorizationActor["delegation"]> {
  if (!auth.localInstallation?.id || !auth.cliSession?.id || !auth.accessTokenJti) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED", "Verified installation context is required.");
  }
  return { installationId: auth.localInstallation.id, sessionId: auth.cliSession.id,
    bindingId: auth.delegation?.bindingId ?? null, accessTokenJti: auth.accessTokenJti };
}
