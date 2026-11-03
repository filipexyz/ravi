"use client";

import { ChevronRight, Globe, KeyRound, Lock, MessageSquare, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PageVisibility, PublishedPageSummary } from "@/features/console/types";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { CopyButton } from "@/ui/copy";
import type { DnsRecord } from "./domains-model";
import { VISIBILITY_LABEL } from "./model";

const VISIBILITY_ICON: Record<PageVisibility, LucideIcon> = {
  password: KeyRound,
  private: Lock,
  protected_link: ShieldCheck,
  public: Globe,
};

/**
 * Who can open a page, as a badge with a word and an icon: what visitors get,
 * never the raw route setting. Public stands out because it reaches people
 * outside the project.
 */
export function VisibilityBadge({ className, visibility }: { className?: string; visibility: PageVisibility }) {
  const Icon = VISIBILITY_ICON[visibility];
  return (
    <Badge className={className} tone={visibility === "public" ? "info" : "neutral"}>
      <Icon aria-hidden className="-ml-0.5" size={12} />
      {VISIBILITY_LABEL[visibility]}
    </Badge>
  );
}

/** Open comments on a page, with the new ones from other people called out. */
export function CommentsChip({ comments }: { comments: PublishedPageSummary["comments"] }) {
  if (comments.openCount === 0) return null;
  const count = comments.hasUnread ? comments.unreadCount : comments.openCount;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[13px] whitespace-nowrap",
        comments.hasUnread ? "font-medium text-warn" : "text-ink-3",
      )}
    >
      <MessageSquare aria-hidden size={13} />
      {comments.hasUnread ? `${count} new` : count}
      <span className="sr-only">{count === 1 ? " comment" : " comments"}</span>
    </span>
  );
}

/** DNS records to add, each value copyable. */
export function DnsRecords({ className, records }: { className?: string; records: DnsRecord[] }) {
  return (
    <div className={cn("divide-y divide-line overflow-hidden rounded-md border border-line bg-sunken", className)}>
      {records.map((record) => (
        <dl
          className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
          key={`${record.type}-${record.name}-${record.value}`}
        >
          <dt className="text-ink-3">Type</dt>
          <dd className="font-mono font-medium text-ink">{record.type}</dd>
          <RecordValue label="Name" value={record.name} />
          <RecordValue label="Value" value={record.value} />
        </dl>
      ))}
    </div>
  );
}

function RecordValue({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 font-mono break-all text-ink">{value}</span>
        <CopyButton className="shrink-0" label={`Copy ${label.toLowerCase()}`} value={value} />
      </dd>
    </>
  );
}

/** Focuses a section's heading without scrolling, so keyboard and screen reader users continue from there. */
export function focusSectionHeading(target: HTMLElement | null) {
  const heading = target ? (target.matches("h2") ? target : target.querySelector<HTMLElement>("h2")) : null;
  if (!heading) return false;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  return true;
}

/** How long a section named in the URL stays in place while the sections above it load. */
const ARRIVAL_PIN_MS = 4000;

/**
 * Arriving on a screen: a `#section` in the URL scrolls to that section and
 * focuses its heading; otherwise focus goes to the screen's title, when given.
 * Runs once the content is there (`key` set) and again when `key` changes.
 * Sections above the target may still be loading and push it down, so it is
 * scrolled back into place until they settle or the person scrolls or types.
 */
export function useArrivalFocus(key: string | null, titleRef?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!key) return;
    let id = "";
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      id = "";
    }
    const target = id ? document.getElementById(id) : null;
    if (!target || !focusSectionHeading(target)) {
      titleRef?.current?.focus({ preventScroll: true });
      return;
    }
    target.scrollIntoView({ block: "start" });
    const observer = new ResizeObserver(() => target.scrollIntoView({ block: "start" }));
    observer.observe(document.body);
    const events = ["keydown", "pointerdown", "touchstart", "wheel"] as const;
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, stop);
    };
    const timer = window.setTimeout(stop, ARRIVAL_PIN_MS);
    for (const event of events) window.addEventListener(event, stop, { passive: true });
    return stop;
  }, [key, titleRef]);
}

/**
 * "Show more" buttons go away once everything shows. Call `reveal()` from the
 * button; focus then moves to the first item it revealed instead of falling to
 * the page.
 */
export function useRevealFocus<T extends HTMLElement>(expanded: boolean, firstRevealed: number) {
  const containerRef = useRef<T | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!expanded || !pending.current) return;
    pending.current = false;
    const item = containerRef.current?.querySelectorAll<HTMLElement>("[data-reveal-item]")[firstRevealed];
    if (!item) return;
    item.tabIndex = -1;
    item.focus();
  }, [expanded, firstRevealed]);
  return {
    containerRef,
    reveal: () => {
      pending.current = true;
    },
  };
}

/** A small heading inside a section. */
export function SubHeading({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h3 className={cn("text-sm font-semibold text-ink", className)}>{children}</h3>;
}

/**
 * A section that starts closed, for what most visits don't need (history,
 * developer settings). It opens on its own when the URL's hash names it.
 */
export function Collapsible({
  children,
  count,
  id,
  title,
}: {
  /** Mounted only while open, so what it loads waits until someone asks. */
  children: React.ReactNode;
  count?: number;
  id: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `${id}-panel`;

  useEffect(() => {
    const sync = () => {
      if (window.location.hash === `#${id}`) setOpen(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [id]);

  return (
    <section className="scroll-mt-24 border-t border-line pt-4" id={id}>
      <h2 className="text-[15px] font-semibold text-ink">
        <button
          aria-controls={panelId}
          aria-expanded={open}
          className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 hover:text-ink-2"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <ChevronRight aria-hidden className={cn("text-ink-3 transition-transform", open && "rotate-90")} size={16} />
          {title}
          {count ? <span className="font-normal text-ink-3">{count}</span> : null}
        </button>
      </h2>
      {open ? (
        <div className="mt-3" id={panelId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
