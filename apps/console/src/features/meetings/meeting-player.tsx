"use client";

import { Maximize, MessageSquare, Pause, Play, RotateCcw, RotateCw, Video, VideoOff } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { Button, IconButton } from "@/ui/button";
import { Notice } from "@/ui/states";

import type { ChatItem, Conversation, SearchMatch, Speaker, TimedLine } from "./conversation";
import { formatClock } from "./format";
import { PLAYBACK_RATES, type MeetingPlayer } from "./player";
import { toneBg } from "./tones";

/** The picture (or nothing, for audio), the transport and the conversation map, in one block. */
export function PlayerPanel({
  activeLine,
  conversation,
  currentMatch,
  matches,
  onJump,
  onToggleSpeaker,
  player,
  selected,
  transportRef,
}: {
  activeLine: TimedLine | null;
  conversation: Conversation;
  currentMatch: SearchMatch | null;
  matches: SearchMatch[];
  onJump: (time: number) => void;
  onToggleSpeaker: (key: string) => void;
  player: MeetingPlayer;
  selected: ReadonlySet<string>;
  transportRef?: React.Ref<HTMLDivElement>;
}) {
  const speaker = activeLine ? (conversation.speakerByKey.get(activeLine.speaker) ?? null) : null;
  const hasMap = conversation.lines.length > 0 || conversation.items.some((item) => item.kind === "chat" && item.at !== null);
  if (!player.available && !hasMap) return null;
  return (
    <div className="space-y-3">
      {player.failed ? (
        <div role="alert">
          <Notice tone="warn" title="The recording couldn't be played">
            <p>It may have expired, or the connection dropped while it loaded.</p>
            <Button className="mt-2" onClick={player.retry} size="sm" variant="secondary">
              Try again
            </Button>
          </Notice>
        </div>
      ) : player.available && player.kind === "video" ? (
        <VideoSurface player={player} />
      ) : player.mediaProps ? (
        <audio {...player.mediaProps} className="hidden" key={player.mediaKey} />
      ) : null}

      <div className="rounded-lg border border-line bg-surface px-3 pt-2.5 pb-3">
        {player.available && !player.failed ? (
          <Transport player={player} ref={transportRef} speaker={player.time > 0 || player.playing ? speaker : null} />
        ) : null}
        {hasMap ? (
          <ConversationMap
            className={player.available ? "mt-3" : undefined}
            conversation={conversation}
            currentMatch={currentMatch}
            duration={player.available ? player.duration : conversation.duration}
            matches={matches}
            onJump={onJump}
            onToggleSpeaker={onToggleSpeaker}
            playing={player.playing}
            selected={selected}
            // Where the clock can't be trusted the map is its own cursor through the conversation.
            time={player.available && conversation.seekable ? player.time : null}
          />
        ) : null}
      </div>
    </div>
  );
}

