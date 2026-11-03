"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { useOrgKey } from "@/features/shell/workspace";
import { api } from "@/lib/api/client";
import type { AgentGrantRow, ConnectionDetail, ToolPolicy, ToolRow, UsageRow } from "@/server/connectors/console-client";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Select } from "@/ui/form";
import { Skeleton } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { RevokeGrantDialog } from "./agent-grants-section";
import {
  activityView,
  capabilityLabel,
  connectorErrorText,
  conversationLabel,
  detailEndpoint,
  grantOperator,
  grantTitle,
  groupTools,
  isMissingRoute,
  newestGrantsFirst,
  retryConnectorQuery,
  sharedConversationsText,
  stricterPolicy,
  TOOL_POLICY_LABELS,
  toolPolicyHint,
  toolPolicyOptions,
  toolPolicyValue,
  toolsEndpoint,
  usageDetails,
  usageTitle,
  type Connection,
  type ConnectionDetailResponse,
} from "./model";

const ACTIVITY_LIMIT = 20;

/** Cache key of one connection's detail, under the list's key so list refreshes refresh it too. */
export function useDetailKey(connectionId: string | null | undefined) {
  const orgKey = useOrgKey();
  return orgKey("connectors", "detail", connectionId ?? "none");
}

/**
 * The drawer's tools, usage and activity. With `enabled: false` it only reads
 * what the cache already has, so the Disconnect dialog can list what stops
 * without loading anything.
 */
export function useConnectionDetail(connectionId: string | null | undefined, enabled = true) {
  const key = useDetailKey(connectionId);
  return useQuery({
    enabled: Boolean(connectionId) && enabled,
    queryFn: () => api.post<ConnectionDetailResponse>(detailEndpoint(connectionId as string)),
    queryKey: key,
    retry: retryConnectorQuery,
    select: (response) => response.connection,
  });
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-ink">{children}</h3>;
}

function DetailError({ error, onRetry, retrying }: { error: unknown; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-[13px] text-err" role="alert">
        {connectorErrorText(error)}
      </p>
      <Button icon={RefreshCw} loading={retrying} onClick={onRetry} size="sm" variant="ghost">
        Try again
      </Button>
    </div>
  );
}

