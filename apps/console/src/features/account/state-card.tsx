"use client";

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";

export type StateTone = "ok" | "err" | "warn" | "info" | "neutral";

const tileTones: Record<StateTone, string> = {
  err: "bg-err-soft text-err",
  info: "bg-info-soft text-info",
  neutral: "bg-sunken text-ink-3",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
};

/** Round icon tile that opens a standalone card. */
export function IconTile({ className, icon: Icon, tone = "neutral" }: { className?: string; icon: LucideIcon; tone?: StateTone }) {
  return (
    <span aria-hidden className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-full", tileTones[tone], className)}>
      <Icon size={19} />
    </span>
  );
}

/** The bordered card standalone pages put their content in. */
export function StandaloneCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-8", className)}>{children}</div>;
}

/**
 * A finished or blocked state on a standalone page: what happened, in a
 * sentence, and the next step.
 */
export function StateCard({
  actions,
  children,
  heading = "h1",
  icon,
  title,
  tone,
}: {
  actions?: React.ReactNode;
  children?: React.ReactNode;
  heading?: "h1" | "h2";
  icon: LucideIcon;
  title: React.ReactNode;
  tone: StateTone;
}) {
  const Heading = heading;
  return (
    <StandaloneCard>
      <IconTile icon={icon} tone={tone} />
      <Heading className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">{title}</Heading>
      {children ? <div className="mt-1.5 space-y-3 text-sm leading-relaxed text-ink-2">{children}</div> : null}
      {actions ? <div className="mt-6 flex flex-wrap gap-2">{actions}</div> : null}
    </StandaloneCard>
  );
}

/** Renders `backtick` spans in fixed copy as inline code. */
export function InlineText({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[12.5px] text-ink" key={index}>
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
