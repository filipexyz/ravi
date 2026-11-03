"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, Clock3, Lock, RefreshCw, ShieldQuestion, X, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { StandaloneCard, StateCard } from "@/features/account/state-card";
import { SignedInAs, StandaloneFrame } from "@/features/account/standalone-frame";
import { api, ApiError } from "@/lib/api/client";
import type { ApprovalPageState } from "@/server/connectors/approvals";
import type { ApprovalDecision, ApprovalDetail } from "@/server/connectors/console-client";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { DetailList } from "@/ui/layout";
import { Notice } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import {
  approvalAskedBy,
  approvalPreview,
  approvalReasonText,
  approvalStateCopy,
  approvalView,
  approveGate,
  capabilityProvider,
  connectorErrorText,
  decideEndpoint,
  decisionCopy,
  previewGapText,
  type ApprovalDecideResponse,
  type Copy,
} from "./model";
import { ProviderMark } from "./provider-mark";

type Viewer = { email: string; name: string };

const CONNECTORS_BUTTON = (
  <Button href="/connectors" iconRight={ArrowRight} variant="secondary">
    Go to Connectors
  </Button>
);

const DETAIL_GRID =
  "border-y border-line [&>div]:grid-cols-[112px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5 sm:[&>div]:grid-cols-[140px_minmax(0,1fr)]";

function BlockedCard({ copy, tone = "neutral" }: { copy: Copy; tone?: "err" | "warn" | "neutral" }) {
  return (
    <StateCard actions={CONNECTORS_BUTTON} icon={tone === "warn" ? Clock3 : tone === "err" ? XCircle : Lock} title={copy.title} tone={tone}>
      <p>{copy.description}</p>
    </StateCard>
  );
}

/**
 * `/connectors/approvals/<id>`: a write an agent asked to run with one of the
 * person's accounts. Opening it decides nothing (chat apps fetch links for
 * previews); only Approve and Deny act, and only for the account's owner.
 */
export function ApprovalScreen({ state, viewer }: { state: ApprovalPageState; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      {state.state === "ready" ? (
        <ApprovalBody approval={state.approval} checkedAt={state.checkedAt} />
      ) : state.state === "denied" ? (
        <BlockedCard copy={approvalStateCopy(state.reason)} />
      ) : state.state === "unavailable" ? (
        <UnavailableCard />
      ) : (
        <BlockedCard copy={approvalStateCopy("not_found")} />
      )}
    </StandaloneFrame>
  );
}

function UnavailableCard() {
  const router = useRouter();
  const copy = approvalStateCopy("unavailable");
  return (
    <StateCard
      actions={
        <>
          <Button icon={RefreshCw} onClick={() => router.refresh()} variant="primary">
            Try again
          </Button>
          {CONNECTORS_BUTTON}
        </>
      }
      icon={XCircle}
      title={copy.title}
      tone="err"
    >
      <p>{copy.description}</p>
    </StateCard>
  );
}

