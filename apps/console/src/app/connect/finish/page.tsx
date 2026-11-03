import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { ConnectFinishScreen } from "@/features/connectors/connect-screens";
import { getConsoleAuthState } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Finish connecting",
  // The one-time result token is in the query string: never send it in Referer.
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type ConnectFinishPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined) {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || null;
}

/**
 * Where the connectors Worker sends the browser after the provider's sign-in:
 * `?p=<pendingId>&r=<resultToken>`, or `?p=<pendingId>&error=provider_denied`.
 * Rendering changes nothing; the screen posts the finish once it mounts.
 */
export default async function ConnectFinishPage({ searchParams }: ConnectFinishPageProps) {
  const query = await searchParams;
  const auth = await getConsoleAuthState();

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <ConnectFinishScreen
        error={firstParam(query?.error)}
        pendingId={firstParam(query?.p)}
        resultToken={firstParam(query?.r)}
        viewer={{ email: auth.viewer.email, name: auth.viewer.name }}
      />
    </ConsoleAuthBoundary>
  );
}
