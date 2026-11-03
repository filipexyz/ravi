"use client";

import { useMutation } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, Clock3, Info, Lock, Plus, RefreshCw, ShieldCheck, X, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { StandaloneCard, StateCard } from "@/features/account/state-card";
import { SignedInAs, StandaloneFrame } from "@/features/account/standalone-frame";
import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import type { ConsentPageState } from "@/server/connectors/consent";
import type { ConsentDecision } from "@/server/connectors/console-client";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { DetailList, Mono } from "@/ui/layout";
import { Notice } from "@/ui/states";
import { formatDate } from "@/ui/time";
import {
  CONSENT_DECIDE_ENDPOINT,
  connectorErrorText,
  connectStartBody,
  consentAgentName,
  consentChoice,
  consentDecideBody,
  consentDecisionCopy,
  consentOperator,
  CONSENT_WRITES_LINE,
  consentStateCopy,
  consentTitle,
  consentTrustLine,
  consentView,
  providerName,
  type ConsentDecideResponse,
  type Copy,
} from "./model";
import { ProviderMark } from "./provider-mark";
import { useStartConnect } from "./use-start-connect";

type Viewer = { email: string; name: string };
type PendingState = Extract<ConsentPageState, { state: "pending" }>;

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
 * `/connectors/consent/<token>`: an agent asks once to use the person's
 * account whenever they ask it something. Opening it decides nothing (chat
 * apps fetch links for previews); only Approve and Deny act, and only for the
 * person the request was made for.
 */
export function ConsentScreen({ state, token, viewer }: { state: ConsentPageState; token: string; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      {state.state === "pending" ? (
        <PendingConsent state={state} token={token} />
      ) : state.state === "denied" ? (
        <BlockedCard copy={consentStateCopy(state.reason)} />
      ) : state.state === "unavailable" ? (
        <UnavailableCard />
      ) : state.state === "expired" ? (
        <BlockedCard copy={consentStateCopy("expired")} tone="warn" />
      ) : state.state === "invalid" ? (
        <BlockedCard copy={consentStateCopy("invalid")} tone="err" />
      ) : (
        <BlockedCard copy={consentStateCopy(state.state)} />
      )}
    </StandaloneFrame>
  );
}

