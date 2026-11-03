import type { Metadata } from "next";

import { ConnectedScreen } from "@/features/connectors/connected-screen";

export const metadata: Metadata = { title: "Account connected · Ravi Console" };

/**
 * Where a connectors Worker from before `/connect/finish` sends the browser
 * after the provider's sign-in: `?connector=<id>`. Kept for the rollout.
 */
export default async function ConnectedPage({
  searchParams,
}: {
  searchParams: Promise<{ connector?: string | string[] }>;
}) {
  const { connector } = await searchParams;
  const connectorId = typeof connector === "string" ? connector.trim() : "";
  return <ConnectedScreen connectorId={connectorId || null} />;
}
