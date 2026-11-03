"use client";

import Link from "@/ui/link";
import { ChevronRight, Globe2, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { DomainBindingSummary, DomainClaimSummary, PageSiteSummary, Project } from "@/features/console/types";
import { pagesSettingsHref } from "@/features/pages/paths";
import { featureEnabled, roleCapabilities, roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Badge, type Tone } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { Field, FormMessage, Input } from "@/ui/form";
import { Section } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import { domainErrorMessage } from "./labels";
import { OrgArea } from "./org-area";
import { useAddDomain, useDomainInventory, usePageSitesByProject, useVerifyDomain } from "./queries";

export function OrgDomainsScreen() {
  return (
    <OrgArea tab="domains">
      <DomainsBody />
    </OrgArea>
  );
}

type SiteRef = { project: Project; site: PageSiteSummary };

function DomainsBody() {
  const { features, organization, projects } = useWorkspace();
  const canChange = roleCapabilities(organization.role).canWriteProjects;
  const inventory = useDomainInventory();
  const [adding, setAdding] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const bindings = inventory.data?.bindings ?? [];
  const sitesEnabled = bindings.length > 0 && featureEnabled(features, "console.pages");
  const siteQueries = usePageSitesByProject(projects, sitesEnabled);
  const sitesLoading = sitesEnabled && siteQueries.some((query) => query.isPending);
  const sites = new Map<string, SiteRef>();
  siteQueries.forEach((query, index) => {
    const project = projects[index];
    if (!project || !query.data) return;
    for (const site of query.data) sites.set(site.id, { project, site });
  });

  const addButton = canChange ? (
    <Button icon={Plus} onClick={() => setAdding(true)} variant="primary">
      Add domain
    </Button>
  ) : null;

  return (
    <Section
      actions={inventory.data?.claims.length ? addButton : null}
      description={
        <>
          Prove that your organization owns a domain. To put pages on it, open the project and add the domain in its{" "}
          <Link className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink" href="/projects">
            Pages settings
          </Link>
          .
        </>
      }
      title="Domains"
    >
      {inventory.isPending ? (
        <ListSkeleton rows={2} />
      ) : inventory.isError ? (
        <ErrorState error={inventory.error} onRetry={() => void inventory.refetch()} role={roleLabel(organization.role)} />
      ) : inventory.data.claims.length === 0 ? (
        <EmptyState
          action={addButton}
          description={
            canChange
              ? "Add a domain you own, like example.com. You'll get a DNS record to prove it's yours. Then connect it to pages from a project's Pages settings."
              : "Nobody has added a domain yet. An owner, admin or developer can add one."
          }
          icon={Globe2}
          title="No domains yet"
        />
      ) : (
        <div className="space-y-4">
          {inventory.data.claims.map((claim) => (
            <DomainCard
              bindings={bindings.filter((binding) => binding.claimId === claim.id)}
              canChange={canChange}
              claim={claim}
              highlighted={highlight === claim.id}
              key={claim.id}
              sites={sites}
              sitesLoading={sitesLoading}
            />
          ))}
        </div>
      )}
      <AddDomainDialog
        onAdded={(claim) => setHighlight(claim.id)}
        onClose={() => setAdding(false)}
        open={adding}
      />
    </Section>
  );
}

function claimState(claim: DomainClaimSummary): { label: string; tone: Tone } {
  if (claim.status === "disabled") return { label: "Turned off", tone: "neutral" };
  if (claim.verificationStatus === "verified") return { label: "Verified", tone: "ok" };
  if (claim.verificationStatus === "expired") return { label: "Check expired", tone: "warn" };
  if (claim.verificationStatus === "failed") return { label: "Not found yet", tone: "warn" };
  return { label: "TXT record missing", tone: "warn" };
}

function DomainCard({
  bindings,
  canChange,
  claim,
  highlighted,
  sites,
  sitesLoading,
}: {
  bindings: DomainBindingSummary[];
  canChange: boolean;
  claim: DomainClaimSummary;
  highlighted: boolean;
  sites: Map<string, SiteRef>;
  sitesLoading: boolean;
}) {
  const verify = useVerifyDomain();
  const toast = useToast();
  const state = claimState(claim);
  const verified = claim.verificationStatus === "verified";
  const expected = claim.verification.expected;
  const checking = verify.isPending && verify.variables === claim.id;
  const lastChecked = claim.verification.lastCheckedAt;

  return (
    <article
      aria-label={claim.domain}
      className={`overflow-hidden rounded-lg border bg-surface ${highlighted ? "border-focus ring-2 ring-focus/20" : "border-line"}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 pb-3 sm:px-5">
        <Globe2 aria-hidden className="shrink-0 text-ink-3" size={16} />
        <h3 className="min-w-0 flex-1 truncate font-mono text-[14px] font-medium text-ink">{claim.displayDomain || claim.domain}</h3>
        <Badge dot tone={state.tone}>
          {state.label}
        </Badge>
      </header>

      <div className="space-y-4 px-4 pb-5 sm:px-5">
        {verified ? (
          <p className="text-sm text-ink-2">
            Your organization owns this domain
            {claim.verifiedAt ? (
              <>
                {" "}
                (verified <RelativeTime value={claim.verifiedAt} />)
              </>
            ) : null}
            . Hostnames under it can be connected to pages.
          </p>
        ) : claim.status === "disabled" ? (
          <p className="text-sm text-ink-2">This domain is turned off and can&apos;t be used for pages.</p>
        ) : (
          <>
            <p className="text-sm text-ink-2">
              {claim.verificationStatus === "failed" ? (
                <>
                  We looked for the TXT record
                  {lastChecked ? (
                    <>
                      {" "}
                      <RelativeTime value={lastChecked} />
                    </>
                  ) : null}
                  {" "}and didn&apos;t find it yet. DNS changes can take a few minutes, sometimes longer. Check the
                  record below, then verify again.
                </>
              ) : claim.verificationStatus === "expired" ? (
                <>The last check expired. Make sure the TXT record below is still there, then verify again.</>
              ) : (
                <>
                  Add this TXT record where you manage the domain&apos;s DNS (your registrar or DNS provider), then
                  select Verify.
                </>
              )}
            </p>
            {expected?.name && expected.value ? (
              <DnsRecord name={expected.name} type={expected.type ?? "TXT"} value={expected.value} />
            ) : null}
            {canChange ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  icon={RefreshCw}
                  loading={checking}
                  onClick={() =>
                    verify.mutate(claim.id, {
                      onSuccess: (result) => {
                        if (result.claim.verificationStatus === "verified") toast.show(`${claim.domain} is verified.`);
                      },
                    })
                  }
                  size="sm"
                >
                  {checking ? "Checking" : "Verify"}
                </Button>
                {lastChecked && !checking ? (
                  <span className="text-[13px] text-ink-3">
                    Last checked <RelativeTime value={lastChecked} />
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-[13px] text-ink-3">An owner, admin or developer can verify it once the record is added.</p>
            )}
            {verify.isError && verify.variables === claim.id ? <FormMessage>{domainErrorMessage(verify.error)}</FormMessage> : null}
          </>
        )}

        {verified || bindings.length ? (
          <Hostnames bindings={bindings} sites={sites} sitesLoading={sitesLoading} verified={verified} />
        ) : null}
      </div>
    </article>
  );
}

function DnsRecord({ name, type, value }: { name: string; type: string; value: string }) {
  return (
    <div className="max-w-3xl rounded-md border border-line bg-sunken">
      <dl className="divide-y divide-line">
        <div className="flex items-center gap-3 px-3 py-2">
          <dt className="w-12 shrink-0 text-[13px] text-ink-3">Type</dt>
          <dd className="font-mono text-[13px] text-ink">{type.toUpperCase()}</dd>
        </div>
        <div className="flex items-center gap-3 px-3 py-1.5">
          <dt className="w-12 shrink-0 text-[13px] text-ink-3">Name</dt>
          <dd className="min-w-0 flex-1 font-mono text-[13px] break-all text-ink">{name}</dd>
          <CopyButton label="Copy name" value={name} />
        </div>
        <div className="flex items-center gap-3 px-3 py-1.5">
          <dt className="w-12 shrink-0 text-[13px] text-ink-3">Value</dt>
          <dd className="min-w-0 flex-1 font-mono text-[13px] break-all text-ink">{value}</dd>
          <CopyButton label="Copy value" value={value} />
        </div>
      </dl>
      <p className="border-t border-line px-3 py-2 text-xs text-ink-3">
        If your DNS provider adds the domain to names on its own, enter only the part before your domain.
      </p>
    </div>
  );
}

function bindingState(binding: DomainBindingSummary): { label: string; tone: Tone; detail?: string } {
  const readiness = binding.readiness ?? {};
  const status = typeof readiness.status === "string" ? readiness.status : binding.status;
  const reason = typeof readiness.reason === "string" ? readiness.reason : null;
  const redirectTo =
    readiness.mode === "redirect" && typeof readiness.redirectToHostname === "string" ? readiness.redirectToHostname : null;

  if (binding.status === "disabled") return { label: "Turned off", tone: "neutral" };
  if (binding.status === "active" || status === "ready") {
    return redirectTo ? { detail: `Sends visitors to ${redirectTo}`, label: "Live", tone: "ok" } : { label: "Live", tone: "ok" };
  }
  if (binding.status === "failed" || status === "failed") {
    return { detail: "Open the project's Pages settings to see what's wrong.", label: "Setup failed", tone: "err" };
  }
  if (
    reason === "cloudflare_custom_hostname_adapter_unconfigured" ||
    reason === "cloudflare_custom_hostname_provider_unauthorized" ||
    reason === "cloudflare_custom_hostname_zone_unavailable"
  ) {
    return { detail: "Custom domains need setup on the Ravi side first.", label: "Waiting on Ravi", tone: "warn" };
  }
  if (reason === "cloudflare_custom_hostname_provider_failed" || reason === "cloudflare_custom_hostname_provider_rate_limited") {
    return { detail: "Check it again in a few minutes from the project's Pages settings.", label: "Try again soon", tone: "warn" };
  }
  return {
    detail: redirectTo ? `Will send visitors to ${redirectTo}` : "Add the DNS record shown in the project's Pages settings.",
    label: "Waiting for DNS",
    tone: "warn",
  };
}

function Hostnames({
  bindings,
  sites,
  sitesLoading,
  verified,
}: {
  bindings: DomainBindingSummary[];
  sites: Map<string, SiteRef>;
  sitesLoading: boolean;
  verified: boolean;
}) {
  const pages = bindings.filter((binding) => binding.product === "pages");
  const others = bindings.length - pages.length;

  return (
    <div className="border-t border-line pt-4">
      <h4 className="mb-2 text-[13px] font-medium text-ink">Hostnames using this domain</h4>
      {pages.length === 0 ? (
        <p className="text-[13px] text-ink-3">
          {verified
            ? "None yet. To connect one, open a project's Pages settings and add a custom domain."
            : "After it's verified, connect hostnames like www from a project's Pages settings."}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {pages.map((binding) => {
            const siteId = typeof binding.readiness?.siteId === "string" ? binding.readiness.siteId : null;
            const ref = siteId ? sites.get(siteId) : undefined;
            const state = bindingState(binding);
            return (
              <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4" key={binding.id}>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] text-ink">{binding.hostname}</div>
                  <div className="truncate text-[13px] text-ink-3">
                    {ref ? (
                      <>
                        {ref.project.name} · <span className="font-mono">{ref.site.defaultHostname}</span>
                      </>
                    ) : sitesLoading ? (
                      "Finding the project…"
                    ) : (
                      "A page host in a project you can't open"
                    )}
                  </div>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-3 sm:justify-end">
                  <div className="min-w-0 flex-1 sm:flex-none sm:text-right">
                    <Badge dot tone={state.tone}>
                      {state.label}
                    </Badge>
                    {state.detail ? <div className="mt-0.5 text-xs text-ink-3">{state.detail}</div> : null}
                  </div>
                  {ref ? (
                    <Button href={pagesSettingsHref(ref.project.id, ref.site.id, "domains")} iconRight={ChevronRight} size="sm" variant="ghost">
                      Pages
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {others > 0 ? (
        <p className="mt-2 text-[13px] text-ink-3">
          {others === 1 ? "One more hostname is" : `${others} more hostnames are`} used by another Ravi product.
        </p>
      ) : null}
    </div>
  );
}

function AddDomainDialog({
  onAdded,
  onClose,
  open,
}: {
  onAdded: (claim: DomainClaimSummary) => void;
  onClose: () => void;
  open: boolean;
}) {
  const toast = useToast();
  const add = useAddDomain();
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setDomain("");
    setError(null);
    add.reset();
    onClose();
  };

  return (
    <Dialog
      description="This proves your organization owns the domain. Pages come later, from a project."
      onClose={close}
      open={open}
      title="Add a domain"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const value = domain
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/\/.*$/, "")
            .replace(/\.$/, "");
          if (!value || !value.includes(".")) {
            setError("Enter a domain like example.com.");
            return;
          }
          setError(null);
          add.mutate(value, {
            onSuccess: (result) => {
              toast.show(`${result.claim.domain} was added. Add its TXT record to verify it.`);
              onAdded(result.claim);
              close();
            },
          });
        }}
      >
        <Field
          error={error}
          hint="Your domain (example.com) or a subdomain you control (shop.example.com)."
          label="Domain"
        >
          {(props) => (
            <Input
              {...props}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              autoFocus
              className="font-mono text-[13px]"
              onChange={(event) => {
                setDomain(event.target.value);
                setError(null);
              }}
              placeholder="example.com"
              spellCheck={false}
              value={domain}
            />
          )}
        </Field>
        <Notice tone="info">
          Next you&apos;ll get a TXT record to add at your DNS provider. Once it&apos;s verified, open a project&apos;s
          Pages settings to connect a hostname like www to its pages.
        </Notice>
        {add.isError ? <FormMessage>{domainErrorMessage(add.error)}</FormMessage> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button loading={add.isPending} type="submit" variant="primary">
            Add domain
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