function ApprovalBody({ approval, checkedAt }: { approval: ApprovalDetail; checkedAt: number }) {
  const router = useRouter();
  const [decided, setDecided] = useState<string | null>(null);
  const [seenGaps, setSeenGaps] = useState(false);
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) =>
      api.post<ApprovalDecideResponse>(decideEndpoint(approval.id), { decision }),
    onError: (error) => {
      // The request changed state (decided elsewhere, expired): show what it is now.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "forbidden") {
        router.refresh();
      }
    },
    onSuccess: (result) => setDecided(result.approvalStatus),
  });

  if (decided) return <DecidedCard status={decided} />;

  const view = approvalView(approval, checkedAt);
  if (view !== "pending") return <BlockedCard copy={approvalStateCopy(view)} tone={view === "expired" ? "warn" : "neutral"} />;

  const provider = capabilityProvider(approval.capability);
  const preview = approvalPreview(approval.preview);
  const askedBy = approvalAskedBy(approval);
  const busy = decide.isPending ? decide.variables : null;
  const gate = approveGate(preview);

  return (
    <StandaloneCard>
      {provider ? (
        <ProviderMark provider={provider} size="lg" />
      ) : (
        <span className="inline-flex size-11 items-center justify-center rounded-md bg-sunken text-ink-3">
          <ShieldQuestion aria-hidden size={20} />
        </span>
      )}
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">{approval.label}</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        An agent wants to do this with{" "}
        {approval.email ? <span className="font-medium text-ink">{approval.email}</span> : "your account"}. Nothing
        happens until you answer.
      </p>

      <Notice className="mt-5" icon={ShieldQuestion} title="Why you're asked" tone="info">
        {approvalReasonText(approval.reason)}.
      </Notice>

      <section aria-label="What it will do" className="mt-5 space-y-3">
        {preview.fields.length ? (
          <DetailList
            className={DETAIL_GRID}
            items={preview.fields.map((field) => ({
              key: field.label,
              label: field.label,
              value: <span className="break-words">{field.value}</span>,
            }))}
          />
        ) : null}
        {preview.body !== null ? (
          <div className="space-y-1.5">
            <div className="text-[13px] font-medium text-ink">Message</div>
            <div
              aria-label="Message excerpt"
              className="max-h-64 overflow-y-auto rounded-md border border-line bg-sunken px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-ink-2"
              role="region"
              tabIndex={0}
            >
              {preview.body || <span className="text-ink-3">(no plain-text message)</span>}
            </div>
          </div>
        ) : null}
        {preview.html !== null ? (
          <div className="space-y-1.5">
            <div className="text-[13px] font-medium text-ink">HTML part</div>
            <p className="text-[12.5px] text-ink-3">
              What most mail apps show. It&apos;s shown here as its markup, so check that it says the same as the message.
            </p>
            <pre
              aria-label="HTML part"
              className="max-h-64 overflow-auto rounded-md border border-line bg-sunken px-3 py-2.5 font-mono text-[12.5px] whitespace-pre-wrap break-words text-ink-2"
              tabIndex={0}
            >
              {preview.html || <span className="text-ink-3">(empty HTML part)</span>}
            </pre>
          </div>
        ) : null}
        {preview.other ? (
          <div className="space-y-1.5">
            <div className="text-[13px] font-medium text-ink">Details</div>
            <pre
              aria-label="Request details"
              className="max-h-64 overflow-auto rounded-md border border-line bg-sunken px-3 py-2.5 font-mono text-[12.5px] text-ink-2"
              tabIndex={0}
            >
              {preview.other}
            </pre>
          </div>
        ) : null}
        {gate === "unavailable" ? (
          <Notice icon={AlertTriangle} title="This request can't be shown" tone="warn">
            Ravi couldn&apos;t read what this request contains, so it can&apos;t be approved. Deny it, and ask the agent
            again if you still want it.
          </Notice>
        ) : preview.gaps.length ? (
          <Notice icon={AlertTriangle} title="Part of this request isn't shown" tone="warn">
            <ul className="list-disc space-y-1 pl-4">
              {preview.gaps.map((gap) => (
                <li key={gap}>{previewGapText(gap)}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
      </section>

      <section className="mt-6 space-y-2">
        <h2 className="text-sm font-semibold text-ink">Who asked</h2>
        {askedBy.length ? (
          <DetailList
            className={DETAIL_GRID}
            items={askedBy.map((item) => ({ key: item.label, label: item.label, value: item.value }))}
          />
        ) : (
          <p className="text-[13px] text-ink-3">The request didn&apos;t say which computer or agent it came from.</p>
        )}
      </section>

      {decide.isError ? (
        <div className="mt-5">
          <FormMessage>{connectorErrorText(decide.error, "decide")}</FormMessage>
        </div>
      ) : null}

      {gate === "confirm" ? (
        <label className="mt-5 flex cursor-pointer items-start gap-2 text-[13px] text-ink-2">
          <input
            checked={seenGaps}
            className="mt-0.5 size-4 shrink-0 accent-[var(--rv-ink)]"
            disabled={decide.isPending}
            onChange={(event) => setSeenGaps(event.target.checked)}
            type="checkbox"
          />
          I understand that part of this request isn&apos;t shown here, and I still want it to run.
        </label>
      ) : null}

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          className="w-full sm:w-auto"
          disabled={busy === "approve"}
          icon={X}
          loading={busy === "deny"}
          onClick={() => decide.mutate("deny")}
          variant="danger"
        >
          Deny
        </Button>
        {gate !== "unavailable" ? (
          <Button
            className="w-full sm:w-auto"
            disabled={busy === "deny" || (gate === "confirm" && !seenGaps)}
            icon={Check}
            loading={busy === "approve"}
            onClick={() => decide.mutate("approve")}
            variant="primary"
          >
            Approve
          </Button>
        ) : null}
      </div>

      <p className="mt-5 text-[13px] text-ink-3">
        {gate === "unavailable" ? "This request" : "Approving lets this exact request run once. It"} expires{" "}
        <RelativeTime value={approval.expiresAt} />, at {formatDate(approval.expiresAt, true)}.
      </p>
    </StandaloneCard>
  );
}

function DecidedCard({ status }: { status: string }) {
  const copy = decisionCopy(status);
  if (status === "expired") return <BlockedCard copy={copy} tone="warn" />;
  const approved = status !== "denied";
  return (
    <StateCard actions={CONNECTORS_BUTTON} icon={approved ? Check : X} title={copy.title} tone={approved ? "ok" : "neutral"}>
      <p>{copy.description}</p>
    </StateCard>
  );
}
