"use client";

import { ArrowDownToLine, ArrowLeft, ChevronDown, Clock, Download, ExternalLink, FileText, LogOut, Terminal, Trash2, VideoOff } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import type { Project } from "@/features/console/types";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock, CopyValue } from "@/ui/copy";
import { FormMessage } from "@/ui/form";
import { DetailList, PageHeader, Panel } from "@/ui/layout";
import { Dialog, Menu, MenuItem, MenuLabel, MenuSeparator } from "@/ui/overlay";
import { ErrorState, Notice, Skeleton } from "@/ui/states";
import { formatDate } from "@/ui/time";
import { useToast } from "@/ui/toast";

import {
  mediaPath,
  meetingErrorText,
  useDeleteStoredTranscript,
  useLeaveMeeting,
  useMeeting,
  useMeetingRecording,
  useMeetingSettings,
  useStoredTranscript,
} from "./api";
import {
  buildConversation,
  conversationSource,
  conversationText,
  emptyTranscriptCopy,
  itemForMoment,
  lineAt,
  parseMoment,
  recordingFromStored,
  recordingNeedsStored,
  recordingShowsSkeleton,
  searchConversation,
  type Conversation,
} from "./conversation";
import { canLeave, formatDuration, meetingState, meetingTitle } from "./format";
import { ConversationList, ConversationToolbar, SHELL_HEADER_HEIGHT } from "./meeting-conversation";
import { MiniPlayer, PlayerPanel } from "./meeting-player";
import { MeetingProgress } from "./meeting-progress";
import { MeetingBriefingPanel } from "@/features/calendar/briefing-panel";
import { ShareMeetingButton } from "./meeting-sharing";
import { MeetingsProjectGate } from "./meetings-screen";
import { useMeetingPlayer } from "./player";
import { toneBg } from "./tones";
import type { Meeting, MeetingRecording } from "./types";

export function MeetingScreen({ meetingId, projectId }: { meetingId: string; projectId: string }) {
  return (
    <MeetingsProjectGate projectRef={projectId}>
      {(project) => <MeetingDetail meetingId={meetingId} project={project} />}
    </MeetingsProjectGate>
  );
}

function MeetingDetail({ meetingId, project }: { meetingId: string; project: Project }) {
  const { organization } = useWorkspace();
  const query = useMeeting(project.id, meetingId);
  const meeting = query.data;
  const back = (
    <Button className="-ml-2.5 mb-3" href={`/p/${project.id}/meetings`} icon={ArrowLeft} size="sm" variant="ghost">
      All meetings
    </Button>
  );

  if (query.isPending) {
    return (
      <>
        {back}
        <div aria-busy aria-label="Loading" className="space-y-4" role="status">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-48 w-full" />
        </div>
      </>
    );
  }
  if (query.isError || !meeting) {
    return (
      <>
        {back}
        <ErrorState error={query.error} onRetry={() => void query.refetch()} role={roleLabel(organization.role)} title="This meeting couldn't load" />
      </>
    );
  }

  return (
    <>
      {back}
      {meeting.status === "done" ? <RecordedMeeting meeting={meeting} project={project} /> : <LiveMeeting meeting={meeting} projectId={project.id} />}
    </>
  );
}

export function MeetingTitle({ meeting }: { meeting: Meeting }) {
  const state = meetingState(meeting);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="min-w-0 break-words">{meetingTitle(meeting)}</span>
      <Badge dot={meeting.status !== "done" || !meeting.ready} tone={state.tone}>
        {state.label}
      </Badge>
    </span>
  );
}

// Before the recording exists: where Ravi is on its way, and the call's facts.

