"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plug, PlugZap, RefreshCw } from "lucide-react";
import { useState } from "react";

import { api } from "@/lib/api/client";
import { roleLabel, useFeature, useOrgKey, useWorkspace } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { PageHeader, Section } from "@/ui/layout";
import { List } from "@/ui/list";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { useToast } from "@/ui/toast";
import { AddConnectionCard } from "./add-connection";
import { AgentGrantsSection } from "./agent-grants-section";
import { WaitingForYouSection } from "./approvals-section";
import { ComputersSection } from "./computers-section";
import { ConnectionDrawer } from "./connection-drawer";
import { ConnectionRow, HistoryRow, type ConnectionActions } from "./connection-row";
import { DisconnectDialog, type DisconnectResult } from "./disconnect-dialog";
import {
  CONNECTABLE_PROVIDERS,
  connectableProvider,
  CONNECTIONS_ENDPOINT,
  connectionName,
  connectorErrorText,
  connectStartBody,
  defaultConnectionId,
  defaultEndpoint,
  groupByProvider,
  isNotConfigured,
  isUsable,
  providerName,
  retryConnectorQuery,
  splitConnections,
  type Connection,
  type ConnectionsResponse,
} from "./model";
import { RenameDialog } from "./rename-dialog";
import { useStartConnect } from "./use-start-connect";

/**
 * The person's own connected accounts in the selected organization. Each
 * connection belongs to the person who connected it; no project is involved.
 */
