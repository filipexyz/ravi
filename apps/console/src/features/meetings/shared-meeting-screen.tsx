"use client";

import { useMemo } from "react";

import { isNotFound } from "@/lib/api/client";
import { SignedInAs, StandaloneFrame } from "@/features/account/standalone-frame";
import { PageHeader, Panel } from "@/ui/layout";
import { EmptyState, ErrorState, Skeleton } from "@/ui/states";

import { useSharedMeeting } from "./api";
import { buildConversation, emptyTranscriptCopy } from "./conversation";
import { DownloadMenu, MeetingFacts, MeetingMeta, MeetingTitle, RecordingWorkspace } from "./meeting-screen";
import type { MeetingRecording, SharedMeeting } from "./types";

/**
 * A meeting opened from a share link (`/shared/meetings/<id>`), outside any
 * organization: the recording to watch and read, without the project's
 * actions. Members of the meeting's organization see the same page.
 */
export function SharedMeetingScreen({ meetingId, viewer }: { meetingId: string; viewer: { email: string; name?: string } }) {
  const query = useSharedMeeting(meetingId);
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="xl">
      {query.isPending ? (
        <div aria-busy aria-label="Loading" className="space-y-4" role="status">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : query.isError || !query.data ? (
        isNotFound(query.error) ? (
          <EmptyState
            description={`This meeting doesn't exist, or it wasn't shared with ${viewer.email}. Ask whoever sent the link to share it with this email.`}
            title="Meeting not found"
          />
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} title="This meeting couldn't load" />
        )
      ) : (
        <SharedMeetingBody shared={query.data} />
      )}
    </StandaloneFrame>
  );
}

function SharedMeetingBody({ shared }: { shared: SharedMeeting }) {
  const { meeting, organization, project, recording } = shared;
  const data: MeetingRecording | null = useMemo(() => (recording ? { meeting, ...recording } : null), [meeting, recording]);
  const conversation = useMemo(() => (data ? buildConversation(data) : null), [data]);
  const from = [organization.name, project?.name].filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader
        actions={data && conversation ? <DownloadMenu conversation={conversation} data={data} meeting={meeting} /> : null}
        title={<MeetingTitle meeting={meeting} />}
      >
        <p className="text-sm text-ink-3">
          {from}
          {shared.access === "guest" ? " · shared with you" : null}
        </p>
        <MeetingMeta conversation={conversation} meeting={meeting} />
      </PageHeader>
      {data && conversation ? (
        <RecordingWorkspace conversation={conversation} data={data} emptyCopy={emptyTranscriptCopy(data, null)} meeting={meeting} />
      ) : (
        <Panel className="px-5">
          <p className="pt-4 text-sm text-ink-2">The recording shows up here once the call is over and processed.</p>
          <MeetingFacts meeting={meeting} />
        </Panel>
      )}
    </>
  );
}
