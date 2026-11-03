"use client";

import { useSyncExternalStore } from "react";

import { LOCALE } from "./format";

// PT-BR relative times for the Bases screen ("há 3 h", with the exact date on
// hover). Same clock and hydration rules as `RelativeTime` in `@/ui/time`.

function toDate(input: number | string | Date) {
  return input instanceof Date ? input : new Date(input);
}

export function formatDatePt(input: number | string | Date, withTime = false) {
  const date = toDate(input);
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

export function formatRelativePt(input: number | string | Date, now = Date.now()) {
  const date = toDate(input);
  const time = date.getTime();
  if (Number.isNaN(time)) return "data desconhecida";
  const diff = now - time;
  const future = diff < 0;
  const seconds = Math.abs(diff) / 1000;
  const minutes = Math.max(1, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  let text: string;
  if (seconds < 45) return "agora";
  if (minutes < 60) text = `${minutes} min`;
  else if (hours < 24) text = `${hours} h`;
  else if (days < 30) text = `${days} ${days === 1 ? "dia" : "dias"}`;
  else return formatDatePt(date);
  return future ? `em ${text}` : `há ${text}`;
}

function subscribeToClock(onChange: () => void) {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}
const readClock = () => Math.floor(Date.now() / 15_000) * 15_000;
const readServerClock = () => null;

/** "há 3 h", with the exact date on hover. Renders the date until hydrated to avoid a mismatch. */
export function When({ className, value }: { className?: string; value: number | string | Date | null | undefined }) {
  const now = useSyncExternalStore(subscribeToClock, readClock, readServerClock);
  if (value === null || value === undefined || value === "") return <span className={className}>nunca</span>;
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return <span className={className}>data desconhecida</span>;
  return (
    <time className={className} dateTime={date.toISOString()} title={formatDatePt(date, true)}>
      {now === null ? formatDatePt(date) : formatRelativePt(date, now)}
    </time>
  );
}
