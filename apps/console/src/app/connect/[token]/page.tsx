import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { ConnectLinkScreen } from "@/features/connectors/connect-screens";
import { getConsoleAuthState } from "@/lib/auth/session";
import { getConnectPageState } from "@/server/connectors/connect-grants";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect an account",
  // Keeps the token out of Referer for other sites while same-origin posts
  // still carry a real Origin header.
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type ConnectTokenPageProps = {
  params: Promise<{ token: string }>;
};

// Opening this page changes nothing: chat apps fetch links to build previews.
// Only "Continue" (a POST, initiator only) moves the connection forward.
export default async function ConnectTokenPage({ params }: ConnectTokenPageProps) {
  const { token } = await params;
  const auth = await getConsoleAuthState();
  const state = await getConnectPageState(auth, token);

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <ConnectLinkScreen state={state} token={token} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}
