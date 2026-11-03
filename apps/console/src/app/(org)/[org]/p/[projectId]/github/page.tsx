import { redirect } from "next/navigation";

import { orgPath } from "@/lib/console-paths";

/**
 * GitHub moved to Settings → Integrations. The GitHub App setup route still
 * returns here (`?githubSetup=…&installationId=…`), so the whole query string
 * goes along.
 */
export default async function ProjectGithubPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, projectId } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const search = query.toString();
  redirect(orgPath(org, `/p/${encodeURIComponent(projectId)}/settings/integrations${search ? `?${search}` : ""}`));
}
