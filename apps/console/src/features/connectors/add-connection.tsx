"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { useState } from "react";

import { Button } from "@/ui/button";
import { FormMessage } from "@/ui/form";
import { Segmented } from "@/ui/tabs";
import { connectorErrorText, type ConnectableProvider } from "./model";
import type { ConnectorAccessMode } from "@/server/connectors/console-client";
import { ProviderMark } from "./provider-mark";

/**
 * One catalog card per provider. "Connect" goes straight to the provider's
 * sign-in; "Read only" asks for no write permission at all.
 */
export function AddConnectionCard({
  busy,
  disabled,
  error,
  onConnect,
  provider,
}: {
  busy: boolean;
  disabled: boolean;
  error: unknown;
  onConnect: (accessMode: ConnectorAccessMode) => void;
  provider: ConnectableProvider;
}) {
  const [accessMode, setAccessMode] = useState<ConnectorAccessMode>("full");
  const permissions = accessMode === "read_only" ? provider.readOnlyPermissions : provider.permissions;
  return (
    <li className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-start">
      <ProviderMark provider={provider.id} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-ink">{provider.name}</div>
          <p className="text-[13px] text-ink-2">{provider.pitch}</p>
        </div>
        <ul aria-label={`What ${provider.name} allows`} className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-2">
          {permissions.map((permission) => (
            <li className="inline-flex items-center gap-1" key={permission}>
              <Check aria-hidden className="text-ok" size={13} />
              {permission}
            </li>
          ))}
        </ul>
        {accessMode === "read_only" ? (
          <p className="text-[13px] text-ink-3">
            Agents can read but never send. You can allow writing later from the connection.
          </p>
        ) : null}
        {error ? <FormMessage>{connectorErrorText(error, "connect")}</FormMessage> : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
        <Segmented
          label={`Access for ${provider.name}`}
          onChange={setAccessMode}
          options={[
            { label: "Full access", value: "full" },
            { label: "Read only", value: "read_only" },
          ]}
          value={accessMode}
        />
        <Button
          disabled={disabled && !busy}
          iconRight={ArrowUpRight}
          loading={busy}
          onClick={() => onConnect(accessMode)}
          variant="primary"
        >
          Connect
        </Button>
      </div>
    </li>
  );
}