function VideoSurface({ player }: { player: MeetingPlayer }) {
  const frame = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Only a full screen entered from the keyboard hands focus back to its button on the way out.
  const fromKeyboard = useRef(false);
  useEffect(() => {
    const onChange = () => {
      const now = document.fullscreenElement === frame.current && frame.current !== null;
      setFullscreen(now);
      // Leaving full screen puts focus back where it was, instead of on the page.
      if (!now && fromKeyboard.current && (document.activeElement === document.body || document.activeElement === null)) {
        requestAnimationFrame(() => fullscreenButton.current?.focus({ preventScroll: true }));
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const enterFullscreen = (event: React.MouseEvent) => {
    fromKeyboard.current = event.detail === 0;
    const target = frame.current;
    if (target?.requestFullscreen) {
      void target.requestFullscreen().catch(() => {});
      return;
    }
    // iPhone Safari only lets the video itself go full screen.
    const video = target?.querySelector("video") as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    video?.webkitEnterFullscreen?.();
  };

  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border border-line bg-black" ref={frame}>
      <video
        {...player.mediaProps}
        className="size-full"
        controls={fullscreen}
        data-fullscreen-target
        key={player.mediaKey}
        // In full screen the browser's own controls handle clicks.
        onClick={fullscreen ? undefined : player.toggle}
      />
      {!player.playing && !fullscreen ? (
        <button
          aria-label="Play"
          className="absolute inset-0 m-auto flex size-14 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-transform hover:scale-105"
          onClick={player.toggle}
          type="button"
        >
          <Play aria-hidden className="translate-x-px" fill="currentColor" size={22} />
        </button>
      ) : null}
      <IconButton
        className={cn("absolute right-2 bottom-2 bg-black/45 text-white hover:bg-black/65 hover:text-white", fullscreen && "hidden")}
        icon={Maximize}
        label="Full screen"
        onClick={enterFullscreen}
        ref={fullscreenButton}
        size="sm"
      />
    </div>
  );
}

function Transport({ player, ref, speaker }: { player: MeetingPlayer; ref?: React.Ref<HTMLDivElement>; speaker: Speaker | null }) {
  const nextRate = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(player.rate as (typeof PLAYBACK_RATES)[number]) + 1) % PLAYBACK_RATES.length]!;
  return (
    <div className="flex items-center gap-1" ref={ref}>
      <PlayButton player={player} />
      <IconButton icon={RotateCcw} label="Back 10 seconds" onClick={() => player.skip(-10)} size="sm" />
      <IconButton icon={RotateCw} label="Forward 10 seconds" onClick={() => player.skip(10)} size="sm" />
      <div className="ml-1 min-w-0 flex-1">
        <div className="font-mono text-[13px] text-ink tabular-nums">
          {formatClock(player.time) ?? "00:00"}
          <span className="text-ink-3"> / {formatClock(player.duration) ?? "--:--"}</span>
        </div>
        <div aria-live="off" className="flex h-4 min-w-0 items-center gap-1.5 text-xs text-ink-3">
          {speaker ? (
            <>
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneBg(speaker.tone))} />
              <span className="truncate">{speaker.name}</span>
            </>
          ) : null}
        </div>
      </div>
      <button
        aria-label={`Playback speed ${player.rate}×, change to ${nextRate}×`}
        className="h-8 min-w-11 rounded-md px-2 font-mono text-[13px] font-medium text-ink-2 tabular-nums transition-colors hover:bg-hover hover:text-ink"
        onClick={() => player.setRate(nextRate)}
        title="Playback speed"
        type="button"
      >
        {player.rate}×
      </button>
      {player.canSwitchKind ? (
        <IconButton
          icon={player.kind === "video" ? VideoOff : Video}
          label={player.kind === "video" ? "Audio only" : "Show the video"}
          onClick={() => player.setKind(player.kind === "video" ? "audio" : "video")}
          size="sm"
        />
      ) : null}
    </div>
  );
}

function PlayButton({ className, player }: { className?: string; player: MeetingPlayer }) {
  const Icon = player.playing ? Pause : Play;
  return (
    <button
      aria-label={player.playing ? "Pause" : "Play"}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-colors hover:bg-accent-hover",
        className,
      )}
      onClick={player.toggle}
      title={player.playing ? "Pause (space)" : "Play (space)"}
      type="button"
    >
      <Icon aria-hidden className={player.playing ? undefined : "translate-x-px"} fill="currentColor" size={15} />
    </button>
  );
}

const MAX_LANES = 8;

/**
 * Who spoke when, one lane per person, with the chat and search hits on top.
 * It is the scrubber too: pointing at it shows the moment, selecting it jumps there.
 */
