"use client";

import { Trash2, UserPlus } from "lucide-react";
import { useId, useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import { roleCapabilities, useWorkspace } from "@/features/shell/workspace";
import { Avatar } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { Field, FormMessage, Input, Select, Switch } from "@/ui/form";
import { Panel } from "@/ui/layout";
import { List } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { ListSkeleton, Skeleton } from "@/ui/states";
import { RelativeTime, formatDate } from "@/ui/time";
import { useToast } from "@/ui/toast";

import {
  useMeetingAccess,
  useMeetingsSharingSettings,
  useSaveMeetingsSharingSettings,
  useShareMeeting,
  useUnshareMeeting,
} from "./api";
import type { Meeting, MeetingGrant } from "./types";

const EXPIRY_OPTIONS = [
  { days: 0, label: "No end date" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

function shareErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "forbidden":
      case "PROJECT_ACCESS_DENIED":
        return "Only people who can record calls in this project can share its meetings.";
      case "user_inactive":
        return "This person's account is suspended, so they can't be given access.";
      case "grant_not_found":
        return "This person no longer has access. Refresh the page.";
      case "validation_failed":
        if (error.fieldErrors?.expiresAt) return "Pick an end date within the next 365 days.";
        break;
    }
  }
  return describeError(error);
}

function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "");
}

/**
 * Share for one meeting, as a header button: who was given it, and a form to
 * give it to one more person by email. Shown to people who can write to the
 * project; the server checks again.
 */
export function ShareMeetingButton({ meeting, projectId }: { meeting: Meeting; projectId: string }) {
  const { organization } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!roleCapabilities(organization.role).canWriteProjects) return null;
  return (
    <>
      <Button icon={UserPlus} onClick={() => setOpen(true)} variant="ghost">
        Share
      </Button>
      {open ? <ShareMeetingDialog meeting={meeting} onClose={() => setOpen(false)} projectId={projectId} /> : null}
    </>
  );
}

