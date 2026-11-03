"use client";

import { useSyncExternalStore } from "react";

function toDate(input: number | string | Date) {
  return input instanceof Date ? input : new Date(input);
}

export function formatRelative(input: number | string | Date | null | undefined, now = Date.now()) {
  if (input === null || input === undefined || input === "") return "never";
  const date = toDate(input);
  const time = date.getTime();
  if (Number.isNaN(time)) return "unknown";
  const diff = now - time;
  const future = diff < 0;
  const seconds = Math.abs(diff) / 1000;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  let text: string;
  if (seconds < 45) return "just now";
  if (minutes < 60) text = `${minutes} min`;
  else if (hours < 24) text = `${hours} h`;
  else if (days < 30) text = `${days} d`;
  else return formatDate(date);
  return future ? `in ${text}` : `${text} ago`;
}

export function formatDate(input: number | string | Date, withTime = false) {
  const date = toDate(input);
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

// One shared clock, re-read every minute. The snapshot is rounded so React sees a stable value between ticks.
function subscribeToClock(onChange: () => void) {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}
const readClock = () => Math.floor(Date.now() / 15_000) * 15_000;
const readServerClock = () => null;

/** "3 h ago", with the exact date on hover. Renders the date until hydrated to avoid a mismatch. */
export function RelativeTime({ className, value }: { className?: string; value: number | string | Date | null | undefined }) {
  const now = useSyncExternalStore(subscribeToClock, readClock, readServerClock);
  if (value === null || value === undefined || value === "") return <span className={className}>never</span>;
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return <span className={className}>unknown</span>;
  return (
    <time className={className} dateTime={date.toISOString()} title={formatDate(date, true)}>
      {now === null ? formatDate(date) : formatRelative(date, now)}
    </time>
  );
}
