"use client";

import { PencilLine, PenLine, RefreshCw, Star, Unplug } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { FormMessage } from "@/ui/form";
import { DetailList, Mono } from "@/ui/layout";
import { Drawer } from "@/ui/overlay";
import { Notice } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { CalendarSection } from "@/features/calendar/calendar-section";
import { ConnectionDetailSections } from "./connection-detail";
import type { ConnectionActions } from "./connection-row";
import {
  accessLabel,
  connectedDate,
  connectionLabel,
  connectionName,
  connectionStatus,
  permissionsSentence,
  providerName,
  type Connection,
} from "./model";

/**
 * One connection in detail: the account, what it allows, its tools and their
 * rules, who uses it, what it did lately, and its actions.
 */
export function ConnectionDrawer({
  actions,
  busyAction,
  connection,
  error,
  isDefault,
  onClose,
}: {
  actions: ConnectionActions | null;
  /** Which start is on its way to the provider: "reconnect" or "allow-writing". */
  busyAction?: string | null;
  connection: Connection | null;
  /** Why the last Reconnect or Allow writing didn't start. */
  error?: string | null;
  isDefault: boolean;
  onClose: () => void;
}) {
  const status = connection ? connectionStatus(connection) : null;
  return (
    <Drawer
      description={connection ? providerName(connection.provider) : undefined}
      onClose={onClose}
      open={Boolean(connection && actions)}
      title={connection ? connectionName(connection) : "Connection"}
    >
      {connection && actions && status ? (
        <div className="space-y-6">
          {status.hint ? (
            <Notice title={status.label} tone="warn">
              {status.hint}
            </Notice>
          ) : null}

          <section className="space-y-1">
            <h3 className="text-sm font-semibold text-ink">Account</h3>
            <DetailList
              items={[
                { label: "Email", value: connection.email ?? "Not known yet. Reconnect to fill it in." },
                {
                  label: "Name",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={connectionLabel(connection) ? "text-ink" : "text-ink-3"}>
                        {connectionLabel(connection) ?? "No name"}
                      </span>
                      <Button icon={PencilLine} onClick={actions.onRename} size="sm" variant="ghost">
                        Rename
                      </Button>
                    </span>
                  ),
                },
                {
                  label: "Status",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge dot tone={status.tone}>
                        {status.label}
                      </Badge>
                      {isDefault ? <Badge>Default</Badge> : null}
                    </span>
                  ),
                },
                {
                  label: "Access",
                  value: (
                    <span className="block space-y-0.5">
                      <span className="block">{accessLabel(connection)}</span>
                      <span className="block text-[13px] text-ink-3">{permissionsSentence(connection.scopes)}</span>
                    </span>
                  ),
                },
                { label: "Connected", value: formatDate(connectedDate(connection), true) },
                {
                  label: "Last used",
                  value: connection.lastUsedAt ? <RelativeTime value={connection.lastUsedAt} /> : "Not used yet",
                },
                {
                  label: "Id",
                  value: (
                    <span className="flex min-w-0 items-center gap-1">
                      <Mono className="min-w-0 truncate text-ink-2">{connection.id}</Mono>
                      <CopyButton label="Copy id" value={connection.id} />
                    </span>
                  ),
                },
              ]}
            />
          </section>

          {connection.provider === "google" && connection.scopeKind === "user" ? (
            <CalendarSection connectionId={connection.id} />
          ) : null}

          <ConnectionDetailSections connection={connection} />

          <section className="space-y-3 border-t border-line pt-5">
            <h3 className="text-sm font-semibold text-ink">Actions</h3>
            <div className="flex flex-wrap gap-2">
              {actions.onReconnect ? (
                <Button
                  icon={RefreshCw}
                  loading={busyAction === "reconnect"}
                  onClick={actions.onReconnect}
                  size="sm"
                  variant={status.next === "reconnect" ? "primary" : "secondary"}
                >
                  Reconnect
                </Button>
              ) : null}
              {actions.onAllowWriting ? (
                <Button icon={PenLine} loading={busyAction === "allow-writing"} onClick={actions.onAllowWriting} size="sm">
                  Allow writing
                </Button>
              ) : null}
              {actions.onMakeDefault ? (
                <Button icon={Star} onClick={actions.onMakeDefault} size="sm">
                  Make default
                </Button>
              ) : null}
              <Button icon={Unplug} onClick={actions.onDisconnect} size="sm" variant="danger">
                {status.next === "retry-disconnect" ? "Try disconnecting again" : "Disconnect"}
              </Button>
            </div>
            {error ? <FormMessage>{error}</FormMessage> : null}
            <p className="text-[13px] text-ink-3">
              Reconnect signs in again with the same account and keeps this connection.
              {actions.onAllowWriting ? " Allow writing does the same with full access, so agents can also send." : ""}
            </p>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
