"use client";

import { AppShell } from "@/features/shell/app-shell";
import { useAppPathname } from "@/lib/org-href";
import { isRedesignedPath } from "@/features/shell/routes";
import type { ConsoleViewer } from "@/lib/auth/session";
import type { ConsoleFeatureAccessData, Org, Project } from "@/features/console/types";

/**
 * Frame for every screen under the Console layout. Redesigned routes render
 * directly in the shell; screens hidden from navigation keep their legacy
 * view inside it. `/org` (choose an organization) renders without a frame.
 */
export function ConsoleFrame({
  children,
  features,
  organization,
  platformOperator = false,
  projects,
  viewer,
}: {
  children: React.ReactNode;
  features: ConsoleFeatureAccessData;
  organization: Org;
  platformOperator?: boolean;
  projects: Project[];
  viewer: ConsoleViewer;
}) {
  const pathname = useAppPathname();

  if (pathname === "/org") {
    return <>{children}</>;
  }

  return (
    <AppShell
      legacy={!isRedesignedPath(pathname)}
      workspace={{ features, organization, platformOperator, projects, viewer }}
    >
      {children}
    </AppShell>
  );
}