function ConversationMap({
  className,
  conversation,
  currentMatch,
  duration,
  matches,
  onJump,
  onToggleSpeaker,
  playing,
  selected,
  time,
}: {
  className?: string;
  conversation: Conversation;
  currentMatch: SearchMatch | null;
  duration: number;
  matches: SearchMatch[];
  onJump: (time: number) => void;
  onToggleSpeaker: (key: string) => void;
  playing: boolean;
  selected: ReadonlySet<string>;
  time: number | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDraggingState] = useState<number | null>(null);
  // The drag lives in a ref too, so a flick whose events land before a render still ends it.
  const drag = useRef<number | null>(null);
  const setDragging = (value: number | null) => {
    drag.current = value;
    setDraggingState(value);
  };
  // Without a player the map still moves through the conversation, from where it last pointed.
  const [aim, setAim] = useState<number | null>(null);
  // A touch waits to see whether it is a tap, a drag along the map, or a scroll of the page.
  const press = useRef<{ id: number; x: number; y: number } | null>(null);
  const span = Math.max(duration, 1);
  const now = time ?? aim ?? 0;
  const jumpTo = (value: number) => {
    const next = Math.min(span, Math.max(0, value));
    setAim(next);
    onJump(next);
  };
  const pct = (value: number) => `${Math.min(100, Math.max(0, (value / span) * 100))}%`;

  const { chats, laneCount, laneOf, lanes, others } = useMemo(() => {
    const speakers = conversation.speakers.filter((speaker) => speaker.tone !== null);
    const lanes = speakers.slice(0, MAX_LANES);
    const others = speakers.slice(MAX_LANES);
    const laneOf = new Map<string, number>();
    lanes.forEach((speaker, index) => laneOf.set(speaker.key, index));
    others.forEach((speaker) => laneOf.set(speaker.key, MAX_LANES));
    const chats = conversation.items.filter((item): item is ChatItem => item.kind === "chat" && item.at !== null);
    return { chats, laneCount: lanes.length + (others.length ? 1 : 0), laneOf, lanes, others };
  }, [conversation]);

  const timeAt = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * span;
  };
  const shown = dragging ?? hover;
  const hoverLine = shown !== null ? speakerAt(conversation, shown) : null;
  const filtering = selected.size > 0;

  if (!conversation.lines.length && !chats.length && time === null) return null;

  return (
    <div className={cn("flex gap-2", className)}>
      <div className="flex w-[76px] shrink-0 flex-col gap-1.5 pt-px">
        {lanes.map((speaker) => (
          <LaneLabel
            active={!filtering || selected.has(speaker.key)}
            key={speaker.key}
            label={speaker.name}
            onClick={() => onToggleSpeaker(speaker.key)}
            pressed={selected.has(speaker.key)}
          />
        ))}
        {others.length ? <LaneLabel active label={`${others.length} more`} /> : null}
        {chats.length ? <LaneLabel active label="Chat" /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div
          aria-label="Moment in the call"
          aria-valuemax={Math.round(span)}
          aria-valuemin={0}
          aria-valuenow={Math.round(now)}
          aria-valuetext={formatClock(now) ?? undefined}
          className="relative cursor-pointer touch-pan-y rounded outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onKeyDown={(event) => {
            const step = event.shiftKey ? 30 : 5;
            const moves: Record<string, number> = {
              ArrowRight: now + step,
              ArrowUp: now + step,
              ArrowLeft: now - step,
              ArrowDown: now - step,
              PageUp: now + 30,
              PageDown: now - 30,
              Home: 0,
              End: span,
            };
            const next = moves[event.key];
            if (next === undefined) return;
            event.preventDefault();
            jumpTo(next);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if (event.pointerType === "touch") {
              press.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(timeAt(event.clientX));
          }}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(event) => {
            const at = timeAt(event.clientX);
            const touch = press.current;
            if (touch && touch.id === event.pointerId && drag.current === null) {
              // Sideways is a drag along the map; up and down is left to the page to scroll.
              const dx = Math.abs(event.clientX - touch.x);
              if (dx > 8 && dx > Math.abs(event.clientY - touch.y)) {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(at);
              }
              return;
            }
            if (drag.current !== null) setDragging(at);
            else if (event.pointerType === "mouse") setHover(at);
          }}
          onPointerUp={(event) => {
            const touch = press.current;
            press.current = null;
            const wasDragging = drag.current !== null;
            setDragging(null);
            if (wasDragging || (touch && touch.id === event.pointerId)) jumpTo(timeAt(event.clientX));
          }}
          onPointerCancel={() => {
            press.current = null;
            setDragging(null);
          }}
          ref={track}
          role="slider"
          tabIndex={0}
        >
          <MapLanes chats={chats} conversation={conversation} laneCount={laneCount} laneOf={laneOf} selected={selected} span={span} />

          {matches.map((match) =>
            match.time !== null ? (
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full",
                  match.index === currentMatch?.index ? "bg-warn" : "bg-warn/45",
                )}
                key={match.index}
                style={{ left: pct(match.time) }}
              />
            ) : null,
          )}

          {time !== null ? (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute -top-1.5 -bottom-1.5 w-0.5 -translate-x-1/2 rounded-full bg-ink",
                playing && dragging === null && "transition-[left] duration-300 ease-linear",
              )}
              style={{ left: pct(dragging ?? time) }}
            >
              <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-ink" />
            </span>
          ) : null}

          {shown !== null ? (
            <>
              <span
                aria-hidden
                className="pointer-events-none absolute -top-1 -bottom-1 w-px -translate-x-1/2 bg-ink-3"
                style={{ left: pct(shown) }}
              />
              <span
                className={cn(
                  "pointer-events-none absolute top-full z-10 mt-2 flex max-w-56 items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap text-ink shadow-pop",
                  shown / span > 0.6 ? "-translate-x-full" : shown / span > 0.3 ? "-translate-x-1/2" : null,
                )}
                style={{ left: pct(shown) }}
              >
                <span className="font-mono tabular-nums">{formatClock(shown)}</span>
                {hoverLine ? (
                  <>
                    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneBg(hoverLine.tone))} />
                    <span className="truncate text-ink-2">{hoverLine.name}</span>
                  </>
                ) : null}
              </span>
            </>
          ) : null}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-ink-3 tabular-nums">
          <span>00:00</span>
          <span>{formatClock(span)}</span>
        </div>
      </div>
    </div>
  );
}

