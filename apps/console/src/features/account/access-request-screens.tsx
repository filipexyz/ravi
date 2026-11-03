"use client";

import { CheckCircle2, Clock, KeyRound, Lock, XCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { Field, Textarea } from "@/ui/form";
import { DetailList } from "@/ui/layout";
import { Notice } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { SignedInAs, StandaloneFrame } from "./standalone-frame";
import { IconTile, StandaloneCard, StateCard } from "./state-card";

type Viewer = { email: string; name: string };
type Copy = { title: string; description: string };

export type AccessRequestStatus = "pending" | "approved" | "denied" | "cancelled" | "expired";

export type AccessRequestFormState =
  | { kind: "form"; host: string; path: string; returnTo: string; error?: string | null }
  | { kind: "error"; copy: Copy };

export type AccessRequestDecisionState =
  | { kind: "invalid" }
  | { kind: "not_allowed" }
  | {
      kind: "requester";
      justSent: boolean;
      pageUrl: string;
      request: { expiresAt: string; host: string; path: string; status: AccessRequestStatus; url: string };
    }
  | {
      kind: "approver";
      error?: string | null;
      request: {
        agentName: string | null;
        createdAt: string;
        decidedAt: string | null;
        expiresAt: string;
        host: string;
        id: string;
        message: string | null;
        organizationName: string;
        pageUrl: string;
        path: string;
        requester: { email: string; name: string | null };
        routeMatched: boolean;
        status: AccessRequestStatus;
        via: "page" | "cli";
      };
    };

/** `/access/request?returnTo=`: ask for access to a private page. */
export function AccessRequestFormScreen({ state, viewer }: { state: AccessRequestFormState; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      {state.kind === "error" ? (
        <StateCard icon={XCircle} title={state.copy.title} tone="err">
          <p>{state.copy.description}</p>
        </StateCard>
      ) : (
        <RequestForm state={state} viewer={viewer} />
      )}
    </StandaloneFrame>
  );
}

function RequestForm({ state, viewer }: { state: Extract<AccessRequestFormState, { kind: "form" }>; viewer: Viewer }) {
  const [submitting, setSubmitting] = useState(false);
  return (
    <StandaloneCard>
      <IconTile icon={Lock} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">Ask for access</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        This page is private. The people who manage it will see your request with your email, {viewer.email}.
      </p>

      <DetailList
        className="mt-5 border-y border-line [&>div]:grid-cols-[112px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5 sm:[&>div]:grid-cols-[140px_minmax(0,1fr)]"
        items={[{ label: "Page", value: <span className="break-all font-mono text-[13px]">{state.host + state.path}</span> }]}
      />

      {state.error ? (
        <Notice className="mt-5" title="The request was not sent" tone="err">
          {state.error}
        </Notice>
      ) : null}

      <form
        action="/api/console/access/requests/create"
        className="mt-5 space-y-5"
        method="post"
        onSubmit={() => setSubmitting(true)}
      >
        <input name="returnTo" type="hidden" value={state.returnTo} />
        <Field hint="Say who you are and why you need it." label="Message" optional>
          {(props) => <Textarea {...props} maxLength={500} name="message" placeholder="Hi, I'm reviewing the weekly report." />}
        </Field>
        <div className="flex justify-end">
          <Button className="w-full sm:w-auto" loading={submitting} type="submit" variant="primary">
            Send request
          </Button>
        </div>
      </form>
    </StandaloneCard>
  );
}

/** `/access/requests/:id`: the forwardable link. Opening it changes nothing. */
export function AccessRequestDecisionScreen({ state, viewer }: { state: AccessRequestDecisionState; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      <DecisionBody state={state} />
    </StandaloneFrame>
  );
}

function DecisionBody({ state }: { state: AccessRequestDecisionState }) {
  if (state.kind === "invalid") {
    return (
      <StateCard icon={XCircle} title="This request link is not valid" tone="err">
        <p>Check that you copied the whole link, or ask whoever sent it for it again.</p>
      </StateCard>
    );
  }

  if (state.kind === "not_allowed") {
    return (
      <StateCard icon={KeyRound} title="Only the page's managers can approve this" tone="warn">
        <p>
          Someone asked for access to a private page. People who can publish to its project approve it. If that is you,
          sign in with that account. Otherwise, forward this link to them.
        </p>
      </StateCard>
    );
  }

  if (state.kind === "requester") return <RequesterView state={state} />;
  return <ApproverView state={state} />;
}

function RequesterView({ state }: { state: Extract<AccessRequestDecisionState, { kind: "requester" }> }) {
  const page = state.request.host + state.request.path;
  if (state.request.status === "approved") {
    return (
      <StateCard
        actions={
          <Button external href={state.pageUrl} variant="primary">
            Open the page
          </Button>
        }
        icon={CheckCircle2}
        title="Your access was approved"
        tone="ok"
      >
        <p>You can now open {page}.</p>
      </StateCard>
    );
  }
  if (state.request.status !== "pending") {
    return (
      <StateCard icon={XCircle} title={state.request.status === "denied" ? "Your request was declined" : "This request is closed"} tone="err">
        <p>
          {state.request.status === "denied"
            ? `The people who manage ${page} declined it.`
            : "It expired or was replaced by a newer request. Ask again from the page if you still need it."}
        </p>
      </StateCard>
    );
  }
  return (
    <StandaloneCard>
      <IconTile icon={Clock} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">
        {state.justSent ? "Request sent" : "Waiting for approval"}
      </h1>
      <p className="mt-1.5 text-sm text-ink-2">
        The people who manage {page} were told. If you know who manages it, send them this link: anyone can open it, and only
        they can approve.
      </p>
      <div className="mt-5 flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{state.request.url}</span>
        <CopyButton label="Copy link" value={state.request.url} variant="secondary">
          Copy link
        </CopyButton>
      </div>
      <p className="mt-5 text-[13px] text-ink-3">
        The request stays open until <RelativeTime value={state.request.expiresAt} />, on{" "}
        {formatDate(state.request.expiresAt, true)}.
      </p>
    </StandaloneCard>
  );
}

function ApproverView({ state }: { state: Extract<AccessRequestDecisionState, { kind: "approver" }> }) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const request = state.request;
  const who = request.requester.name && request.requester.name !== request.requester.email
    ? `${request.requester.name} (${request.requester.email})`
    : request.requester.email;
  const page = request.host + request.path;

  if (request.status !== "pending") {
    return (
      <StateCard
        icon={request.status === "approved" ? CheckCircle2 : XCircle}
        title={
          request.status === "approved"
            ? "This request was approved"
            : request.status === "denied"
              ? "This request was declined"
              : "This request is closed"
        }
        tone={request.status === "approved" ? "ok" : "neutral"}
      >
        <p>
          {request.status === "approved"
            ? `${who} can open ${page}. Manage who has access from the site's sharing panel.`
            : `Nothing was shared with ${who}.`}
        </p>
      </StateCard>
    );
  }

  return (
    <StandaloneCard>
      <IconTile icon={KeyRound} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">Approve access?</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {who} asked to see a private page of {request.organizationName}
        {request.via === "cli" ? `, through ${request.agentName ? `the agent ${request.agentName}` : "an agent"}` : ""}.
      </p>

      <DetailList
        className="mt-5 border-y border-line [&>div]:grid-cols-[112px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5 sm:[&>div]:grid-cols-[140px_minmax(0,1fr)]"
        items={[
          { label: "Page", value: <span className="break-all font-mono text-[13px]">{page}</span> },
          { label: "Person", value: who },
          ...(request.message ? [{ label: "Message", value: <span className="whitespace-pre-wrap">{request.message}</span> }] : []),
          { label: "Asked", value: <RelativeTime value={request.createdAt} /> },
        ]}
      />

      {state.error ? (
        <Notice className="mt-5" title="Nothing changed" tone="err">
          {state.error}
        </Notice>
      ) : null}

      <Notice className="mt-5" title="What they get" tone="info">
        {request.routeMatched
          ? "Only this page, unless you give the whole site. They don't join the organization and see nothing else."
          : "No single page matched, so approving gives every private page of this site. They don't join the organization."}
      </Notice>

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DecisionForm decision="deny" id={request.id} onSubmit={setSubmitting} submitting={submitting} />
        {request.routeMatched ? (
          <DecisionForm decision="approve" id={request.id} onSubmit={setSubmitting} scope="site" submitting={submitting} />
        ) : null}
        <DecisionForm
          decision="approve"
          id={request.id}
          onSubmit={setSubmitting}
          primary
          scope={request.routeMatched ? "route" : "site"}
          submitting={submitting}
        />
      </div>
    </StandaloneCard>
  );
}

function DecisionForm({
  decision,
  id,
  onSubmit,
  primary,
  scope,
  submitting,
}: {
  decision: "approve" | "deny";
  id: string;
  onSubmit: (key: string) => void;
  primary?: boolean;
  scope?: "route" | "site";
  submitting: string | null;
}) {
  const key = `${decision}:${scope ?? ""}`;
  const label = decision === "deny" ? "Decline" : scope === "site" && !primary ? "Give the whole site" : primary && scope === "route" ? "Give this page" : "Approve";
  return (
    <form action="/api/console/access/requests/decide" method="post" onSubmit={() => onSubmit(key)}>
      <input name="id" type="hidden" value={id} />
      <input name="decision" type="hidden" value={decision} />
      {scope ? <input name="scope" type="hidden" value={scope} /> : null}
      <Button
        className="w-full sm:w-auto"
        disabled={submitting !== null && submitting !== key}
        loading={submitting === key}
        type="submit"
        variant={primary ? "primary" : "secondary"}
      >
        {label}
      </Button>
    </form>
  );
}
