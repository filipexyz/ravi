"use client";

import { SearchX, Video } from "lucide-react";
import { useOrgRouter } from "@/lib/org-href";
import { useState } from "react";

import { UpcomingMeetings } from "@/features/calendar/upcoming-meetings";
import type { Project } from "@/features/console/types";
import { findProject, roleLabel, useFeature, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { Field, FormMessage, Input, Select } from "@/ui/form";
import { PageHeader, Panel } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, NoAccess, Notice } from "@/ui/states";
import { Segmented } from "@/ui/tabs";
import { formatDate, RelativeTime } from "@/ui/time";

import { meetingErrorText, useMeetings, useMeetingSettings, useSendMeetingBot, useUpdateMeetingSettings } from "./api";
import { formatDuration, meetingState, meetingTitle, retentionMonthOptions } from "./format";
import type { Meeting } from "./types";

/**
 * Resolves the project from the route and checks that meetings are on for this
 * organization and role. The server still enforces both on every call.
 */
export function MeetingsProjectGate({
  children,
  projectRef,
}: {
  children: (project: Project) => React.ReactNode;
  projectRef: string;
}) {
  const { organization, projects } = useWorkspace();
  const enabled = useFeature("console.meetings");
  const project = findProject(projects, projectRef);

  if (!project) {
    return (
      <EmptyState
        action={<Button href="/projects">All projects</Button>}
        description="Check the address, or pick a project from the list."
        icon={SearchX}
        title="This project doesn't exist or you don't have access"
      />
    );
  }
  if (!enabled) {
    return (
      <NoAccess
        description="Meeting recording isn't turned on for this organization, or your role doesn't include it."
        role={roleLabel(organization.role)}
        title="Meetings aren't available here"
      />
    );
  }
  return <>{children(project)}</>;
}

export function MeetingsScreen({ projectId }: { projectId: string }) {
  return <MeetingsProjectGate projectRef={projectId}>{(project) => <MeetingsList project={project} />}</MeetingsProjectGate>;
}

function MeetingsList({ project }: { project: Project }) {
  const { organization } = useWorkspace();
  const [recordOpen, setRecordOpen] = useState(false);
  const meetings = useMeetings(project.id);
  const list = meetings.data ?? [];
  const waiting = list.filter((meeting) => meeting.status === "waiting_room");

  return (
    <>
      <PageHeader
        actions={
          list.length ? (
            <Button icon={Video} onClick={() => setRecordOpen(true)} variant="primary">
              Record a call
            </Button>
          ) : null
        }
        description="Ravi joins your Google Meet calls to record and transcribe them. Calls sent from here and from your agents show up in this list as they happen."
        title="Meetings"
      />

      <UpcomingMeetings projectId={project.id} />

      {waiting.length ? (
        <Notice className="mb-4" title={`Ravi is waiting to be let into ${waiting.length === 1 ? meetingTitle(waiting[0]!) : `${waiting.length} calls`}`} tone="warn">
          Someone in the call has to admit it. It gives up after 10 minutes.
        </Notice>
      ) : null}

      {meetings.isPending ? (
        <ListSkeleton rows={3} />
      ) : meetings.isError ? (
        <ErrorState error={meetings.error} onRetry={() => void meetings.refetch()} role={roleLabel(organization.role)} />
      ) : list.length === 0 ? (
        <EmptyState
          action={
            <Button icon={Video} onClick={() => setRecordOpen(true)} variant="primary">
              Record a call
            </Button>
          }
          description="Send Ravi to a Google Meet call and the recording and transcript show up here when it ends. Agents can do the same from your machine."
          icon={Video}
          title="No recorded calls yet"
        >
          <CodeBlock code="ravi meetings join https://meet.google.com/abc-defg-hij" label="From the terminal or an agent" />
        </EmptyState>
      ) : (
        <List label="Meetings">
          {list.map((meeting) => (
            <MeetingRow key={meeting.id} meeting={meeting} projectId={project.id} />
          ))}
        </List>
      )}

      <TranscriptRetention projectId={project.id} />

      <RecordDialog onClose={() => setRecordOpen(false)} open={recordOpen} projectId={project.id} />
    </>
  );
}

/**
 * How long Ravi keeps this project's meeting transcripts once the recording's
 * media is gone. Shown to project admins when the organization uses Knowledge.
 */
function TranscriptRetention({ projectId }: { projectId: string }) {
  const settings = useMeetingSettings(projectId);
  const update = useUpdateMeetingSettings(projectId);
  const [months, setMonths] = useState<number | null>(null);
  const data = settings.data;
  if (!data || !data.canManage || !data.knowledgeEnabled) return null;
  const chosen = months ?? data.transcriptRetentionMonths;
  const changed = chosen !== data.transcriptRetentionMonths;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!changed) return;
    update.mutate({ transcriptRetentionMonths: chosen }, { onSuccess: () => setMonths(null) });
  };

  return (
    <Panel as="section" className="mt-8" padded>
      <form className="space-y-3" noValidate onSubmit={submit}>
        <Field
          hint="Ravi keeps each call's transcript this long, so the team can look things up after the recording expires. Changing it applies to calls already kept."
          label="Keep transcripts for"
        >
          {(props) => (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                {...props}
                className="w-40"
                onChange={(event) => {
                  update.reset();
                  setMonths(Number(event.target.value));
                }}
                value={String(chosen)}
              >
                {retentionMonthOptions(chosen).map((option) => (
                  <option key={option} value={option}>
                    {option} {option === 1 ? "month" : "months"}
                  </option>
                ))}
              </Select>
              <Button disabled={!changed} loading={update.isPending} type="submit" variant="secondary">
                Save
              </Button>
            </div>
          )}
        </Field>
        {update.isError ? <FormMessage>{meetingErrorText(update.error) ?? "The setting couldn't be saved."}</FormMessage> : null}
        {update.isSuccess ? <FormMessage tone="ok">Transcripts are now kept for {data.transcriptRetentionMonths} months.</FormMessage> : null}
      </form>
    </Panel>
  );
}

