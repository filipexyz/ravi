"use client";

import type { ConsoleFeatureKey } from "@/features/console/types";
import { featureEnabled, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Avatar } from "@/ui/badge";
import { PageHeader } from "@/ui/layout";
import { ErrorState, NoAccess, Skeleton } from "@/ui/states";
import { TabNav } from "@/ui/tabs";
import { lockedReason } from "./labels";
import { useOrganizationAccess } from "./access";
import type { OrganizationAction } from "@/shared/organization-access";

export type OrgTab = "settings" | "onboarding" | "sso" | "credentials" | "api-keys" | "installations" | "permissions" | "members" | "domains" | "github" | "connectors" | "billing" | "audit";
const POLICY_TABS: Partial<Record<OrgTab, OrganizationAction>> = {
  settings: "organization.settings.read", onboarding: "organization.onboarding.read", sso: "organization.sso.read",
  credentials: "organization.credentials.read", installations: "organization.installations.read",
  permissions: "organization.authorization.read",
  members: "organization.members.read",
  "api-keys": "organization.api_keys.read",
};

const MEMBERS = { feature: "console.settings", href: "/org/members", key: "members", label: "Members" } as const;

/** Settings tabs. Members is its own organization tab in the header, next to Projects and Settings. */
const TABS: Array<{ key: OrgTab; href: string; label: string; feature: ConsoleFeatureKey }> = [
  { feature: "console.settings", href: "/org/settings", key: "settings", label: "General" },
  { feature: "console.settings", href: "/org/sso", key: "sso", label: "Login e SSO" },
  { feature: "console.settings", href: "/org/credentials", key: "credentials", label: "Credenciais" },
  { feature: "console.settings", href: "/org/api-keys", key: "api-keys", label: "Chaves de API" },
  { feature: "console.settings", href: "/org/installations", key: "installations", label: "Instalações Ravi" },
  { feature: "console.settings", href: "/org/permissions", key: "permissions", label: "Políticas de acesso" },
  { feature: "console.domains", href: "/org/domains", key: "domains", label: "Domains" },
  { feature: "console.github", href: "/org/github", key: "github", label: "GitHub" },
  { feature: "console.connectors", href: "/org/connectors", key: "connectors", label: "Connectors" },
  { feature: "console.billing", href: "/org/billing", key: "billing", label: "Billing" },
  { feature: "console.audit", href: "/org/audit", key: "audit", label: "Activity" },
];

/**
 * The Organization area: one header and, for settings, tabs that are URLs.
 * Each tab is gated by its own feature, so a role sees exactly the tabs it can
 * open, and a closed tab's URL says why instead of loading forever.
 */
export function OrgArea({ children, tab }: { children: React.ReactNode; tab: OrgTab }) {
  const { features, organization } = useWorkspace();
  const access = useOrganizationAccess();
  const isMembers = tab === "members";
  const current = isMembers ? MEMBERS : TABS.find((item) => item.key === tab);
  const action = POLICY_TABS[tab];
  const open = action ? access.allows(action) : current ? featureEnabled(features, current.feature) : false;
  const items = isMembers
    ? []
    : TABS.filter((item) => POLICY_TABS[item.key] ? access.allows(POLICY_TABS[item.key]!) : featureEnabled(features, item.feature)).map((item) => ({
        active: item.key === tab,
        href: item.href,
        label: item.label,
      }));

  return (
    <>
      <PageHeader
        className="mb-5"
        description={
          <span className="flex min-w-0 items-center gap-2">
            <Avatar label={organization.name} seed={organization.id} size="sm" />
            <span className="truncate font-medium text-ink">{organization.name}</span>
          </span>
        }
        title={isMembers ? "Members" : "Settings"}
      />
      {items.length ? (
        <div className="mb-8 border-b border-line">
          <TabNav items={items} label="Organization settings" />
        </div>
      ) : null}
      {action && access.isPending ? <Skeleton className="h-32" /> : action && access.isError ?
        <ErrorState error={access.error} onRetry={() => void access.refetch()} /> : open || (!current && !action) ? (
        children
      ) : (
        <NoAccess
          description={action ? "Seu acesso atual não permite consultar esta configuração." : lockedReason(features.byKey[current!.feature], current!.label)}
          role={action ? undefined : roleLabel(organization.role)}
          title={action ? "Acesso não concedido" : `You can't open ${current!.label}`}
        />
      )}
    </>
  );
}
