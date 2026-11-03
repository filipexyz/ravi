"use client";

import { Cloud, KeyRound, SearchX } from "lucide-react";

import type { Project } from "@/features/console/types";
import { findProject, roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import type { CloudAgentsAvailability } from "@/server/console/cloud-agents/service";
import type { CloudCredential } from "@/server/console/cloud-agents/types";
import { Button } from "@/ui/button";
import Link from "@/ui/link";
import { PageHeader } from "@/ui/layout";
import { EmptyState, ErrorState, ListSkeleton, NoAccess, Notice } from "@/ui/states";
import { TabNav } from "@/ui/tabs";

import { useCloudAvailability, useCloudCredential } from "./api";

export type CloudTab = "agents" | "runs" | "schedules";

export type CloudScope = {
  project: Project;
  availability: CloudAgentsAvailability;
  /** The signed-in person, to tell their own runs apart. */
  viewerId: string;
  /** Undefined while it loads or when it could not be read. */
  credential: CloudCredential | undefined;
};

const TAB_PATHS: Record<CloudTab, string> = { agents: "", runs: "/runs", schedules: "/schedules" };
const TAB_LABELS: Record<CloudTab, string> = { agents: "Agents", runs: "Runs", schedules: "Schedules" };

/**
 * Resolves the project from the route and checks that cloud agents are on for
 * this organization and role, and set up on this Console. The server still
 * enforces all of it on every call.
 */
export function CloudProjectGate({ children, projectRef }: { children: (scope: CloudScope) => React.ReactNode; projectRef: string }) {
  const { organization, projects } = useWorkspace();
  const enabled = useFeature("console.cloud_agents");
  const project = findProject(projects, projectRef);
  const availability = useCloudAvailability();
  const ready = Boolean(project && enabled && availability.data?.availability.state === "available");
  const credential = useCloudCredential(ready);

  if (!project) {
    return (
      <EmptyState
        action={<Button href="/projects">All projects</Button>}
        description="Check the address, or pick a project from the list."
        icon={SearchX}
        title="This project doesn't exist or you don't have access"
      />
    );
  }
  if (!enabled) {
    return (
      <NoAccess
        description="Cloud agents aren't turned on for this organization, or your role doesn't include them."
        role={roleLabel(organization.role)}
        title="Cloud agents aren't available here"
      />
    );
  }
  if (availability.isPending) return <ListSkeleton rows={3} />;
  if (availability.isError) {
    return <ErrorState error={availability.error} onRetry={() => void availability.refetch()} role={roleLabel(organization.role)} />;
  }
  if (availability.data.availability.state === "unconfigured") {
    return (
      <EmptyState
        description="This Console has no encryption key for cloud agents yet, so it can't keep an Anthropic API key. Whoever runs this Console sets RAVI_CLOUD_AGENTS_KEY."
        headingLevel={2}
        icon={Cloud}
        title="Cloud agents aren't set up on this Console"
      />
    );
  }
  if (availability.data.availability.state === "not_enabled") {
    return (
      <NoAccess
        description="Cloud agents aren't open to this organization yet."
        role={roleLabel(organization.role)}
        title="Cloud agents aren't available here"
      />
    );
  }
  return <>{children({ project, availability: availability.data.availability, viewerId: availability.data.viewerId, credential: credential.data })}</>;
}

/** The section header, the key warning and the Agents / Runs / Schedules tabs. */
export function CloudFrame({ children, scope, tab }: { children: React.ReactNode; scope: CloudScope; tab: CloudTab }) {
  const root = `/p/${scope.project.id}/cloud`;
  return (
    <>
      <PageHeader
        description="Library agents that run on Anthropic's cloud with this organization's own API key. A run acts as the person who started it, uses Ravi's tools through the Console, and asks a person before it changes anything."
        title="Cloud agents"
      />
      <KeyNotice availability={scope.availability} credential={scope.credential} />
      <div className="mb-6 border-b border-line">
        <TabNav
          items={(Object.keys(TAB_PATHS) as CloudTab[]).map((key) => ({
            active: key === tab,
            href: `${root}${TAB_PATHS[key]}`,
            label: TAB_LABELS[key],
          }))}
          label="Cloud agents"
        />
      </div>
      {children}
    </>
  );
}

/** Nothing runs without the organization's key: say so, and where to fix it. */
export function KeyNotice({ availability, credential }: { availability: CloudAgentsAvailability; credential: CloudCredential | undefined }) {
  if (!credential || credential.status === "active") return null;
  const invalid = credential.status === "invalid";
  return (
    <Notice
      className="mb-4"
      icon={KeyRound}
      title={invalid ? "Anthropic rejected the organization's API key" : "Add the organization's Anthropic API key"}
      tone={invalid ? "err" : "warn"}
    >
      {availability.canManageKey ? (
        <>
          Runs use this organization&apos;s own key and its Anthropic credits.{" "}
          <Link className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink" href="/org/settings#cloud-agents">
            {invalid ? "Replace the key in Organization settings" : "Add it in Organization settings"}
          </Link>
          .
        </>
      ) : (
        <>Runs use this organization&apos;s own key. An owner or admin adds it in Organization settings.</>
      )}
    </Notice>
  );
}
