"use client";

import type { ConsoleFeatureKey, Project } from "@/features/console/types";
import { featureEnabled, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { PageHeader } from "@/ui/layout";
import { NoAccess } from "@/ui/states";
import { TabNav } from "@/ui/tabs";
import { ProjectNotFound, useRouteProject } from "./project-scope";

export type SettingsTab = "general" | "integrations" | "activity";

const TABS: Array<{
  denied: string;
  deniedTitle: string;
  feature: ConsoleFeatureKey;
  key: SettingsTab;
  label: string;
  path: string;
}> = [
  {
    denied: "The project's name, slug and default access are changed by owners and admins.",
    deniedTitle: "You can't change this project's settings",
    feature: "console.settings",
    key: "general",
    label: "General",
    path: "",
  },
  {
    denied: "Connecting GitHub to this project isn't available to you.",
    deniedTitle: "You can't manage this project's integrations",
    feature: "console.github",
    key: "integrations",
    label: "Integrations",
    path: "/integrations",
  },
  {
    denied: "The project's activity log isn't available to you.",
    deniedTitle: "You can't see this project's activity",
    feature: "console.audit",
    key: "activity",
    label: "Activity",
    path: "/activity",
  },
];

/**
 * Header and tabs shared by the project settings pages. Each tab is its own
 * URL and its own feature; a tab whose feature is off is not listed, and its
 * URL says why instead of rendering the page.
 */
export function SettingsFrame({
  children,
  projectRef,
  tab,
}: {
  children: (project: Project) => React.ReactNode;
  projectRef: string;
  tab: SettingsTab;
}) {
  const { features, organization } = useWorkspace();
  const project = useRouteProject(projectRef);
  if (!project) return <ProjectNotFound />;

  const enabled = TABS.filter((item) => featureEnabled(features, item.feature));
  const current = TABS.find((item) => item.key === tab);
  const allowed = enabled.some((item) => item.key === tab);
  const reason = current ? features.byKey[current.feature]?.reason : undefined;

  return (
    <>
      <PageHeader className="mb-4" title="Settings" />
      {enabled.length ? (
        <div className="mb-8 border-b border-line">
          <TabNav
            items={enabled.map((item) => ({
              active: item.key === tab,
              href: `/p/${project.id}/settings${item.path}`,
              label: item.label,
            }))}
            label="Project settings"
          />
        </div>
      ) : null}
      {allowed ? (
        children(project)
      ) : (
        <NoAccess
          description={
            reason === "role_denied" || !reason
              ? current?.denied
              : `${current?.label ?? "This"} isn't turned on for this organization's plan.`
          }
          role={roleLabel(organization.role)}
          title={current?.deniedTitle ?? "You don't have access to this"}
        />
      )}
    </>
  );
}
