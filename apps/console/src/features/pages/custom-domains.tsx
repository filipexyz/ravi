"use client";

import { Globe2, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import type { DomainBindingSummary, DomainClaimSummary, DomainClaimsData, PageSiteSummary } from "@/features/console/types";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { Field, FormMessage, Input } from "@/ui/form";
import { Section } from "@/ui/layout";
import { Dialog } from "@/ui/overlay";
import { ErrorState, ListSkeleton, Notice } from "@/ui/states";
import { useToast } from "@/ui/toast";
import { domainApi, useCheckBinding, useRefreshPages } from "./data";
import {
  bindingSiteId,
  bindingsForSite,
  claimIsVerified,
  describeBinding,
  domainErrorMessage,
  findClaimForHostname,
  globalHostRecord,
  looksLikeHostname,
  normalizeHostnameInput,
  ownershipRecord,
  pagesHostnameRecord,
} from "./domains-model";
import { DnsRecords } from "./parts";

type DomainsQuery = {
  data: DomainClaimsData | undefined;
  error: unknown;
  isPending: boolean;
  refetch: () => unknown;
};

/** Hostnames that open this host's pages, each with one state and its next step. */
export function CustomDomainsSection({
  canWrite,
  domains,
  hostnameForSite,
  projectId,
  site,
}: {
  canWrite: boolean;
  domains: DomainsQuery;
  /** Names another host of this project, when a hostname already points there. */
  hostnameForSite: (siteId: string) => string | null;
  projectId: string;
  site: PageSiteSummary;
}) {
  const { organization } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const bindings = domains.data ? bindingsForSite(domains.data.bindings, site.id) : [];

  return (
    <Section
      actions={
        canWrite && domains.data ? (
          <Button icon={Plus} onClick={() => setAdding(true)} size="sm">
            Add domain
          </Button>
        ) : null
      }
      className="scroll-mt-24"
      description={bindings.length === 0 ? "Open this host's pages at your own domain, like www.example.com." : undefined}
      id="domains"
      title="Custom domains"
    >
      {domains.isPending ? (
        <ListSkeleton rows={1} />
      ) : domains.error ? (
        <ErrorState error={domains.error} onRetry={() => domains.refetch()} role={roleLabel(organization.role)} />
      ) : bindings.length === 0 ? (
        canWrite ? null : <p className="text-sm text-ink-3">No custom domain.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {bindings.map((binding) => (
            <BindingRow binding={binding} canWrite={canWrite} key={binding.id} projectId={projectId} />
          ))}
        </ul>
      )}
      {adding && domains.data ? (
        <AddDomainDialog
          bindings={domains.data.bindings}
          claims={domains.data.claims}
          hostnameForSite={hostnameForSite}
          onClose={() => setAdding(false)}
          projectId={projectId}
          site={site}
        />
      ) : null}
    </Section>
  );
}

function BindingRow({ binding, canWrite, projectId }: { binding: DomainBindingSummary; canWrite: boolean; projectId: string }) {
  const view = describeBinding(binding);
  const check = useCheckBinding(projectId);
  const toast = useToast();

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 basis-full items-center gap-1 sm:basis-0 sm:flex-1">
          <span className="truncate font-mono text-[13px] font-medium text-ink">{binding.hostname}</span>
          <CopyButton label="Copy hostname" value={binding.hostname} />
        </div>
        <Badge dot tone={view.tone}>
          {view.label}
        </Badge>
        {canWrite && view.state !== "ready" ? (
          <Button
            icon={RefreshCw}
            loading={check.isPending}
            onClick={() =>
              check.mutate(binding.id, {
                onError: (error) => toast.show(domainErrorText(error), "err"),
                onSuccess: (result) => {
                  const next = describeBinding(result.binding);
                  toast.show(next.state === "ready" ? `${binding.hostname} is ready.` : `${binding.hostname}: ${next.label.toLowerCase()}.`, next.state === "ready" ? "ok" : "err");
                },
              })
            }
            size="sm"
          >
            Check again
          </Button>
        ) : null}
      </div>
      {view.state === "ready" && !view.redirectTo ? null : <p className="mt-0.5 text-[13px] text-ink-3">{view.message}</p>}
      {view.records.length ? <DnsRecords className="mt-3 max-w-2xl" records={view.records} /> : null}
    </li>
  );
}

function domainErrorText(error: unknown) {
  return (error instanceof ApiError ? domainErrorMessage(error.code) : null) ?? describeError(error);
}

type Step =
  | { kind: "hostname" }
  | { kind: "ownership"; hostname: string; claim: DomainClaimSummary; notFound: boolean }
  | { kind: "result"; hostname: string; binding: DomainBindingSummary };

