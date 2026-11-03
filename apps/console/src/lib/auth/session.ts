import { withAuth, type NoUserInfo, type UserInfo } from "@workos-inc/authkit-nextjs";
import type { User } from "@workos-inc/node";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isAnonymousModeEnabled, isWorkOSConfigured } from "./config";
import { oidcModeEnabled } from "./oidc-config";
import { getRuntimeOidcConfig } from "./oidc-runtime";
import { OIDC_SESSION_COOKIE } from "./oidc-transaction";
import type { OidcVerifiedIdentity } from "./oidc-client";
export { configuredWorkOSRedirectUri, isAnonymousModeEnabled, isWorkOSConfigured } from "./config";

export type ConsoleRole = "owner" | "admin" | "developer" | "viewer" | "billing";

export const WORKOS_PROVIDER = "workos" as const;

export type ConsoleViewer = {
  name: string;
  email: string;
  mark: string;
};

export type ConsoleAuthState = {
  mode: "workos" | "anonymous" | "oidc";
  oidc?: OidcVerifiedIdentity & { userId: string; sessionId?: string };
  initialAuth?: Omit<UserInfo | NoUserInfo, "accessToken">;
  viewer: ConsoleViewer;
};

export async function getConsoleAuthState(): Promise<ConsoleAuthState> {
  if (oidcModeEnabled()) {
    let config;
    try { config = await getRuntimeOidcConfig(false); } catch { redirect("/login?auth=missing-config"); }
    const auth = await readOidcAuthState(config);
    if (!auth) redirect("/login");
    return auth;
  }
  if (isAnonymousModeEnabled()) {
    return {
      mode: "anonymous",
      viewer: {
        name: "Anonymous Developer",
        email: "anonymous@local",
        mark: "A",
      },
    };
  }

  if (!isWorkOSConfigured()) {
    redirect("/login?auth=missing-config");
  }

  const auth = await withAuth({ ensureSignedIn: true });
  const { accessToken: _accessToken, ...initialAuth } = auth;

  return {
    mode: "workos",
    initialAuth,
    viewer: viewerFromUser(auth.user),
  };
}

export async function getConsoleApiAuthState(): Promise<ConsoleAuthState | null> {
  if (oidcModeEnabled()) {
    let config;
    try { config = await getRuntimeOidcConfig(false); } catch { return null; }
    return readOidcAuthState(config);
  }
  if (isAnonymousModeEnabled()) {
    return {
      mode: "anonymous",
      viewer: {
        name: "Anonymous Developer",
        email: "anonymous@local",
        mark: "A",
      },
    };
  }

  if (!isWorkOSConfigured()) {
    return null;
  }

  const auth = await withAuth();
  if (!auth.user) return null;

  const { accessToken: _accessToken, ...initialAuth } = auth;

  return {
    mode: "workos",
    initialAuth,
    viewer: viewerFromUser(auth.user),
  };
}

// Config is request-local, never cached across requests/revocation.
async function readOidcAuthState(config: Awaited<ReturnType<typeof getRuntimeOidcConfig>>): Promise<ConsoleAuthState | null> {
  const { readOidcBrowserSession } = await import("./oidc-store");
  const identity = await readOidcBrowserSession((await cookies()).get(OIDC_SESSION_COOKIE)?.value, config);
  if (!identity) return null;
  return { mode: "oidc", oidc: identity,
    viewer: { name: identity.name, email: identity.email, mark: identity.name.slice(0, 1).toUpperCase() } };
}

function viewerFromUser(user: User): ConsoleViewer {
  const firstName = user.firstName?.trim();
  const lastName = user.lastName?.trim();
  const email = user.email ?? "user@ravi.bot";
  const name = [firstName, lastName].filter(Boolean).join(" ") || email;

  return {
    name,
    email,
    mark: (firstName ?? email).slice(0, 1).toUpperCase(),
  };
}
