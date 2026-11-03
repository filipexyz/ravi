"use client";

import { CheckCircle2, FileText, HelpCircle, Link2, SearchX } from "lucide-react";
import { useState } from "react";

import { InlineText, IconTile, StandaloneCard, StateCard } from "@/features/account/state-card";
import { SignedInAs, StandaloneFrame } from "@/features/account/standalone-frame";
import type { KnowledgeProposalCard, KnowledgeRouteCard } from "@/server/console/knowledge/proposals";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/form";
import { Notice } from "@/ui/states";
import { formatDate } from "@/ui/time";

import {
  knowledgeCardErrorMessage,
  PROPOSAL_DONE_COPY,
  proposalKindLabel,
  ROUTE_DONE_COPY,
  routeStateLabel,
} from "./copy";

type Viewer = { email: string; name: string };
type Flash = { done: string | null; error: string | null };

const PROPOSAL_ACTION = "/api/console/knowledge/cards/proposals";
const ROUTE_ACTION = "/api/console/knowledge/cards/routes";

/** The same view for a missing id, another organization and no project access: it never confirms an id exists. */
function NotFoundCard() {
  return (
    <StateCard icon={SearchX} title="Nothing to show here" tone="neutral">
      <p>This link does not exist or you cannot open it. Check that you are signed in with the right account.</p>
    </StateCard>
  );
}

/** `/k/[id]`: one proposal (a gap, note, correction or transcript). Opening it changes nothing. */
export function KnowledgeProposalCardScreen({ card, flash, viewer }: { card: KnowledgeProposalCard; flash: Flash; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="lg">
      {card.kind === "not_found" ? <NotFoundCard /> : <ProposalBody card={card} flash={flash} />}
    </StandaloneFrame>
  );
}

function ProposalBody({ card, flash }: { card: Extract<KnowledgeProposalCard, { kind: "proposal" }>; flash: Flash }) {
  const proposal = card.proposal;
  const done = flash.done ? PROPOSAL_DONE_COPY[flash.done] : null;
  if (done && proposal.status !== "pending") {
    return (
      <StateCard
        actions={
          proposal.faq ? (
            <Button external href={`${proposal.faq.url}#${proposal.faq.anchor}`} variant="primary">
              Open /faq
            </Button>
          ) : undefined
        }
        icon={CheckCircle2}
        title={done.title}
        tone="ok"
      >
        <p>{done.body}</p>
      </StateCard>
    );
  }
  if (proposal.status !== "pending") {
    return (
      <StateCard icon={FileText} title={closedTitle(proposal.status)} tone="neutral">
        {proposal.kind === "gap" && proposal.answer ? <p className="whitespace-pre-wrap">{proposal.answer}</p> : null}
        {proposal.faq ? (
          <p>
            <a className="break-all text-ink underline underline-offset-2" href={`${proposal.faq.url}#${proposal.faq.anchor}`} rel="noreferrer" target="_blank">
              {proposal.faq.url}#{proposal.faq.anchor}
            </a>
          </p>
        ) : null}
      </StateCard>
    );
  }
  return proposal.kind === "gap" ? <GapCard card={card} flash={flash} /> : <ApprovalCard card={card} flash={flash} />;
}

function GapCard({ card, flash }: { card: Extract<KnowledgeProposalCard, { kind: "proposal" }>; flash: Flash }) {
  const proposal = card.proposal;
  const [submitting, setSubmitting] = useState(false);
  const error = knowledgeCardErrorMessage(flash.error);
  return (
    <StandaloneCard>
      <IconTile icon={HelpCircle} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">{proposalKindLabel(proposal.kind)}</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {proposal.projectName ? `${proposal.projectName}. ` : ""}
        {proposal.waitingCount === 1 ? "1 contact is waiting for an answer." : `${proposal.waitingCount} contacts are waiting for an answer.`}
      </p>

      <figure className="mt-5 border-l-2 border-line-strong pl-4">
        <figcaption className="text-xs font-medium uppercase tracking-wide text-ink-3">A contact asked</figcaption>
        <blockquote className="mt-1 whitespace-pre-wrap text-[15px] text-ink">{proposal.body}</blockquote>
      </figure>

      {error ? (
        <Notice className="mt-5" title="Nothing changed" tone="err">
          <InlineText text={error} />
        </Notice>
      ) : null}

      {card.canDecide ? (
        <form action={PROPOSAL_ACTION} className="mt-5 space-y-5" method="post" onSubmit={() => setSubmitting(true)}>
          <input name="id" type="hidden" value={proposal.id} />
          <Field hint="Clients read this on /faq and receive it in their chat." label="Answer">
            {(props) => <Textarea {...props} maxLength={2000} name="answer" required rows={5} />}
          </Field>
          <Field hint="Edit the client's words so they read well in public." label="Question as shown on /faq">
            {(props) => <Input {...props} defaultValue={proposal.faqQuestion ?? proposal.body} maxLength={300} name="faqQuestion" required />}
          </Field>
          <Audience
            items={[
              ...(proposal.audienceLabel ? [`Contacts of ${proposal.audienceLabel}`] : []),
              "Anyone with the link: /faq is public",
            ]}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button className="w-full sm:w-auto" disabled={submitting} formNoValidate name="decision" type="submit" value="dismiss" variant="secondary">
              Dismiss
            </Button>
            <Button className="w-full sm:w-auto" loading={submitting} name="decision" type="submit" value="publish" variant="primary">
              Publish
            </Button>
          </div>
        </form>
      ) : (
        <ReadOnlyNotice />
      )}
    </StandaloneCard>
  );
}

