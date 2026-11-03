"use client";

import { Copy, MoreHorizontal, PenLine, RefreshCw, Star, Unplug, PencilLine } from "lucide-react";

import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Menu, MenuItem, MenuSeparator } from "@/ui/overlay";
import { formatDate, RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import {
  connectedDate,
  connectionLabel,
  connectionName,
  connectionStatus,
  historyReason,
  permissionsSentence,
  usedBySentence,
  type Connection,
} from "./model";
import { ProviderMark } from "./provider-mark";

export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** What can be done to one connection. Missing entries are not offered. */
export type ConnectionActions = {
  onOpen: () => void;
  onRename: () => void;
  onDisconnect: () => void;
  onReconnect?: () => void;
  onMakeDefault?: () => void;
  onAllowWriting?: () => void;
};

/** The row menu; the drawer offers the same actions as buttons. */
export function ConnectionMenu({ actions, connection }: { actions: ConnectionActions; connection: Connection }) {
  const toast = useToast();
  const status = connectionStatus(connection);
  const name = connectionName(connection);
  return (
    <Menu
      align="end"
      label={`Actions for ${name}`}
      trigger={(props) => <IconButton {...props} icon={MoreHorizontal} label={`Actions for ${name}`} size="sm" />}
    >
      <MenuItem icon={PencilLine} onSelect={actions.onRename}>
        Rename
      </MenuItem>
      {actions.onReconnect ? (
        <MenuItem description="Sign in again with the same account" icon={RefreshCw} onSelect={actions.onReconnect}>
          Reconnect
        </MenuItem>
      ) : null}
      {actions.onMakeDefault ? (
        <MenuItem description="Used when a command doesn't name an account" icon={Star} onSelect={actions.onMakeDefault}>
          Make default
        </MenuItem>
      ) : null}
      {actions.onAllowWriting ? (
        <MenuItem description="Reconnect with full access" icon={PenLine} onSelect={actions.onAllowWriting}>
          Allow writing
        </MenuItem>
      ) : null}
      <MenuItem
        description={<span className="font-mono">{connection.id.slice(0, 8)}…</span>}
        icon={Copy}
        onSelect={() => {
          void copyText(connection.id).then((ok) =>
            toast.show(ok ? "Copied the connection id." : "Couldn't copy. Select the id and copy it by hand.", ok ? "ok" : "err"),
          );
        }}
      >
        Copy id
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Unplug} onSelect={actions.onDisconnect} tone="danger">
        {status.next === "retry-disconnect" ? "Try disconnecting again" : "Disconnect"}
      </MenuItem>
    </Menu>
  );
}

/** One connected account: the email, its state, what it allows, when it was last used. */
export function ConnectionRow({
  actions,
  busy,
  connection,
  isDefault,
}: {
  actions: ConnectionActions;
  /** A reconnect for this row is on its way to the provider. */
  busy?: boolean;
  connection: Connection;
  /** Shown only when the person has more than one account of the provider. */
  isDefault: boolean;
}) {
  const status = connectionStatus(connection);
  const name = connectionName(connection);
  const label = connectionLabel(connection);
  const usedBy = usedBySentence(connection.usedBy);

  return (
    <li className="flex items-start gap-1 pr-3 transition-colors hover:bg-hover">
      <button className="flex min-w-0 flex-1 items-start gap-3 px-4 py-4 text-left" onClick={actions.onOpen} type="button">
        <ProviderMark provider={connection.provider} />
        <span className="block min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="min-w-0 truncate text-sm font-medium text-ink">{name}</span>
            {label ? <span className="min-w-0 truncate text-[13px] text-ink-3">{label}</span> : null}
            <Badge dot tone={status.tone}>
              {status.label}
            </Badge>
            {isDefault ? <Badge title="Commands that don't name an account use this one.">Default</Badge> : null}
            {connection.accessMode === "read_only" ? <Badge>Read only</Badge> : null}
          </span>
          <span className="block text-[13px] text-ink-2">{permissionsSentence(connection.scopes)}</span>
          <span className="block truncate text-[13px] text-ink-3">
            {usedBy ?? `Connected ${formatDate(connectedDate(connection))}`}
            {connection.lastUsedAt ? (
              <>
                {" · "}
                {usedBy ? "last used" : "Last used"} <RelativeTime value={connection.lastUsedAt} />
              </>
            ) : null}
          </span>
          {status.hint ? <span className="block pt-1 text-[13px] text-warn">{status.hint}</span> : null}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1 pt-4">
        {status.next === "reconnect" && actions.onReconnect ? (
          <Button className="hidden sm:inline-flex" icon={RefreshCw} loading={busy} onClick={actions.onReconnect} size="sm">
            Reconnect
          </Button>
        ) : null}
        {status.next === "retry-disconnect" ? (
          <Button className="hidden sm:inline-flex" onClick={actions.onDisconnect} size="sm">
            Try again
          </Button>
        ) : null}
        <ConnectionMenu actions={actions} connection={connection} />
      </div>
    </li>
  );
}

/** A disconnected account kept for reference: no access and no tokens left. */
export function HistoryRow({ connection }: { connection: Connection }) {
  const toast = useToast();
  const status = connectionStatus(connection);
  const name = connectionName(connection);
  const ended = connection.revokedAt ? ` · ${formatDate(connection.revokedAt)}` : "";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <ProviderMark muted provider={connection.provider} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm text-ink-2">{name}</span>
          <Badge tone="neutral">{status.label}</Badge>
        </div>
        <div className="mt-0.5 truncate text-[13px] text-ink-3">
          {historyReason(connection)}
          {ended} · Connected {formatDate(connectedDate(connection))}
        </div>
      </div>
      <IconButton
        className="shrink-0"
        icon={Copy}
        label="Copy id"
        onClick={() => {
          void copyText(connection.id).then((ok) =>
            toast.show(ok ? "Copied the connection id." : "Couldn't copy the id.", ok ? "ok" : "err"),
          );
        }}
        size="sm"
      />
    </li>
  );
}
