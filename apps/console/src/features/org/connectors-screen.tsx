"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Lock, Plug, Unplug } from "lucide-react";
import { useState } from "react";

import {
  ADMIN_CONNECTIONS_ENDPOINT,
  ADMIN_POLICY_SET_ENDPOINT,
  adminRevokeEndpoint,
  CEILING_OPTIONS,
  ceilingChange,
  ceilingHint,
  CONNECTABLE_PROVIDERS,
  connectionStatus,
  connectorErrorText,
  groupTools,
  isHistory,
  isNotConfigured,
  memberName,
  providerName,
  retryConnectorQuery,
  shownCeiling,
  type AdminConnectionsResponse,
  type CeilingValue,
  type ConnectableProvider,
  type OrgPolicyResponse,
} from "@/features/connectors/model";
import { roleCapabilities, roleLabel, useOrgKey, useWorkspace } from "@/features/shell/workspace";
import { api, ApiError } from "@/lib/api/client";
import type { AdminConnectionRow, OrgPolicy, ToolCeilingChange } from "@/server/connectors/console-client";
import { Avatar, Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { FormMessage, Select, Switch } from "@/ui/form";
import { Panel, Section } from "@/ui/layout";
import { List } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Skeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { useOrgPolicy, useOrgPolicyKey } from "./connector-policy";
import { ManagedAccountsSection, OrganizationAccountsSection } from "./org-accounts-section";
import { OrgArea } from "./org-area";

export function OrgConnectorsScreen() {
  return (
    <OrgArea tab="connectors">
      <ConnectorsBody />
    </OrgArea>
  );
}

function ConnectorsBody() {
  const { organization } = useWorkspace();
  if (!roleCapabilities(organization.role).canAdminOrganization) {
    // A member who manages an organization account also gets it here, without the organization's rules.
    return (
      <div className="space-y-10">
        <EmptyState
          action={
            <Button href="/connectors" iconRight={ArrowRight} variant="secondary">
              Go to Connectors
            </Button>
          }
          description={`Owners and admins decide which connectors members can use here, what agents may do with them, and which organization accounts agents share. Your role is ${roleLabel(organization.role)}. Your own connected accounts are in Connectors.`}
          icon={Lock}
          title="Only owners and admins manage this"
        />
        <ManagedAccountsSection />
      </div>
    );
  }
  return (
    <div className="space-y-10">
      {CONNECTABLE_PROVIDERS.map((provider) => (
        <ProviderPolicySection key={provider.id} provider={provider} />
      ))}
      <OrganizationAccountsSection />
      <MemberConnectionsSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The organization's rules for one connector
// ---------------------------------------------------------------------------

/** One change at a time, as the set route takes it: a switch, or one tool's ceiling. */
type PolicyChange = { enabled?: boolean; writesAllowed?: boolean; sharedAllowed?: boolean; toolCeiling?: ToolCeilingChange };

function ProviderPolicySection({ provider }: { provider: ConnectableProvider }) {
  const { organization } = useWorkspace();
  const key = useOrgPolicyKey(provider.id);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmOff, setConfirmOff] = useState(false);

  const query = useOrgPolicy(provider.id);
  const save = useMutation({
    mutationFn: (change: PolicyChange) =>
      api.post<OrgPolicyResponse>(ADMIN_POLICY_SET_ENDPOINT, { provider: provider.id, ...change }),
    onSuccess: (response, change) => {
      queryClient.setQueryData(key, response);
      setConfirmOff(false);
      toast.show(changeMessage(provider.name, change));
    },
  });

  return (
    <Section
      description={`Whether members can connect ${provider.name} here, and the most agents may do with those accounts.`}
      title={provider.name}
    >
      {query.isPending ? (
        <Panel padded>
          <div aria-busy aria-label="Loading" className="space-y-4" role="status">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-9 w-full" />
          </div>
        </Panel>
      ) : query.isError ? (
        isNotConfigured(query.error) ? (
          <EmptyState
            description="The service that keeps connected accounts isn't set up for this Console, so these rules can't be read or changed here."
            icon={Plug}
            title="Connections aren't set up on this Console"
          />
        ) : (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            role={roleLabel(organization.role)}
            title={`${provider.name} rules couldn't load`}
          />
        )
      ) : (
        <PolicyPanel
          error={save.isError ? connectorErrorText(save.error, "admin") : null}
          onChange={(change) => {
            if (change.enabled === false) setConfirmOff(true);
            else save.mutate(change);
          }}
          pending={save.isPending ? (save.variables ?? null) : null}
          policy={query.data}
          provider={provider}
        />
      )}
      <Dialog
        description={`Members can't connect ${provider.name} accounts here, and agents stop using the ones already connected until you turn it back on. The connections stay.`}
        footer={
          <>
            <Button disabled={save.isPending} onClick={() => setConfirmOff(false)} variant="ghost">
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate({ enabled: false })} variant="danger">
              Turn off
            </Button>
          </>
        }
        onClose={() => {
          if (!save.isPending) setConfirmOff(false);
        }}
        open={confirmOff}
        title={`Turn off ${provider.name} for ${organization.name}?`}
      >
        {save.isError && confirmOff ? <FormMessage>{connectorErrorText(save.error, "admin")}</FormMessage> : null}
      </Dialog>
    </Section>
  );
}

function changeMessage(provider: string, change: PolicyChange) {
  if (change.enabled !== undefined) return change.enabled ? `${provider} is on for this organization.` : `${provider} is off for this organization.`;
  if (change.writesAllowed !== undefined) return change.writesAllowed ? "Writing tools are allowed." : "Writing tools are off. Agents can only read.";
  if (change.sharedAllowed !== undefined) {
    return change.sharedAllowed
      ? "Shared accounts are allowed. Connect an organization account below."
      : "Shared accounts are off. Agents stop using organization accounts.";
  }
  return "Tool limits saved.";
}

function PolicyPanel({
  error,
  onChange,
  pending,
  policy,
  provider,
}: {
  error: string | null;
  onChange: (change: PolicyChange) => void;
  /** The change being saved; controls show it until the save settles. */
  pending: PolicyChange | null;
  policy: OrgPolicy;
  provider: ConnectableProvider;
}) {
  const enabled = pending?.enabled ?? policy.enabled;
  const writesAllowed = pending?.writesAllowed ?? policy.writesAllowed;
  const sharedAllowed = pending?.sharedAllowed ?? policy.sharedAllowed;
  const busy = pending !== null;
  const groups = groupTools(policy.tools);

  return (
    <Panel>
      <div className="space-y-5 px-5 py-5">
        <Switch
          checked={enabled}
          description={
            enabled
              ? `Members can connect ${provider.name} accounts, and agents use them only as each member allows.`
              : `Nobody can connect ${provider.name} here, and agents can't use the accounts already connected.`
          }
          disabled={busy}
          label={`${provider.name} enabled for this organization`}
          onChange={(checked) => onChange({ enabled: checked })}
        />
        <Switch
          checked={writesAllowed}
          description={
            writesAllowed
              ? "Agents may send email when the account's owner allows it."
              : "Agents can only read. Sending email is blocked for everyone."
          }
          disabled={busy}
          label="Allow writing tools"
          onChange={(checked) => onChange({ writesAllowed: checked })}
        />
        <Switch
          checked={sharedAllowed}
          description={
            sharedAllowed
              ? `Owners and admins can connect organization ${provider.name} accounts and choose which agents share them, and where.`
              : `Only personal accounts. Agents can't use an organization ${provider.name} account.`
          }
          disabled={busy}
          label="Allow shared accounts"
          onChange={(checked) => onChange({ sharedAllowed: checked })}
        />
      </div>

      <div className="space-y-3 border-t border-line px-5 py-5">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-ink">Tool limits</h3>
          <p className="text-[13px] text-ink-3">The most each member can allow. Members can always be stricter.</p>
        </div>
        {groups.length === 0 ? (
          <p className="text-[13px] text-ink-3">There are no tools to limit yet.</p>
        ) : (
          groups.map((group) => (
            <div className="space-y-1" key={group.key}>
              <h4 className="text-[13px] font-medium text-ink-2">{group.title}</h4>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {group.tools.map((tool) => {
                  const hint = ceilingHint(tool, { writesAllowed });
                  return (
                    <li className="space-y-1 px-3 py-2.5" key={tool.capability}>
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                        <span className={hint ? "text-sm text-ink-3" : "text-sm text-ink"}>{tool.label}</span>
                        <Select
                          aria-label={`Limit for ${tool.label}`}
                          className="h-8 w-[160px] text-[13px]"
                          disabled={busy || Boolean(hint)}
                          onChange={(event) =>
                            onChange({ toolCeiling: ceilingChange(tool.capability, event.target.value as CeilingValue) })
                          }
                          value={hint ? "blocked" : shownCeiling(policy.toolCeilings, tool.capability, pending?.toolCeiling)}
                        >
                          {CEILING_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                      {hint ? <p className="text-[12.5px] text-ink-3">{hint}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
      {error ? (
        <div className="border-t border-line px-5 py-4">
          <FormMessage>{error}</FormMessage>
        </div>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Members' connections
// ---------------------------------------------------------------------------

function MemberConnectionsSection() {
  const { organization } = useWorkspace();
  const orgKey = useOrgKey();
  const key = orgKey("connectors", "admin", "connections");
  const [revoking, setRevoking] = useState<AdminConnectionRow | null>(null);
  const query = useQuery({
    queryFn: () => api.post<AdminConnectionsResponse>(ADMIN_CONNECTIONS_ENDPOINT),
    queryKey: key,
    retry: retryConnectorQuery,
    // Organization accounts have their own section.
    select: (response) =>
      (response.connections ?? []).filter((connection) => !isHistory(connection) && connection.scopeKind !== "organization"),
  });

  return (
    <Section
      description="Accounts members connected in this organization. You see who and which account, never what agents read or sent."
      title="Members' connections"
    >
      {query.isPending ? (
        <ListSkeleton rows={2} />
      ) : query.isError ? (
        isNotConfigured(query.error) ? null : (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            role={roleLabel(organization.role)}
            title="Members' connections couldn't load"
          />
        )
      ) : query.data.length === 0 ? (
        <EmptyState description="When members connect an account, it shows here." icon={Plug} title="No member has connected an account" />
      ) : (
        <List label="Members' connections">
          {query.data.map((connection) => (
            <MemberConnectionRow connection={connection} key={connection.id} onRevoke={() => setRevoking(connection)} />
          ))}
        </List>
      )}
      <RevokeMemberConnectionDialog connection={revoking} listKey={key} onClose={() => setRevoking(null)} />
    </Section>
  );
}

function MemberConnectionRow({ connection, onRevoke }: { connection: AdminConnectionRow; onRevoke: () => void }) {
  const status = connectionStatus(connection);
  const member = memberName(connection);
  const disconnecting = connection.status === "revoke_pending";
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Avatar label={member} seed={connection.member.userId ?? connection.id} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-ink">{member}</span>
          {connection.member.name && connection.member.email ? (
            <span className="hidden truncate text-[13px] text-ink-3 sm:inline">{connection.member.email}</span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[13px] text-ink-3">
          {providerName(connection.provider)} · {connection.email ?? "Account email not known yet"}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-ink-3 md:hidden">
          <Badge dot tone={status.tone}>
            {status.label}
          </Badge>
        </div>
      </div>
      <div className="hidden shrink-0 items-center gap-3 text-[13px] text-ink-3 md:flex">
        <Badge dot tone={status.tone}>
          {status.label}
        </Badge>
        <span>{connection.lastUsedAt ? <>Used <RelativeTime value={connection.lastUsedAt} /></> : "Not used yet"}</span>
      </div>
      <Button
        className="shrink-0"
        icon={Unplug}
        onClick={onRevoke}
        size="sm"
        variant="ghost"
      >
        {disconnecting ? "Try again" : "Revoke"}
      </Button>
    </li>
  );
}

function RevokeMemberConnectionDialog({
  connection,
  listKey,
  onClose,
}: {
  connection: AdminConnectionRow | null;
  listKey: readonly unknown[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const revoke = useMutation({
    mutationFn: (target: AdminConnectionRow) =>
      api.post<{ status: "ok"; revoked: boolean }>(adminRevokeEndpoint(target.id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: listKey }),
  });
  const close = () => {
    if (revoke.isPending) return;
    revoke.reset();
    onClose();
  };
  const run = (target: AdminConnectionRow) =>
    revoke.mutate(target, {
      onError: (error) => {
        if (error instanceof ApiError && error.code === "connector_provider_error") {
          revoke.reset();
          onClose();
          toast.show(
            `${providerName(target.provider)} didn't confirm yet, so the connection shows Disconnecting… Agents can't use it meanwhile; Ravi keeps trying.`,
            "err",
          );
        }
      },
      onSuccess: () => {
        toast.show(`Revoked ${target.email ?? "the connection"} of ${memberName(target)}.`);
        onClose();
      },
    });

  const provider = connection ? providerName(connection.provider) : "";
  const member = connection ? memberName(connection) : "";
  return (
    <Dialog
      description={
        connection
          ? `${provider} is told to revoke access and Ravi deletes the tokens. ${member}'s agents and commands that use this account stop working. They can connect it again.`
          : undefined
      }
      footer={
        <>
          <Button disabled={revoke.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button icon={Unplug} loading={revoke.isPending} onClick={() => connection && run(connection)} variant="danger">
            Revoke
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(connection)}
      title={connection ? `Revoke ${connection.email ?? `${member}'s ${provider} account`}?` : "Revoke connection"}
    >
      {revoke.isError ? <FormMessage>{connectorErrorText(revoke.error, "admin")}</FormMessage> : null}
    </Dialog>
  );
}