function ApprovalCard({ card, flash }: { card: Extract<KnowledgeProposalCard, { kind: "proposal" }>; flash: Flash }) {
  const proposal = card.proposal;
  const [submitting, setSubmitting] = useState<string | null>(null);
  const error = knowledgeCardErrorMessage(flash.error);
  const hiddenLines = proposal.kind === "transcript" ? Math.max(0, proposal.bodyLineCount - 40) : 0;
  return (
    <StandaloneCard>
      <IconTile icon={FileText} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">
        {proposal.title ? `${proposalKindLabel(proposal.kind)}: ${proposal.title}` : proposalKindLabel(proposal.kind)}
      </h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {proposal.projectName ? `For ${proposal.projectName}.` : "For the whole organization."} Proposed {formatDate(proposal.createdAt, true)}.
      </p>

      <pre className="mt-5 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2 p-3 font-sans text-sm text-ink">
        {proposal.body}
      </pre>
      {hiddenLines > 0 ? <p className="mt-2 text-[13px] text-ink-3">{hiddenLines} more lines not shown.</p> : null}

      {proposal.supersedes ? (
        <p className="mt-4 text-sm text-ink-2">
          Corrects <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[12.5px]">{proposal.supersedes}</code>
        </p>
      ) : null}
      {proposal.evidence.length > 0 ? (
        <div className="mt-4">
          <h2 className="text-sm font-medium text-ink">Evidence</h2>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {proposal.evidence.map((ref) => (
              <li key={ref}>
                <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12.5px] text-ink-2">{ref}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Audience items={["Project members"]} />

      {error ? (
        <Notice className="mt-5" title="Nothing changed" tone="err">
          <InlineText text={error} />
        </Notice>
      ) : null}

      {card.canDecide ? (
        <form action={PROPOSAL_ACTION} className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end" method="post" onSubmit={(event) => {
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          setSubmitting(submitter?.value ?? "approve");
        }}>
          <input name="id" type="hidden" value={proposal.id} />
          <Button className="w-full sm:w-auto" disabled={submitting !== null} loading={submitting === "reject"} name="decision" type="submit" value="reject" variant="secondary">
            Reject
          </Button>
          <Button className="w-full sm:w-auto" disabled={submitting !== null} loading={submitting === "approve"} name="decision" type="submit" value="approve" variant="primary">
            Approve
          </Button>
        </form>
      ) : (
        <ReadOnlyNotice />
      )}
    </StandaloneCard>
  );
}

/** `/k/routes/[routeId]`: who hears one page, pinned to the version approved here. */
export function KnowledgeRouteCardScreen({ card, flash, viewer }: { card: KnowledgeRouteCard; flash: Flash; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="lg">
      {card.kind === "not_found" ? <NotFoundCard /> : <RouteBody card={card} flash={flash} />}
    </StandaloneFrame>
  );
}

function RouteBody({ card, flash }: { card: Extract<KnowledgeRouteCard, { kind: "route" }>; flash: Flash }) {
  const route = card.route;
  const [submitting, setSubmitting] = useState<string | null>(null);
  const error = knowledgeCardErrorMessage(flash.error);
  const done = flash.done ? ROUTE_DONE_COPY[flash.done] : null;
  const stateTone = route.state === "active" ? "ok" : route.state === "suspended" ? "warn" : "neutral";
  return (
    <StandaloneCard>
      <IconTile icon={Link2} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">Who hears this page</h1>
      <p className="mt-1.5 break-all font-mono text-[13px] text-ink-2">
        <a className="underline-offset-2 hover:underline" href={route.url} rel="noreferrer" target="_blank">
          {route.url}
        </a>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
        <Badge dot tone={stateTone}>
          {routeStateLabel(route.state)}
        </Badge>
        {route.approvedVersion ? <span>Approved version {route.approvedVersion}</span> : null}
        {route.currentVersion ? <span>Current version {route.currentVersion}</span> : null}
      </div>

      {done ? (
        <Notice className="mt-5" icon={CheckCircle2} title="Saved" tone="ok">
          {done}
        </Notice>
      ) : null}
      {error ? (
        <Notice className="mt-5" title="Nothing changed" tone="err">
          <InlineText text={error} />
        </Notice>
      ) : null}
      {route.state === "suspended" ? (
        <Notice className="mt-5" title="Needs re-approval" tone="warn">
          {route.suspendedReason === "route_removed"
            ? "The page left the published site, so nobody hears it until it is back and re-approved."
            : "The page changed since it was approved, so nobody hears it until you re-approve the new version."}
        </Notice>
      ) : null}

      {route.diff ? (
        <section aria-labelledby="route-diff" className="mt-5">
          <h2 className="text-sm font-medium text-ink" id="route-diff">
            Changes since the approved version
          </h2>
          {route.diff.length === 0 ? (
            <p className="mt-1 text-sm text-ink-2">No section changed.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {route.diff.map((change) => (
                <li className="flex items-center gap-2" key={`${change.change}:${change.stableKey}`}>
                  <Badge tone={change.change === "added" ? "ok" : change.change === "removed" ? "err" : "warn"}>{change.change}</Badge>
                  <span className="text-ink">{change.heading ?? change.stableKey}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby="route-sections" className="mt-5">
        <h2 className="text-sm font-medium text-ink" id="route-sections">
          What it says now
        </h2>
        {route.sections.length === 0 ? (
          <p className="mt-1 text-sm text-ink-2">This page has not been read yet; try again in a minute.</p>
        ) : (
          <div className="mt-2 max-h-[420px] space-y-3 overflow-auto rounded-md border border-line bg-surface-2 p-3 text-sm">
            {route.sections.map((section, index) => (
              <div key={`${section.stableKey}:${index}`}>
                {section.heading ? <h3 className="font-medium text-ink">{section.heading}</h3> : null}
                <p className="whitespace-pre-wrap text-ink-2">{section.text}</p>
              </div>
            ))}
            {route.sectionCount > route.sections.length ? (
              <p className="text-[13px] text-ink-3">{route.sectionCount - route.sections.length} more sections not shown.</p>
            ) : null}
          </div>
        )}
      </section>

      {card.canDecide ? (
        <form
          action={ROUTE_ACTION}
          className="mt-6 space-y-5"
          method="post"
          onSubmit={(event) => {
            const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            setSubmitting(submitter?.value ?? "mark");
          }}
        >
          <input name="routeId" type="hidden" value={route.id} />
          {route.currentDocumentId ? <input name="expectedDocumentId" type="hidden" value={route.currentDocumentId} /> : null}
          <fieldset>
            <legend className="text-sm font-medium text-ink">Who will hear this</legend>
            <div className="mt-2 space-y-2">
              {route.audiences.map((audience) => (
                <label className="flex items-start gap-2.5 text-sm text-ink" key={audience.value}>
                  <input
                    className="mt-0.5 size-4 shrink-0 accent-[var(--rv-ink)]"
                    defaultChecked={audience.checked}
                    name="audiences"
                    type="checkbox"
                    value={audience.value}
                  />
                  <span>
                    {audience.label}
                    {audience.detail ? <span className="block text-[13px] text-ink-3">{audience.detail}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {route.state !== "unmarked" ? (
              <Button className="w-full sm:w-auto" disabled={submitting !== null} loading={submitting === "unmark"} name="action" type="submit" value="unmark" variant="secondary">
                Unmark
              </Button>
            ) : null}
            {route.state === "unmarked" ? (
              <Button className="w-full sm:w-auto" disabled={submitting !== null} loading={submitting === "mark"} name="action" type="submit" value="mark" variant="primary">
                Mark
              </Button>
            ) : (
              <Button className="w-full sm:w-auto" disabled={submitting !== null} loading={submitting === "reapprove"} name="action" type="submit" value="reapprove" variant="primary">
                Re-approve
              </Button>
            )}
          </div>
        </form>
      ) : (
        <ReadOnlyNotice />
      )}
    </StandaloneCard>
  );
}

function Audience({ items }: { items: string[] }) {
  return (
    <div className="mt-5">
      <h2 className="text-sm font-medium text-ink">Who will hear this</h2>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item}>
            <Badge>{item}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReadOnlyNotice() {
  return (
    <Notice className="mt-6" title="View only" tone="info">
      Only project admins can decide this.
    </Notice>
  );
}

function closedTitle(status: string) {
  switch (status) {
    case "approved":
      return "Already approved";
    case "rejected":
      return "Already declined";
    case "expired":
      return "This expired";
    default:
      return "This is closed";
  }
}
