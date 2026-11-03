// Visual-only fixture: renders the EXISTING settings component, not a login/E2E proof.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrgGeneralScreen } from "../../src/features/org/general-screen";
import { FleetScreen } from "../../src/features/org/fleet-screen";
import { SsoScreen } from "../../src/features/org/sso-screen";
import { OnboardingScreen } from "../../src/features/org/onboarding-screen";
import { SetupScreen } from "../../src/features/org/setup-screen";
import { WorkspaceProvider, type Workspace } from "../../src/features/shell/workspace";
import { ToastProvider } from "../../src/ui/toast";
import { OrgSegmentProvider } from "../../src/lib/org-href";
import { ORGANIZATION_ACTIONS } from "../../src/shared/project-authorization";
import { AppShell } from "../../src/features/shell/app-shell";
import { OrgArea } from "../../src/features/org/org-area";
import { NewProjectScreen } from "../../src/features/projects/new-project-screen";
import { ProjectsScreen } from "../../src/features/projects/projects-screen";
import { OrgMembersScreen } from "../../src/features/org/members-screen";

const scenario = new URL(location.href).searchParams.get("scenario");
const tab = new URL(location.href).searchParams.get("tab");
const organization = { id: "00000000-0000-4000-8000-000000000001", name: "Acme Test", slug: "acme", role: tab === "new-project" || tab === "projects" ? "owner" : "viewer", plan: "self-hosted", mark: "A", color: "c1" as const };
const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
client.setQueryData(["organization", organization.id, "organization-access"], {
  actions: Object.fromEntries(ORGANIZATION_ACTIONS.map(action => [action, scenario === "policyonly" ? action === "organization.authorization.read" : scenario !== "denied" && (scenario !== "readonly" || action.endsWith(".read"))])),
  generation: 1, revisionId: "00000000-0000-4000-8000-000000000010",
});
client.setQueryData(["organization", organization.id, "settings", "org"], { name: organization.name, slug: organization.slug, scope: "org", members: [] });
if (tab === "members") client.setQueryData(["organization", organization.id, "settings", "org"], {
  id: organization.id, name: organization.name, slug: organization.slug, currentRole: "owner", currentUserId: "member-1", canManageMembers: true,
  members: [{ id: "member-1", name: "Marina Teste", email: "marina@example.invalid", role: "owner", status: "active" },
    { id: "member-2", name: "Alex Teste", email: "alex@example.invalid", role: "viewer", status: "suspended" }], tokens: [],
});
client.setQueryData(["organization", organization.id, "settings", "invites"], { invites: [] });
client.setQueryData(["organization", organization.id, "members"], { currentUserId: "member-1", members: [
  { userId: "member-1", name: "Marina Teste", email: "marina@example.invalid", status: "active", version: "2026-10-24 00:00:00+00" },
  { userId: "member-2", name: "Alex Teste", email: "alex@example.invalid", status: "suspended", version: "2026-10-24 00:00:00+00" },
] });
for (const tab of ["credentials", "installations"]) client.setQueryData(["organization", organization.id, "fleet", tab], { credentials: [], installations: [] });
client.setQueryData(["organization", organization.id, "fleet-credential-choices"], []);
client.setQueryData(["organization", organization.id, "fleet-sso"], { connections: [], source: "bootstrap" });
client.setQueryData(["organization", organization.id, "onboarding"], { completed: false, name: organization.name, slug: organization.slug,
  login: "bootstrap", storedCredentials: 0, activeTransports: 0, pendingTransports: 0, snapshot: "a".repeat(64) });
const workspace = { organization, viewer: { name: "Test Admin", email: "admin@example.invalid", mark: "T" }, projects: [], platformOperator: false,
  features: { byKey: { "console.settings": { enabled: tab !== "permissions", visible: tab !== "permissions" } } } } as unknown as Workspace;
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>{tab === "permissions" ? <AppShell workspace={workspace}>
    <OrgArea tab="permissions"><p>Navigation fixture only — policy editor has its own browser suite.</p></OrgArea>
  </AppShell> : <WorkspaceProvider value={workspace}><OrgSegmentProvider value="acme"><ToastProvider>
    <div className="min-h-screen bg-canvas p-5 text-ink sm:p-10">{tab === "members" ? <OrgMembersScreen /> : tab === "new-project" ? <NewProjectScreen /> : tab === "projects" ? <ProjectsScreen /> : tab === "setup" ? <SetupScreen /> : tab === "onboarding" ? <OnboardingScreen /> : tab === "sso" ? <SsoScreen /> : tab === "credentials" || tab === "installations" ? <FleetScreen tab={tab} /> : <OrgGeneralScreen />}</div>
  </ToastProvider></OrgSegmentProvider></WorkspaceProvider>}</QueryClientProvider>,
);