function LiveMeeting({ meeting, projectId }: { meeting: Meeting; projectId: string }) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  const leave = useLeaveMeeting(projectId, meeting.id);
  const toast = useToast();
  // A scheduled bot is not in a call yet, so there is nothing to leave.
  const open = canLeave(meeting) && meeting.status !== "requested";
  const stopLabel = meeting.status === "recording" ? "Stop recording" : "Remove Ravi";

  return (
    <>
      {/* The steps say what is happening and what comes next, so the header carries no hint. */}
      <PageHeader
        actions={
          <>
            <ShareMeetingButton meeting={meeting} projectId={projectId} />
            {open ? (
              <>
                <Button external href={meeting.meetingUrl} icon={ExternalLink} target="_blank" variant="ghost">
                  Open in Meet
                </Button>
                <Button icon={LogOut} onClick={() => setConfirmLeave(true)} variant="danger">
                  {stopLabel}
                </Button>
              </>
            ) : null}
          </>
        }
        title={<MeetingTitle meeting={meeting} />}
      />

      <MeetingBriefingPanel meetingId={meeting.id} />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel className="p-5">
          <MeetingProgress meeting={meeting} />
        </Panel>
        <Panel className="px-5">
          <MeetingFacts meeting={meeting} />
        </Panel>
      </div>

      <Dialog
        description="Ravi leaves the call now. What it recorded so far is kept and shows up here once it's processed."
        footer={
          <>
            <Button onClick={() => setConfirmLeave(false)} variant="ghost">
              Keep Ravi in the call
            </Button>
            <Button
              loading={leave.isPending}
              onClick={() =>
                leave.mutate(undefined, {
                  onSuccess: ({ left }) => {
                    setConfirmLeave(false);
                    toast.show(left ? "Ravi is leaving the call." : "Ravi had already left the call.");
                  },
                })
              }
              variant="danger"
            >
              {stopLabel}
            </Button>
          </>
        }
        onClose={() => {
          leave.reset();
          setConfirmLeave(false);
        }}
        open={confirmLeave}
        title="Take Ravi out of this call?"
      >
        {leave.isError ? <FormMessage>{meetingErrorText(leave.error) ?? "Ravi couldn't leave the call."}</FormMessage> : null}
      </Dialog>
    </>
  );
}