/** The detail while it loads, or why it didn't; `title` names what the drawer is waiting for. */
function DetailNotReady({ detail, title }: { detail: ReturnType<typeof useConnectionDetail>; title: string }) {
  if (detail.isPending) {
    return (
      <div aria-busy aria-label={`Loading ${title.toLowerCase()}`} className="space-y-3 border-t border-line pt-5" role="status">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  return (
    <section className="space-y-2 border-t border-line pt-5">
      <SectionTitle>{title}</SectionTitle>
      {isMissingRoute(detail.error) ? (
        // The connectors service is updated after the Console; the connection itself is fine.
        <p className="text-[13px] text-ink-3">{title} aren&apos;t available yet.</p>
      ) : (
        <DetailError error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
      )}
    </section>
  );
}

/** Tools, Used by, the agents allowed and Recent activity of one connection, loaded once the drawer opens. */
export function ConnectionDetailSections({ connection }: { connection: Connection }) {
  const detail = useConnectionDetail(connection.id);
  if (!detail.isSuccess) return <DetailNotReady detail={detail} title="Tools and activity" />;
  return (
    <>
      <ToolsSection detail={detail.data} />
      <UsedBySection usage={detail.data.usage} />
      <AgentsAllowedSection grants={detail.data.grants} />
      <ActivitySection detail={detail.data} />
    </>
  );
}

/**
 * Only the Tools of one connection, for a drawer that shows the rest its own
 * way (an organization account's). `description` replaces the line under
 * the title when someone other than the viewer answers the approvals.
 */
export function ConnectionToolsSection({ connectionId, description }: { connectionId: string; description?: string }) {
  const detail = useConnectionDetail(connectionId);
  if (!detail.isSuccess) return <DetailNotReady detail={detail} title="Tools" />;
  return <ToolsSection description={description} detail={detail.data} />;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function ToolsSection({ description, detail }: { description?: string; detail: ConnectionDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = useDetailKey(detail.id);
  const change = useMutation({
    mutationFn: (input: { capability: string; policy: ToolPolicy }) =>
      api.post<{ status: "ok"; ok: boolean }>(toolsEndpoint(detail.id), input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    onSuccess: (_result, input) => {
      // Show the saved rule at once; the refetch then brings the Worker's view.
      queryClient.setQueryData<ConnectionDetailResponse>(key, (current) =>
        current
          ? {
              ...current,
              connection: {
                ...current.connection,
                tools: current.connection.tools.map((item) =>
                  item.capability === input.capability
                    ? { ...item, policy: stricterPolicy(input.policy, item.ceiling), userPolicy: input.policy }
                    : item,
                ),
              },
            }
          : current,
      );
      const tool = detail.tools.find((item) => item.capability === input.capability);
      toast.show(`${tool?.label ?? input.capability}: ${TOOL_POLICY_LABELS[input.policy]}.`);
    },
  });
  const groups = groupTools(detail.tools);

  return (
    <section className="space-y-3 border-t border-line pt-5">
      <div className="space-y-0.5">
        <SectionTitle>Tools</SectionTitle>
        <p className="text-[13px] text-ink-3">{description ?? "What agents may do with this account without asking you first."}</p>
      </div>
      {groups.length === 0 ? (
        <p className="text-[13px] text-ink-3">This connection has no tools to set yet.</p>
      ) : (
        groups.map((group) => (
          <div className="space-y-1" key={group.key}>
            <h4 className="text-[13px] font-medium text-ink-2">{group.title}</h4>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {group.tools.map((tool) => (
                <ToolPolicyRow
                  error={
                    change.isError && change.variables?.capability === tool.capability
                      ? connectorErrorText(change.error, "policy")
                      : null
                  }
                  key={tool.capability}
                  locked={change.isPending}
                  onChange={(policy) => change.mutate({ capability: tool.capability, policy })}
                  pending={change.isPending && change.variables?.capability === tool.capability ? change.variables.policy : null}
                  tool={tool}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function ToolPolicyRow({
  error,
  locked,
  onChange,
  pending,
  tool,
}: {
  error: string | null;
  /** Another rule is being saved; one change at a time. */
  locked: boolean;
  onChange: (policy: ToolPolicy) => void;
  /** The rule being saved, shown until the save settles. */
  pending: ToolPolicy | null;
  tool: ToolRow;
}) {
  const hint = toolPolicyHint(tool);
  const value = pending ?? toolPolicyValue(tool);
  return (
    <li className="space-y-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className={tool.available ? "text-sm text-ink" : "text-sm text-ink-3"}>{tool.label}</span>
        <Select
          aria-label={`Rule for ${tool.label}`}
          className="h-8 w-[160px] text-[13px]"
          disabled={!tool.available || locked}
          onChange={(event) => onChange(event.target.value as ToolPolicy)}
          value={value}
        >
          {toolPolicyOptions(tool).map((option) => (
            <option disabled={option.disabled} key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {hint ? <p className="text-[12.5px] text-ink-3">{hint}</p> : null}
      {error ? (
        <p className="text-[12.5px] text-err" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Used by
// ---------------------------------------------------------------------------

/** One "Used by" entry: who, where, how, and when last. */
export function UsageItem({ row }: { row: UsageRow }) {
  return (
    <li className="space-y-0.5 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm text-ink">{usageTitle(row)}</span>
        {row.lastUsedAt ? (
          <span className="text-[12.5px] text-ink-3">
            <RelativeTime value={row.lastUsedAt} />
          </span>
        ) : null}
      </div>
      <p className="text-[12.5px] text-ink-3">{usageDetails(row)}</p>
    </li>
  );
}

function UsedBySection({ usage }: { usage: UsageRow[] }) {
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <SectionTitle>Used by</SectionTitle>
      {usage.length === 0 ? (
        <p className="text-[13px] text-ink-3">No agent or command has used this account yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {usage.map((row, index) => (
            <UsageItem key={`${row.installationId ?? "none"}:${row.agentId ?? ""}:${row.routineKey ?? ""}:${row.mode}:${index}`} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agents allowed to use it
// ---------------------------------------------------------------------------

/** The grants that use this account: agents allowed when the person asks, or where it is shared. Hidden when none. */
function AgentsAllowedSection({ grants }: { grants: AgentGrantRow[] }) {
  const [revoking, setRevoking] = useState<AgentGrantRow | null>(null);
  if (!grants.length) return null;
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <div className="space-y-0.5">
        <SectionTitle>Agents allowed</SectionTitle>
        <p className="text-[13px] text-ink-3">These agents use this account when you ask them something.</p>
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {newestGrantsFirst(grants).map((grant) => {
          const meta =
            grant.mode === "shared"
              ? ["Shared account", sharedConversationsText(grant.conversations)]
              : [grantOperator(grant), grant.createdAt ? `Since ${formatDate(grant.createdAt)}` : null];
          return (
            <li className="flex items-center justify-between gap-3 px-3 py-2.5" key={grant.id}>
              <div className="min-w-0 space-y-0.5">
                <div className="truncate text-sm text-ink">{grantTitle(grant)}</div>
                <p className="text-[12.5px] text-ink-3">{meta.filter(Boolean).join(" · ")}</p>
              </div>
              {grant.mode === "person_asking" ? (
                <Button className="shrink-0" onClick={() => setRevoking(grant)} size="sm" variant="ghost">
                  Revoke
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <RevokeGrantDialog grant={revoking} onClose={() => setRevoking(null)} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

function ActivitySection({ detail }: { detail: ConnectionDetail }) {
  const rows = detail.activity.slice(0, ACTIVITY_LIMIT);
  return (
    <section className="space-y-3 border-t border-line pt-5">
      <div className="space-y-0.5">
        <SectionTitle>Recent activity</SectionTitle>
        <p className="text-[13px] text-ink-3">The last {ACTIVITY_LIMIT} actions. What was read or sent is never kept here.</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-3">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {rows.map((row, index) => {
            const tool = capabilityLabel(row.capability, detail.tools);
            const { badge, text } = activityView(row);
            const meta = [row.agentId ? `Agent ${row.agentId}` : null, conversationLabel(row.conversation)].filter(Boolean);
            return (
              <li className="flex items-start justify-between gap-3 px-3 py-2.5" key={`${row.at}:${index}`}>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <span>{tool ? `${tool} · ${text}` : text}</span>
                    {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
                  </div>
                  {meta.length ? <p className="text-[12.5px] text-ink-3">{meta.join(" · ")}</p> : null}
                </div>
                <span className="shrink-0 text-[12.5px] text-ink-3">
                  <RelativeTime value={row.at} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
