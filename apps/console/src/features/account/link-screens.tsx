"use client";

import { ArrowLeft, CheckCircle2, Link2, MessageCircle, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/ui/button";
import { Dialog } from "@/ui/overlay";
import { DetailList } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { EmptyState, Notice } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { SignedInAs, StandaloneFrame } from "./standalone-frame";
import { IconTile, InlineText, StandaloneCard, StateCard } from "./state-card";

type Viewer = { email: string; name: string };
type Copy = { title: string; description: string };

export type LinkBindingItem = {
  id: string;
  channel: string | null;
  installationName: string;
  linkedAt: string;
  organizationName: string;
};

/** `/link`: the chat accounts that act as the signed-in person. */
export function LinkedAccountsScreen({
  bindings,
  error,
  revoked,
  viewer,
}: {
  bindings: LinkBindingItem[];
  error: Copy | null;
  revoked: boolean;
  viewer: Viewer;
}) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="lg">
      <Button className="mb-4 -ml-2.5" href="/projects" icon={ArrowLeft} size="sm" variant="ghost">
        Back to Console
      </Button>
      <div className="mb-6 space-y-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Linked chat accounts</h1>
        <p className="text-sm text-ink-2">
          Chat accounts that act as you in Ravi. Unlinking takes effect on the installation within a few minutes.
        </p>
      </div>

      <div className="space-y-3">
        {revoked ? (
          <Notice icon={CheckCircle2} title="Unlinked" tone="ok">
            That chat account no longer acts as you.
          </Notice>
        ) : null}
        {error ? (
          <Notice icon={XCircle} title={error.title} tone="err">
            <InlineText text={error.description} />
          </Notice>
        ) : null}

        {bindings.length === 0 ? (
          <EmptyState
            description={<InlineText text="Run `ravi link` in a chat with Ravi to link your account. Ravi replies with a link that brings you here to approve it." />}
            icon={Link2}
            title="No linked chat accounts"
          />
        ) : (
          <>
            <List label="Linked chat accounts">
              {bindings.map((binding) => (
                <ListRow
                  actions={<UnlinkButton binding={binding} />}
                  description={
                    <>
                      <span className="block whitespace-normal md:truncate md:whitespace-nowrap">
                        {binding.installationName} · {binding.organizationName}
                      </span>
                      <span className="block md:hidden">
                        Linked <RelativeTime value={binding.linkedAt} />
                      </span>
                    </>
                  }
                  key={binding.id}
                  leading={
                    <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-full bg-sunken text-ink-3">
                      <MessageCircle size={16} />
                    </span>
                  }
                  meta={
                    <span title={formatDate(binding.linkedAt, true)}>
                      Linked <RelativeTime value={binding.linkedAt} />
                    </span>
                  }
                  title={`${binding.channel ?? "Chat"} account`}
                />
              ))}
            </List>
            <p className="px-1 text-[13px] text-ink-3">
              <InlineText text="To link another chat account, send `ravi link` in a chat with Ravi." />
            </p>
          </>
        )}
      </div>
    </StandaloneFrame>
  );
}

/** Confirms before posting the same revoke form the page always used. */
function UnlinkButton({ binding }: { binding: LinkBindingItem }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const name = `${binding.channel ?? "chat"} account`;
  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="danger">
        Unlink
      </Button>
      <Dialog
        description={`Messages from it stop acting as you in Ravi. This takes effect on ${binding.installationName} within a few minutes.`}
        footer={
          <>
            <Button onClick={() => setOpen(false)} variant="secondary">
              Cancel
            </Button>
            <form action={`/api/console/link/bindings/${binding.id}/revoke`} method="post" onSubmit={() => setSubmitting(true)}>
              <Button loading={submitting} type="submit" variant="danger">
                Unlink
              </Button>
            </form>
          </>
        }
        onClose={() => setOpen(false)}
        open={open}
        title={`Unlink this ${name}?`}
      >
        <p className="text-sm text-ink-2">
          <InlineText text="To link it again later, send `ravi link` in that chat." />
        </p>
      </Dialog>
    </>
  );
}

