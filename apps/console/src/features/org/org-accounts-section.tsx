"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Building2, Plus, RefreshCw, UserRound, Unplug } from "lucide-react";
import { createContext, useContext, useState } from "react";

import { ConnectionToolsSection } from "@/features/connectors/connection-detail";
import { ProviderMark } from "@/features/connectors/provider-mark";
import { useStartConnect } from "@/features/connectors/use-start-connect";
import {
  adminRevokeEndpoint,
  CONNECTABLE_PROVIDERS,
  connectionName,
  connectionStatus,
  connectorErrorText,
  connectStartBody,
  grantsByConnection,
  grantTitle,
  isHistory,
  isMissingRoute,
  isNotConfigured,
  isSharedAccountsOff,
  managerName,
  noManagerText,
  ORG_CONNECTIONS_ENDPOINT,
  ORG_INSTALLATIONS_ENDPOINT,
  ORG_SHARED_ENDPOINT,
  ORG_SHARED_LIST_ENDPOINT,
  organizationInstallationLabel,
  orgOwnerEndpoint,
  orgSharedRevokeEndpoint,
  providerName,
  retryConnectorQuery,
  revokeEndpoint,
  SHARED_CONVERSATION_OPTIONS,
  sharedConversationsText,
  sharedGrantConflict,
  sharedGrantConflictText,
  sharedGrantDraftError,
  type AgentGrantsResponse,
  type Connection,
  type ConnectableProvider,
  type ConnectorAction,
  type OrgConnectionsResponse,
  type OrgInstallationsResponse,
  type SharedGrantDraft,
  type SharedGrantResponse,
} from "@/features/connectors/model";
import { roleLabel, useOrgKey, useWorkspace } from "@/features/shell/workspace";
import { api, ApiError } from "@/lib/api/client";
import type { AgentGrantRow, SharedConversation } from "@/server/connectors/console-client";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input, Select } from "@/ui/form";
import { DetailList, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog, Drawer } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice } from "@/ui/states";
import { formatDate, RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { useOrgPolicy, useOrgPolicyKey } from "./connector-policy";
import { useOrganizationMemberNames } from "./member-queries";

/**
 * Who is looking. `admin`: an owner or admin, who sees every organization
 * account and changes its owner. `manager`: any other member, who sees only
 * the accounts they manage and does with them what the Worker lets a
 * manager do (Reconnect, Tools, the agents that share it, Disconnect).
 */
type AccountsView = "admin" | "manager";

const AccountsViewContext = createContext<AccountsView>("admin");

function useAccountsView() {
  const view = useContext(AccountsViewContext);
  // How the Worker's refusals read for this viewer.
  const errorAction: ConnectorAction = view === "admin" ? "admin" : "manage";
  return { admin: view === "admin", errorAction, keyPart: view === "admin" ? "admin" : "managed" };
}

/** Everything this section reads lives under one key, so a change refreshes it all. */
function useOrgAccountsKey() {
  const orgKey = useOrgKey();
  return orgKey("connectors", useAccountsView().keyPart, "org-accounts");
}

/**
 * The shared grants as the drawer and its dialogs read them. Until they load
 * (or when they fail) nobody can say which agents use an account.
 */
type SharedGrantsState =
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "success"; byConnection: Map<string, AgentGrantRow[]> };

function grantsOf(state: SharedGrantsState, connectionId: string | null | undefined) {
  return state.status === "success" && connectionId ? (state.byConnection.get(connectionId) ?? []) : [];
}

function allGrants(state: SharedGrantsState) {
  return state.status === "success" ? [...state.byConnection.values()].flat() : [];
}

/** Refreshes the organization's rules after the Worker said shared accounts are off, so the buttons follow. */
function useRefreshPolicyWhenSharedOff(providerId: string) {
  const queryClient = useQueryClient();
  const policyKey = useOrgPolicyKey(providerId);
  return (error: unknown) => {
    if (isSharedAccountsOff(error)) void queryClient.invalidateQueries({ queryKey: policyKey });
  };
}

/**
 * "Organization accounts": accounts the organization owns (a support inbox,
 * a shared calendar), each managed by one member, and the agents allowed to
 * use them and where. Owners and admins only; the page checks the role first.
 */
