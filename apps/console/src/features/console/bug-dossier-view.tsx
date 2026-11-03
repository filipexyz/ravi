"use client";

import type { ReactNode } from "react";

import { Tag } from "@/components/ui";
import {
  bugDossierHasContent,
  bugDossierHasKnownSections,
  projectBugDossierView,
  type BugDossierChip,
  type BugDossierContext,
  type BugDossierEvidence,
  type BugDossierExtra,
  type BugDossierReproduction,
} from "@/features/console/bug-dossier";
import { relTime, type BugReportComment } from "@/features/console/types";

export function BugDossier({
  headerSummary,
  payload,
}: {
  headerSummary?: string | null;
  payload: unknown;
}) {
  const view = projectBugDossierView(payload, { headerSummary });
  if (!bugDossierHasContent(view)) {
    return (
      <div className="col gap-8" style={{ padding: 24, textAlign: "center" }}>
        <span className="t-strong">No payload sections</span>
        <span className="t-body t-mute">This report did not include extra dossier fields.</span>
      </div>
    );
  }

  const known = bugDossierHasKnownSections(view);

  return (
    <div className="bug-dossier">
      {view.problem ? (
        <DossierSection title="Problem">
          <p className="bug-dossier-prose">{view.problem}</p>
        </DossierSection>
      ) : null}

      {view.source || view.tags.length > 0 ? (
        <div className="bug-dossier-chips" aria-label="Report origin">
          {view.source ? <DossierChip label="Source" value={view.source} /> : null}
          {view.tags.map((tag) => (
            <DossierChip key={tag} label="Tag" value={tag} />
          ))}
        </div>
      ) : null}

      {view.environment.length > 0 ? (
        <DossierSection title="Environment">
          <ul className="bug-dossier-chips">
            {view.environment.map((chip) => (
              <li key={chip.key}>
                <DossierChip chip={chip} />
              </li>
            ))}
          </ul>
        </DossierSection>
      ) : null}

      {view.reproduction ? <ReproductionBlock reproduction={view.reproduction} /> : null}

      {view.evidence ? <EvidenceBlock evidence={view.evidence} /> : null}

      {view.context ? <ContextBlock context={view.context} /> : null}

      {view.sanitization.length > 0 ? (
        <DossierSection title="Sanitization">
          <ul className="bug-dossier-check">
            {view.sanitization.map((rule) => (
              <li key={rule}>
                <span aria-hidden="true" className="bug-dossier-check-mark">
                  ✓
                </span>
                <span>{rule}</span>
              </li>
            ))}
          </ul>
        </DossierSection>
      ) : null}

      {view.extras.length > 0 ? (
        <ExtrasBlock extras={view.extras} fallbackOnly={!known} />
      ) : null}
    </div>
  );
}