export function ConnectorsScreen() {
  const { organization } = useWorkspace();
  const enabled = useFeature("console.connectors");
  const orgKey = useOrgKey();
  const listKey = orgKey("connectors");
  const queryClient = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    enabled,
    queryFn: () => api.post<ConnectionsResponse>(CONNECTIONS_ENDPOINT, { includeHistory: true }),
    queryKey: [...listKey, "list"],
    retry: retryConnectorQuery,
    select: (response) => response.connections ?? [],
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Connection | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const connect = useStartConnect();

  const makeDefault = useMutation({
    mutationFn: (connection: Connection) => api.post<{ status: "ok"; ok: boolean }>(defaultEndpoint(connection.id)),
    onError: (error) => toast.show(connectorErrorText(error, "default"), "err"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
    onSuccess: (_result, connection) => toast.show(`${connectionName(connection)} is now your default ${providerName(connection.provider)} account.`),
  });

  const connections = query.data ?? [];
  const { current, history } = splitConnections(connections);
  const groups = groupByProvider(current);
  const defaults = new Map(groups.map((group) => [group.provider, defaultConnectionId(current, group.provider)]));
  const selected = current.find((connection) => connection.id === selectedId) ?? null;

  const shownAsDefault = (connection: Connection) => {
    const group = groups.find((item) => item.provider === connection.provider);
    return Boolean(group && group.items.length > 1 && defaults.get(connection.provider) === connection.id);
  };

  const actionsFor = (connection: Connection): ConnectionActions => {
    // A row being disconnected or paused by Ravi can't be signed in again from here.
    const connectable =
      Boolean(connectableProvider(connection.provider)) &&
      connection.status !== "revoke_pending" &&
      connection.status !== "suspended";
    const siblings = current.filter((item) => item.provider === connection.provider).length;
    return {
      onAllowWriting:
        connectable && connection.status === "active" && connection.accessMode === "read_only"
          ? () =>
              connect.start({
                body: connectStartBody(connection.provider, { accessMode: "full", reconnect: connection }),
                key: `allow-writing:${connection.id}`,
              })
          : undefined,
      onDisconnect: () => {
        setSelectedId(null);
        setDisconnecting(connection);
      },
      // Offered on any working row that isn't already what commands use, by the same rule as the badge.
      onMakeDefault:
        defaults.get(connection.provider) !== connection.id && siblings > 1 && isUsable(connection)
          ? () => makeDefault.mutate(connection)
          : undefined,
      onOpen: () => setSelectedId(connection.id),
      onReconnect: connectable
        ? () =>
            connect.start({
              body: connectStartBody(connection.provider, { reconnect: connection }),
              key: `reconnect:${connection.id}`,
            })
        : undefined,
      onRename: () => setRenaming(connection),
    };
  };

  const onDisconnected = (result: DisconnectResult, connection: Connection) => {
    setDisconnecting(null);
    const name = connectionName(connection);
    if (result === "disconnected") {
      toast.show(`Disconnected ${name}.`);
    } else {
      toast.show(
        `${providerName(connection.provider)} didn't confirm the disconnect yet, so ${name} shows Disconnecting… Agents can't use it meanwhile; try again in a moment.`,
        "err",
      );
    }
  };

  const startError = connect.errorKey?.startsWith("reconnect:") || connect.errorKey?.startsWith("allow-writing:") ? connect.error : null;
  const drawerBusy =
    selected && connect.busyKey
      ? connect.busyKey === `reconnect:${selected.id}`
        ? "reconnect"
        : connect.busyKey === `allow-writing:${selected.id}`
          ? "allow-writing"
          : null
      : null;

  return (
    <>
      <PageHeader description="Accounts you connected. Agents use them only as you allow." title="Connectors" />

      {enabled ? <WaitingForYouSection className="mb-8" /> : null}

      {!enabled ? (
        <EmptyState
          description="Connecting outside accounts isn't available in this organization yet."
          icon={Plug}
          title="Connectors aren't enabled here"
        />
      ) : query.isPending ? (
        <ListSkeleton rows={2} />
      ) : query.isError ? (
        isNotConfigured(query.error) ? (
          <NotConfiguredState onRetry={() => void query.refetch()} retrying={query.isFetching} />
        ) : (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            role={roleLabel(organization.role)}
            title="Your connections couldn't load"
          />
        )
      ) : (
        <div className="space-y-8">
          <Section title="Your connections">
            {current.length === 0 ? (
              <EmptyState
                description={
                  CONNECTABLE_PROVIDERS.length
                    ? "Connect an account below. Only you can use it, and agents use it only as you allow."
                    : "There is nothing you can connect yet."
                }
                icon={Plug}
                title="No accounts connected"
              />
            ) : (
              <div className="space-y-6">
                {groups.map((group) => (
                  <div className="space-y-2" key={group.provider}>
                    {groups.length > 1 ? <h3 className="px-1 text-sm font-medium text-ink-2">{group.name}</h3> : null}
                    <List label={`${group.name} connections`}>
                      {group.items.map((connection) => (
                        <ConnectionRow
                          actions={actionsFor(connection)}
                          busy={connect.busyKey === `reconnect:${connection.id}`}
                          connection={connection}
                          isDefault={shownAsDefault(connection)}
                          key={connection.id}
                        />
                      ))}
                    </List>
                    {group.provider === "google" && group.items.length > 1 ? (
                      <p className="px-1 text-[13px] text-ink-3">
                        From the terminal,{" "}
                        <span className="font-mono text-[12.5px] whitespace-nowrap text-ink-2">ravi gmail</span> uses the
                        account marked Default. To use another one, pass{" "}
                        <span className="font-mono text-[12.5px] whitespace-nowrap text-ink-2">--connector &lt;id&gt;</span> with
                        the id you copy from its menu.
                      </p>
                    ) : null}
                  </div>
                ))}
                {startError && !selected ? (
                  <p className="px-1 text-[13px] text-err" role="alert">
                    {connectorErrorText(startError, "connect")}
                  </p>
                ) : null}
              </div>
            )}
          </Section>

          {history.length ? (
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 text-sm font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden className="transition-transform group-open:rotate-90" size={16} />
                History
                <span className="font-normal text-ink-3">· {history.length} disconnected</span>
              </summary>
              <div className="mt-3 space-y-2">
                <List label="Disconnected accounts">
                  {history.map((connection) => (
                    <HistoryRow connection={connection} key={connection.id} />
                  ))}
                </List>
                <p className="px-1 text-[13px] text-ink-3">
                  These have no access and no tokens left. To use one of these accounts again, connect it again.
                </p>
              </div>
            </details>
          ) : null}

          {CONNECTABLE_PROVIDERS.length ? (
            <Section title="Add connection">
              <ul className="space-y-3">
                {CONNECTABLE_PROVIDERS.map((provider) => (
                  <AddConnectionCard
                    busy={connect.busyKey === `connect:${provider.id}`}
                    disabled={Boolean(connect.busyKey)}
                    error={connect.errorKey === `connect:${provider.id}` ? connect.error : null}
                    key={provider.id}
                    onConnect={(accessMode) =>
                      connect.start({ body: connectStartBody(provider.id, { accessMode }), key: `connect:${provider.id}` })
                    }
                    provider={provider}
                  />
                ))}
              </ul>
            </Section>
          ) : null}

          <AgentGrantsSection />

          <ComputersSection />
        </div>
      )}

      <ConnectionDrawer
        actions={selected ? actionsFor(selected) : null}
        busyAction={drawerBusy}
        connection={selected}
        error={startError && selected && connect.errorKey?.endsWith(`:${selected.id}`) ? connectorErrorText(startError, "connect") : null}
        isDefault={selected ? shownAsDefault(selected) : false}
        onClose={() => setSelectedId(null)}
      />
      <RenameDialog connection={renaming} listKey={listKey} onClose={() => setRenaming(null)} />
      <DisconnectDialog
        connection={disconnecting}
        isDefault={Boolean(disconnecting && shownAsDefault(disconnecting))}
        listKey={listKey}
        onClose={() => setDisconnecting(null)}
        onDone={onDisconnected}
      />
    </>
  );
}

function NotConfiguredState({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <EmptyState
      action={
        <Button icon={RefreshCw} loading={retrying} onClick={onRetry} size="sm">
          Try again
        </Button>
      }
      description="The service that keeps connected accounts isn't set up for this Console, so accounts can't be listed or connected here. Ask whoever runs this Console to set it up, then try again."
      icon={PlugZap}
      title="Connections aren't set up on this Console"
    />
  );
}
