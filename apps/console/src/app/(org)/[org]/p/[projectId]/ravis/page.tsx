import { redirect } from "next/navigation";

import { orgPath } from "@/lib/console-paths";

export default async function ProjectManagedRavisPage({
  params,
}: {
  params: Promise<{ org: string; projectId: string }>;
}) {
  const { org, projectId } = await params;
  redirect(orgPath(org, `/org/control?project=${encodeURIComponent(projectId)}`));
}