/** The bars, drawn once per conversation and filter rather than on every tick of the player. */
const MapLanes = memo(function MapLanes({
  chats,
  conversation,
  laneCount,
  laneOf,
  selected,
  span,
}: {
  chats: ChatItem[];
  conversation: Conversation;
  laneCount: number;
  laneOf: Map<string, number>;
  selected: ReadonlySet<string>;
  span: number;
}) {
  const pct = (value: number) => `${Math.min(100, Math.max(0, (value / span) * 100))}%`;
  const filtering = selected.size > 0;
  return (
    <div className="flex flex-col gap-1.5 py-px">
      {Array.from({ length: laneCount }, (_, lane) => (
        <div className="relative h-2.5 overflow-hidden rounded-full bg-sunken" key={lane}>
          {conversation.lines.map((line) => {
            if (laneOf.get(line.speaker) !== lane || line.start === null) return null;
            const tone = conversation.speakerByKey.get(line.speaker)?.tone ?? null;
            const end = line.end ?? line.start + 2;
            return (
              <span
                className={cn(
                  "absolute inset-y-0 min-w-[2px] rounded-full transition-opacity",
                  toneBg(tone),
                  filtering && !selected.has(line.speaker) && "opacity-25",
                )}
                key={line.id}
                style={{ left: pct(line.start), width: `calc(${pct(end - line.start)} + 1px)` }}
              />
            );
          })}
        </div>
      ))}
      {chats.length ? (
        <div className="relative h-2.5">
          {chats.map((item) =>
            item.at !== null ? (
              <span
                className={cn(
                  "absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-3",
                  filtering && !selected.has(item.speaker) && "opacity-25",
                )}
                key={item.id}
                style={{ left: pct(item.at) }}
              />
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
});

function LaneLabel({ active, label, onClick, pressed }: { active: boolean; label: string; onClick?: () => void; pressed?: boolean }) {
  const first = label.split(/\s+/)[0] ?? label;
  // The row is as tall as its bar; the text line is taller and overflows it, so accents and descenders aren't cut.
  const className = cn("flex h-2.5 min-w-0 items-center text-left text-[11px] transition-colors", active ? "text-ink-2" : "text-ink-3");
  if (!onClick) {
    return (
      <span className={className}>
        <span className="truncate leading-[14px]">
          {label === "Chat" ? <MessageSquare aria-hidden className="mr-1 inline" size={10} /> : null}
          {label}
        </span>
      </span>
    );
  }
  return (
    <button
      aria-label={`Show what ${label} said`}
      aria-pressed={pressed}
      className={cn(className, "hover:text-ink")}
      onClick={onClick}
      title={label}
      type="button"
    >
      <span className="truncate leading-[14px]">{first}</span>
    </button>
  );
}

function speakerAt(conversation: Conversation, time: number) {
  for (const line of conversation.lines) {
    if (line.start === null || line.start > time) continue;
    const end = line.end ?? line.start + 2;
    if (time <= end) return conversation.speakerByKey.get(line.speaker) ?? null;
  }
  return null;
}

/** On small screens, keeps play, time and who is speaking at hand once the player scrolls away. */
export function MiniPlayer({
  activeLine,
  conversation,
  onShowCurrent,
  player,
  visible,
}: {
  activeLine: TimedLine | null;
  conversation: Conversation;
  onShowCurrent: () => void;
  player: MeetingPlayer;
  visible: boolean;
}) {
  if (!player.available || player.failed) return null;
  const speaker = activeLine ? conversation.speakerByKey.get(activeLine.speaker) : null;
  const progress = player.duration ? Math.min(100, (player.time / player.duration) * 100) : 0;
  return (
    <div
      aria-hidden={!visible}
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-pop backdrop-blur transition-transform duration-200 lg:hidden",
        visible ? "translate-y-0" : "pointer-events-none translate-y-full",
      )}
      inert={!visible}
    >
      <div className="h-0.5 bg-sunken">
        <div className="h-full bg-ink" style={{ width: `${progress}%` }} />
      </div>
      <div className="flex items-center gap-2.5 px-4 py-2">
        <PlayButton player={player} />
        <button className="min-w-0 flex-1 text-left" onClick={onShowCurrent} type="button">
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <span className="font-mono tabular-nums">{formatClock(player.time) ?? "00:00"}</span>
            {speaker ? (
              <>
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneBg(speaker.tone))} />
                <span className="truncate">{speaker.name}</span>
              </>
            ) : null}
          </span>
          <span className="block truncate text-[13px] text-ink">{activeLine?.text ?? "Play to follow the conversation"}</span>
        </button>
        <IconButton icon={RotateCcw} label="Back 10 seconds" onClick={() => player.skip(-10)} size="sm" />
      </div>
    </div>
  );
}
