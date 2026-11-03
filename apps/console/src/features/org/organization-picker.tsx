"use client";

import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import type { Org } from "@/features/console/types";
import { RaviMark } from "@/features/shell/app-shell";
import { roleLabel } from "@/features/shell/workspace";
import { Avatar, Badge } from "@/ui/badge";

/**
 * Full-height branded frame for screens that render outside the Console
 * shell: choosing an organization, or a Console that couldn't load.
 */
export function CenteredScreen({
  children,
  description,
  title,
}: {
  children?: React.ReactNode;
  description?: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <div className="rv-app flex min-h-dvh flex-col bg-canvas font-sans text-ink antialiased">
      <main className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center px-4 py-12 sm:py-16">
        <div className="mb-6 flex justify-center">
          <RaviMark className="size-10 rounded-lg text-lg" />
        </div>
        <div className="mb-6 space-y-1.5 text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-balance text-ink">{title}</h1>
          {description ? <div className="text-sm text-balance text-ink-2">{description}</div> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

/**
 * One row per organization. Each row is a plain form post, so choosing works
 * without JavaScript and the server sets the organization cookie.
 */
export function OrganizationChoices({
  currentId,
  orgs,
  returnTo,
}: {
  currentId?: string | null;
  orgs: Org[];
  returnTo: string;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => {
    // Coming back with the browser's Back button restores this page as it was left.
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPendingId(null);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  const sorted = [...orgs].sort((a, b) => {
    if (a.id === currentId) return -1;
    if (b.id === currentId) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <ul aria-label="Organizations" className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {sorted.map((org) => {
        const current = org.id === currentId;
        const pending = pendingId === org.id;
        return (
          <li key={org.id}>
            <form action="/api/console/organizations/select" method="post" onSubmit={() => setPendingId(org.id)}>
              <input name="organizationId" type="hidden" value={org.id} />
              <input name="returnTo" type="hidden" value={returnTo} />
              <button
                aria-current={current ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-hover focus-visible:bg-hover",
                  pendingId && !pending && "opacity-60",
                )}
                disabled={Boolean(pendingId)}
                type="submit"
              >
                <Avatar label={org.name} seed={org.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{org.name}</span>
                  <span className="block truncate text-[13px] text-ink-3">{roleLabel(org.role)}</span>
                </span>
                {current ? (
                  <Badge dot tone="ok">
                    Current
                  </Badge>
                ) : null}
                {pending ? (
                  <Loader2 aria-label="Opening" className="shrink-0 animate-spin text-ink-3" size={16} />
                ) : (
                  <ChevronRight aria-hidden className="shrink-0 text-ink-3" size={16} />
                )}
              </button>
            </form>
          </li>
        );
      })}
    </ul>
  );
}
