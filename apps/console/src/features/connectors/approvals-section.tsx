"use client";

import { useQuery } from "@tanstack/react-query";
import { Hourglass, RefreshCw } from "lucide-react";

import { useOrgKey } from "@/features/shell/workspace";
import { api } from "@/lib/api/client";
import { Button } from "@/ui/button";
import { Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { RelativeTime } from "@/ui/time";
import {
  APPROVALS_ENDPOINT,
  approvalHref,
  approvalSummaryLine,
  approvalView,
  connectorErrorText,
  isMissingRoute,
  isNotConfigured,
  retryConnectorQuery,
  type ApprovalsResponse,
} from "./model";

/**
 * "Waiting for you": writes agents asked to run with the person's accounts,
 * each opening its approval page. Hidden when nothing waits.
 */
export function WaitingForYouSection({ className }: { className?: string }) {
  const orgKey = useOrgKey();
  const query = useQuery({
    queryFn: () => api.post<ApprovalsResponse>(APPROVALS_ENDPOINT),
    queryKey: orgKey("connectors", "approvals"),
    // Requests last 15 minutes; a stale list would offer expired ones. A service
    // without approvals yet has nothing to poll for.
    refetchInterval: (current) => (isMissingRoute(current.state.error) ? false : 30_000),
    retry: retryConnectorQuery,
    select: (response) => (response.approvals ?? []).filter((approval) => approvalView({ ...approval, status: "pending" }) === "pending"),
  });

  if (query.isPending) return null;
  if (query.isError) {
    // The connections list says when the service isn't set up, and a service
    // without approvals yet has none waiting; nothing to add here.
    if (isNotConfigured(query.error) || isMissingRoute(query.error)) return null;
    return (
      <div className={className}>
        <div className="flex flex-wrap items-center gap-3 px-1">
          <p className="text-[13px] text-err" role="alert">
            Requests waiting for your approval couldn&apos;t load. {connectorErrorText(query.error)}
          </p>
          <Button icon={RefreshCw} loading={query.isFetching} onClick={() => void query.refetch()} size="sm" variant="ghost">
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (query.data.length === 0) return null;

  return (
    <Section
      className={className}
      description="Agents asked to do these with your accounts. Nothing happens until you answer."
      title="Waiting for you"
    >
      <List label="Waiting for your approval">
        {query.data.map((approval) => (
          <ListRow
            chevron
            description={
              <>
                {approvalSummaryLine(approval)} · expires <RelativeTime value={approval.expiresAt} />
              </>
            }
            href={approvalHref(approval.id)}
            key={approval.id}
            leading={
              <span className="inline-flex size-8 items-center justify-center rounded-md bg-warn-soft text-warn">
                <Hourglass aria-hidden size={16} />
              </span>
            }
            title={approval.label}
          />
        ))}
      </List>
    </Section>
  );
}
