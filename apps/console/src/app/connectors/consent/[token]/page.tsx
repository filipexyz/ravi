import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { ConsentScreen } from "@/features/connectors/consent-screen";
import { getConsoleAuthState } from "@/lib/auth/session";
import { getConsentPageState } from "@/server/connectors/consent";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Allow an agent",
  // Keeps the token out of Referer for other sites while same-origin posts
  // still carry a real Origin header.
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type ConsentPageProps = {
  params: Promise<{ token: string }>;
};

// Opening this page decides nothing: chat apps fetch links to build previews.
// Only Approve and Deny (POST, the person the request was made for) answer it.
export default async function ConsentPage({ params }: ConsentPageProps) {
  const { token } = await params;
  const auth = await getConsoleAuthState();
  const state = await getConsentPageState(auth, token);

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <ConsentScreen state={state} token={token} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}
