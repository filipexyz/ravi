"use client";

import { ChevronDown, ChevronUp, Link2, MessageSquare, Search, X } from "lucide-react";
import { forwardRef, memo, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { IconButton } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { Input } from "@/ui/form";
import { Notice } from "@/ui/states";

import {
  findLinks,
  isSearchable,
  textRuns,
  type ChatItem,
  type Conversation,
  type ConversationItem,
  type SearchMatch,
  type Speaker,
  type TextRun,
  type TurnItem,
} from "./conversation";
import { formatClock } from "./format";
import { toneBg, toneSoft, toneText } from "./tones";

// The shell header (56 px bar, 40 px tabs over its 1 px border) stays on top while the page scrolls.
export const SHELL_HEADER_HEIGHT = 96;
const SHELL_HEADER_OFFSET = "top-[96px]";

type Ranges = Array<{ from: number; to: number; index: number }>;

/** Search and the people filter, kept on screen while the conversation scrolls. */
export const ConversationToolbar = forwardRef<
  HTMLInputElement,
  {
    conversation: Conversation;
    currentMatch: SearchMatch | null;
    matches: SearchMatch[];
    onClearSpeakers: () => void;
    onQuery: (value: string) => void;
    onStep: (delta: 1 | -1) => void;
    onToggleSpeaker: (key: string) => void;
    query: string;
    selected: ReadonlySet<string>;
  }
>(function ConversationToolbar(
  { conversation, currentMatch, matches, onClearSpeakers, onQuery, onStep, onToggleSpeaker, query, selected },
  ref,
) {
  const people = conversation.speakers.filter((speaker) => speaker.lineCount > 0 || speaker.chatCount > 0);
  const searching = isSearchable(query);
  const status = searching ? (matches.length ? `${(currentMatch?.index ?? 0) + 1} of ${matches.length}` : "No matches") : "";
  // The count and buttons sit inside the field, so the text stops where they begin.
  const controls = useRef<HTMLDivElement>(null);
  const [controlsWidth, setControlsWidth] = useState(0);
  const hasControls = query !== "";
  useEffect(() => {
    const element = controls.current;
    if (!hasControls || !element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setControlsWidth(element.offsetWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasControls]);
  return (
    <div
      className={cn(
        "sticky z-20 -mx-4 bg-canvas px-4 pt-1 pb-3 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0",
        SHELL_HEADER_OFFSET,
      )}
      data-conversation-toolbar
    >
      <span aria-live="polite" className="sr-only">
        {status}
      </span>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" size={16} />
        <Input
          aria-label="Search the conversation"
          className="pl-9 [&::-webkit-search-cancel-button]:hidden"
          enterKeyHint="search"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onStep(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              onQuery("");
            }
          }}
          placeholder="Search the conversation"
          ref={ref}
          style={hasControls && controlsWidth ? { paddingRight: controlsWidth + 8 } : undefined}
          type="search"
          value={query}
        />
        {hasControls ? (
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center" ref={controls}>
            {searching ? (
              <span aria-hidden className="px-1.5 text-xs whitespace-nowrap text-ink-3 tabular-nums">
                {status}
              </span>
            ) : null}
            {matches.length > 1 ? (
              <>
                <IconButton className="size-7" icon={ChevronUp} label="Previous match" onClick={() => onStep(-1)} size="sm" />
                <IconButton className="size-7" icon={ChevronDown} label="Next match" onClick={() => onStep(1)} size="sm" />
              </>
            ) : null}
            <IconButton className="size-7" icon={X} label="Clear the search" onClick={() => onQuery("")} size="sm" />
          </div>
        ) : null}
      </div>

      {people.length > 1 ? (
        <div aria-label="Show what each person said" className="-mx-1 mt-1 flex gap-1.5 overflow-x-auto p-1 [scrollbar-width:none] lg:flex-wrap" role="group">
          <Chip onClick={onClearSpeakers} pressed={selected.size === 0}>
            Everyone
          </Chip>
          {people.map((speaker) => (
            <Chip key={speaker.key} onClick={() => onToggleSpeaker(speaker.key)} pressed={selected.has(speaker.key)}>
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", toneBg(speaker.tone))} />
              <span className="max-w-36 truncate">{speaker.name}</span>
              <span className="text-ink-3">{speaker.lineCount ? `${Math.max(1, Math.round(speaker.share * 100))}%` : "chat"}</span>
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function Chip({ children, onClick, pressed }: { children: React.ReactNode; onClick: () => void; pressed: boolean }) {
  return (
    <button
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors",
        pressed ? "border-ink bg-ink text-canvas [&_.text-ink-3]:text-canvas/70" : "border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink",
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

/** The call as one list: turns by speaker, with chat messages where they were sent. */
export function ConversationList({
  activeLineId,
  canSeek,
  conversation,
  currentMatch,
  flashId,
  items,
  matches,
  emptyCopy,
  onSeek,
}: {
  activeLineId: string | null;
  canSeek: boolean;
  conversation: Conversation;
  currentMatch: SearchMatch | null;
  flashId: string | null;
  items: ConversationItem[];
  matches: SearchMatch[];
  /** What to say when there are no lines (`emptyTranscriptCopy`). */
  emptyCopy: { tone: "info" | "warn"; text: string } | null;
  onSeek: (time: number) => void;
}) {
  // Ranges per line (or per chat message), so each row only re-renders when its own hits change.
  const rangesByKey = useMemo(() => {
    const map = new Map<string, Ranges>();
    for (const match of matches) {
      for (const piece of match.pieces) {
        const key = piece.lineId ?? match.itemId;
        const list = map.get(key) ?? [];
        list.push({ from: piece.from, to: piece.to, index: match.index });
        map.set(key, list);
      }
    }
    return map;
  }, [matches]);
  const hasLines = conversation.lines.length > 0;

  return (
    <div className="space-y-3">
      {!hasLines && emptyCopy ? <Notice tone={emptyCopy.tone}>{emptyCopy.text}</Notice> : null}
      <ol aria-label="Conversation" className="space-y-1">
        {items.map((item) =>
          item.kind === "turn" ? (
            <TurnRow
              activeLineId={activeLineId !== null && item.lines.some((line) => line.id === activeLineId) ? activeLineId : null}
              canSeek={canSeek}
              currentMatch={currentMatch !== null && currentMatch.itemId === item.id ? currentMatch.index : null}
              flash={flashId === item.id}
              key={item.id}
              onSeek={onSeek}
              rangesByKey={rangesByKey}
              speaker={conversation.speakerByKey.get(item.speaker)}
              turn={item}
            />
          ) : (
            <ChatRow
              canSeek={canSeek}
              currentMatch={currentMatch !== null && currentMatch.itemId === item.id ? currentMatch.index : null}
              flash={flashId === item.id}
              item={item}
              key={item.id}
              onSeek={onSeek}
              ranges={rangesByKey.get(item.id)}
              speaker={conversation.speakerByKey.get(item.speaker)}
            />
          ),
        )}
      </ol>
    </div>
  );
}

const TurnRow = memo(function TurnRow({
  activeLineId,
  canSeek,
  currentMatch,
  flash,
  onSeek,
  rangesByKey,
  speaker,
  turn,
}: {
  activeLineId: string | null;
  canSeek: boolean;
  currentMatch: number | null;
  flash: boolean;
  onSeek: (time: number) => void;
  rangesByKey: Map<string, Ranges>;
  speaker: Speaker | undefined;
  turn: TurnItem;
}) {
  const name = speaker?.name ?? "Unknown speaker";
  const at = formatClock(turn.start);
  const active = activeLineId !== null;
  return (
    <li
      className={cn(
        "group relative scroll-my-48 rounded-lg py-2.5 pr-2 pl-12 transition-colors duration-300 sm:pr-3",
        active ? "bg-surface shadow-[0_0_0_1px_var(--rv-line)]" : null,
        flash ? "bg-warn-soft" : null,
      )}
      data-item={turn.id}
      id={`item-${turn.id}`}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-2.5 left-2.5 flex size-7 items-center justify-center rounded-full text-xs font-semibold",
          toneSoft(speaker?.tone ?? null),
          toneText(speaker?.tone ?? null),
        )}
      >
        {initials(name)}
      </span>
      <div className="flex min-h-7 items-center gap-2">
        <span className="truncate text-sm font-medium text-ink">{name}</span>
        {speaker?.isHost ? <span className="shrink-0 text-xs text-ink-3">host</span> : null}
        {at ? (
          canSeek && turn.start !== null ? (
            <button
              className="shrink-0 rounded font-mono text-xs text-ink-3 tabular-nums transition-colors hover:text-ink hover:underline"
              onClick={() => onSeek(turn.start!)}
              title={`Play from ${at}`}
              type="button"
            >
              {at}
            </button>
          ) : (
            <span className="shrink-0 font-mono text-xs text-ink-3 tabular-nums">{at}</span>
          )
        ) : null}
        <MomentActions start={turn.start} text={`${name}${at ? ` (${at})` : ""}: ${turn.lines.map((line) => line.text).join(" ")}`} />
      </div>
      <p className="text-[15px] leading-relaxed text-ink-2">
        {turn.lines.map((line) => {
          const isActive = line.id === activeLineId;
          return (
            <span key={line.id}>
              <span
                className={cn(
                  "rounded-sm box-decoration-clone transition-colors",
                  canSeek && line.start !== null && "cursor-pointer hover:bg-hover hover:text-ink",
                  isActive && "bg-ok-soft text-ink",
                )}
                data-line={line.id}
                onClick={() => {
                  // Selecting text to copy shouldn't jump the recording.
                  if (!canSeek || line.start === null || !window.getSelection()?.isCollapsed) return;
                  onSeek(line.start);
                }}
              >
                <Highlighted currentMatch={currentMatch} ranges={rangesByKey.get(line.id)} text={line.text} />
              </span>{" "}
            </span>
          );
        })}
      </p>
    </li>
  );
});

const ChatRow = memo(function ChatRow({
  canSeek,
  currentMatch,
  flash,
  item,
  onSeek,
  ranges,
  speaker,
}: {
  canSeek: boolean;
  currentMatch: number | null;
  flash: boolean;
  item: ChatItem;
  onSeek: (time: number) => void;
  ranges: Ranges | undefined;
  speaker: Speaker | undefined;
}) {
  const name = speaker?.name ?? "Someone";
  const at = formatClock(item.at);
  return (
    <li className="scroll-my-48 py-1 pr-2 pl-12" data-item={item.id} id={`item-${item.id}`}>
      <div
        className={cn(
          "inline-block max-w-full rounded-lg border border-line bg-surface px-3 py-2 transition-colors duration-300",
          flash && "bg-warn-soft",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-3">
          <MessageSquare aria-hidden size={12} />
          <span className="font-medium text-ink-2">{name}</span>
          <span>{item.toEveryone ? "in the chat" : "in a private message"}</span>
          {at ? (
            canSeek && item.at !== null ? (
              <button className="font-mono tabular-nums hover:text-ink hover:underline" onClick={() => onSeek(item.at!)} title={`Play from ${at}`} type="button">
                {at}
              </button>
            ) : (
              <span className="font-mono tabular-nums">{at}</span>
            )
          ) : null}
        </div>
        <p className="mt-0.5 text-sm break-words whitespace-pre-wrap text-ink">
          <Highlighted currentMatch={currentMatch} links ranges={ranges} text={item.text} />
        </p>
      </div>
    </li>
  );
});

/** Copy a link that opens the call at this moment, or the turn as text. Shown on hover where there is hover. */
function MomentActions({ start, text }: { start: number | null; text: string }) {
  const link = useMemo(() => {
    if (start === null || typeof window === "undefined") return null;
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    // Rounded up, so the link opens inside this turn rather than at the end of the one before.
    url.searchParams.set("t", String(Math.ceil(start * 10) / 10));
    return url.toString();
  }, [start]);
  return (
    <div className="ml-auto hidden shrink-0 items-center transition-opacity group-focus-within:opacity-100 sm:flex [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
      {link ? <CopyButton className="size-7" icon={Link2} label="Copy a link to this moment" value={link} /> : null}
      <CopyButton className="size-7" label="Copy what was said" value={text} />
    </div>
  );
}

function Highlighted({
  currentMatch,
  links = false,
  ranges,
  text,
}: {
  currentMatch: number | null;
  links?: boolean;
  ranges: Ranges | undefined;
  text: string;
}) {
  const linked = links ? findLinks(text) : [];
  if (!ranges?.length && !linked.length) return <>{text}</>;
  // Links people pasted in the chat open in a new tab, whole, with any search match inside them.
  const groups: Array<{ href: string | null; runs: TextRun[] }> = [];
  for (const run of textRuns(text, ranges ?? [], linked)) {
    const last = groups.at(-1);
    if (last && run.href !== null && last.href === run.href) last.runs.push(run);
    else groups.push({ href: run.href, runs: [run] });
  }
  const render = (run: TextRun, key: string) =>
    run.match === null ? (
      <span key={key}>{run.text}</span>
    ) : (
      <mark
        className={cn("rounded-sm", run.match === currentMatch ? "bg-warn text-canvas" : "bg-warn-soft text-ink")}
        data-match={run.match}
        key={key}
      >
        {run.text}
      </mark>
    );
  return (
    <>
      {groups.flatMap((group, index) =>
        group.href === null
          ? group.runs.map((run, at) => render(run, `${index}-${at}`))
          : [
              <a className="text-info underline underline-offset-2" href={group.href} key={index} rel="noreferrer nofollow" target="_blank">
                {group.runs.map((run, at) => render(run, String(at)))}
              </a>,
            ],
      )}
    </>
  );
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return ((words[0]![0] ?? "") + (words.length > 1 ? (words.at(-1)![0] ?? "") : "")).toUpperCase();
}
