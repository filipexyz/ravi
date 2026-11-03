import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { AccessRequestDecisionScreen, type AccessRequestDecisionState } from "@/features/account/access-request-screens";
import { getConsoleAuthState } from "@/lib/auth/session";
import { accessRequestErrorMessage } from "@/server/console/access/request-copy";
import { getAccessRequestView } from "@/server/console/access/requests";
import { raviLinkApproverFromAuth } from "@/server/console/ravi-link-web";
import { raviLinkConsoleOrigin } from "@/server/console/ravi-link-requests";
import { ConsoleEmailVerificationRequiredError } from "@/server/console/workspace";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Access request",
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type AccessRequestDecisionPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// Anyone may open this link (it is meant to be forwarded); it shows the
// request only to its requester and to people who can share the page, and
// changes nothing. Only the Approve and Decline buttons (POST) act.
export default async function AccessRequestDecisionPage({ params, searchParams }: AccessRequestDecisionPageProps) {
  const { id } = await params;
  const query = await searchParams;
  const error = firstParam(query?.error);
  const sent = firstParam(query?.sent) === "1";
  const auth = await getConsoleAuthState();
  let viewer: Awaited<ReturnType<typeof raviLinkApproverFromAuth>>;
  try {
    viewer = await raviLinkApproverFromAuth(auth);
  } catch (caught) {
    // The Console home asks them to verify their email first.
    if (caught instanceof ConsoleEmailVerificationRequiredError) redirect("/");
    throw caught;
  }
  const view = await getAccessRequestView({ id, origin: await requestOrigin(), viewerUserId: viewer.userId });

  let state: AccessRequestDecisionState;
  switch (view.state) {
    case "approver":
      state = { error: error ? accessRequestErrorMessage(error) : null, kind: "approver", request: view.detail };
      break;
    case "requester":
      state = { justSent: sent, kind: "requester", pageUrl: view.pageUrl, request: view.request };
      break;
    case "not_allowed":
      state = { kind: "not_allowed" };
      break;
    default:
      state = { kind: "invalid" };
  }

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <AccessRequestDecisionScreen state={state} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}

async function requestOrigin() {
  const list = await headers();
  const host = list.get("x-forwarded-host") ?? list.get("host") ?? "console.ravi.bot";
  const proto = list.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return raviLinkConsoleOrigin(`${proto}://${host}/`);
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
