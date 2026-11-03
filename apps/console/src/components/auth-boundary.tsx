"use client";

import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { NoUserInfo, UserInfo } from "@workos-inc/authkit-nextjs";

export function ConsoleAuthBoundary({
  children,
  mode,
  initialAuth,
}: {
  children: React.ReactNode;
  mode: "workos" | "anonymous" | "oidc";
  initialAuth?: Omit<UserInfo | NoUserInfo, "accessToken">;
}) {
  if (mode !== "workos") {
    return <>{children}</>;
  }

  return <AuthKitProvider initialAuth={initialAuth}>{children}</AuthKitProvider>;
}
