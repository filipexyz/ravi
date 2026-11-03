import type { Metadata } from "next";

import { ConsoleAuthBoundary } from "@/components/auth-boundary";
import { InviteScreen, type InviteScreenState } from "@/features/account/invite-screens";
import { getConsoleAuthState } from "@/lib/auth/session";
import { getOrganizationInviteView } from "@/server/console/access/invites";
import { raviLinkApproverFromAuth } from "@/server/console/ravi-link-web";
import { ConsoleEmailVerificationRequiredError } from "@/server/console/workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Join organization",
  // Keeps the token out of Referer for other sites while same-origin posts
  // still carry a real Origin header.
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

type InviteTokenPageProps = {
  params: Promise<{ token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// Opening this page changes nothing: chat apps fetch links to build previews.
// Only the Join button (POST) accepts the invite.
export default async function InviteTokenPage({ params, searchParams }: InviteTokenPageProps) {
  const { token } = await params;
  const query = await searchParams;
  const error = firstParam(query?.error);
  const auth = await getConsoleAuthState();

  let state: InviteScreenState;
  try {
    const view = await getOrganizationInviteView({ token, viewer: await raviLinkApproverFromAuth(auth) });
    state = stateFor(view, error);
  } catch (caught) {
    if (!(caught instanceof ConsoleEmailVerificationRequiredError)) throw caught;
    state = { copy: inviteErrorCopy("INVITE_EMAIL_UNVERIFIED"), kind: "error" };
  }

  return (
    <ConsoleAuthBoundary initialAuth={auth.initialAuth} mode={auth.mode}>
      <InviteScreen state={state} token={token} viewer={{ email: auth.viewer.email, name: auth.viewer.name }} />
    </ConsoleAuthBoundary>
  );
}

function stateFor(view: Awaited<ReturnType<typeof getOrganizationInviteView>>, error: string | undefined): InviteScreenState {
  switch (view.state) {
    case "pending":
      if (error) return { copy: inviteErrorCopy(error), kind: "error" };
      return {
        email: view.email,
        expiresAt: view.expiresAt,
        invitedBy: view.invitedBy,
        kind: "pending",
        organizationName: view.organizationName,
        role: view.role,
      };
    case "accepted":
    case "already_member":
      return { kind: "joined", organizationName: view.organizationName };
    case "email_mismatch":
    case "email_unverified":
      return {
        email: view.email,
        kind: "wrong_account",
        organizationName: view.organizationName,
        unverified: view.state === "email_unverified",
      };
    case "expired":
      return { copy: inviteErrorCopy("INVITE_EXPIRED"), kind: "error" };
    case "revoked":
      return { copy: inviteErrorCopy("INVITE_REVOKED"), kind: "error" };
    default:
      return { copy: inviteErrorCopy("INVITE_INVALID"), kind: "error" };
  }
}

/** Fixed copy per error code; never echoes ids or other people's emails. */
function inviteErrorCopy(code: string) {
  switch (code) {
    case "INVITE_EXPIRED":
      return {
        description: "Invites last 7 days. Ask whoever invited you to send a new link.",
        title: "This invite has expired",
      };
    case "INVITE_REVOKED":
      return {
        description: "Whoever invited you cancelled it or sent a newer link. Ask them for the latest one.",
        title: "This invite was cancelled",
      };
    case "INVITE_USED":
      return {
        description: "Each invite works once. If you still need access, ask for a new link.",
        title: "This invite was already used",
      };
    case "INVITE_EMAIL_UNVERIFIED":
      return {
        description:
          "Sign in with a method that confirms you own the invited address, such as a code sent to it or Google, then open the link again.",
        title: "Verify your email first",
      };
    case "INVITE_EMAIL_MISMATCH":
      return {
        description: "Sign in with the email the invite was sent to, then open the link again.",
        title: "This invite is for another email",
      };
    case "INVITE_INVALID":
      return {
        description: "Check that you copied the whole link, or ask whoever invited you to send it again.",
        title: "This invite link is not valid",
      };
    default:
      return {
        description: "Nothing changed. Try again, or ask whoever invited you for a new link.",
        title: "Something went wrong",
      };
  }
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
