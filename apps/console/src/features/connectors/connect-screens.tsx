"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, Clock3, Lock, RefreshCw, ShieldCheck, Terminal, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { InlineText, StandaloneCard, StateCard } from "@/features/account/state-card";
import { SignedInAs, StandaloneFrame } from "@/features/account/standalone-frame";
import { api, ApiError } from "@/lib/api/client";
import type { ConnectPageState } from "@/server/connectors/connect-grants";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { DetailList } from "@/ui/layout";
import { Notice, Skeleton } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import {
  CONNECT_CONTINUE_ENDPOINT,
  CONNECT_FINISH_ENDPOINT,
  connectableProvider,
  connectLinkCopy,
  connectorErrorText,
  FINISH_OTHER_BROWSER_COPY,
  finishConnectedView,
  finishRejectedCopy,
  finishStateCopy,
  providerName,
  type ConnectContinueResponse,
  type ConnectFinishResponse,
  type Copy,
} from "./model";
import { ProviderMark } from "./provider-mark";
import { ReconnectNotice } from "./reconnect-notice";

type Viewer = { email: string; name: string };

const CONNECTORS_BUTTON = (
  <Button href="/connectors" iconRight={ArrowRight} variant="secondary">
    Go to Connectors
  </Button>
);

function BlockedCard({ copy, tone = "err" }: { copy: Copy; tone?: "err" | "warn" | "neutral" }) {
  return (
    <StateCard actions={CONNECTORS_BUTTON} icon={tone === "neutral" ? Lock : tone === "warn" ? Clock3 : XCircle} title={copy.title} tone={tone}>
      <p>
        <InlineText text={copy.description} />
      </p>
    </StateCard>
  );
}

// ---------------------------------------------------------------------------
// /connect/<token>
// ---------------------------------------------------------------------------

/**
 * A connect link opened in the browser. Opening it changes nothing (chat apps
 * fetch links for previews); only "Continue" acts, and only for the person
 * who started it.
 */
export function ConnectLinkScreen({ state, token, viewer }: { state: ConnectPageState; token: string; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      {state.state === "pending" ? (
        <PendingConnect state={state} token={token} viewer={viewer} />
      ) : state.state === "denied" ? (
        <BlockedCard copy={connectLinkCopy(state.reason)} tone="neutral" />
      ) : state.state === "expired" ? (
        <BlockedCard copy={connectLinkCopy("expired")} tone="warn" />
      ) : state.state === "used" ? (
        <BlockedCard copy={connectLinkCopy("used")} tone="neutral" />
      ) : state.state === "disabled_by_org" ? (
        <BlockedCard copy={connectLinkCopy("disabled_by_org")} tone="neutral" />
      ) : (
        <BlockedCard copy={connectLinkCopy(state.state)} />
      )}
    </StandaloneFrame>
  );
}

