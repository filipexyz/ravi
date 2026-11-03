"use client";

import { createContext, useContext } from "react";

import type { ConsoleViewer } from "@/lib/auth/session";
import { orgScopedKey } from "@/lib/query-keys";
import type { ConsoleFeatureAccessData, ConsoleFeatureKey, Org, Project } from "@/features/console/types";

export type Workspace = {
  features: ConsoleFeatureAccessData;
  organization: Org;
  platformOperator: boolean;
  projects: Project[];
  viewer: ConsoleViewer;
};

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ children, value }: { children: React.ReactNode; value: Workspace }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** The organization, projects, features and viewer the server layout resolved. */
export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside the Console shell.");
  return value;
}

export function featureEnabled(features: ConsoleFeatureAccessData, key: ConsoleFeatureKey) {
  const feature = features.byKey[key];
  return Boolean(feature?.enabled && feature.visible);
}

export function useFeature(key: ConsoleFeatureKey) {
  return featureEnabled(useWorkspace().features, key);
}

/** Query key under the selected organization. */
export function useOrgKey() {
  const { organization } = useWorkspace();
  return (...parts: unknown[]) => orgScopedKey(organization.id, ...parts);
}

const WRITE_ROLES = new Set(["owner", "admin", "developer"]);
const ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * What the organization role allows, as the server decides it today: owner,
 * admin and developer read and write every project; viewer only reaches
 * projects it is a member of; billing reaches none. The server still enforces
 * every call; this only decides what to show.
 */
export function roleCapabilities(role: string) {
  return {
    canAdminOrganization: ADMIN_ROLES.has(role),
    canWriteProjects: WRITE_ROLES.has(role),
  };
}

export function findProject(projects: Project[], ref: string | undefined) {
  if (!ref) return undefined;
  return projects.find((project) => project.id === ref || project.slug === ref);
}

export function roleLabel(role: string) {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "developer":
      return "Developer";
    case "viewer":
      return "Viewer";
    case "billing":
      return "Billing";
    default:
      return role;
  }
}
