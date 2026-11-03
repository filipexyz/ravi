"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, CircleHelp, Plug, RefreshCw, SearchX } from "lucide-react";
import Link from "@/ui/link";

import { api, ApiError } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { RaviMark } from "@/features/shell/app-shell";
import { Button } from "@/ui/button";
import { Panel } from "@/ui/layout";
import { Skeleton } from "@/ui/states";
import {
  CONNECTIONS_ENDPOINT,
  connectionName,
  connectorErrorText,
  describeScopes,
  isHistory,
  providerName,
  retryConnectorQuery,
  type Connection,
  type ConnectionsResponse,
} from "./model";
import { ProviderMark } from "./provider-mark";

/*
 * This page sits outside the Console shell (the OAuth redirect lands on it
 * with a full page load), so there is no workspace context here. Its cache is
 * fresh on every visit, which is why the keys are not organization-scoped.
 */
const LIST_KEY = ["connectors", "connected", "list"] as const;

const CLI_LINE = "If you started from the terminal, you can go back to it: the CLI has already picked it up.";

/**
 * Where a connectors worker from before `/connect/finish` sends the browser
 * after the provider's sign-in (`?connector=<id>`): confirms the connection
 * in words and points to the list.
 */
export function ConnectedScreen({ connectorId }: { connectorId: string | null }) {
  const list = useQuery({
    enabled: Boolean(connectorId),
    queryFn: () => api.post<ConnectionsResponse>(CONNECTIONS_ENDPOINT, { includeHistory: true }),
    queryKey: LIST_KEY,
    retry: retryConnectorQuery,
    select: (response) => response.connections ?? [],
  });

  const connection = list.data?.find((item) => item.id === connectorId) ?? null;

  return (
    <div className="rv-app flex min-h-dvh flex-col bg-canvas font-sans text-ink antialiased">
      <header className="mx-auto flex h-14 w-full max-w-[1120px] items-center px-4 sm:px-6">
        <Link aria-label="Ravi Console home" className="flex items-center gap-2.5 rounded-md" href="/projects">
          <RaviMark />
          <span className="text-sm font-medium text-ink">Ravi Console</span>
        </Link>
      </header>
      <main className="flex flex-1 justify-center px-4 pt-[6vh] pb-16 sm:pt-[10vh]" id="main">
        <div className="w-full max-w-md">
          <Panel className="p-6 sm:p-7">
            {!connectorId ? (
              <Outcome
                cliLine={false}
                description="This page opens after you connect an account. Your connected accounts are listed in Connectors."
                icon={<StateIcon icon={CircleHelp} />}
                title="Nothing to show here"
              />
            ) : list.isPending ? (
              <div aria-busy aria-label="Loading" className="space-y-4" role="status">
                <Skeleton className="size-11 rounded-full" />
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-9 w-40" />
              </div>
            ) : list.isError ? (
              <Outcome
                description={
                  <>
                    {connectorErrorText(list.error)}{" "}
                    {list.error instanceof ApiError && list.error.code === "server_not_configured"
                      ? "We can't confirm the connection here."
                      : "Your account may still be connected: check your connections."}
                  </>
                }
                extra={
                  <Button icon={RefreshCw} loading={list.isFetching} onClick={() => void list.refetch()}>
                    Try again
                  </Button>
                }
                icon={<StateIcon icon={Plug} tone="warn" />}
                title="We couldn't load this connection"
              />
            ) : !connection ? (
              <Outcome
                description="It may be in another organization, or it was already disconnected. Your connections in the selected organization are listed in Connectors."
                icon={<StateIcon icon={SearchX} />}
                title="This connection isn't in your list"
              />
            ) : isHistory(connection) ? (
              <Outcome
                description={`${connectionName(connection)} was disconnected and has no access anymore. Connect it again from your connections.`}
                icon={<ProviderMark muted provider={connection.provider} size="lg" />}
                title={`${providerName(connection.provider)} connection disconnected`}
              />
            ) : (
              <ConnectedOutcome connection={connection} />
            )}
          </Panel>
        </div>
      </main>
    </div>
  );
}

function ConnectedOutcome({ connection }: { connection: Connection }) {
  const { labels } = describeScopes(connection.scopes);
  return (
    <div className="space-y-5">
      <div className="relative w-fit">
        <ProviderMark provider={connection.provider} size="lg" />
        <span className="absolute -right-1.5 -bottom-1.5 inline-flex size-5 items-center justify-center rounded-full bg-ok text-surface ring-2 ring-surface">
          <Check aria-hidden size={12} strokeWidth={3} />
        </span>
      </div>
      <div className="space-y-1.5">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
          {providerName(connection.provider)} connected: {connectionName(connection)}
        </h1>
        <p className="text-sm text-ink-2">Your agents and the ravi CLI can now use this account, only as you allow.</p>
      </div>
      {labels.length ? (
        <div className="space-y-2">
          <div className="text-[13px] font-medium text-ink">What they can do</div>
          <ul className="space-y-1.5">
            {labels.map((label) => (
              <li className="flex items-center gap-2 text-sm text-ink-2" key={label}>
                <Check aria-hidden className="shrink-0 text-ok" size={15} />
                {label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-3 border-t border-line pt-5">
        <Button className="w-full sm:w-auto" href="/connectors" iconRight={ArrowRight} variant="primary">
          View my connections
        </Button>
        <p className="text-[13px] text-ink-3">{CLI_LINE}</p>
      </div>
    </div>
  );
}

function Outcome({
  cliLine = true,
  description,
  extra,
  icon,
  title,
}: {
  cliLine?: boolean;
  description: React.ReactNode;
  extra?: React.ReactNode;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="space-y-5">
      {icon}
      <div className="space-y-1.5">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="text-sm text-ink-2">{description}</p>
      </div>
      <div className="space-y-3 border-t border-line pt-5">
        <div className="flex flex-wrap gap-2">
          <Button href="/connectors" iconRight={ArrowRight} variant="primary">
            View my connections
          </Button>
          {extra}
        </div>
        {cliLine ? <p className="text-[13px] text-ink-3">{CLI_LINE}</p> : null}
      </div>
    </div>
  );
}

function StateIcon({ icon: Icon, tone = "neutral" }: { icon: typeof Plug; tone?: "neutral" | "warn" }) {
  return (
    <span
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-full",
        tone === "warn" ? "bg-warn-soft text-warn" : "bg-sunken text-ink-3",
      )}
    >
      <Icon aria-hidden size={20} />
    </span>
  );
}