/**
 * One hostname field. The dialog then chains the existing endpoints: find or
 * create the domain's ownership claim, show its TXT record until it is proven,
 * bind the hostname to this host, and check it.
 */
function AddDomainDialog({
  bindings,
  claims,
  hostnameForSite,
  onClose,
  projectId,
  site,
}: {
  bindings: DomainBindingSummary[];
  claims: DomainClaimSummary[];
  hostnameForSite: (siteId: string) => string | null;
  onClose: () => void;
  projectId: string;
  site: PageSiteSummary;
}) {
  const refresh = useRefreshPages(projectId);
  const [step, setStep] = useState<Step>({ kind: "hostname" });
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [moveWarning, setMoveWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(domainErrorText(cause));
    } finally {
      setBusy(false);
      void refresh();
    }
  }

  async function connect(claim: DomainClaimSummary, hostname: string) {
    const { binding } = await domainApi.createBinding(claim.id, hostname, site.id);
    let checked = binding;
    try {
      checked = (await domainApi.checkBinding(binding.id)).binding;
    } catch {
      // The binding is saved; its row offers Check again.
    }
    setStep({ binding: checked, hostname, kind: "result" });
  }

  function submitHostname() {
    const hostname = normalizeHostnameInput(value);
    if (!looksLikeHostname(hostname)) {
      setFieldError("Enter a hostname like www.example.com.");
      return;
    }
    if (hostname === site.defaultHostname || hostname.endsWith(".ravi.page")) {
      setFieldError("Use a domain you own. ravi.page addresses are given by Ravi.");
      return;
    }
    setFieldError(null);
    const existing = bindings.find(
      (binding) => binding.product === "pages" && binding.status !== "deleted" && binding.hostname === hostname,
    );
    const existingSiteId = existing ? bindingSiteId(existing) : null;
    if (existing && existingSiteId === site.id) {
      setFieldError("This hostname is already linked to this host. Its state is in the list.");
      return;
    }
    if (existing && existingSiteId && moveWarning !== hostname) {
      setMoveWarning(hostname);
      return;
    }
    void run(async () => {
      let claim = findClaimForHostname(claims, hostname);
      if (!claim) {
        const { getDomain } = await import("tldts");
        const domain = getDomain(hostname.replace(/^\*\./, ""), { allowPrivateDomains: true });
        if (!domain) throw new Error("This doesn't look like a domain you can own. Check the spelling.");
        claim = (await domainApi.createClaim(domain)).claim;
      }
      if (!claimIsVerified(claim)) {
        setStep({ claim, hostname, kind: "ownership", notFound: false });
        return;
      }
      await connect(claim, hostname);
    });
  }

  function verify(claim: DomainClaimSummary, hostname: string) {
    void run(async () => {
      const verified = (await domainApi.verifyClaim(claim.id)).claim;
      if (!claimIsVerified(verified)) {
        setStep({ claim: verified, hostname, kind: "ownership", notFound: true });
        return;
      }
      await connect(verified, hostname);
    });
  }

  function checkAgain(binding: DomainBindingSummary, hostname: string) {
    void run(async () => {
      const checked = (await domainApi.checkBinding(binding.id)).binding;
      setStep({ binding: checked, hostname, kind: "result" });
    });
  }

  function movedFrom(hostname: string) {
    const existing = bindings.find((binding) => binding.hostname === hostname);
    const siteId = existing ? bindingSiteId(existing) : null;
    return siteId ? hostnameForSite(siteId) : null;
  }

  if (step.kind === "hostname") {
    return (
      <Dialog
        className="max-w-xl"
        description="Pages on this host will also open at this address."
        footer={
          <>
            <Button onClick={onClose} variant="ghost">
              Cancel
            </Button>
            <Button form="add-domain-form" loading={busy} type="submit" variant="primary">
              Continue
            </Button>
          </>
        }
        onClose={onClose}
        open
        title="Add a custom domain"
      >
        <form
          className="space-y-4"
          id="add-domain-form"
          onSubmit={(event) => {
            event.preventDefault();
            submitHostname();
          }}
        >
          <StepLine current={1} />
          <Field
            error={fieldError}
            hint="The full address people will type. A bare domain (example.com) works when your DNS provider supports CNAME flattening or ALIAS at the root."
            label="Hostname"
          >
            {(props) => (
              <Input
                {...props}
                autoCapitalize="none"
                autoComplete="off"
                autoFocus
                className="font-mono text-[13px]"
                inputMode="url"
                onChange={(event) => setValue(event.target.value)}
                placeholder="www.example.com"
                spellCheck={false}
                value={value}
              />
            )}
          </Field>
          {moveWarning && moveWarning === normalizeHostnameInput(value) ? (
            <Notice tone="warn">
              {moveWarning} already opens{" "}
              {movedFrom(moveWarning) ?? "another host in this organization"}. Press Continue again to move it to this host.
            </Notice>
          ) : null}
          {error ? <FormMessage>{error}</FormMessage> : null}
        </form>
      </Dialog>
    );
  }

  if (step.kind === "ownership") {
    const txt = ownershipRecord(step.claim);
    return (
      <Dialog
        className="max-w-xl"
        description={
          <>
            Then <span className="font-mono text-[13px] text-ink">{step.hostname}</span>{" "}
            can open this host&apos;s pages. You do this once per domain.
          </>
        }
        footer={
          <>
            <Button onClick={onClose} variant="ghost">
              Close
            </Button>
            <Button loading={busy} onClick={() => verify(step.claim, step.hostname)} variant="primary">
              Verify
            </Button>
          </>
        }
        onClose={onClose}
        open
        title={`Prove you own ${step.claim.domain}`}
      >
        <div className="space-y-4">
          <StepLine current={2} />
          <p className="text-sm text-ink-2">
            Add these records where the DNS of {step.claim.domain} is managed (often where you bought the domain), then
            press Verify. The TXT proves you own the domain; the CNAME points {step.hostname} to Ravi Pages, so the last
            step needs no second visit.
          </p>
          {txt ? (
            <DnsRecords records={[txt, pagesHostnameRecord(step.hostname)]} />
          ) : (
            <FormMessage>This domain has no ownership record to show. Contact support.</FormMessage>
          )}
          {step.notFound ? (
            <FormMessage>
              The record isn&apos;t visible yet. DNS changes can take from a few minutes to an hour. You can close this and come
              back: add {step.hostname} again and you&apos;ll continue from here.
            </FormMessage>
          ) : null}
          {error ? <FormMessage>{error}</FormMessage> : null}
        </div>
      </Dialog>
    );
  }

  const view = describeBinding(step.binding);
  const globalHost = globalHostRecord(step.hostname, findClaimForHostname(claims, step.hostname)?.domain ?? null);
  return (
    <Dialog
      className="max-w-xl"
      description={
        <>
          <span className="font-mono text-[13px] text-ink">{step.hostname}</span> is linked to{" "}
          <span className="font-mono text-[13px] text-ink">{site.defaultHostname}</span>.
        </>
      }
      footer={
        <>
          {view.state !== "ready" ? (
            <Button icon={RefreshCw} loading={busy} onClick={() => checkAgain(step.binding, step.hostname)}>
              Check again
            </Button>
          ) : null}
          <Button onClick={onClose} variant="primary">
            Done
          </Button>
        </>
      }
      onClose={onClose}
      open
      title={view.state === "ready" ? "Your domain is ready" : "Almost there"}
    >
      <div className="space-y-4">
        <StepLine current={3} />
        <div className="flex flex-wrap items-center gap-2">
          <Globe2 aria-hidden className="text-ink-3" size={16} />
          <span className="font-mono text-[13px] text-ink">{step.hostname}</span>
          <Badge dot tone={view.tone}>
            {view.label}
          </Badge>
        </div>
        <p className="text-sm text-ink-2">{view.message}</p>
        {view.records.length ? <DnsRecords records={view.records} /> : null}
        {view.state === "dns_missing" && globalHost ? (
          <p className="text-[13px] text-ink-3">
            To skip this step for every other subdomain, add once{" "}
            <span className="font-mono text-ink">{globalHost.name}</span> as a CNAME to{" "}
            <span className="font-mono text-ink">{globalHost.value}</span>.
          </p>
        ) : null}
        {view.state !== "ready" ? (
          <p className="text-[13px] text-ink-3">You can close this. The domain stays under Custom domains with its next step.</p>
        ) : null}
        {error ? <FormMessage>{error}</FormMessage> : null}
      </div>
    </Dialog>
  );
}

const STEPS = ["Hostname", "Ownership", "Connect"];

function StepLine({ current }: { current: number }) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      {STEPS.map((label, index) => {
        const number = index + 1;
        const state = number < current ? "done" : number === current ? "current" : "next";
        return (
          <li className="flex items-center gap-2" key={label}>
            {index > 0 ? <span aria-hidden className="h-px w-4 bg-line-strong" /> : null}
            <span
              aria-current={state === "current" ? "step" : undefined}
              className={state === "current" ? "font-medium text-ink" : state === "done" ? "text-ok" : "text-ink-3"}
            >
              {number}. {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
