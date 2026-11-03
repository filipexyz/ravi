import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginScreen, type LoginNotice } from "@/features/account/login-screen";
import { isAnonymousModeEnabled, isWorkOSConfigured } from "@/lib/auth/session";
import { oidcModeEnabled } from "@/lib/auth/oidc-config";
import { isRuntimeOidcConfigured } from "@/lib/auth/oidc-runtime";
import {
  authReturnToFromRecord,
  signInPathForReturnTo,
  type AuthSearchParams,
} from "@/lib/auth/return-to";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in · Ravi Console",
};

type LoginPageProps = {
  searchParams?: Promise<AuthSearchParams>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const anonymousMode = isAnonymousModeEnabled();
  const managedOidc = oidcModeEnabled();
  const signInConfigured = managedOidc ? await isRuntimeOidcConfigured() : isWorkOSConfigured();
  const returnTo = authReturnToFromRecord(params);
  const notice = loginNotice(params?.auth);

  // A failed sign-in stays here to say so instead of bouncing straight back
  // to the hosted sign-in, which could loop on the same failure.
  if (signInConfigured && !anonymousMode && notice === null) {
    redirect(signInPathForReturnTo(returnTo));
  }

  return (
    <LoginScreen
      anonymousHref={returnTo}
      anonymousMode={anonymousMode}
      managedOidc={managedOidc}
      notice={notice}
      showSetupDetails={process.env.NODE_ENV !== "production"}
      signInHref={signInPathForReturnTo(returnTo)}
      signUpHref={returnTo === "/projects" ? "/sign-up" : `/sign-up?${new URLSearchParams({ returnTo }).toString()}`}
      signInConfigured={signInConfigured}
    />
  );
}

function loginNotice(value: string | string[] | undefined): LoginNotice {
  const auth = Array.isArray(value) ? value[0] : value;
  if (auth === "error") return "error";
  if (auth === "missing-config") return "missing-config";
  if (auth === "access-denied") return "access-denied";
  if (auth === "signed-out") return "signed-out";
  return null;
}