export function MeetingFacts({ meeting }: { meeting: Meeting }) {
  const duration = meeting.recordingSeconds ? formatDuration(meeting.recordingSeconds) : null;
  const cap = formatDuration(meeting.maxRecordingSeconds);
  return (
    <DetailList
      items={[
        meeting.meetingUrl
          ? { label: "Call", value: <CopyValue display={meeting.meetingUrl.replace(/^https:\/\//, "")} value={meeting.meetingUrl} /> }
          : null,
        { label: "Sent", value: formatDate(meeting.createdAt, true) },
        meeting.joinAt ? { label: "Scheduled for", value: formatDate(meeting.joinAt, true) } : null,
        meeting.recordingStartedAt ? { label: "Recording started", value: formatDate(meeting.recordingStartedAt, true) } : null,
        meeting.endedAt ? { label: "Ended", value: formatDate(meeting.endedAt, true) } : null,
        duration ? { label: "Recorded", value: duration } : null,
        cap ? { label: "Leaves after", value: `${cap} of recording at most` } : null,
        { label: "Name in the call", value: meeting.botName },
        { label: "Language", value: languageName(meeting.language) },
      ]}
    />
  );
}

// Once recorded: the player and the conversation side by side, on one clock.

function RecordedMeeting({ meeting, project }: { meeting: Meeting; project: Project }) {
  const { organization } = useWorkspace();
  const recording = useMeetingRecording(project.id, meeting.id, true);
  // The kept transcript is asked for only when the recording has none to show (or never loaded).
  const recordingEmpty = recordingNeedsStored(recording);
  const stored = useStoredTranscript(project.id, meeting.id, recordingEmpty);
  const settings = useMeetingSettings(project.id);
  const source = conversationSource(recording.data, stored.data);
  const data = useMemo(
    () => (source === "stored" && stored.data ? recordingFromStored(meeting, stored.data) : (recording.data ?? null)),
    [meeting, recording.data, source, stored.data],
  );
  const conversation = useMemo(() => (data ? buildConversation(data) : null), [data]);
  const emptyCopy = emptyTranscriptCopy(recording.data, stored.data);
  const canDelete = settings.data?.canManage === true && settings.data.knowledgeEnabled;
  const [useInRavi, setUseInRavi] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const waiting = recordingShowsSkeleton({ recording, stored, needsStored: recordingEmpty });

  return (
    <>
      <PageHeader
        actions={
          <>
            <ShareMeetingButton meeting={meeting} projectId={project.id} />
            <Button icon={Terminal} onClick={() => setUseInRavi(true)} variant="ghost">
              Use in Ravi
            </Button>
            {canDelete ? (
              <Button icon={Trash2} onClick={() => setDeleteOpen(true)} variant="ghost">
                Delete transcript
              </Button>
            ) : null}
            {data && conversation ? <DownloadMenu conversation={conversation} data={data} meeting={meeting} /> : null}
          </>
        }
        title={<MeetingTitle meeting={meeting} />}
      >
        <MeetingMeta conversation={conversation} meeting={meeting} />
      </PageHeader>

      <MeetingBriefingPanel meetingId={meeting.id} />

      {source === "stored" ? (
        <Notice className="mb-4" tone="info">
          Media expired; showing the transcript Ravi kept.
        </Notice>
      ) : null}

      {waiting ? (
        <div aria-busy aria-label="Loading the recording" className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" role="status">
          <div className="space-y-3">
            <Skeleton className="aspect-video w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-9 w-full" />
            {[0, 1, 2, 3].map((index) => (
              <div className="flex gap-3" key={index}>
                <Skeleton className="size-7 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-4 w-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : !data || !conversation ? (
        // A failed refresh keeps the recording that already loaded; only a first load that fails shows this.
        <ErrorState
          error={recording.error}
          onRetry={() => void recording.refetch()}
          role={roleLabel(organization.role)}
          title="The recording couldn't load"
        />
      ) : (
        <RecordingWorkspace conversation={conversation} data={data} emptyCopy={emptyCopy} meeting={meeting} />
      )}

      <DeleteTranscriptDialog meetingId={meeting.id} onClose={() => setDeleteOpen(false)} open={deleteOpen} projectId={project.id} />

      <Dialog
        description="Bring this call into a Ravi on your machine as a meeting artifact. Its agents can then read the transcript, quote it and act on it."
        footer={
          <Button onClick={() => setUseInRavi(false)} variant="ghost">
            Done
          </Button>
        }
        onClose={() => setUseInRavi(false)}
        open={useInRavi}
        title="Use this call in Ravi"
      >
        <div className="space-y-4">
          <CodeBlock code={`ravi meetings fetch ${meeting.id} --project ${project.slug}`} label="In a terminal, or ask an agent to run it" />
          <CodeBlock code={`ravi meetings read ${meetingLink(meeting.id)}`} label="Or read it without saving, from any Ravi you're logged into" />
        </div>
      </Dialog>
    </>
  );
}

/** Deletes the transcript Ravi kept for good; the recording, while it lasts, stays. */
function DeleteTranscriptDialog({ meetingId, onClose, open, projectId }: { meetingId: string; onClose: () => void; open: boolean; projectId: string }) {
  const toast = useToast();
  const remove = useDeleteStoredTranscript(projectId, meetingId);
  const close = () => {
    remove.reset();
    onClose();
  };
  return (
    <Dialog
      description="Ravi deletes the transcript it kept for this call, and it can no longer be found or quoted by your team or agents. This can't be undone. The call's recording, while it lasts, is not affected."
      footer={
        <>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  close();
                  toast.show("Transcript deleted.");
                },
              })
            }
            variant="danger"
          >
            Delete transcript
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title="Delete the kept transcript?"
    >
      {remove.isError ? <FormMessage>{meetingErrorText(remove.error) ?? "The transcript couldn't be deleted."}</FormMessage> : null}
    </Dialog>
  );
}

export function MeetingMeta({ conversation, meeting }: { conversation: Conversation | null; meeting: Meeting }) {
  const people = conversation?.speakers.length ?? 0;
  const parts = [
    formatDate(meeting.recordingStartedAt ?? meeting.createdAt, true),
    formatDuration(meeting.recordingSeconds ?? (conversation?.duration || null)),
    people ? `${people} ${people === 1 ? "person" : "people"}` : null,
    languageName(meeting.language),
  ].filter(Boolean);
  return <p className="text-sm text-ink-3">{parts.join(" · ")}</p>;
}

export function DownloadMenu({ conversation, data, meeting }: { conversation: Conversation; data: MeetingRecording; meeting: Meeting }) {
  const toast = useToast();
  const several = data.recordings.length > 1;
  const text = conversationText(conversation);
  return (
    <Menu
      align="end"
      label="Download"
      trigger={(props) => (
        <Button {...props} icon={Download} iconRight={ChevronDown} variant="secondary">
          Download
        </Button>
      )}
    >
      {data.media.length ? <MenuLabel>Recording</MenuLabel> : null}
      {data.media.map((item) => (
        <MenuItem
          description={several ? `Part ${item.part + 1}` : undefined}
          external
          href={mediaPath(item.path)}
          icon={ArrowDownToLine}
          key={`${item.kind}-${item.part}`}
        >
          {item.kind === "video" ? "Video" : "Audio"} ({item.format})
        </MenuItem>
      ))}
      {conversation.items.length ? (
        <>
          {data.media.length ? <MenuSeparator /> : null}
          <MenuLabel>Transcript</MenuLabel>
          <MenuItem icon={FileText} onSelect={() => saveText(`${fileName(meeting)}.txt`, text)}>
            Transcript (.txt)
          </MenuItem>
          <MenuItem
            icon={FileText}
            onSelect={() =>
              void navigator.clipboard
                .writeText(text)
                .then(() => toast.show("Transcript copied."))
                .catch(() => toast.show("The transcript couldn't be copied.", "err"))
            }
          >
            Copy the transcript
          </MenuItem>
        </>
      ) : null}
    </Menu>
  );
}

// The shell header (96 px) plus the gap above the content.
const ASIDE_TOP = "lg:top-[120px] lg:max-h-[calc(100dvh-120px)]";

export function RecordingWorkspace({
  conversation,
  data,
  emptyCopy,
  meeting,
}: {
  conversation: Conversation;
  data: MeetingRecording;
  emptyCopy: { tone: "info" | "warn"; text: string } | null;
  meeting: Meeting;
}) {
  const player = useMeetingPlayer({
    fallbackDuration: conversation.duration,
    media: data.media,
    parts: conversation.parts,
    placed: conversation.seekable,
  });
  const { seek } = player;
  const canSeek = player.available && conversation.seekable;

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState({ key: "", index: 0 });
  const [follow, setFollow] = useState(true);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [transportVisible, setTransportVisible] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const transportRef = useRef<HTMLDivElement>(null);

  const items = useMemo(
    () => (selected.size ? conversation.items.filter((item) => selected.has(item.speaker)) : conversation.items),
    [conversation.items, selected],
  );
  const matches = useMemo(() => searchConversation(items, deferredQuery), [items, deferredQuery]);
  // The cursor belongs to one search; a new search starts at its first match.
  const searchKey = `${deferredQuery}|${[...selected].join(",")}`;
  const matchIndex = cursor.key === searchKey ? Math.min(cursor.index, Math.max(0, matches.length - 1)) : 0;
  const currentMatch = matches[matchIndex] ?? null;

  const engaged = player.playing || player.time > 0;
  const activeLine = useMemo(
    () => (canSeek && engaged ? lineAt(conversation.lines, player.time) : null),
    [canSeek, conversation.lines, engaged, player.time],
  );

  // A new search or filter starts at its first match, even one typed before.
  const resetCursor = useCallback(() => setCursor({ key: "", index: 0 }), []);

  const toggleSpeaker = useCallback((key: string) => {
    resetCursor();
    // The list reflows under the filter; that is not a person scrolling away.
    holdScroll(600);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [resetCursor]);

  const clearSpeakers = useCallback(() => {
    resetCursor();
    holdScroll(600);
    setSelected(new Set());
  }, [resetCursor]);

  const seekTo = useCallback(
    (time: number) => {
      seek(time, { play: true });
      setFollow(true);
    },
    [seek],
  );

  // The map jumps there and brings the conversation along.
  const jump = useCallback(
    (time: number) => {
      if (canSeek) seek(time);
      setFollow(true);
      const item = itemForMoment(conversation.lines, items, time);
      if (item) scrollIntoView(`#item-${item.id}`);
    },
    [canSeek, conversation.lines, items, seek],
  );

  const step = useCallback(
    (delta: 1 | -1) => {
      if (!matches.length) return;
      const index = (matchIndex + delta + matches.length) % matches.length;
      setCursor({ key: searchKey, index });
      setFollow(false);
      scrollIntoView(`[data-match="${index}"]`);
    },
    [matchIndex, matches.length, searchKey],
  );

  const onQuery = useCallback(
    (value: string) => {
      setQuery(value);
      resetCursor();
      setFollow(false);
    },
    [resetCursor],
  );

  // A new search shows its first match.
  const firstMatch = matches.length ? 0 : null;
  useEffect(() => {
    if (firstMatch === null) return;
    scrollIntoView(`[data-match="${firstMatch}"]`);
  }, [searchKey, firstMatch]);

  // A link with ?t= opens the call at that moment, ready to play.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const moment = parseMoment(new URLSearchParams(window.location.search).get("t"));
    if (moment === null) return;
    if (canSeek) seek(moment, { play: false });
    const item = itemForMoment(conversation.lines, conversation.items, moment);
    if (!item) return;
    requestAnimationFrame(() => {
      setFlashId(item.id);
      scrollIntoView(`#item-${item.id}`, "auto");
    });
  }, [canSeek, conversation.items, conversation.lines, seek]);

  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), 2400);
    return () => clearTimeout(timer);
  }, [flashId]);

  // Follow along: keep what is being said in view, below the search bar, while it plays.
  useEffect(() => {
    if (!follow || !player.playing || !activeLine) return;
    const element = document.querySelector(`[data-line="${activeLine.id}"]`);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const top = (document.querySelector("[data-conversation-toolbar]")?.getBoundingClientRect().bottom ?? 200) + 8;
    if (rect.top < top || rect.bottom > window.innerHeight - 120) scrollElementIntoView(element);
  }, [activeLine, follow, player.playing]);

  // Scrolling by hand while it plays (wheel, touch, keys, scrollbar, find in page) stops following, until asked again.
  useEffect(() => {
    if (!player.playing) return;
    // Full screen, and the way in and out of it, move the page without anyone scrolling.
    const stop = () => {
      if (!document.fullscreenElement) setFollow(false);
    };
    const onScroll = () => {
      if (performance.now() > autoScrollUntil) stop();
    };
    // A resized window reflows the page the same way.
    const onFullscreen = () => holdScroll(1000);
    const onScrollEnd = () => {
      autoScrollUntil = Math.min(autoScrollUntil, performance.now());
    };
    const onKey = (event: KeyboardEvent) => {
      if (!["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      // Keys that move the map or edit text move nothing on the page.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=slider], [role=menu], dialog")) return;
      stop();
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", onScrollEnd);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFullscreen);
    window.addEventListener("resize", onFullscreen);
    return () => {
      window.removeEventListener("resize", onFullscreen);
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", onScrollEnd);
      window.removeEventListener("keydown", onKey);
    };
  }, [player.playing]);

  // "/" searches, as in most reading apps.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // On small screens a mini player takes over once the full one scrolls away.
  useEffect(() => {
    const element = transportRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setTransportVisible(entry?.isIntersecting ?? true), {
      rootMargin: `-${SHELL_HEADER_HEIGHT}px 0px 0px 0px`,
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [player.available]);

  const showCurrent = useCallback(() => {
    setFollow(true);
    if (!activeLine) return;
    const selector = `[data-line="${activeLine.id}"]`;
    if (scrollIntoView(selector)) return;
    // The people filter hides what is playing: show everyone again to get there.
    clearSpeakers();
    requestAnimationFrame(() => requestAnimationFrame(() => scrollIntoView(selector)));
  }, [activeLine, clearSpeakers]);

  const expiresAt =
    data.media.map((item) => item.expiresAt).find(Boolean) ?? data.recordings.map((item) => item.expiresAt).find(Boolean) ?? null;

  return (
    <div className="grid items-start gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className={cn("space-y-4 lg:sticky lg:-mx-1 lg:overflow-y-auto lg:px-1 lg:pb-4 lg:[scrollbar-width:thin]", ASIDE_TOP)}>
        <PlayerPanel
          activeLine={activeLine}
          conversation={conversation}
          currentMatch={currentMatch}
          matches={matches}
          onJump={jump}
          onToggleSpeaker={toggleSpeaker}
          player={player}
          selected={selected}
          transportRef={transportRef}
        />
        {!player.available ? <NoMedia expiresAt={expiresAt} /> : expiresAt ? <Expiry expiresAt={expiresAt} /> : null}
        {!conversation.seekable && player.available ? (
          <p className="text-[13px] text-ink-3">
            This call was recorded in {data.recordings.length} parts, so a time in the conversation doesn&apos;t play from there.
          </p>
        ) : null}
        {player.available ? (
          <p className="hidden text-xs text-ink-3 lg:block">
            <Key>Space</Key> plays or pauses · <Key>←</Key> <Key>→</Key> skip 5 s · <Key>/</Key> searches
          </p>
        ) : null}
        <AboutCall className="hidden lg:block" conversation={conversation} meeting={meeting} />
      </aside>

      <section aria-label="Conversation" className="min-w-0">
        <ConversationToolbar
          conversation={conversation}
          currentMatch={currentMatch}
          matches={matches}
          onClearSpeakers={clearSpeakers}
          onQuery={onQuery}
          onStep={step}
          onToggleSpeaker={toggleSpeaker}
          query={query}
          ref={searchRef}
          selected={selected}
        />
        <ConversationList
          activeLineId={activeLine?.id ?? null}
          canSeek={canSeek}
          conversation={conversation}
          currentMatch={currentMatch}
          flashId={flashId}
          items={items}
          matches={matches}
          onSeek={seekTo}
          emptyCopy={emptyCopy}
        />
        {player.playing && !follow && activeLine ? (
          // Sticks to the bottom of the conversation column, above the mini player on small screens.
          <div className={cn("pointer-events-none sticky z-30 flex justify-center pt-4", transportVisible ? "bottom-6" : "bottom-24 lg:bottom-6")}>
            <button
              className="pointer-events-auto inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-[13px] font-medium text-accent-ink shadow-pop transition-colors hover:bg-accent-hover"
              onClick={showCurrent}
              type="button"
            >
              <span aria-hidden className={cn("size-2 rounded-full", toneBg(conversation.speakerByKey.get(activeLine.speaker)?.tone ?? null))} />
              Back to what&apos;s playing
            </button>
          </div>
        ) : null}
        <AboutCall className="mt-8 lg:hidden" conversation={conversation} meeting={meeting} />
      </section>


      <MiniPlayer activeLine={activeLine} conversation={conversation} onShowCurrent={showCurrent} player={player} visible={!transportVisible} />
    </div>
  );
}

// Until when a scroll is the page's own (following, jumping, a search), so a scroll by hand can be told apart.
let autoScrollUntil = 0;

function holdScroll(ms: number) {
  autoScrollUntil = Math.max(autoScrollUntil, performance.now() + ms);
}

function scrollElementIntoView(element: Element, behavior: ScrollBehavior = "smooth") {
  const smooth = behavior === "smooth" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  autoScrollUntil = performance.now() + (smooth ? 1200 : 200);
  element.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
}

function scrollIntoView(selector: string, behavior: ScrollBehavior = "smooth") {
  const element = document.querySelector(selector);
  if (element) scrollElementIntoView(element, behavior);
  return element !== null;
}

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-line bg-surface px-1 font-sans text-[11px] text-ink-2">{children}</kbd>;
}

/** Why there is no player: the files are gone, or the call never had any. */
function NoMedia({ expiresAt }: { expiresAt: string | null }) {
  const [expired] = useState(() => expiresAt !== null && Date.parse(expiresAt) <= Date.now());
  return (
    <p className="flex items-start gap-2 text-[13px] text-ink-3">
      <VideoOff aria-hidden className="mt-0.5 shrink-0" size={14} />
      <span>
        {expired && expiresAt
          ? `The video and audio were kept until ${formatDate(expiresAt, true)} and are no longer available.`
          : "This call has no audio or video to play."}
      </span>
    </p>
  );
}

function Expiry({ expiresAt }: { expiresAt: string }) {
  const [soon] = useState(() => Date.parse(expiresAt) - Date.now() < 48 * 3600 * 1000);
  return (
    <p className={cn("flex items-start gap-2 text-[13px]", soon ? "text-warn" : "text-ink-3")}>
      <Clock aria-hidden className="mt-0.5 shrink-0" size={14} />
      <span>
        The video, audio and transcript are kept until {formatDate(expiresAt, true)}. Download them or use the call in Ravi before then.
      </span>
    </p>
  );
}

function AboutCall({ className, conversation, meeting }: { className?: string; conversation: Conversation; meeting: Meeting }) {
  return (
    <details className={cn("group rounded-lg border border-line bg-surface", className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        About this call
        <ChevronDown aria-hidden className="text-ink-3 transition-transform group-open:rotate-180" size={16} />
      </summary>
      <div className="border-t border-line px-4 pb-2">
        <PeopleList conversation={conversation} />
        <MeetingFacts meeting={meeting} />
      </div>
    </details>
  );
}

function PeopleList({ conversation }: { conversation: Conversation }) {
  if (!conversation.speakers.length) return null;
  return (
    <div className="border-b border-line py-3">
      <div className="mb-2 text-[13px] text-ink-3">People in the call</div>
      <ul className="space-y-2">
        {conversation.speakers.map((speaker) => (
          <li className="flex items-center gap-2.5 text-sm" key={speaker.key}>
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", toneBg(speaker.tone))} />
            <span className="min-w-0 flex-1 truncate text-ink">
              {speaker.name}
              {speaker.isHost ? <span className="text-ink-3"> · host</span> : null}
            </span>
            <span className="shrink-0 text-[13px] text-ink-3 tabular-nums">
              {speaker.lineCount
                ? `${formatDuration(speaker.talkSeconds) ?? "0 s"} · ${Math.max(1, Math.round(speaker.share * 100))}%`
                : speaker.chatCount
                  ? "only in the chat"
                  : "didn't speak"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The link `ravi meetings read` takes, on the Console the page is on. */
function meetingLink(meetingId: string) {
  const origin = typeof window === "undefined" ? "https://console.ravi.bot" : window.location.origin;
  return `${origin}/shared/meetings/${meetingId}`;
}

function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileName(meeting: Meeting) {
  const base = meetingTitle(meeting)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return base || "transcript";
}

function languageName(code: string) {
  if (code === "auto") return "Detected automatically";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
