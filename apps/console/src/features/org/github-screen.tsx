"use client";

import { ArrowUpRight, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import { withOrganizationParam } from "@/lib/api/organization";
import type { GithubAppConnection, GithubAvailableInstallation, OrganizationGithubConfig } from "@/features/console/types";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Badge, type Tone } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyValue } from "@/ui/copy";
import { FormMessage } from "@/ui/form";
import { GithubMark } from "@/ui/github-mark";
import { Panel, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice } from "@/ui/states";
import { useToast } from "@/ui/toast";
import { OrgArea } from "./org-area";
import { useLinkGithubInstallation, useOrgGithub, useUnlinkGithubInstallation } from "./queries";

/** How the GitHub round trip ended; the setup and callback routes set `?github=`. */
export type GithubReturnStatus =
  | "linked"
  | "signed_in"
  | "requested"
  | "not_accessible"
  | "denied"
  | "expired"
  | "sign_in_not_configured"
  | "error";

export function OrgGithubScreen({ status }: { status?: string }) {
  return (
    <OrgArea tab="github">
      <GithubBody status={status} />
    </OrgArea>
  );
}

function GithubBody({ status }: { status?: string }) {
  const { organization } = useWorkspace();
  const query = useOrgGithub();

  if (query.isPending) return <ListSkeleton rows={2} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        role={roleLabel(organization.role)}
        title="GitHub couldn't load"
      />
    );
  }

  const config = query.data;
  return (
    <div className="space-y-10">
      <ReturnNotice status={status} />
      <LinkedAccounts config={config} />
      {config.canManage ? <AvailableAccounts config={config} /> : null}
      <Details config={config} />
    </div>
  );
}

function ReturnNotice({ status }: { status?: string }) {
  switch (status as GithubReturnStatus | undefined) {
    case "linked":
      return (
        <Notice title="GitHub account linked" tone="ok">
          Its repositories are available to every project in this organization.
        </Notice>
      );
    case "signed_in":
      return (
        <Notice title="Signed in with GitHub" tone="info">
          Link the accounts this organization should use. Nothing is linked until you choose.
        </Notice>
      );
    case "requested":
      return (
        <Notice title="Install requested" tone="info">
          An owner of that GitHub organization has to approve the Ravi app. Once they do, link it here.
        </Notice>
      );
    case "not_accessible":
      return (
        <Notice title="GitHub didn't list that installation for you" tone="err">
          Only someone who can see the installation on GitHub can link it. Nothing was linked.
        </Notice>
      );
    case "denied":
      return (
        <Notice title="GitHub sign-in was cancelled" tone="warn">
          Nothing was linked. Continue with GitHub when you&apos;re ready.
        </Notice>
      );
    case "expired":
      return (
        <Notice title="That GitHub link expired" tone="warn">
          Links to GitHub are valid for 15 minutes. Start again from this page.
        </Notice>
      );
    case "sign_in_not_configured":
      return (
        <Notice title="The app was installed, but it can't be linked yet" tone="warn">
          Signing in with GitHub isn&apos;t set up on this Console. See Details below.
        </Notice>
      );
    case "error":
      return (
        <Notice title="GitHub setup didn't finish" tone="err">
          Nothing was linked. Start again from this page.
        </Notice>
      );
    default:
      return null;
  }
}

/** Sends the browser to an API route that redirects to GitHub, or says why it can't. */
function useGithubRedirect(path: string) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const start = async () => {
    setStarting(true);
    setError(null);
    const url = withOrganizationParam(path);
    try {
      const response = await fetch(url, { credentials: "same-origin", redirect: "manual" });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        window.location.assign(url);
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(response.status, body?.error ?? `http_${response.status}`, body?.error ?? "GitHub failed");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, "network_error", "network_error"));
      setStarting(false);
    }
  };
  return { error, start, starting };
}

function githubErrorText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === "github_app_not_configured" || error.code === "github_app_state_secret_missing") {
      return "The Ravi GitHub App isn't set up on this Console yet.";
    }
    if (error.code === "github_sign_in_not_configured") {
      return "Signing in with GitHub isn't set up on this Console yet. See Details below.";
    }
    if (error.code === "github_sign_in_required") return "Your GitHub sign-in expired. Continue with GitHub again.";
    if (error.code === "github_installation_not_accessible") {
      return "GitHub no longer lists that installation for you. Continue with GitHub again.";
    }
    if (error.code === "github_manage_forbidden") return "Linking GitHub needs the owner, admin or developer role.";
  }
  return describeError(error);
}

