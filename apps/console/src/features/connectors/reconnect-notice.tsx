"use client";

import { Info } from "lucide-react";

import { Notice } from "@/ui/states";

/**
 * After a reconnect that signed in with a different account. Reconnect never
 * swaps the account under a connection, so the new account became its own
 * connection and the old one is unchanged.
 */
export function ReconnectNotice({
  className,
  email,
  listedIn = "Connectors",
  provider,
}: {
  className?: string;
  email: string | null;
  /** Where both accounts are listed: Connectors, or Organization accounts for an organization account. */
  listedIn?: string;
  provider: string;
}) {
  return (
    <Notice className={className} icon={Info} title="This is a different account" tone="info">
      You signed in as {email ?? `another ${provider} account`}, not the account you were reconnecting. Ravi added it as a
      new connection and left the other one as it was. Both are listed in {listedIn}.
    </Notice>
  );
}
