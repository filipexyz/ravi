"use client";

import Image from "next/image";
import { Clock, FileText, ImageOff, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api/client";
import { withOrganizationParam } from "@/lib/api/organization";
import { cn } from "@/lib/cn";
import type { PublishedPageSummary } from "@/features/console/types";
import { useRequestThumbnails } from "./data";

/** Pages one thumbnail request may name; the server takes at most this many. */
const THUMBNAIL_BATCH = 6;
/** A batch nobody heard back from stops holding the next one after this long. */
const BATCH_PATIENCE_MS = 90_000;

export type PreviewState = "current" | "stale" | "updating" | "making" | "failed" | "none";

/** What a page's preview shows: its current look, an older one, one on the way, or nothing. */
export function previewState(thumbnail: PublishedPageSummary["thumbnail"]): PreviewState {
  const pending = thumbnail.attempt?.status === "pending";
  if (thumbnail.url && thumbnail.state === "current") return "current";
  if (thumbnail.url && thumbnail.state === "stale") return pending ? "updating" : "stale";
  if (pending) return "making";
  if (thumbnail.attempt?.status === "failed") return "failed";
  return "none";
}

const LABEL: Record<PreviewState, string> = {
  current: "",
  failed: "No preview",
  making: "Making preview…",
  none: "No preview yet",
  stale: "Older version",
  updating: "Updating…",
};

/** One line for screen readers and captions; empty when the preview is current. */
export function previewDescription(state: PreviewState) {
  switch (state) {
    case "stale":
      return "Preview from an earlier version.";
    case "updating":
      return "Preview from an earlier version, updating.";
    case "making":
      return "Making a preview.";
    case "failed":
      return "No preview.";
    case "none":
      return "No preview yet.";
    default:
      return "";
  }
}

const PLACEHOLDER_ICON: Record<"making" | "failed" | "none", LucideIcon> = {
  failed: ImageOff,
  making: Loader2,
  none: FileText,
};

/**
 * A page's screenshot in a 16:10 frame that always keeps its size, so lists
 * never jump when previews arrive. Older previews are dimmed and say so;
 * pages without one show what is happening instead. Decorative: the card or
 * the page around it says the same in words.
 */
export function PagePreview({
  className,
  page,
  size,
}: {
  className?: string;
  page: PublishedPageSummary;
  size: "row" | "card" | "hero";
}) {
  const state = previewState(page.thumbnail);
  const url = page.thumbnail.url;
  const showsImage = Boolean(url) && (state === "current" || state === "stale" || state === "updating");
  const olderImage = state === "stale" || state === "updating";
  const Icon = showsImage ? null : PLACEHOLDER_ICON[state as "making" | "failed" | "none"];
  const compact = size === "row";

  return (
    <span
      aria-hidden
      className={cn(
        "relative block aspect-[16/10] shrink-0 overflow-hidden bg-sunken",
        compact ? "w-16 rounded" : "w-full rounded-md",
        className,
      )}
      data-preview-state={state}
    >
      {showsImage && url ? (
        <Image
          alt=""
          className={cn("object-cover object-top", olderImage && "opacity-55 saturate-50")}
          fill
          sizes={size === "hero" ? "(min-width: 1024px) 560px, 100vw" : size === "card" ? "(min-width: 1024px) 320px, 50vw" : "64px"}
          src={withOrganizationParam(url)}
          unoptimized
        />
      ) : Icon ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-ink-3">
          <Icon
            className={cn(state === "making" && "motion-safe:animate-spin")}
            size={compact ? 14 : size === "hero" ? 28 : 20}
            strokeWidth={1.75}
          />
          {compact ? null : <span className="text-xs">{LABEL[state]}</span>}
        </span>
      ) : null}
      {olderImage ? (
        compact ? (
          <span className="absolute right-0.5 bottom-0.5 inline-flex size-4 items-center justify-center rounded-full bg-surface text-ink-2 ring-1 ring-line">
            <Clock size={10} />
          </span>
        ) : (
          <span className="absolute bottom-2 left-2 inline-flex h-6 items-center gap-1 rounded-full bg-surface/95 px-2 text-xs font-medium text-ink-2 ring-1 ring-line">
            {state === "updating" ? <Loader2 className="motion-safe:animate-spin" size={12} /> : <Clock size={12} />}
            {LABEL[state]}
          </span>
        )
      ) : null}
      <span className={cn("pointer-events-none absolute inset-0 ring-1 ring-line ring-inset", compact ? "rounded" : "rounded-md")} />
    </span>
  );
}

/**
 * For people who can publish: asks for previews of the shown pages that have
 * none of their current content, a few at a time, each page version once per
 * visit. Readers never start captures, and a 403 stops asking.
 */
export function useAutoThumbnails(projectId: string, pages: PublishedPageSummary[] | undefined, enabled: boolean) {
  const { isPending, mutate } = useRequestThumbnails(projectId);
  const asked = useRef(new Set<string>());
  const denied = useRef(false);
  const batch = useRef<{ routeIds: string[]; at: number } | null>(null);
  // Looks again once a batch's patience runs out, even if nothing else changed.
  const [patienceTick, setPatienceTick] = useState(0);
  const patienceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (patienceTimer.current) clearTimeout(patienceTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!enabled || !pages?.length || denied.current || isPending) return;
    if (pages.some((page) => page.thumbnail.attempt?.status === "pending")) return;
    const last = batch.current;
    if (last && Date.now() - last.at < BATCH_PATIENCE_MS) {
      const settled = last.routeIds.every((routeId) => {
        const page = pages.find((item) => item.routeId === routeId);
        return !page || page.thumbnail.state === "current" || page.thumbnail.attempt?.status === "failed";
      });
      if (!settled) return;
    }

    const wanted = pages
      .filter(
        (page) =>
          page.thumbnail.state !== "current" &&
          page.thumbnail.attempt === null &&
          !asked.current.has(`${page.routeId}:${page.artifactVersionId}`),
      )
      .slice(0, THUMBNAIL_BATCH);
    if (wanted.length === 0) return;

    for (const page of wanted) asked.current.add(`${page.routeId}:${page.artifactVersionId}`);
    batch.current = { at: Date.now(), routeIds: wanted.map((page) => page.routeId) };
    if (patienceTimer.current) clearTimeout(patienceTimer.current);
    patienceTimer.current = setTimeout(() => setPatienceTick((tick) => tick + 1), BATCH_PATIENCE_MS);
    mutate(
      { routeIds: wanted.map((page) => page.routeId) },
      {
        onError: (error) => {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) denied.current = true;
          // Nothing started: the next batch need not wait for this one.
          batch.current = null;
        },
        onSuccess: (result) => {
          if (!result.items.some((item) => item.state === "pending")) batch.current = null;
        },
      },
    );
  }, [enabled, isPending, mutate, pages, patienceTick]);
}
