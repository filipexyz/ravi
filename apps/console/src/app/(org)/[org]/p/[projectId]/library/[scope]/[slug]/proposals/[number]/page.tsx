import { notFound } from "next/navigation";

import { LibraryProposalScreen } from "@/features/library/library-proposal-screen";

export default async function ProjectLibraryProposalPage({
  params,
}: {
  params: Promise<{ projectId: string; scope: string; slug: string; number: string }>;
}) {
  const { projectId, scope, slug, number } = await params;
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) notFound();
  return (
    <LibraryProposalScreen number={parsed} projectId={projectId} scope={decodeURIComponent(scope)} slug={decodeURIComponent(slug)} />
  );
}
