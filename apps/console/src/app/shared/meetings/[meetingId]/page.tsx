import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { SharedMeetingScreen } from "@/features/meetings/shared-meeting-screen";
import { getConsoleAuthState } from "@/lib/auth/session";
import { ConsoleEmailVerificationRequiredError, getConsoleUserFromAuth } from "@/server/console/workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Meeting",
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

// The link a meeting is shared with. It opens outside any organization, so
// someone given only this meeting sees it; access is checked by the API.
export default async function SharedMeetingPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const { meetingId } = await params;
  const auth = await getConsoleAuthState();
  try {
    await getConsoleUserFromAuth(auth);
  } catch (caught) {
    // The Console home asks them to verify their email first.
    if (caught instanceof ConsoleEmailVerificationRequiredError) redirect("/");
    throw caught;
  }
  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <SharedMeetingScreen meetingId={meetingId} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}
