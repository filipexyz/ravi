"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, RefreshCw, Unplug } from "lucide-react";
import { useState } from "react";

import { InlineText } from "@/features/account/state-card";
import { useOrgKey } from "@/features/shell/workspace";
import { api, ApiError } from "@/lib/api/client";
import type { InstallationRow } from "@/server/connectors/installations";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { ListSkeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import {
  connectorErrorText,
  INSTALLATIONS_ENDPOINT,
  installationDetails,
  retryConnectorQuery,
  revokeInstallationEndpoint,
  type InstallationsResponse,
} from "./model";

/**
 * "Your computers": where the person is signed in to `ravi` in this
 * organization. Their agents there use their connections; revoking a
 * computer signs it out.
 */
export function ComputersSection() {
  const orgKey = useOrgKey();
  const key = orgKey("connectors", "installations");
  const [revoking, setRevoking] = useState<InstallationRow | null>(null);

  const query = useQuery({
    queryFn: () => api.post<InstallationsResponse>(INSTALLATIONS_ENDPOINT),
    queryKey: key,
    retry: retryConnectorQuery,
    select: (response) => response.installations ?? [],
  });

  // Nothing to show until it loads; a failure stays a line, the connections above still work.
  if (query.isPending) {
    return (
      <Section title="Your computers">
        <ListSkeleton rows={1} />
      </Section>
    );
  }

  return (
    <Section
      description="Where you're signed in to ravi. Agents there use your connections only as you allow."
      title="Your computers"
    >
      {query.isError ? (
        <div className="flex flex-wrap items-center gap-3 px-1">
          <p className="text-[13px] text-err" role="alert">
            {connectorErrorText(query.error)}
          </p>
          <Button icon={RefreshCw} loading={query.isFetching} onClick={() => void query.refetch()} size="sm" variant="ghost">
            Try again
          </Button>
        </div>
      ) : query.data.length === 0 ? (
        <p className="px-1 text-[13px] text-ink-3">
          <InlineText text="No computer is signed in for you here. Run `ravi login` on one to use your connections from its agents." />
        </p>
      ) : (
        <List label="Your computers">
          {query.data.map((installation) => {
            const details = installationDetails(installation);
            return (
              <ListRow
                actions={
                  <Button onClick={() => setRevoking(installation)} size="sm" variant="ghost">
                    Revoke
                  </Button>
                }
                description={
                  // Last seen first: on a narrow screen the end of the line is what gets cut.
                  <>
                    Last seen <RelativeTime value={installation.lastSeenAt} />
                    {details ? ` · ${details}` : null}
                  </>
                }
                key={installation.id}
                leading={
                  <span className="inline-flex size-8 items-center justify-center rounded-md bg-sunken text-ink-2">
                    <Laptop aria-hidden size={16} />
                  </span>
                }
                title={installation.name}
              />
            );
          })}
        </List>
      )}
      <RevokeComputerDialog installation={revoking} onClose={() => setRevoking(null)} />
    </Section>
  );
}

function RevokeComputerDialog({ installation, onClose }: { installation: InstallationRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const orgKey = useOrgKey();
  const revoke = useMutation({
    mutationFn: (target: InstallationRow) =>
      api.post<{ status: "ok"; revoked: boolean }>(revokeInstallationEndpoint(target.id)),
    // Revoking also takes back the permissions agents there had, which the
    // agents section and every connection's detail list.
    onSettled: () => queryClient.invalidateQueries({ queryKey: orgKey("connectors") }),
    onSuccess: (_result, target) => {
      toast.show(`Revoked ${target.name}. ravi there is signed out.`);
      onClose();
    },
  });
  const close = () => {
    if (revoke.isPending) return;
    revoke.reset();
    onClose();
  };
  const errorText =
    revoke.error instanceof ApiError && revoke.error.code === "not_found"
      ? "This computer isn't signed in anymore, or it isn't yours. Reload the page."
      : connectorErrorText(revoke.error);

  return (
    <Dialog
      description={
        installation ? (
          <InlineText text="Every ravi session on it is signed out and its agents stop using your connections. Agents you allowed there lose that permission. Run `ravi login` on it to use it again." />
        ) : undefined
      }
      footer={
        <>
          <Button disabled={revoke.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            icon={Unplug}
            loading={revoke.isPending}
            onClick={() => installation && revoke.mutate(installation)}
            variant="danger"
          >
            Revoke
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(installation)}
      title={installation ? `Revoke ${installation.name}?` : "Revoke computer"}
    >
      {revoke.isError ? <FormMessage>{errorText}</FormMessage> : null}
    </Dialog>
  );
}
