import { KnowledgeScreen } from "@/features/console/screens";

export default async function ProjectKnowledgePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <KnowledgeScreen projectId={projectId} />;
}
