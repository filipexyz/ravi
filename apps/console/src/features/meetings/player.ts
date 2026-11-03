"use client";

// Plays a recorded call on the call's own clock. A recording can come in
// parts; the player switches parts when a seek lands in another one and moves
// on to the next part when one ends, so callers only ever see call time.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { inlineMediaPath } from "./api";
import { locate, type RecordingPart } from "./conversation";
import type { MeetingRecording } from "./types";

export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2] as const;

export type MediaKind = "video" | "audio";

export type MeetingPlayer = ReturnType<typeof useMeetingPlayer>;

export function useMeetingPlayer({
  fallbackDuration,
  media,
  parts,
  placed = true,
}: {
  fallbackDuration: number;
  media: MeetingRecording["media"];
  parts: RecordingPart[];
  /** False when the parts' places on the call clock are estimates; skipping then stays inside the part playing. */
  placed?: boolean;
}) {
  // Only parts with a file can play, so a seek never lands in a part without one.
  const playable = useMemo(() => parts.filter((candidate) => media.some((item) => item.part === candidate.index)), [media, parts]);
  const [kind, setKindState] = useState<MediaKind>(() => (media.some((item) => item.kind === "video") ? "video" : "audio"));
  const [part, setPart] = useState(() => playable[0]?.index ?? 0);
  const [playing, setPlaying] = useState(false);
  const [time, setTimeState] = useState(0);
  const [rate, setRateState] = useState<number>(1);
  const [durations, setDurations] = useState<Record<number, number>>({});
  // A file that failed to load, and how many times it was retried (a retry remounts the element).
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const element = useRef<HTMLMediaElement | null>(null);
  const timeRef = useRef(0);
  // A seek or a switch waits here until the new source has loaded.
  const pending = useRef<{ local: number; play: boolean } | null>(null);

  const source =
    media.find((item) => item.kind === kind && item.part === part) ?? media.find((item) => item.part === part) ?? null;
  const offset = parts.find((candidate) => candidate.index === part)?.offset ?? 0;
  const mediaKey = source ? `${source.kind}-${source.part}-${attempt}` : "none";
  const failed = source !== null && failedKey === mediaKey;
  const canSwitchKind =
    media.some((item) => item.part === part && item.kind === "video") && media.some((item) => item.part === part && item.kind === "audio");
  // One part: the file knows its length. Several: the last part's end, or the transcript's.
  const last = parts.at(-1);
  const duration =
    parts.length <= 1
      ? (durations[0] ?? fallbackDuration)
      : Math.max(last ? last.offset + (durations[last.index] ?? last.duration ?? 0) : 0, fallbackDuration);

  const setTime = useCallback((value: number) => {
    timeRef.current = value;
    setTimeState(value);
  }, []);

  const play = useCallback((target: HTMLMediaElement) => {
    void target.play().catch(() => setPlaying(false));
  }, []);

  const seek = useCallback(
    (to: number, options: { play?: boolean } = {}) => {
      const target = element.current;
      let clamped = Math.max(0, duration ? Math.min(to, duration) : to);
      let spot = locate(playable, clamped);
      // A moment between two parts, or past the end of one, plays from the start of the next part.
      const at = playable.findIndex((candidate) => candidate.index === spot.part);
      const here = playable[at];
      const length = here ? (durations[here.index] ?? here.duration) : null;
      const next = playable[at + 1];
      if (next && length !== null && spot.local >= length - 0.05) {
        spot = { part: next.index, local: 0 };
        clamped = next.offset;
      }
      setTime(clamped);
      const shouldPlay = options.play ?? pending.current?.play ?? (target ? !target.paused : false);
      if (!target || spot.part !== part || target.readyState < 1) {
        pending.current = { local: spot.local, play: shouldPlay };
        if (spot.part !== part) setPart(spot.part);
        // A file that failed stays still until a retry, or until the seek moves to another part.
        setPlaying(shouldPlay && (spot.part !== part || !failed));
        return;
      }
      target.currentTime = spot.local;
      if (shouldPlay) play(target);
    },
    [duration, durations, failed, part, play, playable, setTime],
  );

  const toggle = useCallback(() => {
    const target = element.current;
    if (!target) return;
    // While a file loads, the choice waits with the seek. Playing starts the load inside the
    // click, since some browsers (iPhone, data saver) load nothing until a person asks to play.
    const waiting = pending.current;
    if (waiting) {
      const next = !playing;
      waiting.play = next;
      setPlaying(next);
      if (next) play(target);
      else target.pause();
      return;
    }
    if (!target.paused) {
      target.pause();
      return;
    }
    // Once the last part has ended, playing starts the call over rather than that part.
    if (target.ended && playable.length > 1 && part === playable.at(-1)?.index) seek(0, { play: true });
    else play(target);
  }, [part, play, playable, playing, seek]);

  const skip = useCallback(
    (delta: number) => {
      const target = element.current;
      // Where parts sit on the clock is only estimated, so a skip can't tell which part a moment is in.
      if (!placed && target && !pending.current) {
        const end = Number.isFinite(target.duration) ? target.duration : Infinity;
        target.currentTime = Math.min(end, Math.max(0, target.currentTime + delta));
        setTime(offset + target.currentTime);
        return;
      }
      seek(timeRef.current + delta);
    },
    [offset, placed, seek, setTime],
  );

  const setRate = useCallback((value: number) => {
    setRateState(value);
    if (element.current) element.current.playbackRate = value;
  }, []);

  const setKind = useCallback(
    (value: MediaKind) => {
      // Only a part that has the other file switches; anything else would wait for a load that never comes.
      if (source?.kind === value || !media.some((item) => item.kind === value && item.part === part)) return;
      const target = element.current;
      if (target) pending.current = { local: target.currentTime, play: !target.paused };
      setKindState(value);
    },
    [media, part, source?.kind],
  );

  const retry = useCallback(() => {
    pending.current ??= { local: Math.max(0, timeRef.current - offset), play: false };
    setFailedKey(null);
    setAttempt((value) => value + 1);
  }, [offset]);

  // Space, the arrows, "j", "k" and "l" drive the player, except while typing, in a menu or under a dialog.
  useEffect(() => {
    if (!source || failed) return;
    // Controls focused by a click or a tap give Space back to the player; ones reached with the keyboard keep it.
    const pointerFocused = new WeakSet<EventTarget>();
    let pointerAt = 0;
    const onPointerDown = () => {
      pointerAt = performance.now();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!event.target) return;
      if (performance.now() - pointerAt < 500) pointerFocused.add(event.target);
      else pointerFocused.delete(event.target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const toggleKey = event.key === " " || event.key === "k";
      const back = event.key === "ArrowLeft" || event.key === "j";
      const forward = event.key === "ArrowRight" || event.key === "l";
      if (!toggleKey && !back && !forward) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=menu], [role=menuitem], [role=dialog], dialog")) return;
      if (document.querySelector("dialog[open]")) return;
      const control = target?.closest("button, a, summary, [role=button]");
      if (event.key === " " && control && !pointerFocused.has(control)) return;
      event.preventDefault();
      if (toggleKey) {
        if (!event.repeat) toggle();
      } else skip(event.key === "j" ? -10 : event.key === "l" ? 10 : back ? -5 : 5);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [failed, skip, source, toggle]);

  const mediaProps = source
    ? {
        preload: "metadata" as const,
        playsInline: true,
        // The fragment makes browsers load and show the first frame instead of a black box.
        src: `${inlineMediaPath(source.path)}${source.kind === "video" ? "#t=0.001" : ""}`,
        ref: (target: HTMLMediaElement | null) => {
          element.current = target;
        },
        onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => {
          const target = event.currentTarget;
          target.playbackRate = rate;
          if (Number.isFinite(target.duration)) setDurations((value) => ({ ...value, [part]: target.duration }));
          const next = pending.current;
          pending.current = null;
          if (next) {
            target.currentTime = next.local;
            if (next.play) play(target);
          }
        },
        onTimeUpdate: (event: React.SyntheticEvent<HTMLMediaElement>) => {
          if (!pending.current) setTime(offset + event.currentTarget.currentTime);
        },
        onPlay: () => setPlaying(true),
        onPause: () => setPlaying(false),
        onEnded: () => {
          const next = playable[playable.findIndex((candidate) => candidate.index === part) + 1];
          if (next) {
            pending.current = { local: 0, play: true };
            setPart(next.index);
            setTime(next.offset);
            setPlaying(true);
          } else setPlaying(false);
        },
        onError: () => {
          // A retry, or a seek into another part, picks up from where this file stopped.
          pending.current = { local: Math.max(0, timeRef.current - offset), play: false };
          setPlaying(false);
          setFailedKey(mediaKey);
        },
      }
    : null;

  return {
    available: source !== null,
    canSwitchKind,
    duration,
    failed,
    kind: source?.kind ?? kind,
    /** Remounts the element when the file changes. */
    mediaKey,
    mediaProps,
    playing,
    rate,
    retry,
    seek,
    setKind,
    setRate,
    skip,
    time,
    toggle,
    videoElement: () => (element.current instanceof HTMLVideoElement ? element.current : null),
  };
}