export function OrganizationAccountsSection() {
  return (
    <AccountsViewContext.Provider value="admin">
      <AccountsSection />
    </AccountsViewContext.Provider>
  );
}

/**
 * "Accounts you manage", for a member who isn't an owner or admin: the
 * organization accounts they manage, in the same list and drawer, without
 * Change owner or the organization's rules. Shows nothing until the Worker
 * lists one for them.
 */
export function ManagedAccountsSection() {
  return (
    <AccountsViewContext.Provider value="manager">
      <AccountsSection />
    </AccountsViewContext.Provider>
  );
}

function AccountsSection() {
  const { organization } = useWorkspace();
  const { admin } = useAccountsView();
  const key = useOrgAccountsKey();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const accounts = useQuery({
    queryFn: () => api.post<OrgConnectionsResponse>(ORG_CONNECTIONS_ENDPOINT),
    queryKey: [...key, "list"],
    retry: retryConnectorQuery,
    select: (response) => (response.connections ?? []).filter((connection) => !isHistory(connection)),
  });
  const grants = useQuery({
    enabled: accounts.isSuccess && (admin || accounts.data.length > 0),
    queryFn: () => api.post<AgentGrantsResponse>(ORG_SHARED_LIST_ENDPOINT),
    queryKey: [...key, "grants"],
    retry: retryConnectorQuery,
    select: (response) => grantsByConnection(response.grants ?? []),
  });

  const selected = accounts.data?.find((connection) => connection.id === selectedId) ?? null;
  const grantsState: SharedGrantsState = grants.isSuccess
    ? { byConnection: grants.data, status: "success" }
    : grants.isError
      ? { error: grants.error, status: "error" }
      : { status: "pending" };
  const title = admin ? "Organization accounts" : "Accounts you manage";
  const list =
    accounts.isSuccess && accounts.data.length > 0 ? (
      <List label={title}>
        {accounts.data.map((connection) => (
          <OrganizationAccountRow
            connection={connection}
            grants={grants.data?.get(connection.id) ?? null}
            key={connection.id}
            onOpen={() => setSelectedId(connection.id)}
          />
        ))}
      </List>
    ) : null;
  const drawer = <OrganizationAccountDrawer connection={selected} grants={grantsState} onClose={() => setSelectedId(null)} />;

  if (!admin) {
    // Most members manage none, and see nothing here.
    if (!list) return null;
    return (
      <Section
        description="Organization accounts you manage. You answer their approvals and choose which agents use them, and where."
        title={title}
      >
        {list}
        {drawer}
      </Section>
    );
  }

  return (
    <Section
      description="Accounts the organization owns, like a support inbox. Each has a member who manages it and answers its approvals. Agents use one only where you allow it."
      title={title}
    >
      {CONNECTABLE_PROVIDERS.map((provider) => (
        <ConnectOrganizationAccount key={provider.id} provider={provider} />
      ))}
      {accounts.isPending ? (
        <ListSkeleton rows={1} />
      ) : accounts.isError ? (
        isNotConfigured(accounts.error) ? null : isMissingRoute(accounts.error) ? (
          <p className="px-1 text-[13px] text-ink-3">Organization accounts aren&apos;t available yet.</p>
        ) : (
          <ErrorState
            error={accounts.error}
            onRetry={() => void accounts.refetch()}
            role={roleLabel(organization.role)}
            title="Organization accounts couldn't load"
          />
        )
      ) : (
        list ?? (
          <EmptyState
            description="When an owner or admin connects one, it shows here with the agents that share it."
            icon={Building2}
            title="No organization accounts"
          />
        )
      )}
      {drawer}
    </Section>
  );
}