function MeetingRow({ meeting, projectId }: { meeting: Meeting; projectId: string }) {
  const state = meetingState(meeting);
  const duration = meeting.recordingSeconds ? formatDuration(meeting.recordingSeconds) : null;
  const when =
    meeting.status === "requested" && meeting.joinAt ? (
      <span>Joins {formatDate(meeting.joinAt, true)}</span>
    ) : (
      <RelativeTime value={meeting.recordingStartedAt ?? meeting.createdAt} />
    );

  return (
    <ListRow
      chevron
      description={
        <>
          <span className="font-mono text-[12px]">{meeting.meetingCode ?? meeting.meetingUrl}</span>
          <span className="md:hidden"> · {when}</span>
        </>
      }
      href={`/p/${projectId}/meetings/${meeting.id}`}
      leading={
        <span className="relative inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-3">
          <Video aria-hidden size={16} />
          {meeting.status === "recording" ? (
            <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2.5 animate-pulse rounded-full bg-err ring-2 ring-surface" />
          ) : null}
        </span>
      }
      meta={
        <>
          {duration ? <span>{duration}</span> : null}
          {when}
        </>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{meetingTitle(meeting)}</span>
          <Badge dot={meeting.status !== "done" || !meeting.ready} title={state.hint} tone={state.tone}>
            {state.label}
          </Badge>
        </span>
      }
    />
  );
}

const LANGUAGES = [
  { value: "pt", label: "Portuguese" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "auto", label: "Detect automatically" },
];

function RecordDialog({ onClose, open, projectId }: { onClose: () => void; open: boolean; projectId: string }) {
  const router = useOrgRouter();
  const send = useSendMeetingBot(projectId);
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("pt");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [joinAt, setJoinAt] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [joinAtError, setJoinAtError] = useState<string | null>(null);

  const close = () => {
    send.reset();
    setLinkError(null);
    setJoinAtError(null);
    onClose();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!link.trim()) {
      setLinkError("Paste the Google Meet link of the call.");
      return;
    }
    setLinkError(null);
    const scheduled = when === "later" ? new Date(joinAt) : null;
    // Without a valid time the server would send Ravi right away, not at the time asked for.
    if (scheduled && (!joinAt || Number.isNaN(scheduled.getTime()))) {
      setJoinAtError("Pick when Ravi should join.");
      return;
    }
    setJoinAtError(null);
    send.mutate(
      {
        meetingUrl: link.trim(),
        language,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(scheduled ? { joinAt: scheduled.toISOString() } : {}),
      },
      {
        onSuccess: ({ meeting }) => {
          setLink("");
          setTitle("");
          setJoinAt("");
          setWhen("now");
          close();
          router.push(`/p/${projectId}/meetings/${meeting.id}`);
        },
      },
    );
  };

  const formId = "record-call-form";
  return (
    <Dialog
      className="max-w-lg"
      description="Ravi joins as a participant, posts a notice in the chat saying it is recording, and leaves when the call ends."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button form={formId} loading={send.isPending} type="submit" variant="primary">
            {when === "later" ? "Schedule" : "Send Ravi"}
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title="Record a call"
    >
      <form className="space-y-4" id={formId} noValidate onSubmit={submit}>
        <Field error={linkError} hint="A link like meet.google.com/abc-defg-hij, or just the code." label="Google Meet link">
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              autoFocus
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://meet.google.com/abc-defg-hij"
              value={link}
            />
          )}
        </Field>
        <Field label="Title" optional>
          {(props) => (
            <Input {...props} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="Weekly sync" value={title} />
          )}
        </Field>
        <Field hint="The language spoken in the call, for the transcript." label="Language">
          {(props) => (
            <Select {...props} onChange={(event) => setLanguage(event.target.value)} value={language}>
              {LANGUAGES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="space-y-2">
          <Segmented
            label="When Ravi joins"
            onChange={setWhen}
            options={[
              { value: "now", label: "Join now" },
              { value: "later", label: "Schedule" },
            ]}
            value={when}
          />
          {when === "later" ? (
            <Field error={joinAtError} hint="Up to 30 days ahead, in your time zone." label="Join at">
              {(props) => (
                <Input {...props} onChange={(event) => setJoinAt(event.target.value)} type="datetime-local" value={joinAt} />
              )}
            </Field>
          ) : null}
        </div>
        {send.isError ? <FormMessage>{meetingErrorText(send.error) ?? "Ravi couldn't be sent to this call."}</FormMessage> : null}
      </form>
      <p className="mt-4 text-[13px] text-ink-3">
        The recording shows up here. Calls recorded from here don&apos;t reach a Ravi on your machine; to bring one there, run{" "}
        <span className="font-mono">ravi meetings fetch</span> with its id.
      </p>
    </Dialog>
  );
}