function ShareMeetingDialog({ meeting, onClose, projectId }: { meeting: Meeting; onClose: () => void; projectId: string }) {
  const { organization } = useWorkspace();
  const access = useMeetingAccess(projectId, meeting.id);
  const share = useShareMeeting(projectId, meeting.id);
  const formId = useId();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [days, setDays] = useState("0");
  const [removing, setRemoving] = useState<MeetingGrant | null>(null);

  const serverEmailError = share.error instanceof ApiError && share.error.fieldErrors?.email ? "Enter a valid email address." : null;
  const formError = share.isError && !serverEmailError ? shareErrorMessage(share.error) : null;
  const result = share.data;

  if (removing) {
    return <RemoveMeetingAccessDialog grant={removing} meetingId={meeting.id} onClose={() => setRemoving(null)} projectId={projectId} />;
  }

  if (result) {
    return (
      <Dialog
        description={result.created ? undefined : "They already had access. Their end date now matches what you picked."}
        footer={
          <Button onClick={onClose} variant="primary">
            Done
          </Button>
        }
        onClose={onClose}
        open
        title={`Shared with ${result.grant.email}`}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-line bg-sunken py-1.5 pr-1.5 pl-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink" title={result.grant.url}>
              {displayUrl(result.grant.url)}
            </span>
            <CopyButton label="Copy link" value={result.grant.url} variant="secondary">
              Copy link
            </CopyButton>
          </div>
          <p className="text-sm text-ink-2">
            Send them this link. They sign in with <span className="font-medium text-ink">{result.grant.email}</span> to open it.
          </p>
        </div>
      </Dialog>
    );
  }

  const grants = access.data ?? [];

  return (
    <Dialog
      className="max-w-lg"
      description="One person can watch this call and read its transcript after signing in with their email. They see only this meeting."
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
          <Button form={formId} icon={UserPlus} loading={share.isPending} type="submit" variant="primary">
            Share
          </Button>
        </>
      }
      onClose={onClose}
      open
      title="Share this meeting"
    >
      <div className="space-y-5">
        <form
          className="space-y-4"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            const value = email.trim().toLowerCase();
            if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
              setEmailError("Enter a valid email address.");
              return;
            }
            setEmailError(null);
            const length = Number(days);
            share.mutate({ email: value, expiresAt: length ? new Date(Date.now() + length * 86_400_000).toISOString() : null });
          }}
        >
          <Field error={emailError ?? serverEmailError} label="Email">
            {(props) => (
              <Input
                {...props}
                autoComplete="off"
                autoFocus
                inputMode="email"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailError(null);
                }}
                placeholder="name@company.com"
                spellCheck={false}
                type="email"
                value={email}
              />
            )}
          </Field>
          <Field label="Access ends">
            {(props) => (
              <Select {...props} onChange={(event) => setDays(event.target.value)} value={days}>
                {EXPIRY_OPTIONS.map((option) => (
                  <option key={option.days} value={String(option.days)}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <p className="text-[13px] text-ink-3">
            No email is sent: you send them the link. Their own Ravi can read the transcript only if {organization.name} lets
            agents from other organizations read meetings (organization settings).
          </p>
          {formError ? <FormMessage>{formError}</FormMessage> : null}
        </form>

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-ink">People with access</h3>
          {access.isPending ? (
            <ListSkeleton rows={1} />
          ) : access.isError ? (
            <p className="text-[13px] text-ink-3">{shareErrorMessage(access.error)}</p>
          ) : grants.length === 0 ? (
            <p className="text-[13px] text-ink-3">No one outside the project.</p>
          ) : (
            <List label="People with access">
              {grants.map((grant) => {
                const who = grant.name || grant.email;
                return (
                  <li className="flex items-center gap-3 py-2.5 pr-2 pl-4" key={grant.id}>
                    <Avatar className="rounded-full" label={who} seed={grant.userId} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{who}</div>
                      <div className="text-[13px] [overflow-wrap:anywhere] text-ink-3">
                        {grant.name && grant.name !== grant.email ? <>{grant.email} · </> : null}
                        Shared{grant.createdBy ? ` by ${grant.createdBy}` : null} <RelativeTime value={grant.createdAt} />
                        {grant.expiresAt ? ` · until ${formatDate(grant.expiresAt)}` : null}
                      </div>
                    </div>
                    <CopyButton label={`Copy the link for ${who}`} value={grant.url} variant="ghost" />
                    <IconButton
                      className="text-ink-3 hover:text-err"
                      icon={Trash2}
                      label={`Remove access for ${who}`}
                      onClick={() => setRemoving(grant)}
                      size="sm"
                    />
                  </li>
                );
              })}
            </List>
          )}
        </section>
      </div>
    </Dialog>
  );
}

function RemoveMeetingAccessDialog({
  grant,
  meetingId,
  onClose,
  projectId,
}: {
  grant: MeetingGrant;
  meetingId: string;
  onClose: () => void;
  projectId: string;
}) {
  const remove = useUnshareMeeting(projectId, meetingId);
  const toast = useToast();
  const who = grant.name || grant.email;
  return (
    <Dialog
      description={
        <>
          <span className="font-medium text-ink">{grant.email}</span> can no longer open this meeting, and their Ravi can no
          longer read it. If they are also in the project, they keep that access.
        </>
      }
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            icon={Trash2}
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(grant.id, {
                onSuccess: () => {
                  toast.show(`${who} no longer has access.`);
                  onClose();
                },
              })
            }
            variant="danger"
          >
            Remove access
          </Button>
        </>
      }
      onClose={onClose}
      open
      title={`Remove access for ${who}?`}
    >
      {remove.isError ? <FormMessage>{shareErrorMessage(remove.error)}</FormMessage> : null}
    </Dialog>
  );
}

/**
 * The organization's switch for agents logged into other organizations. Off
 * by default; owners and admins change it, everyone else sees where it is.
 */
export function MeetingsSharingPanel() {
  const settings = useMeetingsSharingSettings();
  const save = useSaveMeetingsSharingSettings();
  const toast = useToast();

  return (
    <Panel padded>
      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold text-ink">Meetings</h2>
        {settings.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : settings.isError ? (
          <p className="text-[13px] text-ink-3">{describeError(settings.error)}</p>
        ) : (
          <>
            <Switch
              checked={settings.data.externalAgents}
              description={
                <>
                  Someone who can see a meeting here (in its project, or because it was shared with them) can have the Ravi
                  of another organization read its transcript at the moment. Nothing is copied: each read asks this
                  organization again and shows up in its audit log.
                  {settings.data.canEdit ? null : " Only owners and admins can change this."}
                </>
              }
              disabled={!settings.data.canEdit || save.isPending}
              label="Agents from other organizations can read meetings"
              onChange={(externalAgents) =>
                save.mutate(
                  { externalAgents },
                  {
                    onError: (error) => toast.show(describeError(error), "err"),
                    onSuccess: () =>
                      toast.show(
                        externalAgents
                          ? "Agents from other organizations can read meetings now."
                          : "Only this organization's agents can read meetings now.",
                      ),
                  },
                )
              }
            />
            {settings.data.updatedAt ? (
              <p className="text-xs text-ink-3">
                Changed{settings.data.updatedBy ? ` by ${settings.data.updatedBy}` : null} <RelativeTime value={settings.data.updatedAt} />
              </p>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
