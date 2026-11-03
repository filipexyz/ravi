"use client";

import { CheckCircle2, Clock3, KeyRound, ShieldX, Terminal, UserX, XCircle } from "lucide-react";
import { useState } from "react";

import { roleLabel } from "@/features/shell/workspace";
import { cn } from "@/lib/cn";
import { Avatar } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CodeBlock } from "@/ui/copy";
import { Notice } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { SignedInAs, StandaloneFrame } from "./standalone-frame";
import { IconTile, StandaloneCard, StateCard } from "./state-card";

export type CliAuthorizeOrganization = {
  id: string;
  name: string;
  role: string;
};

/** What `/cli/authorize` resolved on the server, in the order the page checks it. */
export type CliAuthorizeView =
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "approved" }
  | { kind: "consumed" }
  | { kind: "denied" }
  | { kind: "org_access_denied" }
  | { kind: "error"; code: string }
  | { kind: "no_organizations" }
  | {
      kind: "pending";
      expiresAt: string | null;
      organizations: CliAuthorizeOrganization[];
      selectRequired: boolean;
      userCode: string;
    };

export function CliAuthorizeScreen({ view, viewer }: { view: CliAuthorizeView; viewer: { email: string; name: string } }) {
  return (
    <StandaloneFrame aside={<SignedInAs email={viewer.email} name={viewer.name} />} width="md">
      <CliAuthorizeBody view={view} />
    </StandaloneFrame>
  );
}

function RunLoginAgain({ label = "Run this in your terminal to get a new code:" }: { label?: string }) {
  return (
    <div className="space-y-2 pt-1">
      <p>{label}</p>
      <CodeBlock code="ravi login" />
    </div>
  );
}

function CliAuthorizeBody({ view }: { view: CliAuthorizeView }) {
  switch (view.kind) {
    case "invalid":
      return (
        <StateCard icon={XCircle} title="This sign-in code isn't valid" tone="err">
          <p>The link may be incomplete, or the code was mistyped.</p>
          <RunLoginAgain />
        </StateCard>
      );
    case "expired":
      return (
        <StateCard icon={Clock3} title="This sign-in code expired" tone="warn">
          <p>Codes last 10 minutes.</p>
          <RunLoginAgain />
        </StateCard>
      );
    case "approved":
      return (
        <StateCard icon={CheckCircle2} title="Ravi CLI approved" tone="ok">
          <p>Go back to your terminal. It finishes signing in on its own in a few seconds, and you can close this tab.</p>
        </StateCard>
      );
    case "consumed":
      return (
        <StateCard icon={CheckCircle2} title="Ravi CLI already connected" tone="ok">
          <p>This code was already used, so your terminal is signed in. You can close this tab.</p>
        </StateCard>
      );
    case "denied":
      return (
        <StateCard icon={ShieldX} title="This sign-in was denied" tone="neutral">
          <p>Nothing was approved.</p>
          <RunLoginAgain label="To sign in, start again from your terminal:" />
        </StateCard>
      );
    case "org_access_denied":
      return (
        <StateCard icon={UserX} title="Your account can't connect the CLI yet" tone="err">
          <p>
            This account isn&apos;t an active member of an organization with a Console role. Ask an organization owner
            to add you. If you signed in with the wrong account, sign out or use a private window.
          </p>
          <RunLoginAgain label="Then run this again in your terminal:" />
        </StateCard>
      );
    case "error":
      return <CliErrorState code={view.code} />;
    case "no_organizations":
      return (
        <StateCard icon={UserX} title="No organization to connect to" tone="err">
          <p>
            The CLI always works inside an organization, and this account isn&apos;t in one yet. Ask an organization
            owner to add you. If you signed in with the wrong account, sign out or use a private window.
          </p>
          <RunLoginAgain label="Then run this again in your terminal:" />
        </StateCard>
      );
    case "pending":
      return <PendingApproval view={view} />;
  }
}

function CliErrorState({ code }: { code: string }) {
  if (code === "AUTH_PENDING") {
    return (
      <StateCard icon={Clock3} title="This approval is already going through" tone="info">
        <p>Check your terminal: it should finish signing in in a moment. If it doesn&apos;t, start again.</p>
        <RunLoginAgain label="To start again, run this in your terminal:" />
      </StateCard>
    );
  }
  return (
    <StateCard icon={XCircle} title="Couldn't approve this sign-in" tone="err">
      <p>Start again from your terminal and approve the new code. If it keeps failing, ask an organization owner to check your membership.</p>
      <RunLoginAgain label="Run this in your terminal:" />
      <p className="font-mono text-xs text-ink-3">Reference {code}</p>
    </StateCard>
  );
}