function LinkedAccounts({ config }: { config: OrganizationGithubConfig }) {
  const { organization } = useWorkspace();
  const install = useGithubRedirect(config.installUrl);
  const [unlinking, setUnlinking] = useState<GithubAppConnection | null>(null);

  const installButton = config.canManage && config.configured.install ? (
    <Button icon={Plus} loading={install.starting} onClick={() => void install.start()} variant="secondary">
      Install on GitHub
    </Button>
  ) : null;

  return (
    <Section
      actions={config.connections.length ? installButton : null}
      description={
        <>
          Every project in {organization.name} can watch these accounts&apos; repositories with{" "}
          <span className="whitespace-nowrap font-mono text-[12px] text-ink-2">ravi watch create github</span>.
        </>
      }
      title="GitHub accounts"
    >
      {install.error ? <FormMessage>{githubErrorText(install.error)}</FormMessage> : null}
      {config.connections.length ? (
        <List label="Linked GitHub accounts">
          {config.connections.map((connection) => (
            <LinkedRow
              canManage={config.canManage}
              connection={connection}
              key={connection.id}
              onUnlink={() => setUnlinking(connection)}
            />
          ))}
        </List>
      ) : (
        <EmptyState
          action={installButton}
          description={
            config.canManage
              ? "Install the Ravi app on a GitHub account or organization, or link one where it's already installed."
              : "An owner, admin or developer of this organization links GitHub here."
          }
          title="No GitHub account linked"
        />
      )}
      <UnlinkDialog connection={unlinking} onClose={() => setUnlinking(null)} />
    </Section>
  );
}

function connectionState(connection: GithubAppConnection): { label: string; tone: Tone; next?: string } {
  if (connection.status === "suspended") {
    return { label: "Suspended", next: "The app is suspended on GitHub. Unsuspend it there to receive events again.", tone: "warn" };
  }
  if (connection.status !== "active") {
    return { label: "No repositories", next: "The app can't see any repository yet. Pick some on GitHub.", tone: "warn" };
  }
  return { label: "Linked", tone: "ok" };
}

function LinkedRow({
  canManage,
  connection,
  onUnlink,
}: {
  canManage: boolean;
  connection: GithubAppConnection;
  onUnlink: () => void;
}) {
  const state = connectionState(connection);
  const account = connection.accountLogin || connection.displayName.replace(/^GitHub App:\s*/, "");
  const repositories = connection.repositorySelection === "all"
    ? "All repositories"
    : connection.repositories.length === 1
      ? "1 repository"
      : `${connection.repositories.length} repositories`;

  return (
    <ListRow
      actions={
        <>
          {connection.githubUrl ? (
            <Button external href={connection.githubUrl} iconRight={ArrowUpRight} rel="noreferrer" size="sm" target="_blank" variant="ghost">
              <span className="hidden sm:inline">Manage on GitHub</span>
              <span className="sm:hidden">GitHub</span>
            </Button>
          ) : null}
          {canManage ? (
            <Button onClick={onUnlink} size="sm" variant="ghost">
              Unlink
            </Button>
          ) : null}
        </>
      }
      description={state.next ?? [accountTypeLabel(connection.accountType), repositories].filter(Boolean).join(" · ")}
      leading={<GithubMark className="size-8 rounded-md bg-sunken p-1.5 text-ink" />}
      meta={
        <Badge dot tone={state.tone}>
          {state.label}
        </Badge>
      }
      title={account}
    />
  );
}

function UnlinkDialog({ connection, onClose }: { connection: GithubAppConnection | null; onClose: () => void }) {
  const { organization } = useWorkspace();
  const toast = useToast();
  const unlink = useUnlinkGithubInstallation();
  const account = connection?.accountLogin ?? connection?.displayName ?? "";

  return (
    <Dialog
      description={
        <>
          Watches on its repositories stop delivering events to {organization.name}. The app stays installed on GitHub;
          uninstall it there if no one uses it.
        </>
      }
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            loading={unlink.isPending}
            onClick={() => {
              if (!connection) return;
              unlink.mutate(connection.id, {
                onSuccess: () => {
                  toast.show(`${account} was unlinked.`);
                  onClose();
                },
              });
            }}
            variant="danger"
          >
            Unlink
          </Button>
        </>
      }
      onClose={onClose}
      open={Boolean(connection)}
      title={`Unlink ${account}?`}
    >
      {unlink.isError ? <FormMessage>{githubErrorText(unlink.error)}</FormMessage> : null}
    </Dialog>
  );
}

