"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useOrgKey } from "@/features/shell/workspace";
import { api, ApiError } from "@/lib/api/client";
import type { AgentGrantRow } from "@/server/connectors/console-client";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { formatDate } from "@/ui/time";
import { useToast } from "@/ui/toast";
import {
  CONSENT_LIST_ENDPOINT,
  connectorErrorText,
  consentRevokeEndpoint,
  grantAccount,
  grantOperator,
  grantTitle,
  isMissingRoute,
  isNotConfigured,
  newestGrantsFirst,
  providerName,
  retryConnectorQuery,
  type AgentGrantsResponse,
} from "./model";

/** Cache key of the person's agent grants; the drawer's detail lists the same grants. */
export function useAgentGrantsKey() {
  const orgKey = useOrgKey();
  return orgKey("connectors", "consent");
}

/**
 * "Agents that can use your account": agents the person allowed, from a
 * consent link, to use one of their accounts whenever they ask. Hidden when
 * there are none.
 */
export function AgentGrantsSection({ className }: { className?: string }) {
  const key = useAgentGrantsKey();
  const [revoking, setRevoking] = useState<AgentGrantRow | null>(null);
  const query = useQuery({
    queryFn: () => api.post<AgentGrantsResponse>(CONSENT_LIST_ENDPOINT),
    queryKey: key,
    retry: retryConnectorQuery,
    select: (response) => newestGrantsFirst((response.grants ?? []).filter((grant) => grant.mode === "person_asking")),
  });

  if (query.isPending) return null;
  if (query.isError) {
    // The connections list says when the service isn't set up, and a service
    // without consent yet has no grants; nothing to add here.
    if (isNotConfigured(query.error) || isMissingRoute(query.error)) return null;
    return (
      <div className={className}>
        <div className="flex flex-wrap items-center gap-3 px-1">
          <p className="text-[13px] text-err" role="alert">
            Agents that can use your account couldn&apos;t load. {connectorErrorText(query.error)}
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
      description="You allowed these agents to use your account when you ask them something. Writes, like sending email, always ask you first."
      title="Agents that can use your account"
    >
      <List label="Agents that can use your account">
        {query.data.map((grant) => (
          <ListRow
            actions={
              <Button onClick={() => setRevoking(grant)} size="sm" variant="ghost">
                Revoke
              </Button>
            }
            description={[grantAccount(grant), grantOperator(grant), grant.createdAt ? `since ${formatDate(grant.createdAt)}` : null]
              .filter(Boolean)
              .join(" · ")}
            key={grant.id}
            leading={
              <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-2">
                <Bot aria-hidden size={16} />
              </span>
            }
            title={grantTitle(grant)}
          />
        ))}
      </List>
      <RevokeGrantDialog grant={revoking} onClose={() => setRevoking(null)} />
    </Section>
  );
}

/** Confirms taking an agent's permission back. Shared by the section and the drawer. */
export function RevokeGrantDialog({ grant, onClose }: { grant: AgentGrantRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const orgKey = useOrgKey();
  const revoke = useMutation({
    mutationFn: (target: AgentGrantRow) => api.post<{ status: "ok"; revoked: boolean }>(consentRevokeEndpoint(target.id)),
    // The list and every connection's detail name the grant.
    onSettled: () => queryClient.invalidateQueries({ queryKey: orgKey("connectors") }),
    onSuccess: (_result, target) => {
      toast.show(`${grantTitle(target)} can't use your account anymore.`);
      onClose();
    },
  });
  const close = () => {
    if (revoke.isPending) return;
    revoke.reset();
    onClose();
  };
  const errorText =
    revoke.error instanceof ApiError && (revoke.error.code === "not_found" || revoke.error.code === "connector_unavailable")
      ? "This permission no longer exists. Reload the page."
      : connectorErrorText(revoke.error);
  const provider = grant ? providerName(grant.provider) : "";

  return (
    <Dialog
      description={
        grant
          ? `It stops using ${grant.email ?? `your ${provider} account`} right away. If it needs it again, it sends you a new link to approve.`
          : undefined
      }
      footer={
        <>
          <Button disabled={revoke.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button loading={revoke.isPending} onClick={() => grant && revoke.mutate(grant)} variant="danger">
            Revoke
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(grant)}
      title={grant ? `Revoke ${grantTitle(grant)}?` : "Revoke agent"}
    >
      {revoke.isError ? <FormMessage>{errorText}</FormMessage> : null}
    </Dialog>
  );
}
