import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { LinkApprovalScreen, type LinkApprovalState } from "@/features/account/link-screens";
import { getConsoleAuthState } from "@/lib/auth/session";
import { getRaviLinkRequestView } from "@/server/console/ravi-link-requests";
import { raviLinkApproverFromAuth } from "@/server/console/ravi-link-web";

import { firstParam, linkErrorCopy } from "../_components";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Link chat account",
  // Keeps the token out of Referer for other sites while same-origin posts
  // still carry a real Origin header.
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type LinkTokenPageProps = {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// Opening this page changes nothing: chat apps fetch links to build previews.
// Only the Approve / This wasn't me buttons (POST) act on the request.
export default async function LinkTokenPage({ params, searchParams }: LinkTokenPageProps) {
  const { token } = await params;
  const query = await searchParams;
  const errorCopy = linkErrorCopy(firstParam(query?.error));
  const denied = firstParam(query?.denied) === "1";
  const auth = await getConsoleAuthState();
  const view = await getRaviLinkRequestView({
    approver: await raviLinkApproverFromAuth(auth),
    token,
  });

  let state: LinkApprovalState;
  if (view.state === "approved") {
    state = { kind: "approved" };
  } else if (denied) {
    state = { kind: "denied" };
  } else if (errorCopy) {
    state = { kind: "error", copy: errorCopy };
  } else if (view.state === "pending") {
    state = {
      kind: "pending",
      channel: view.channel,
      expiresAt: view.expiresAt,
      installationName: view.installationName,
      organizationName: view.organizationName,
      requesterDisplayName: view.requesterDisplayName,
    };
  } else {
    const copy = linkErrorCopy(
      view.state === "expired"
        ? "LINK_REQUEST_EXPIRED"
        : view.state === "used"
          ? "LINK_REQUEST_USED"
          : view.state === "not_member"
            ? "NOT_MEMBER"
            : view.state === "user_mismatch"
              ? "LINK_USER_MISMATCH"
              : "LINK_REQUEST_INVALID",
    )!;
    state = { kind: "error", copy };
  }

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <LinkApprovalScreen state={state} token={token} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}