function UnavailableCard() {
  const router = useRouter();
  const copy = consentStateCopy("unavailable");
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

type Decided = { status: string; email: string | null; followsDefault: boolean };

function PendingConsent({ state, token }: { state: PendingState; token: string }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [decided, setDecided] = useState<Decided | null>(null);
  const provider = providerName(state.provider);
  const agent = consentAgentName(state);
  const operator = consentOperator(state);
  // Read on every render: after a failed answer the page reloads the list,
  // and an account that left it can't stay chosen.
  const chosen = consentChoice(state.connections, picked);
  const chosenAccount = state.connections.find((connection) => connection.id === chosen) ?? null;

  const decide = useMutation({
    mutationFn: (input: { decision: ConsentDecision; chosen: string | null }) =>
      api.post<ConsentDecideResponse>(
        CONSENT_DECIDE_ENDPOINT,
        consentDecideBody({ chosen: input.chosen, connections: state.connections, decision: input.decision, token }),
      ),
    onError: (error) => {
      // The request changed state (answered elsewhere, expired): show what it is now.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== "forbidden") {
        router.refresh();
      }
    },
    onSuccess: (result, input) => {
      const account = state.connections.find((connection) => connection.id === input.chosen) ?? null;
      setDecided({ email: account?.email ?? null, followsDefault: Boolean(account?.isDefault), status: result.consentStatus });
    },
  });

  if (decided) return <DecidedCard agent={agent} decided={decided} provider={provider} />;
  if (consentView(state, state.checkedAt) === "expired") return <BlockedCard copy={consentStateCopy("expired")} tone="warn" />;

  const busy = decide.isPending ? (decide.variables?.decision ?? null) : null;
  const hasAccounts = state.connections.length > 0;
  const chosenName = chosenAccount?.email ?? `your ${provider} account`;

  return (
    <StandaloneCard>
      <ProviderMark provider={state.provider} size="lg" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">{consentTitle(state)}</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        Allow it once and it uses your account only for what you ask it. Nothing is allowed until you answer.
      </p>

      <DetailList
        className={cn("mt-5", DETAIL_GRID)}
        items={[
          {
            key: "agent",
            label: "Agent",
            value:
              agent !== state.agentId ? (
                <span className="flex flex-wrap items-baseline gap-x-2">
                  {agent}
                  <Mono className="text-ink-3">{state.agentId}</Mono>
                </span>
              ) : (
                <Mono>{agent}</Mono>
              ),
          },
          { key: "computer", label: "Computer", value: state.installationName ?? "Not named" },
          {
            key: "operator",
            label: "Run by",
            value: operator ?? <span className="text-ink-3">The request didn&apos;t say</span>,
          },
        ]}
      />

      <section aria-label="What it can do" className="mt-5 space-y-2">
        <h2 className="text-sm font-semibold text-ink">What it can do</h2>
        <ul className="space-y-1.5 text-[13px] text-ink-2">
          <li className="flex gap-2">
            <Check aria-hidden className="mt-0.5 shrink-0 text-ok" size={14} />
            Use your {provider} account only when you ask it something in a direct message. Never in groups.
          </li>
          <li className="flex gap-2">
            <Check aria-hidden className="mt-0.5 shrink-0 text-ok" size={14} />
            {CONSENT_WRITES_LINE}
          </li>
          <li className="flex gap-2">
            <Check aria-hidden className="mt-0.5 shrink-0 text-ok" size={14} />
            You can revoke it any time in Connectors.
          </li>
          <li className="flex gap-2">
            <Info aria-hidden className="mt-0.5 shrink-0 text-ink-3" size={14} />
            {consentTrustLine(state)}
          </li>
        </ul>
      </section>

      <section className="mt-6 space-y-2">
        <h2 className="text-sm font-semibold text-ink">Which account</h2>
        {hasAccounts ? (
          <fieldset className="space-y-0">
            <legend className="sr-only">The account {agent} will use</legend>
            <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              {state.connections.map((connection) => (
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-hover",
                    chosen === connection.id && "bg-hover",
                  )}
                  key={connection.id}
                >
                  <input
                    checked={chosen === connection.id}
                    className="size-4 shrink-0 accent-[var(--rv-ink)]"
                    disabled={decide.isPending}
                    name="consent-account"
                    onChange={() => setPicked(connection.id)}
                    type="radio"
                    value={connection.id}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{connection.email ?? `${provider} account`}</span>
                  {connection.isDefault ? <Badge>Default</Badge> : null}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <NoAccount provider={state.provider} state={state} token={token} />
        )}
      </section>

      {decide.isError ? (
        <div className="mt-5">
          <FormMessage>{connectorErrorText(decide.error, "consent")}</FormMessage>
        </div>
      ) : null}

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          className="w-full sm:w-auto"
          disabled={busy === "approve"}
          icon={X}
          loading={busy === "deny"}
          onClick={() => decide.mutate({ chosen, decision: "deny" })}
          variant="danger"
        >
          Deny
        </Button>
        <Button
          className="w-full sm:w-auto"
          disabled={!hasAccounts || !chosen || busy === "deny"}
          icon={Check}
          loading={busy === "approve"}
          onClick={() => decide.mutate({ chosen, decision: "approve" })}
          variant="primary"
        >
          Approve
        </Button>
      </div>

      <p className="mt-5 text-[13px] text-ink-3">
        {hasAccounts
          ? chosenAccount?.isDefault
            ? `If you approve, ${agent} uses your default ${provider} account (${chosenName} now) the next time you ask it something, and follows it if you change the default. `
            : `If you approve, ${agent} uses ${chosenName} the next time you ask it something. `
          : ""}
        This request expires {formatDate(state.expiresAt, true)}.
      </p>
    </StandaloneCard>
  );
}

/**
 * No account to choose yet. Connecting happens in the selected organization,
 * so a person looking at another one switches to the request's first.
 */
function NoAccount({ provider, state, token }: { provider: string; state: PendingState; token: string }) {
  const connect = useStartConnect();
  const name = providerName(provider);
  return (
    <Notice icon={ShieldCheck} title={`You have no ${name} account connected in ${state.organization.name}`} tone="info">
      <p>Connect one, then open this link again to approve. Until then you can only deny.</p>
      <div className="mt-3">
        {state.organization.selected ? (
          <>
            <Button
              iconRight={ArrowUpRight}
              loading={connect.busyKey === "consent"}
              onClick={() => connect.start({ body: connectStartBody(provider), key: "consent" })}
              size="sm"
            >
              Connect an account
            </Button>
            {connect.error ? (
              <p className="mt-2 text-[13px] text-err" role="alert">
                {connectorErrorText(connect.error, "connect")}
              </p>
            ) : null}
          </>
        ) : (
          <form action="/api/console/organizations/select" method="post">
            <input name="organizationId" type="hidden" value={state.organization.id} />
            <input name="returnTo" type="hidden" value={`/connectors/consent/${encodeURIComponent(token)}`} />
            <Button icon={Plus} size="sm" type="submit">
              Switch to {state.organization.name} to connect
            </Button>
          </form>
        )}
      </div>
    </Notice>
  );
}

function DecidedCard({ agent, decided, provider }: { agent: string; decided: Decided; provider: string }) {
  const { email, followsDefault, status } = decided;
  const copy = consentDecisionCopy(status, { agent, email, followsDefault, provider });
  if (status === "expired") return <BlockedCard copy={copy} tone="warn" />;
  const allowed = status !== "denied";
  return (
    <StateCard actions={CONNECTORS_BUTTON} icon={allowed ? Check : X} title={copy.title} tone={allowed ? "ok" : "neutral"}>
      <p>{copy.description}</p>
    </StateCard>
  );
}
