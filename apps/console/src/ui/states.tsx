"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Lock, RefreshCw, SearchX } from "lucide-react";

import { ApiError, describeError, isAccessError, isNotFound } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/** The next step when there is nothing to show yet. */
export function EmptyState({
  action,
  children,
  className,
  description,
  headingLevel = 3,
  icon: Icon,
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  /** 2 when the empty state sits right under the page's h1. */
  headingLevel?: 2 | 3;
  icon?: LucideIcon;
  title: React.ReactNode;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={cn("rounded-lg border border-dashed border-line-strong bg-surface px-6 py-10", className)}>
      <div className="mx-auto flex max-w-lg flex-col items-center text-center">
        {Icon ? (
          <span className="mb-3 inline-flex size-10 items-center justify-center rounded-full bg-sunken text-ink-3">
            <Icon aria-hidden size={18} />
          </span>
        ) : null}
        <Heading className="text-[15px] font-semibold text-ink">{title}</Heading>
        {description ? <div className="mt-1 text-sm text-ink-2">{description}</div> : null}
        {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
      </div>
      {children ? <div className="mx-auto mt-6 max-w-xl text-left">{children}</div> : null}
    </div>
  );
}

/**
 * Renders a failed load: access problems say who can help, missing things say
 * so, anything else offers a retry and the Sentry id when the server sent one.
 */
export function ErrorState({
  className,
  error,
  onRetry,
  role,
  title,
}: {
  className?: string;
  error: unknown;
  onRetry?: () => void;
  /** The viewer's organization role, shown on access errors. */
  role?: string;
  title?: string;
}) {
  if (isAccessError(error)) {
    return (
      <NoAccess
        className={className}
        description={describeError(error)}
        role={role}
        title={title ?? "You don't have access to this"}
      />
    );
  }
  if (isNotFound(error)) {
    return (
      <EmptyState
        className={className}
        description="It may have been removed, or it belongs to another organization."
        icon={SearchX}
        title={title ?? "Not found"}
      />
    );
  }
  const eventId = error instanceof ApiError ? error.eventId : undefined;
  return (
    <div className={cn("rounded-lg border border-line bg-surface px-5 py-5", className)} role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 shrink-0 text-err" size={18} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium text-ink">{title ?? "This couldn't load"}</div>
          <div className="text-sm text-ink-2">{describeError(error)}</div>
          {eventId ? <div className="font-mono text-xs text-ink-3">Reference {eventId}</div> : null}
        </div>
        {onRetry ? (
          <Button icon={RefreshCw} onClick={onRetry} size="sm">
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function NoAccess({
  className,
  description,
  role,
  title = "You don't have access to this",
}: {
  className?: string;
  description?: React.ReactNode;
  role?: string;
  title?: React.ReactNode;
}) {
  return (
    <EmptyState
      className={className}
      description={
        <>
          {description}
          {role ? (
            <>
              {" "}
              Your role in this organization is <span className="font-medium text-ink">{role}</span>.
              {/owner|admin/i.test(role) ? null : " An owner or admin can change it in Organization settings."}
            </>
          ) : null}
        </>
      }
      icon={Lock}
      title={title}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-sunken", className)} />;
}

/** Placeholder rows with the shape of a list. */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div aria-busy aria-label="Loading" className={cn("divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface", className)} role="status">
      {Array.from({ length: rows }, (_, index) => (
        <div className="flex items-center gap-3 px-4 py-3.5" key={index}>
          <Skeleton className="size-8 shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="hidden h-3 w-16 md:block" />
        </div>
      ))}
    </div>
  );
}

/** Inline notice inside a page: a heads-up, not an error. */
export function Notice({
  children,
  className,
  icon: Icon,
  title,
  tone = "info",
}: {
  children?: React.ReactNode;
  className?: string;
  icon?: LucideIcon;
  title?: React.ReactNode;
  tone?: "info" | "warn" | "ok" | "err";
}) {
  const tones = {
    err: "bg-err-soft text-err",
    info: "bg-info-soft text-info",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
  } as const;
  return (
    <div className={cn("flex items-start gap-2.5 rounded-md px-3.5 py-3 text-sm", tones[tone], className)}>
      {Icon ? <Icon aria-hidden className="mt-0.5 shrink-0" size={16} /> : null}
      <div className="min-w-0 space-y-0.5">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div className="text-ink-2">{children}</div> : null}
      </div>
    </div>
  );
}
