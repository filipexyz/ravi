import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { ApprovalScreen } from "@/features/connectors/approval-screen";
import { getConsoleAuthState } from "@/lib/auth/session";
import { getApprovalPageState } from "@/server/connectors/approvals";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Approve a request",
  // The page shows part of the person's email: keep its URL out of Referer for other sites.
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type ApprovalPageProps = {
  params: Promise<{ id: string }>;
};

// Opening this page decides nothing: chat apps fetch links to build previews.
// Only Approve and Deny (POST, by whoever decides it) answer the request.
export default async function ApprovalPage({ params }: ApprovalPageProps) {
  const { id } = await params;
  const auth = await getConsoleAuthState();
  const state = await getApprovalPageState(auth, id);

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <ApprovalScreen state={state} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}
