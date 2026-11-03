import { MeetingsScreen } from "@/features/meetings/meetings-screen";

export default async function MeetingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <MeetingsScreen projectId={projectId} />;
}