/** Accounts where the app is already installed, as GitHub lists them for the signed-in person. */
function AvailableAccounts({ config }: { config: OrganizationGithubConfig }) {
  const connect = useGithubRedirect(config.connectUrl);
  const install = useGithubRedirect(config.installUrl);
  const link = useLinkGithubInstallation();
  const toast = useToast();
  const [linking, setLinking] = useState<string | null>(null);

  if (!config.configured.signIn) {
    return (
      <Section title="Link an account where the app is installed">
        <Notice title="Signing in with GitHub isn't set up" tone="warn">
          Whoever runs this Console sets <span className="font-mono text-[12px]">RAVI_GITHUB_APP_CLIENT_ID</span> and{" "}
          <span className="font-mono text-[12px]">RAVI_GITHUB_APP_CLIENT_SECRET</span>, and adds the Callback URL from
          Details to the GitHub App.
        </Notice>
      </Section>
    );
  }

  if (config.available === null) {
    return (
      <Section title="Link an account where the app is installed">
        <Panel padded>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <GithubMark className="size-10 shrink-0 rounded-lg bg-sunken p-2.5 text-ink" />
            <p className="min-w-0 flex-1 text-sm text-ink-2">
              Sign in with GitHub to see every account where the Ravi app is installed and you have access. Nothing is
              linked until you choose.
            </p>
            <Button className="shrink-0" loading={connect.starting} onClick={() => void connect.start()} variant="primary">
              Continue with GitHub
            </Button>
          </div>
          {connect.error ? <div className="mt-4"><FormMessage>{githubErrorText(connect.error)}</FormMessage></div> : null}
        </Panel>
      </Section>
    );
  }

  const installAction = config.configured.install ? (
    <Button loading={install.starting} onClick={() => void install.start()} size="sm" variant="ghost">
      Install on another account
    </Button>
  ) : null;

  return (
    <Section
      description={config.githubLogin ? <>Signed in to GitHub as <span className="font-medium text-ink-2">@{config.githubLogin}</span>.</> : null}
      title="Link an account where the app is installed"
    >
      {install.error ? <FormMessage>{githubErrorText(install.error)}</FormMessage> : null}
      {link.isError ? <FormMessage>{githubErrorText(link.error)}</FormMessage> : null}
      {config.available.length ? (
        <List label="GitHub accounts you can link">
          {config.available.map((installation) => (
            <AvailableRow
              installation={installation}
              key={installation.installationId}
              linking={link.isPending && linking === installation.installationId}
              onLink={() => {
                setLinking(installation.installationId);
                link.mutate(installation.installationId, {
                  onSuccess: () =>
                    toast.show(
                      installation.linked
                        ? `${installation.accountLogin}'s repositories were refreshed.`
                        : `${installation.accountLogin} was linked.`,
                    ),
                });
              }}
            />
          ))}
        </List>
      ) : (
        <EmptyState
          action={installAction}
          description="The Ravi app isn't installed on any GitHub account you can see. Install it, and it shows up here."
          title="Nothing to link yet"
        />
      )}
    </Section>
  );
}

function AvailableRow({
  installation,
  linking,
  onLink,
}: {
  installation: GithubAvailableInstallation;
  linking: boolean;
  onLink: () => void;
}) {
  return (
    <ListRow
      actions={
        installation.linked ? (
          <div className="flex items-center gap-2">
            <Badge dot tone="ok">
              Linked
            </Badge>
            {/* Repositories added on GitHub later show up for the account's owner; anyone else refreshes here. */}
            <Button loading={linking} onClick={onLink} size="sm" variant="ghost">
              Refresh
            </Button>
          </div>
        ) : (
          <Button loading={linking} onClick={onLink} size="sm" variant="secondary">
            Link
          </Button>
        )
      }
      description={[
        accountTypeLabel(installation.accountType),
        installation.repositorySelection === "all" ? "All repositories" : "Selected repositories",
        installation.suspended ? "Suspended" : null,
      ].filter(Boolean).join(" · ")}
      leading={
        installation.avatarUrl ? (
          // GitHub's avatar CDN; a plain img keeps it out of the image optimizer.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="" className="size-8 rounded-md bg-sunken" src={installation.avatarUrl} />
        ) : (
          <GithubMark className="size-8 rounded-md bg-sunken p-1.5 text-ink" />
        )
      }
      title={installation.accountLogin}
    />
  );
}

function accountTypeLabel(type: string | null) {
  if (type === "Organization") return "Organization";
  if (type === "User") return "Personal account";
  return null;
}

/** Addresses to paste into the GitHub App's settings, for whoever runs the Console. */
function Details({ config }: { config: OrganizationGithubConfig }) {
  return (
    <details className="group rounded-lg border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-medium text-ink select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="text-ink-3 transition-transform group-open:rotate-90" size={16} />
        Details
        <span className="hidden font-normal text-ink-3 sm:inline">for setting up the GitHub App</span>
      </summary>
      <div className="space-y-4 border-t border-line px-5 py-4">
        <DetailRow label="Setup URL">
          <CopyValue value={config.setupUrl} />
        </DetailRow>
        <DetailRow label="Callback URL">
          <CopyValue value={config.callbackUrl} />
        </DetailRow>
        <DetailRow label="Webhook URL">
          <CopyValue value={config.webhookUrl} />
        </DetailRow>
        {config.connections.length ? (
          <DetailRow label={config.connections.length === 1 ? "Installation" : "Installations"}>
            <div className="space-y-1">
              {config.connections.map((connection) => (
                <div className="flex min-w-0 flex-wrap items-center gap-x-2" key={connection.id}>
                  <CopyValue value={connection.installationId} />
                  <span className="text-[13px] text-ink-3">{connection.accountLogin ?? connection.displayName}</span>
                </div>
              ))}
            </div>
          </DetailRow>
        ) : null}
        <p className="text-[13px] text-ink-3">
          On the GitHub App, turn on Redirect on update and leave &quot;Request user authorization (OAuth) during
          installation&quot; off: it replaces the Setup URL.
        </p>
      </div>
    </details>
  );
}

function DetailRow({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <div className="pt-1 text-sm text-ink-3">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
