import { redirect } from "next/navigation";

import { orgPath } from "@/lib/console-paths";

/** The project's audit log moved to Settings → Activity. */
export default async function ProjectAuditPage({ params }: { params: Promise<{ org: string; projectId: string }> }) {
  const { org, projectId } = await params;
  redirect(orgPath(org, `/p/${encodeURIComponent(projectId)}/settings/activity`));
}
