import { OrgGithubScreen } from "@/features/org/github-screen";

export default async function OrgGithubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { github } = await searchParams;
  return <OrgGithubScreen status={typeof github === "string" ? github : undefined} />;
}
