import { MailScreen } from "@/features/console/screens";

export default async function ProjectMailPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <MailScreen projectId={projectId} scope="project" />;
}
