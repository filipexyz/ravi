"use client";

import { CheckCircle2, MailWarning, UserPlus, XCircle } from "lucide-react";
import { useState } from "react";

import type { OrganizationRole } from "@/features/console/types";
import { ROLE_HELP } from "@/features/org/labels";
import { roleLabel } from "@/features/shell/workspace";
import { Button } from "@/ui/button";
import { DetailList } from "@/ui/layout";
import { Notice } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { SignedInAs, StandaloneFrame } from "./standalone-frame";
import { IconTile, StandaloneCard, StateCard } from "./state-card";

type Viewer = { email: string; name: string };
type Copy = { title: string; description: string };

export type InviteScreenState =
  | { kind: "error"; copy: Copy }
  | { kind: "joined"; organizationName: string }
  | { kind: "wrong_account"; email: string; organizationName: string; unverified: boolean }
  | {
      kind: "pending";
      email: string;
      expiresAt: string;
      invitedBy: string | null;
      organizationName: string;
      role: OrganizationRole;
    };

/** `/invite/:token`: join an organization with the link someone sent. */
export function InviteScreen({ state, token, viewer }: { state: InviteScreenState; token: string; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      <InviteBody state={state} token={token} viewer={viewer} />
    </StandaloneFrame>
  );
}

function InviteBody({ state, token, viewer }: { state: InviteScreenState; token: string; viewer: Viewer }) {
  if (state.kind === "joined") {
    return (
      <StateCard
        actions={
          <Button href="/projects" variant="primary">
            Open the Console
          </Button>
        }
        icon={CheckCircle2}
        title={`You're in ${state.organizationName}`}
        tone="ok"
      >
        <p>This account already belongs to the organization.</p>
      </StateCard>
    );
  }

  if (state.kind === "wrong_account") {
    return (
      <StateCard
        actions={
          <Button external href="/logout" variant="primary">
            Sign in with {state.email}
          </Button>
        }
        icon={MailWarning}
        title={state.unverified ? "Verify your email first" : "This invite is for another email"}
        tone="warn"
      >
        {state.unverified ? (
          <p>
            The invite to {state.organizationName} is for {state.email}. Sign in with a method that confirms you own that
            address, such as a code sent to it or Google, then open the link again.
          </p>
        ) : (
          <p>
            The invite to {state.organizationName} is for {state.email}, and you are signed in as {viewer.email}. Sign out,
            sign in with {state.email}, then open the link again.
          </p>
        )}
      </StateCard>
    );
  }

  if (state.kind === "error") {
    return (
      <StateCard icon={XCircle} title={state.copy.title} tone="err">
        <p>{state.copy.description}</p>
      </StateCard>
    );
  }

  return <PendingInvite state={state} token={token} />;
}

function PendingInvite({ state, token }: { state: Extract<InviteScreenState, { kind: "pending" }>; token: string }) {
  const [submitting, setSubmitting] = useState(false);
  const role = roleLabel(state.role);
  return (
    <StandaloneCard>
      <IconTile icon={UserPlus} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">Join {state.organizationName}</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {state.invitedBy ? `${state.invitedBy} invited you` : "You were invited"} to work in {state.organizationName} on
        Ravi.
      </p>

      <DetailList
        className="mt-5 border-y border-line [&>div]:grid-cols-[112px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5 sm:[&>div]:grid-cols-[140px_minmax(0,1fr)]"
        items={[
          { label: "Organization", value: state.organizationName },
          { label: "Your role", value: role },
          { label: "For", value: state.email },
        ]}
      />

      <Notice className="mt-5" title={`As ${role}`} tone="info">
        {ROLE_HELP[state.role]}
      </Notice>

      <form action="/api/console/invites/accept" className="mt-6 flex justify-end" method="post" onSubmit={() => setSubmitting(true)}>
        <input name="token" type="hidden" value={token} />
        <Button className="w-full sm:w-auto" loading={submitting} type="submit" variant="primary">
          Join {state.organizationName}
        </Button>
      </form>

      <p className="mt-5 text-[13px] text-ink-3">
        This link works once and expires <RelativeTime value={state.expiresAt} />, on {formatDate(state.expiresAt, true)}.
      </p>
    </StandaloneCard>
  );
}