function ReproductionBlock({ reproduction }: { reproduction: BugDossierReproduction }) {
  return (
    <DossierSection title="Reproduction">
      {reproduction.steps.length > 0 ? (
        <ol className="bug-dossier-steps">
          {reproduction.steps.map((step, index) => (
            <li key={`${index}-${step}`}>
              <span aria-hidden="true" className="bug-dossier-step-num">
                {index + 1}
              </span>
              <span className="bug-dossier-prose">{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {reproduction.expected || reproduction.actual ? (
        <div className="bug-dossier-compare">
          {reproduction.expected ? (
            <aside className="bug-dossier-callout bug-dossier-callout--expected">
              <h4>Expected</h4>
              <p>{reproduction.expected}</p>
            </aside>
          ) : null}
          {reproduction.actual ? (
            <aside className="bug-dossier-callout bug-dossier-callout--actual">
              <h4>Actual</h4>
              <p>{reproduction.actual}</p>
            </aside>
          ) : null}
        </div>
      ) : null}
      {reproduction.frequency ? (
        <div className="bug-dossier-chips">
          <DossierChip label="Frequency" value={reproduction.frequency} />
        </div>
      ) : null}
    </DossierSection>
  );
}

function EvidenceBlock({ evidence }: { evidence: BugDossierEvidence }) {
  return (
    <DossierSection title="Evidence">
      {evidence.logs.length > 0 ? (
        <div className="bug-dossier-evidence">
          <h4>Logs</h4>
          <ol className="bug-dossier-timeline">
            {evidence.logs.map((log, index) => (
              <li key={`${index}-${log}`}>
                <p>{log}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {evidence.notes.length > 0 ? (
        <div className="bug-dossier-evidence">
          <h4>Notes</h4>
          <ul className="bug-dossier-notes">
            {evidence.notes.map((note) => (
              <li key={note}>
                <p className="bug-dossier-prose">{note}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {evidence.redactions.length > 0 ? (
        <div className="bug-dossier-evidence">
          <h4>Redactions</h4>
          <ul className="bug-dossier-chips">
            {evidence.redactions.map((item) => (
              <li key={item}>
                <Tag tone="warn">{item}</Tag>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </DossierSection>
  );
}

function ContextBlock({ context }: { context: BugDossierContext }) {
  const chips = [
    context.organizationRef ? { key: "organizationRef", label: "Organization", value: context.organizationRef } : null,
    context.projectRef ? { key: "projectRef", label: "Project", value: context.projectRef } : null,
  ].filter((chip): chip is BugDossierChip => Boolean(chip));

  return (
    <DossierSection title="Context">
      <aside className="bug-dossier-callout bug-dossier-callout--context">
        {context.sessionHints ? <p className="bug-dossier-prose">{context.sessionHints}</p> : null}
        {chips.length > 0 ? (
          <ul className="bug-dossier-chips">
            {chips.map((chip) => (
              <li key={chip.key}>
                <DossierChip chip={chip} />
              </li>
            ))}
          </ul>
        ) : null}
      </aside>
    </DossierSection>
  );
}

function ExtrasBlock({ extras, fallbackOnly }: { extras: BugDossierExtra[]; fallbackOnly: boolean }) {
  const body = (
    <div className="bug-dossier-extras">
      {extras.map((extra) => (
        <ExtraField extra={extra} key={extra.key} />
      ))}
    </div>
  );

  if (fallbackOnly) {
    return <DossierSection title="Other fields">{body}</DossierSection>;
  }

  return (
    <details className="bug-dossier-raw">
      <summary>
        Other fields
        <span className="t-tiny t-mute">{extras.length}</span>
      </summary>
      {body}
    </details>
  );
}

function ExtraField({ extra }: { extra: BugDossierExtra }) {
  return (
    <div className="bug-dossier-extra">
      <h4>{extra.label}</h4>
      {extra.kind === "text" && extra.text ? <p className="bug-dossier-prose">{extra.text}</p> : null}
      {extra.kind === "list" && extra.items ? (
        <ul className="bug-dossier-notes">
          {extra.items.map((item) => (
            <li key={item}>
              <p className="bug-dossier-prose">{item}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {extra.kind === "json" && extra.json ? <pre className="bug-dossier-raw-json">{extra.json}</pre> : null}
    </div>
  );
}

function DossierSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="bug-dossier-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function BugFollowUps({ comments }: { comments?: BugReportComment[] }) {
  const items = comments ?? [];
  if (items.length === 0) {
    return <span className="t-body t-mute">No follow-up comments yet.</span>;
  }

  return (
    <ol className="bug-dossier-timeline" style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((comment) => {
        const evidence = commentEvidence(comment.payload);
        return (
          <li key={comment.id} className="col gap-8">
            <div className="row gap-8" style={{ flexWrap: "wrap" }}>
              <Tag>{comment.source}</Tag>
              <span className="t-mono t-tiny t-mute">{relTime(comment.createdAt)}</span>
            </div>
            {comment.text ? (
              <p className="bug-dossier-prose" style={{ margin: 0 }}>
                {comment.text}
              </p>
            ) : null}
            {evidence.notes.length > 0 ? (
              <ul className="bug-dossier-notes">
                {evidence.notes.map((note) => (
                  <li key={note}>
                    <p className="bug-dossier-prose">{note}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            {evidence.logs.length > 0 ? (
              <ol className="bug-dossier-timeline">
                {evidence.logs.map((log) => (
                  <li key={log}>
                    <pre className="bug-dossier-raw-json">{log}</pre>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function commentEvidence(payload: Record<string, unknown>) {
  const evidence = payload.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { logs: [] as string[], notes: [] as string[] };
  }
  const record = evidence as Record<string, unknown>;
  return {
    logs: stringList(record.logs),
    notes: stringList(record.notes),
  };
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function DossierChip({
  chip,
  label,
  value,
}: {
  chip?: BugDossierChip;
  label?: string;
  value?: string;
}) {
  const resolvedLabel = chip?.label ?? label;
  const resolvedValue = chip?.value ?? value;
  if (!resolvedLabel || !resolvedValue) return null;
  return (
    <span className="bug-dossier-chip">
      <span className="bug-dossier-chip-label">{resolvedLabel}</span>
      <span className="bug-dossier-chip-value">{resolvedValue}</span>
    </span>
  );
}
