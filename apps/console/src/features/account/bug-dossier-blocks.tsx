"use client";

import { Check, ChevronRight } from "lucide-react";

import {
  bugDossierHasContent,
  bugDossierHasKnownSections,
  projectBugDossierView,
  type BugDossierChip,
  type BugDossierExtra,
  type BugDossierView,
} from "@/features/console/bug-dossier";
import type { BugReportComment } from "@/features/console/types";
import { cn } from "@/lib/cn";
import { Badge } from "@/ui/badge";
import { RelativeTime } from "@/ui/time";
import { COMMENT_SOURCE } from "./bug-labels";

/**
 * The report's dossier as visual blocks: prose, chips, numbered steps,
 * expected/actual, evidence and the cleanup checklist. Fields the Console
 * doesn't know go last, collapsed.
 */
export function BugDossierBlocks({ headerSummary, payload }: { headerSummary?: string | null; payload: unknown }) {
  const view = projectBugDossierView(payload, { headerSummary });
  if (!bugDossierHasContent(view)) {
    return (
      <div className="rounded-lg border border-line bg-surface px-5 py-4 text-sm text-ink-3">
        No details beyond the summary were sent with this report.
      </div>
    );
  }
  const known = bugDossierHasKnownSections(view);
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {view.problem || view.source || view.tags.length ? (
        <Block title="Problem">
          {view.problem ? <Prose>{view.problem}</Prose> : null}
          {view.source || view.tags.length ? (
            <ChipRow>
              {view.source ? <Chip label="Source" value={view.source} /> : null}
              {view.tags.map((tag) => (
                <Chip key={tag} label="Tag" value={tag} />
              ))}
            </ChipRow>
          ) : null}
        </Block>
      ) : null}

      {view.reproduction ? <ReproductionBlock reproduction={view.reproduction} /> : null}

      {view.environment.length ? (
        <Block title="Environment">
          <ChipRow>
            {view.environment.map((chip) => (
              <Chip chip={chip} key={chip.key} />
            ))}
          </ChipRow>
        </Block>
      ) : null}

      {view.evidence ? <EvidenceBlock evidence={view.evidence} /> : null}

      {view.context ? (
        <Block title="Context">
          {view.context.sessionHints ? <Prose>{view.context.sessionHints}</Prose> : null}
          {view.context.organizationRef || view.context.projectRef ? (
            <ChipRow>
              {view.context.organizationRef ? <Chip label="Organization" mono value={view.context.organizationRef} /> : null}
              {view.context.projectRef ? <Chip label="Project" mono value={view.context.projectRef} /> : null}
            </ChipRow>
          ) : null}
        </Block>
      ) : null}

      {view.sanitization.length ? (
        <Block title="Cleaned before sending">
          <ul className="space-y-1.5">
            {view.sanitization.map((rule) => (
              <li className="flex items-start gap-2 text-sm text-ink-2" key={rule}>
                <Check aria-hidden className="mt-0.5 shrink-0 text-ok" size={15} />
                <span>{rule}</span>
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      {view.extras.length ? <ExtrasBlock extras={view.extras} open={!known} /> : null}
    </div>
  );
}

function ReproductionBlock({ reproduction }: { reproduction: NonNullable<BugDossierView["reproduction"]> }) {
  return (
    <Block title="How to reproduce">
      {reproduction.steps.length ? (
        <ol className="space-y-2">
          {reproduction.steps.map((step, index) => (
            <li className="flex gap-3" key={`${index}-${step}`}>
              <span
                aria-hidden
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-medium text-ink-2"
              >
                {index + 1}
              </span>
              <Prose className="pt-0.5">{step}</Prose>
            </li>
          ))}
        </ol>
      ) : null}
      {reproduction.expected || reproduction.actual ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {reproduction.expected ? (
            <Callout label="Expected" tone="ok">
              {reproduction.expected}
            </Callout>
          ) : null}
          {reproduction.actual ? (
            <Callout label="What happened" tone="err">
              {reproduction.actual}
            </Callout>
          ) : null}
        </div>
      ) : null}
      {reproduction.frequency ? (
        <ChipRow>
          <Chip label="How often" value={reproduction.frequency} />
        </ChipRow>
      ) : null}
    </Block>
  );
}

function EvidenceBlock({ evidence }: { evidence: NonNullable<BugDossierView["evidence"]> }) {
  return (
    <Block title="Evidence">
      {evidence.notes.length ? (
        <ul className="space-y-1.5">
          {evidence.notes.map((note) => (
            <li className="flex gap-2.5" key={note}>
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3" />
              <Prose>{note}</Prose>
            </li>
          ))}
        </ul>
      ) : null}
      {evidence.logs.length ? (
        <div className="space-y-1.5">
          <div className="text-[13px] text-ink-3">Logs</div>
          <LogList logs={evidence.logs} />
        </div>
      ) : null}
      {evidence.redactions.length ? (
        <div className="space-y-1.5">
          <div className="text-[13px] text-ink-3">Removed before sending</div>
          <div className="flex flex-wrap gap-1.5">
            {evidence.redactions.map((item) => (
              <Badge key={item} tone="warn">
                {item}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </Block>
  );
}

function ExtrasBlock({ extras, open }: { extras: BugDossierExtra[]; open: boolean }) {
  const body = (
    <div className="space-y-4">
      {extras.map((extra) => (
        <div className="space-y-1" key={extra.key}>
          <div className="text-[13px] text-ink-3">{extra.label}</div>
          {extra.kind === "text" && extra.text ? <Prose>{extra.text}</Prose> : null}
          {extra.kind === "list" && extra.items ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
              {extra.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {extra.kind === "json" && extra.json ? (
            <pre className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-ink-2">
              {extra.json}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
  if (open) return <Block title="Other details">{body}</Block>;
  return (
    <details className="group px-5 py-4">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-ink select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="text-ink-3 transition-transform group-open:rotate-90" size={15} />
        Other details
        <span className="text-[13px] font-normal text-ink-3">{extras.length}</span>
      </summary>
      <div className="pt-3 pl-5">{body}</div>
    </details>
  );
}

/** Follow-ups on a report, oldest first. Read-only. */
export function BugCommentThread({ comments }: { comments: BugReportComment[] }) {
  return (
    <ol className="space-y-3">
      {comments.map((comment) => {
        const source = COMMENT_SOURCE[comment.source] ?? COMMENT_SOURCE.cli;
        const Icon = source.icon;
        const evidence = commentEvidence(comment.payload);
        return (
          <li className="flex gap-3" key={comment.id}>
            <span aria-hidden className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-ink-3">
              <Icon size={15} />
            </span>
            <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="font-medium text-ink">{source.label}</span>
                <RelativeTime className="text-ink-3" value={comment.createdAt} />
              </div>
              <div className="mt-1.5 space-y-2.5">
                {comment.text ? <Prose>{comment.text}</Prose> : null}
                {evidence.notes.length ? (
                  <ul className="space-y-1">
                    {evidence.notes.map((note) => (
                      <li className="flex gap-2.5" key={note}>
                        <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-3" />
                        <Prose>{note}</Prose>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {evidence.logs.length ? <LogList logs={evidence.logs} /> : null}
                {!comment.text && !evidence.notes.length && !evidence.logs.length ? (
                  <p className="text-sm text-ink-3">Added details without a note.</p>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function LogList({ logs }: { logs: string[] }) {
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-line bg-sunken">
      {logs.map((log, index) => (
        <pre
          className={cn(
            "px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2",
            index > 0 && "border-t border-line",
          )}
          key={`${index}-${log.slice(0, 24)}`}
        >
          {log}
        </pre>
      ))}
    </div>
  );
}

function Block({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="space-y-3 px-5 py-4">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {children}
    </section>
  );
}

function Prose({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-sm leading-relaxed whitespace-pre-wrap break-words text-ink-2", className)}>{children}</p>;
}

function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function Chip({ chip, label, mono, value }: { chip?: BugDossierChip; label?: string; mono?: boolean; value?: string }) {
  const resolvedLabel = chip?.label ?? label;
  const resolvedValue = chip?.value ?? value;
  if (!resolvedLabel || !resolvedValue) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-sunken px-2 py-1 text-[13px]">
      <span className="shrink-0 text-ink-3">{resolvedLabel}</span>
      <span className={cn("min-w-0 truncate text-ink", mono && "font-mono text-xs")}>{resolvedValue}</span>
    </span>
  );
}

function Callout({ children, label, tone }: { children: React.ReactNode; label: string; tone: "ok" | "err" }) {
  return (
    <div className="rounded-md border border-line bg-canvas px-3.5 py-3">
      <div className={cn("mb-1 flex items-center gap-1.5 text-[13px] font-medium", tone === "ok" ? "text-ok" : "text-err")}>
        <span aria-hidden className={cn("size-1.5 rounded-full", tone === "ok" ? "bg-ok" : "bg-err")} />
        {label}
      </div>
      <Prose>{children}</Prose>
    </div>
  );
}

function commentEvidence(payload: Record<string, unknown>) {
  const evidence = payload?.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return { logs: [] as string[], notes: [] as string[] };
  const record = evidence as Record<string, unknown>;
  return { logs: stringList(record.logs), notes: stringList(record.notes) };
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}