function PendingApproval({ view }: { view: Extract<CliAuthorizeView, { kind: "pending" }> }) {
  const [declined, setDeclined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const single = view.organizations.length === 1 ? view.organizations[0] : undefined;

  if (declined) {
    return (
      <StateCard
        actions={
          <Button onClick={() => setDeclined(false)} variant="secondary">
            Back to the code
          </Button>
        }
        icon={ShieldX}
        title="Sign-in not approved"
        tone="neutral"
      >
        <p>
          Nothing was approved and the terminal stays signed out. It keeps waiting until the code expires; press{" "}
          <kbd className="rounded border border-line bg-sunken px-1 font-mono text-xs">Ctrl+C</kbd> there to stop it.
        </p>
        <p>If you didn&apos;t start this sign-in, you can close this tab.</p>
      </StateCard>
    );
  }

  return (
    <StandaloneCard>
      <IconTile icon={Terminal} tone="info" />
      <h1 className="mt-4 font-display text-xl font-semibold tracking-tight text-ink">Approve sign-in from the Ravi CLI</h1>
      <p className="mt-1.5 text-sm text-ink-2">Check that this code matches the one in your terminal.</p>

      <div className="mt-5 rounded-lg border border-line bg-sunken px-4 py-5 text-center">
        <div aria-label={`Code ${view.userCode.split("").join(" ")}`} className="font-mono text-[28px] font-medium tracking-[0.16em] text-ink sm:text-[34px]">
          {view.userCode}
        </div>
        {view.expiresAt ? (
          <div className="mt-1.5 text-[13px] text-ink-3">
            Expires <RelativeTime value={view.expiresAt} />
          </div>
        ) : null}
      </div>

      <form
        action="/api/console/cli/auth/approve"
        className="mt-6"
        method="post"
        onSubmit={() => setSubmitting(true)}
      >
        <input name="userCode" type="hidden" value={view.userCode} />

        {view.selectRequired ? (
          <Notice className="mb-4" tone="warn">
            Choose the organization the CLI will work in, then approve.
          </Notice>
        ) : null}

        {single ? (
          <div className="space-y-2">
            <div className="text-sm font-medium text-ink">The CLI will work in</div>
            <input name="organizationId" type="hidden" value={single.id} />
            <div className="flex items-center gap-3 rounded-lg border border-line px-3.5 py-3">
              <Avatar label={single.name} seed={single.id} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-ink">{single.name}</div>
                <div className="text-[13px] text-ink-3">{roleLabel(single.role)}</div>
              </div>
            </div>
          </div>
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium text-ink">Choose the organization the CLI will work in</legend>
            {view.organizations.map((organization, index) => (
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3.5 py-3 transition-colors hover:bg-hover",
                  "has-[:checked]:border-ink has-[:checked]:bg-hover has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                )}
                key={organization.id}
              >
                <input
                  className="size-4 shrink-0 accent-[var(--rv-ink)]"
                  name="organizationId"
                  required={index === 0}
                  type="radio"
                  value={organization.id}
                />
                <Avatar label={organization.name} seed={organization.id} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{organization.name}</div>
                  <div className="text-[13px] text-ink-3">{roleLabel(organization.role)}</div>
                </div>
              </label>
            ))}
          </fieldset>
        )}

        <div className="mt-5 flex gap-2.5 text-[13px] text-ink-3">
          <KeyRound aria-hidden className="mt-0.5 shrink-0" size={14} />
          <p>
            The CLI on that computer will act as you in this organization: it can publish pages, read and change bases,
            and receive your agents&apos; events. Approve only if you just ran <code className="font-mono text-ink-2">ravi login</code>.
          </p>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button className="sm:w-auto" onClick={() => setDeclined(true)} variant="secondary">
            Deny
          </Button>
          <Button loading={submitting} type="submit" variant="primary">
            Approve
          </Button>
        </div>
      </form>
    </StandaloneCard>
  );
}
