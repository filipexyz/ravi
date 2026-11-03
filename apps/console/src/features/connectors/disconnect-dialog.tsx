"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Unplug } from "lucide-react";

import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { Dialog } from "@/ui/overlay";
import { UsageItem, useConnectionDetail } from "./connection-detail";
import { connectionName, connectorErrorText, providerName, revokeEndpoint, type Connection } from "./model";

export type DisconnectResult = "disconnected" | "pending";

/**
 * Confirms a disconnect and runs it. A provider failure leaves the row as
 * "Disconnecting…", which the caller reports; other errors stay in the
 * dialog.
 */
export function DisconnectDialog({
  connection,
  isDefault = false,
  listKey,
  onClose,
  onDone,
}: {
  connection: Connection | null;
  /** Commands that don't name an account use this one. */
  isDefault?: boolean;
  /** Query key prefix of the connections list, refreshed after the attempt. */
  listKey: readonly unknown[];
  onClose: () => void;
  onDone: (result: DisconnectResult, connection: Connection) => void;
}) {
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: (target: Connection) => api.post<{ status: "ok"; revoked: boolean }>(revokeEndpoint(target.id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  });
  const run = (target: Connection) =>
    revoke.mutate(target, {
      onError: (error) => {
        if (error instanceof ApiError && error.code === "connector_provider_error") {
          revoke.reset();
          onDone("pending", target);
        }
      },
      onSuccess: () => onDone("disconnected", target),
    });

  // What stops: the drawer's "Used by" when it loaded, else the list's newest five.
  const detail = useConnectionDetail(connection?.id, false);
  const usage = connection ? (detail.data?.id === connection.id ? detail.data.usage : connection.usedBy) : [];

  const open = Boolean(connection);
  const provider = connection ? providerName(connection.provider) : "";
  const retrying = connection?.status === "revoke_pending";
  const close = () => {
    if (revoke.isPending) return;
    revoke.reset();
    onClose();
  };

  return (
    <Dialog
      description={
        connection
          ? `${provider} is told to revoke access and Ravi deletes the tokens. Agents and commands using this account stop working.`
          : undefined
      }
      footer={
        <>
          <Button disabled={revoke.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            icon={Unplug}
            loading={revoke.isPending}
            onClick={() => connection && run(connection)}
            variant="danger"
          >
            {retrying ? "Try disconnecting again" : "Disconnect"}
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title={connection ? `Disconnect ${connectionName(connection)}?` : "Disconnect"}
    >
      {connection && (usage.length || isDefault || revoke.isError) ? (
        <div className="space-y-3">
          {usage.length ? (
            <div className="space-y-1.5">
              <p className="text-sm text-ink-2">These stop using it:</p>
              <ul aria-label="What stops" className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                {usage.map((row, index) => (
                  <UsageItem key={`${row.installationId ?? "none"}:${row.agentId ?? ""}:${row.routineKey ?? ""}:${index}`} row={row} />
                ))}
              </ul>
            </div>
          ) : null}
          {isDefault ? (
            <p className="text-sm text-ink-2">
              This is your default {provider} account. After you disconnect it, commands that don&apos;t name an account
              use your newest other working {provider} connection, if you have one.
            </p>
          ) : null}
          {revoke.isError ? <FormMessage>{connectorErrorText(revoke.error, "disconnect")}</FormMessage> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
