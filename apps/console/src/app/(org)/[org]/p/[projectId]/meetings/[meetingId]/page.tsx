import { MeetingScreen } from "@/features/meetings/meeting-screen";

export default async function MeetingPage({ params }: { params: Promise<{ projectId: string; meetingId: string }> }) {
  const { meetingId, projectId } = await params;
  return <MeetingScreen meetingId={meetingId} projectId={projectId} />;
}
