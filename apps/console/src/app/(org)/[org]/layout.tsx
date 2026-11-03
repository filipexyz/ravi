import { ConsoleWorkspaceLayout } from "@/components/console-workspace-layout";

/** Every screen under `/<org>` opens in the organization its URL names. */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  return <ConsoleWorkspaceLayout urlOrganization={org}>{children}</ConsoleWorkspaceLayout>;
}
