import { ChooseOrganizationScreen } from "@/features/org/choose-organization-screen";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function OrgPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return <ChooseOrganizationScreen notice={first(params.select)} returnTo={first(params.returnTo) ?? first(params.next)} />;
}