export type LinkApprovalState =
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "error"; copy: Copy }
  | {
      kind: "pending";
      channel: string | null;
      expiresAt: string;
      installationName: string;
      organizationName: string;
      requesterDisplayName: string | null;
    };

/** `/link/:token`: one decision, approve the chat account or say it wasn't you. */
export function LinkApprovalScreen({ state, token, viewer }: { state: LinkApprovalState; token: string; viewer: Viewer }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      <LinkApprovalBody state={state} token={token} viewer={viewer} />
    </StandaloneFrame>
  );
}

function LinkApprovalBody({ state, token, viewer }: { state: LinkApprovalState; token: string; viewer: Viewer }) {
  if (state.kind === "approved") {
    return (
      <StateCard
        actions={
          <Button href="/link" variant="secondary">
            Linked chat accounts
          </Button>
        }
        icon={CheckCircle2}
        title="Chat account linked"
        tone="ok"
      >
        <p>
          Ravi now knows this chat account is you. You can close this page and go back to the chat. Manage your links any
          time on the Linked chat accounts page.
        </p>
      </StateCard>
    );
  }
  if (state.kind === "denied") {
    return (
      <StateCard icon={ShieldAlert} title="Request declined" tone="neutral">
        <p>Nothing was linked. If you did not ask for this, you can ignore the message that brought you here.</p>
      </StateCard>
    );
  }
  if (state.kind === "error") {
    return (
      <StateCard icon={XCircle} title={state.copy.title} tone="err">
        <p>
          <InlineText text={state.copy.description} />
        </p>
      </StateCard>
    );
  }
  return <PendingLink state={state} token={token} viewer={viewer} />;
}

function PendingLink({
  state,
  token,
  viewer,
}: {
  state: Extract<LinkApprovalState, { kind: "pending" }>;
  token: string;
  viewer: Viewer;
}) {
  const [submitting, setSubmitting] = useState<"approve" | "deny" | null>(null);
  const channel = state.channel ?? "chat";
  const requester = state.requesterDisplayName ? `${state.requesterDisplayName} on ${channel}` : `A ${channel} account`;

  return (
    <StandaloneCard>
      <IconTile icon={MessageCircle} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">
        Link your {channel} account to {viewer.name}
      </h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {`${requester} asked to be linked to your Console account. Confirm only if that's you.`}
      </p>

      <DetailList
        className="mt-5 border-y border-line [&>div]:grid-cols-[112px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-2.5 sm:[&>div]:grid-cols-[140px_minmax(0,1fr)]"
        items={[
          { label: "Who's asking", value: requester },
          { label: "Ravi installation", value: state.installationName },
          { label: "Organization", value: state.organizationName },
        ]}
      />

      <Notice className="mt-5" icon={ShieldCheck} title="If you approve" tone="info">
        Messages from that chat account act as you in Ravi: your Console identity, your access and your connectors.
        Approve only if you asked for this link yourself.
      </Notice>

      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <form action="/api/console/link/deny" method="post" onSubmit={() => setSubmitting("deny")}>
          <input name="token" type="hidden" value={token} />
          <Button className="w-full sm:w-auto" disabled={submitting === "approve"} loading={submitting === "deny"} type="submit" variant="secondary">
            This wasn&apos;t me
          </Button>
        </form>
        <form action="/api/console/link/approve" method="post" onSubmit={() => setSubmitting("approve")}>
          <input name="token" type="hidden" value={token} />
          <Button className="w-full sm:w-auto" disabled={submitting === "deny"} loading={submitting === "approve"} type="submit" variant="primary">
            Approve
          </Button>
        </form>
      </div>

      <p className="mt-5 text-[13px] text-ink-3">
        This link works once and expires <RelativeTime value={state.expiresAt} />, at {formatDate(state.expiresAt, true)}.
      </p>
    </StandaloneCard>
  );
}
