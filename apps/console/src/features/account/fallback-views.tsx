"use client";

import { AlertTriangle, RefreshCw, SearchX } from "lucide-react";

import { Button } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { StateCard } from "./state-card";

/** 404 outside the Console shell. */
export function GlobalNotFound() {
  return (
    <StateCard
      actions={
        <Button href="/projects" variant="primary">
          Go to projects
        </Button>
      }
      icon={SearchX}
      title="Page not found"
      tone="neutral"
    >
      <p>The link may be mistyped, or the page was moved or removed.</p>
    </StateCard>
  );
}

/** 404 inside the Console shell, under the top bar. */
export function ConsoleNotFound() {
  return (
    <div className="mx-auto max-w-md pt-6 sm:pt-12">
      <StateCard
        actions={
          <>
            <Button href="/projects" variant="primary">
              Go to projects
            </Button>
            <Button onClick={() => window.history.back()} variant="secondary">
              Go back
            </Button>
          </>
        }
        icon={SearchX}
        title="Not found"
        tone="neutral"
      >
        <p>
          This page doesn&apos;t exist, or it&apos;s in another organization. To switch organizations, use the menu
          at the top.
        </p>
      </StateCard>
    </div>
  );
}

/** An unexpected error while rendering a Console page. */
export function ConsoleErrorView({ digest, onRetry }: { digest?: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-md pt-6 sm:pt-12">
      <StateCard
        actions={
          <>
            <Button icon={RefreshCw} onClick={onRetry} variant="primary">
              Try again
            </Button>
            <Button href="/projects" variant="secondary">
              Go to projects
            </Button>
          </>
        }
        icon={AlertTriangle}
        title="Something went wrong"
        tone="err"
      >
        <p>This page hit a problem while loading. Trying again usually fixes it.</p>
        {digest ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-sunken py-1 pr-1 pl-3">
            <span className="min-w-0 truncate text-[13px] text-ink-3">
              Reference <span className="font-mono text-ink-2">{digest}</span>
            </span>
            <CopyButton label="Copy reference" value={digest} />
          </div>
        ) : null}
        {digest ? <p className="text-[13px] text-ink-3">If it keeps happening, include this reference when you send feedback.</p> : null}
      </StateCard>
    </div>
  );
}
