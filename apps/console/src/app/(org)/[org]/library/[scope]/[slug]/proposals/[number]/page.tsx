import { notFound } from "next/navigation";

import { LibraryProposalScreen } from "@/features/library/library-proposal-screen";

export default async function OrgLibraryProposalPage({
  params,
}: {
  params: Promise<{ scope: string; slug: string; number: string }>;
}) {
  const { scope, slug, number } = await params;
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) notFound();
  return <LibraryProposalScreen number={parsed} scope={decodeURIComponent(scope)} slug={decodeURIComponent(slug)} />;
}