function PendingConnect({
  state,
  token,
  viewer,
}: {
  state: Extract<ConnectPageState, { state: "pending" }>;
  token: string;
  viewer: Viewer;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const provider = providerName(state.provider);
  const catalog = connectableProvider(state.provider);
  const readOnly = state.accessMode === "read_only";
  const permissions = catalog ? (readOnly ? catalog.readOnlyPermissions : catalog.permissions) : [];

  const proceed = useMutation({
    mutationFn: () => api.post<ConnectContinueResponse>(CONNECT_CONTINUE_ENDPOINT, { token }),
    onError: (error) => {
      // The link changed state (used, expired, someone else's): show what it is now.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "forbidden") router.refresh();
    },
    onSuccess: (result) => {
      setLeaving(true);
      window.location.assign(result.authorizationUrl);
    },
  });

  const title = state.reconnect
    ? `Reconnect ${state.reconnect.email ?? `your ${provider} account`}`
    : state.scopeKind === "organization"
      ? `Connect an organization ${provider} account`
      : `Connect your ${provider} account`;
  const startedFrom =
    state.origin === "cli"
      ? state.installationName
        ? `The terminal on ${state.installationName}`
        : "The terminal"
      : "Ravi Console";

  return (
    <StandaloneCard>
      <ProviderMark provider={state.provider} size="lg" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">{title}</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {state.origin === "cli"
          ? `You asked to connect ${provider} from the terminal. Continue only if you started this.`
          : `You asked to connect ${provider} from Connectors. Continue only if you started this.`}
      </p>

      <DetailList
        className="mt-5 border-y border-line [&>div]:grid-cols-[112px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5 sm:[&>div]:grid-cols-[140px_minmax(0,1fr)]"
        items={[
          {
            label: "Account",
            value: state.reconnect?.email
              ? `Sign in again as ${state.reconnect.email}`
              : `You choose it on the ${provider} screen`,
          },
          {
            label: "It allows",
            value: (
              <span className="block space-y-1">
                <span className="block">{readOnly ? "Read only: agents can read but never send" : "Full access"}</span>
                {permissions.length ? (
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-2">
                    {permissions.map((permission) => (
                      <span className="inline-flex items-center gap-1" key={permission}>
                        <Check aria-hidden className="text-ok" size={13} />
                        {permission}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            label: "Started from",
            value: (
              <span className="inline-flex items-center gap-1.5">
                {state.origin === "cli" ? <Terminal aria-hidden className="text-ink-3" size={14} /> : null}
                {startedFrom}
              </span>
            ),
          },
        ]}
      />

      <Notice className="mt-5" icon={ShieldCheck} title="It stays yours" tone="info">
        The account connects to your Ravi account, {viewer.email}. Only you can use it, and agents use it only as you allow.
      </Notice>

      {proceed.isError ? (
        <div className="mt-5">
          <FormMessage>
            {proceed.error instanceof ApiError && proceed.error.code === "user_mismatch"
              ? connectLinkCopy("user_mismatch").description
              : connectorErrorText(proceed.error, "connect")}
          </FormMessage>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button className="w-full sm:w-auto" href="/connectors" variant="secondary">
          Cancel
        </Button>
        <Button
          className="w-full sm:w-auto"
          iconRight={ArrowUpRight}
          loading={proceed.isPending || leaving}
          onClick={() => proceed.mutate()}
          variant="primary"
        >
          Continue to {provider}
        </Button>
      </div>

      <p className="mt-5 text-[13px] text-ink-3">
        This link works once and expires <RelativeTime value={state.expiresAt} />, at {formatDate(state.expiresAt, true)}.
      </p>
    </StandaloneCard>
  );
}

// ---------------------------------------------------------------------------
// /connect/finish
// ---------------------------------------------------------------------------

/**
 * Where the provider's sign-in returns. Finishing is idempotent, so the post
 * on mount is safe to repeat (a reload, a second tab). It only finishes in
 * the browser that started or continued the sign-in.
 */
export function ConnectFinishScreen({
  error,
  pendingId,
  resultToken,
  viewer,
}: {
  error: string | null;
  pendingId: string | null;
  resultToken: string | null;
  viewer: Viewer;
}) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      {error ? (
        <BlockedCard copy={finishRejectedCopy(error === "provider_denied" ? "provider_denied" : "unknown")} tone="neutral" />
      ) : !pendingId || !resultToken ? (
        <BlockedCard copy={finishStateCopy("invalid")} tone="neutral" />
      ) : (
        <FinishConnect pendingId={pendingId} resultToken={resultToken} />
      )}
    </StandaloneFrame>
  );
}

function FinishConnect({ pendingId, resultToken }: { pendingId: string; resultToken: string }) {
  const finish = useQuery({
    gcTime: 0,
    queryFn: () => api.post<ConnectFinishResponse>(CONNECT_FINISH_ENDPOINT, { pendingId, resultToken }),
    queryKey: ["connectors", "finish", pendingId],
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => !(error instanceof ApiError && error.status > 0 && error.status < 500) && failureCount < 2,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (finish.isPending) {
    return (
      <StandaloneCard>
        <div aria-busy aria-label="Finishing the connection" className="space-y-4" role="status">
          <Skeleton className="size-11 rounded-md" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </StandaloneCard>
    );
  }

  if (finish.isError) {
    const code = finish.error instanceof ApiError ? finish.error.code : null;
    if (code && ["not_member", "feature_unavailable", "feature_forbidden", "impersonation"].includes(code)) {
      return <BlockedCard copy={connectLinkCopy(code)} tone="neutral" />;
    }
    if (code === "connect_other_browser") return <BlockedCard copy={FINISH_OTHER_BROWSER_COPY} tone="neutral" />;
    return (
      <StateCard
        actions={
          <>
            <Button icon={RefreshCw} loading={finish.isFetching} onClick={() => void finish.refetch()} variant="primary">
              Try again
            </Button>
            {CONNECTORS_BUTTON}
          </>
        }
        icon={XCircle}
        title="We couldn't finish connecting"
        tone="err"
      >
        <p>{connectorErrorText(finish.error, "connect")} Your account may still connect when you try again.</p>
      </StateCard>
    );
  }

  const result = finish.data;
  if (result.state === "rejected") return <BlockedCard copy={finishRejectedCopy(result.reason)} tone="neutral" />;
  if (result.state !== "connected") return <BlockedCard copy={finishStateCopy(result.state)} tone="warn" />;

  const provider = providerName(result.provider);
  const view = finishConnectedView(result);
  return (
    <StandaloneCard>
      <div className="relative w-fit">
        <ProviderMark provider={result.provider} size="lg" />
        <span className="absolute -right-1.5 -bottom-1.5 inline-flex size-5 items-center justify-center rounded-full bg-ok text-surface ring-2 ring-surface">
          <Check aria-hidden size={12} strokeWidth={3} />
        </span>
      </div>
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">{view.title}</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {view.account ? (
          <>
            <span className="font-medium text-ink">{view.account}</span> {view.sentence}
          </>
        ) : (
          view.sentence
        )}
      </p>
      {result.accountChanged ? (
        <ReconnectNotice className="mt-5" email={result.email} listedIn={view.listedIn} provider={provider} />
      ) : null}
      <div className="mt-6 space-y-3 border-t border-line pt-5">
        {result.origin === "cli" ? (
          <>
            <p className="flex items-center gap-2 text-sm font-medium text-ink">
              <Terminal aria-hidden className="text-ink-3" size={16} />
              You can go back to your terminal.
            </p>
            <Button href={view.href} iconRight={ArrowRight} size="sm" variant="ghost">
              {view.linkLabel}
            </Button>
          </>
        ) : (
          <Button href={view.href} iconRight={ArrowRight} variant="primary">
            {view.linkLabel}
          </Button>
        )}
      </div>
    </StandaloneCard>
  );
}