/** "Connect organization account", offered only while the organization allows shared accounts. */
function ConnectOrganizationAccount({ provider }: { provider: ConnectableProvider }) {
  const policy = useOrgPolicy(provider.id);
  // Another admin may have turned shared accounts off since this page loaded.
  const connect = useStartConnect({ onError: useRefreshPolicyWhenSharedOff(provider.id) });
  const key = `org-connect:${provider.id}`;
  if (!policy.isSuccess) return null;
  if (!policy.data.enabled) return null;
  if (!policy.data.sharedAllowed) {
    return (
      <p className="px-1 text-[13px] text-ink-3">
        To connect an organization {provider.name} account, turn on Allow shared accounts above.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <Button
        icon={Plus}
        iconRight={ArrowUpRight}
        loading={connect.busyKey === key}
        onClick={() => connect.start({ body: connectStartBody(provider.id, { scopeKind: "organization" }), key })}
        size="sm"
      >
        Connect organization {provider.name} account
      </Button>
      {connect.errorKey === key ? (
        <p className="px-1 text-[13px] text-err" role="alert">
          {connectorErrorText(connect.error, "admin")}
        </p>
      ) : null}
      <p className="px-1 text-[13px] text-ink-3">You sign in with the organization&apos;s account and manage it until you change its owner.</p>
    </div>
  );
}

function OrganizationAccountRow({
  connection,
  grants,
  onOpen,
}: {
  connection: Connection;
  /** Null while the shared grants load. */
  grants: AgentGrantRow[] | null;
  onOpen: () => void;
}) {
  const { admin } = useAccountsView();
  const status = connectionStatus(connection);
  const manager = managerName(connection);
  const agents = grants === null ? null : grants.length === 1 ? "1 agent" : `${grants.length} agents`;
  // A manager's own list needs no "Managed by".
  const managedBy = admin ? (manager ? `Managed by ${manager}` : "No manager. Pick one.") : null;
  return (
    <ListRow
      chevron
      description={[managedBy, agents ? `Shared with ${agents}` : null].filter(Boolean).join(" · ") || undefined}
      leading={<ProviderMark provider={connection.provider} />}
      meta={
        <Badge dot tone={status.tone}>
          {status.label}
        </Badge>
      }
      onClick={onOpen}
      title={connectionName(connection)}
    />
  );
}

// ---------------------------------------------------------------------------
// One organization account
// ---------------------------------------------------------------------------

function OrganizationAccountDrawer({
  connection,
  grants: grantsState,
  onClose,
}: {
  connection: Connection | null;
  grants: SharedGrantsState;
  onClose: () => void;
}) {
  const [changingOwner, setChangingOwner] = useState(false);
  const [adding, setAdding] = useState(false);
  const [revokingGrant, setRevokingGrant] = useState<AgentGrantRow | null>(null);
  const [disconnecting, setDisconnecting] = useState<Connection | null>(null);
  const { admin, errorAction } = useAccountsView();
  const providerId = connection?.provider ?? "";
  // Connector management is legacy; the directory independently requires members.read.
  const policy = useOrgPolicy(providerId, { enabled: admin && Boolean(connection) });
  const connect = useStartConnect({ onError: useRefreshPolicyWhenSharedOff(providerId) });
  const settings = useOrganizationMemberNames({ enabled: admin && Boolean(connection) });
  const members = settings.data?.members ?? [];
  const status = connection ? connectionStatus(connection) : null;
  const manager = connection ? (admin ? managerName(connection, members) : "You") : null;
  // Who a write waits for, mid-sentence.
  const approver = admin ? (manager ?? "an owner or admin") : "you";
  const reconnectKey = connection ? `org-reconnect:${connection.id}` : "";
  const grants = grantsOf(grantsState, connection?.id);
  // Reconnecting or sharing an organization account needs the connector on and
  // shared accounts allowed; agents can't use it otherwise. A manager learns
  // it from the Worker's refusal.
  const blockedHint = !policy.isSuccess
    ? null
    : !policy.data.enabled
      ? `${providerName(providerId)} is off for this organization. Turn it on to reconnect or share this account.`
      : !policy.data.sharedAllowed
        ? "Shared accounts are off. Turn on Allow shared accounts to reconnect or share this account."
        : null;

  return (
    <>
      <Drawer
        description={connection ? `Organization ${providerName(connection.provider)} account` : undefined}
        onClose={onClose}
        open={Boolean(connection)}
        title={connection ? connectionName(connection) : "Organization account"}
      >
        {connection && status ? (
          <div className="space-y-6">
            {!connection.managedBy ? (
              <Notice title="Nobody manages this account" tone="warn">
                {noManagerText()}
              </Notice>
            ) : status.hint ? (
              <Notice title={status.label} tone="warn">
                {status.hint}
              </Notice>
            ) : null}

            <section className="space-y-1">
              <h3 className="text-sm font-semibold text-ink">Account</h3>
              <DetailList
                items={[
                  { label: "Email", value: connection.email ?? "Not known yet. Reconnect to fill it in." },
                  {
                    label: "Status",
                    value: (
                      <Badge dot tone={status.tone}>
                        {status.label}
                      </Badge>
                    ),
                  },
                  {
                    label: "Managed by",
                    value: (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className={manager ? "text-ink" : "text-ink-3"}>{manager ?? "Nobody"}</span>
                        {admin ? (
                          <Button icon={UserRound} onClick={() => setChangingOwner(true)} size="sm" variant="ghost">
                            Change owner
                          </Button>
                        ) : null}
                      </span>
                    ),
                  },
                  { label: "Connected", value: formatDate(connection.grantedAt || connection.createdAt, true) },
                  {
                    label: "Last used",
                    value: connection.lastUsedAt ? <RelativeTime value={connection.lastUsedAt} /> : "Not used yet",
                  },
                ]}
              />
            </section>

            <ConnectionToolsSection
              connectionId={connection.id}
              description={admin ? `What agents may do with this account without asking ${approver} first.` : undefined}
            />

            <section className="space-y-3 border-t border-line pt-5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="space-y-0.5">
                  <h3 className="text-sm font-semibold text-ink">Agents that share it</h3>
                  <p className="text-[13px] text-ink-3">
                    Only these agents use it, only in these conversations. Reading is limited, and writes wait for{" "}
                    {approver}.
                  </p>
                </div>
                <Button disabled={Boolean(blockedHint)} icon={Plus} onClick={() => setAdding(true)} size="sm">
                  Add
                </Button>
              </div>
              {blockedHint ? <p className="text-[13px] text-ink-3">{blockedHint}</p> : null}
              {grantsState.status === "error" ? (
                <p className="text-[13px] text-err" role="alert">
                  Ravi couldn&apos;t load which agents use it. {connectorErrorText(grantsState.error, errorAction)}
                </p>
              ) : grantsState.status === "pending" ? (
                <p className="text-[13px] text-ink-3">Loading which agents use it…</p>
              ) : grants.length === 0 ? (
                <p className="text-[13px] text-ink-3">No agent uses this account yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {grants.map((grant) => (
                    <li className="flex items-center justify-between gap-3 px-3 py-2.5" key={grant.id}>
                      <div className="min-w-0 space-y-0.5">
                        <div className="truncate text-sm text-ink">{grantTitle(grant)}</div>
                        <p className="text-[12.5px] text-ink-3">
                          {[sharedConversationsText(grant.conversations), grant.createdAt ? `Since ${formatDate(grant.createdAt)}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <Button className="shrink-0" onClick={() => setRevokingGrant(grant)} size="sm" variant="ghost">
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-3 border-t border-line pt-5">
              <h3 className="text-sm font-semibold text-ink">Actions</h3>
              <div className="flex flex-wrap gap-2">
                {status.next === "reconnect" ? (
                  <Button
                    disabled={Boolean(blockedHint)}
                    icon={RefreshCw}
                    loading={connect.busyKey === reconnectKey}
                    onClick={() =>
                      connect.start({
                        body: connectStartBody(connection.provider, { reconnect: connection, scopeKind: "organization" }),
                        key: reconnectKey,
                      })
                    }
                    size="sm"
                    variant="primary"
                  >
                    Reconnect
                  </Button>
                ) : null}
                <Button icon={Unplug} onClick={() => setDisconnecting(connection)} size="sm" variant="danger">
                  {status.next === "retry-disconnect" ? "Try disconnecting again" : "Disconnect"}
                </Button>
              </div>
              {connect.errorKey === reconnectKey ? <FormMessage>{connectorErrorText(connect.error, errorAction)}</FormMessage> : null}
            </section>
          </div>
        ) : null}
      </Drawer>
      {admin ? (
        <ChangeOwnerDialog
          connection={changingOwner ? connection : null}
          members={members}
          membersError={settings.isError ? settings.error : null}
          membersLoading={settings.isPending}
          onClose={() => setChangingOwner(false)}
        />
      ) : null}
      <AddSharedGrantDialog connection={adding ? connection : null} grants={grantsState} onClose={() => setAdding(false)} />
      <RevokeSharedGrantDialog grant={revokingGrant} onClose={() => setRevokingGrant(null)} />
      <DisconnectOrganizationAccountDialog
        connection={disconnecting}
        grants={disconnecting ? { ...grantsState, list: grantsOf(grantsState, disconnecting.id) } : { list: [], status: "pending" }}
        onClose={() => setDisconnecting(null)}
        onDone={() => {
          setDisconnecting(null);
          onClose();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

type MemberOption = { id: string; name: string; email: string; status: string };

function ChangeOwnerDialog({
  connection,
  members,
  membersError,
  membersLoading,
  onClose,
}: {
  connection: Connection | null;
  members: MemberOption[];
  membersError: unknown;
  membersLoading: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = useOrgAccountsKey();
  const active = members.filter((member) => member.status === "active");
  const [picked, setPicked] = useState<string>("");
  const current = connection?.managedBy?.userId ?? "";
  // A manager who left the organization isn't among the choices; nothing is preselected then.
  const value = picked || (active.some((member) => member.id === current) ? current : "");
  const save = useMutation({
    mutationFn: (input: { connection: Connection; userId: string }) =>
      api.post<{ status: "ok"; ok: boolean }>(orgOwnerEndpoint(input.connection.id), { managedByUserId: input.userId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    onSuccess: (_result, input) => {
      const member = active.find((item) => item.id === input.userId);
      toast.show(`${member?.name || member?.email || "The member"} now manages ${connectionName(input.connection)}.`);
      // Not `close()`: this runs while the mutation still reads as pending.
      finish();
    },
  });
  function finish() {
    save.reset();
    setPicked("");
    onClose();
  }
  function close() {
    if (save.isPending) return;
    finish();
  }

  return (
    <Dialog
      description="They answer this account's approvals and are named as its manager. Nothing is reconnected."
      footer={
        <>
          <Button disabled={save.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!value || value === current || membersLoading}
            loading={save.isPending}
            onClick={() => connection && save.mutate({ connection, userId: value })}
            variant="primary"
          >
            Change owner
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(connection)}
      title={connection ? `Who manages ${connectionName(connection)}?` : "Change owner"}
    >
      <div className="space-y-3">
        {membersError ? (
          <FormMessage>Members couldn&apos;t load. {connectorErrorText(membersError)}</FormMessage>
        ) : (
          <Field hint="Only active members can manage an organization account." label="Member">
            {(props) => (
              <Select {...props} disabled={membersLoading || save.isPending} onChange={(event) => setPicked(event.target.value)} value={value}>
                {!value ? <option value="">Choose a member</option> : null}
                {active.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name && member.name !== member.email ? `${member.name} (${member.email})` : member.email}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {save.isError ? <FormMessage>{connectorErrorText(save.error, "admin")}</FormMessage> : null}
      </div>
    </Dialog>
  );
}

const EMPTY_DRAFT: SharedGrantDraft = { agentId: "", conversations: ["dm"], installationId: "" };

function AddSharedGrantDialog({
  connection,
  grants,
  onClose,
}: {
  connection: Connection | null;
  grants: SharedGrantsState;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const orgKey = useOrgKey();
  const { errorAction, keyPart } = useAccountsView();
  const key = useOrgAccountsKey();
  const [draft, setDraft] = useState<SharedGrantDraft>(EMPTY_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  const installations = useQuery({
    enabled: Boolean(connection),
    queryFn: () => api.post<OrgInstallationsResponse>(ORG_INSTALLATIONS_ENDPOINT),
    queryKey: orgKey("connectors", keyPart, "installations"),
    retry: retryConnectorQuery,
    select: (response) => response.installations ?? [],
  });
  const add = useMutation({
    mutationFn: (input: { connection: Connection; draft: SharedGrantDraft; movedFrom: string | null }) =>
      api.post<SharedGrantResponse>(ORG_SHARED_ENDPOINT, {
        agentId: input.draft.agentId.trim(),
        connectionId: input.connection.id,
        conversations: input.draft.conversations,
        installationId: input.draft.installationId,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    onSuccess: (_result, input) => {
      const agent = `Agent ${input.draft.agentId.trim()}`;
      const account = connectionName(input.connection);
      toast.show(
        input.movedFrom
          ? `${agent} uses ${account} now. It no longer uses ${input.movedFrom}.`
          : `${agent} can use ${account} now.`,
      );
      // Not `close()`: this runs while the mutation still reads as pending.
      finish();
    },
  });
  function finish() {
    add.reset();
    setDraft(EMPTY_DRAFT);
    setShowErrors(false);
    onClose();
  }
  function close() {
    if (add.isPending) return;
    finish();
  }
  const problem = sharedGrantDraftError(draft);
  const conflict = connection
    ? sharedGrantConflict(allGrants(grants), {
        agentId: draft.agentId,
        connectionId: connection.id,
        installationId: draft.installationId,
        provider: connection.provider,
      })
    : null;
  const installationName = installations.data?.find((item) => item.id === draft.installationId)?.name ?? null;
  const conflictText =
    connection && conflict
      ? sharedGrantConflictText(conflict, { accountName: connectionName(connection), agentId: draft.agentId, installationName })
      : null;
  const fieldError = (field: "installation" | "agent" | "conversations") =>
    showErrors && problem?.field === field ? problem.message : null;
  const toggle = (value: SharedConversation, on: boolean) =>
    setDraft((current) => ({
      ...current,
      conversations: on
        ? SHARED_CONVERSATION_OPTIONS.map((option) => option.value).filter((item) => item === value || current.conversations.includes(item))
        : current.conversations.filter((item) => item !== value),
    }));
  const submit = () => {
    setShowErrors(true);
    if (!connection || problem || grants.status === "pending") return;
    // A move is said before it happens: the notice names what it takes away and the button says "Move it here".
    const movedFrom = conflict?.kind === "move" ? (conflict.grant.email ?? "the other organization account") : null;
    add.mutate({ connection, draft, movedFrom });
  };

  return (
    <Dialog
      description={
        connection
          ? `The agent can use ${connectionName(connection)} only on that computer and only in the conversations you choose.`
          : undefined
      }
      footer={
        <>
          <Button disabled={add.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={grants.status === "pending"}
            icon={Plus}
            loading={add.isPending}
            onClick={submit}
            variant={conflict?.kind === "move" ? "danger" : "primary"}
          >
            {conflict?.kind === "move" ? "Move it here" : conflict?.kind === "update" ? "Save" : "Add"}
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(connection)}
      title="Share with an agent"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          error={fieldError("installation")}
          hint={installations.isError ? undefined : "Computers signed in to ravi in this organization."}
          label="Computer"
        >
          {(props) =>
            installations.isError ? (
              <p className="text-[13px] text-err" role="alert">
                {connectorErrorText(installations.error, errorAction)}
              </p>
            ) : (
              <Select
                {...props}
                disabled={installations.isPending || add.isPending}
                onChange={(event) => setDraft((current) => ({ ...current, installationId: event.target.value }))}
                value={draft.installationId}
              >
                <option value="">{installations.isPending ? "Loading…" : installations.data?.length ? "Choose a computer" : "No computer is signed in"}</option>
                {(installations.data ?? []).map((installation) => (
                  <option key={installation.id} value={installation.id}>
                    {organizationInstallationLabel(installation)}
                  </option>
                ))}
              </Select>
            )
          }
        </Field>
        <Field error={fieldError("agent")} hint="The agent's id, as ravi agents list shows it on that computer." label="Agent">
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              disabled={add.isPending}
              maxLength={120}
              onChange={(event) => setDraft((current) => ({ ...current, agentId: event.target.value }))}
              placeholder="main"
              spellCheck={false}
              value={draft.agentId}
            />
          )}
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-ink">Conversations</legend>
          {SHARED_CONVERSATION_OPTIONS.map((option) => (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-2" key={option.value}>
              <input
                checked={draft.conversations.includes(option.value)}
                className="size-4 shrink-0 accent-[var(--rv-ink)]"
                disabled={add.isPending}
                onChange={(event) => toggle(option.value, event.target.checked)}
                type="checkbox"
              />
              {option.label}
            </label>
          ))}
          {fieldError("conversations") ? <p className="text-[13px] text-err">{fieldError("conversations")}</p> : null}
        </fieldset>
        {conflictText ? (
          <Notice title={conflict?.kind === "move" ? "This moves the agent" : "Already shared"} tone={conflict?.kind === "move" ? "warn" : "info"}>
            {conflictText}
          </Notice>
        ) : grants.status === "error" ? (
          <p className="text-[13px] text-ink-3">
            Ravi couldn&apos;t check which accounts this agent already uses. If it uses another organization account,
            adding it here moves it.
          </p>
        ) : null}
        {add.isError ? <FormMessage>{connectorErrorText(add.error, errorAction)}</FormMessage> : null}
      </form>
    </Dialog>
  );
}

function RevokeSharedGrantDialog({ grant, onClose }: { grant: AgentGrantRow | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { errorAction } = useAccountsView();
  const key = useOrgAccountsKey();
  const revoke = useMutation({
    mutationFn: (target: AgentGrantRow) => api.post<{ status: "ok"; revoked: boolean }>(orgSharedRevokeEndpoint(target.id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    onSuccess: (_result, target) => {
      toast.show(`${grantTitle(target)} can't use ${target.email ?? "the account"} anymore.`);
      // Not `close()`: this runs while the mutation still reads as pending.
      finish();
    },
  });
  function finish() {
    revoke.reset();
    onClose();
  }
  function close() {
    if (revoke.isPending) return;
    finish();
  }
  return (
    <Dialog
      description={grant ? `It stops using ${grant.email ?? "this organization account"} right away.` : undefined}
      footer={
        <>
          <Button disabled={revoke.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button loading={revoke.isPending} onClick={() => grant && revoke.mutate(grant)} variant="danger">
            Revoke
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(grant)}
      title={grant ? `Revoke ${grantTitle(grant)}?` : "Revoke agent"}
    >
      {revoke.isError ? <FormMessage>{connectorErrorText(revoke.error, errorAction)}</FormMessage> : null}
    </Dialog>
  );
}

function DisconnectOrganizationAccountDialog({
  connection,
  grants: grantsState,
  onClose,
  onDone,
}: {
  connection: Connection | null;
  /** The account's shared grants with how loading them went. */
  grants: SharedGrantsState & { list: AgentGrantRow[] };
  onClose: () => void;
  onDone: () => void;
}) {
  const grants = grantsState.list;
  const queryClient = useQueryClient();
  const toast = useToast();
  const { admin, errorAction } = useAccountsView();
  const key = useOrgAccountsKey();
  const revoke = useMutation({
    // An owner or admin disconnects as the organization; a manager as the person who manages it.
    mutationFn: (target: Connection) =>
      api.post<{ status: "ok"; revoked: boolean }>(admin ? adminRevokeEndpoint(target.id) : revokeEndpoint(target.id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  function close() {
    if (revoke.isPending) return;
    revoke.reset();
    onClose();
  }
  const run = (target: Connection) =>
    revoke.mutate(target, {
      onError: (error) => {
        if (error instanceof ApiError && error.code === "connector_provider_error") {
          revoke.reset();
          onDone();
          toast.show(
            `${providerName(target.provider)} didn't confirm yet, so the account shows Disconnecting… Agents can't use it meanwhile; Ravi keeps trying.`,
            "err",
          );
        }
      },
      onSuccess: () => {
        toast.show(`Disconnected ${connectionName(target)}.`);
        onDone();
      },
    });
  const provider = connection ? providerName(connection.provider) : "";
  // Says who stops only after the grants loaded; never "no agent" while it doesn't know.
  const whoStops =
    grantsState.status === "pending"
      ? "Checking which agents use it…"
      : grantsState.status === "error"
        ? "Ravi couldn't load which agents use it. Every agent that shares it stops using it."
        : grants.length
          ? "These agents stop using it:"
          : "No agent uses it now.";
  return (
    <Dialog
      description={connection ? `${provider} is told to revoke access and Ravi deletes the tokens. ${whoStops}` : undefined}
      footer={
        <>
          <Button disabled={revoke.isPending} onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={grantsState.status === "pending"}
            icon={Unplug}
            loading={revoke.isPending}
            onClick={() => connection && run(connection)}
            variant="danger"
          >
            Disconnect
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(connection)}
      title={connection ? `Disconnect ${connectionName(connection)}?` : "Disconnect"}
    >
      {grants.length || revoke.isError ? (
        <div className="space-y-3">
          {grants.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
              {grants.map((grant) => (
                <li key={grant.id}>
                  {grantTitle(grant)} · {sharedConversationsText(grant.conversations)}
                </li>
              ))}
            </ul>
          ) : null}
          {revoke.isError ? <FormMessage>{connectorErrorText(revoke.error, errorAction)}</FormMessage> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
