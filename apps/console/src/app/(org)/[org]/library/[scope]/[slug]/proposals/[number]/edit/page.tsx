import { notFound } from "next/navigation";

import { LibraryEditorScreen } from "@/features/library/library-editor-screen";

export default async function OrgLibraryProposalEditPage({
  params,
}: {
  params: Promise<{ scope: string; slug: string; number: string }>;
}) {
  const { scope, slug, number } = await params;
  const parsed = Number(number);
  if (!Number.isInteger(parsed) || parsed < 1) notFound();
  return <LibraryEditorScreen mode={{ kind: "edit", scope: decodeURIComponent(scope), slug: decodeURIComponent(slug), number: parsed }} />;
}
