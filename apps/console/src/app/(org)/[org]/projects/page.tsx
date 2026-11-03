import { redirect } from "next/navigation";

/** The organization's projects are its home. */
export default async function OrganizationProjectsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  redirect(`/${encodeURIComponent(org)}`);
}
