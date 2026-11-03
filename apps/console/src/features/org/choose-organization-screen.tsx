"use client";

import { useQuery } from "@tanstack/react-query";
import { Building2, Plus, RefreshCw } from "lucide-react";

import { api, describeError } from "@/lib/api/client";
import type { Org } from "@/features/console/types";
import { Button } from "@/ui/button";
import { Notice, Skeleton } from "@/ui/states";
import { safeAuthReturnTo } from "@/lib/auth/return-to";

import { CenteredScreen, OrganizationChoices } from "./organization-picker";

/** Only same-site paths: no protocol-relative or backslash tricks. */
export function safeReturnPath(value: string | null | undefined) {
  return safeAuthReturnTo(value) ?? "/projects";
}

export function ChooseOrganizationScreen({
  notice,
  returnTo,
}: {
  notice?: string | null;
  returnTo?: string | null;
}) {
  const target = safeReturnPath(returnTo);
  const orgs = useQuery({
    queryFn: () => api.get<Org[]>("/api/console/organizations"),
    queryKey: ["console", "choose-organization", "organizations"],
  });
  const current = useQuery({
    queryFn: () => api.get<Org>("/api/console/organization"),
    queryKey: ["console", "choose-organization", "current"],
    retry: false,
  });
  const list = orgs.data ?? [];
  const currentId = current.data?.id ?? null;

  const message =
    notice === "denied"
      ? "You aren't a member of that organization anymore. Choose another one."
      : notice === "missing"
        ? "Choose an organization to continue."
        : null;

  if (orgs.isPending) {
    return (
      <CenteredScreen title="Choose an organization">
        <div aria-busy aria-label="Loading" className="divide-y divide-line rounded-lg border border-line bg-surface" role="status">
          {[0, 1].map((index) => (
            <div className="flex items-center gap-3 px-4 py-3.5" key={index}>
              <Skeleton className="size-7" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      </CenteredScreen>
    );
  }

  if (orgs.isError) {
    return (
      <CenteredScreen description={describeError(orgs.error)} title="Your organizations couldn't load">
        <div className="flex justify-center gap-2">
          <Button icon={RefreshCw} onClick={() => void orgs.refetch()} variant="primary">
            Try again
          </Button>
          <Button external href="/logout" variant="ghost">
            Sign out
          </Button>
        </div>
      </CenteredScreen>
    );
  }

  if (list.length === 0) {
    return (
      <CenteredScreen
        description="You need an organization before you can open projects and pages."
        title="You're not in an organization yet"
      >
        <div className="space-y-4 rounded-lg border border-line bg-surface p-5 text-center">
          <span className="mx-auto inline-flex size-10 items-center justify-center rounded-full bg-sunken text-ink-3">
            <Building2 aria-hidden size={18} />
          </span>
          <p className="text-sm text-ink-2">
            Create one for your team. If someone added your email to their organization, it shows up here: refresh
            this page.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button href="/sign-up" icon={Plus} variant="primary">
              Create an organization
            </Button>
            <Button icon={RefreshCw} onClick={() => void orgs.refetch()} variant="ghost">
              Refresh
            </Button>
          </div>
        </div>
        <Footer />
      </CenteredScreen>
    );
  }

  return (
    <CenteredScreen
      description={
        list.length > 1
          ? "Private pages and data open only in the organization that owns them."
          : "This is the organization your account belongs to."
      }
      title="Choose an organization"
    >
      {message ? (
        <Notice className="mb-4" tone="warn">
          {message}
        </Notice>
      ) : null}
      <OrganizationChoices currentId={currentId} orgs={list} returnTo={target} />
      <Footer backHref={currentId ? target : undefined} />
    </CenteredScreen>
  );
}

function Footer({ backHref }: { backHref?: string }) {
  return (
    <div className="mt-6 flex items-center justify-center gap-1 text-[13px]">
      {backHref ? (
        <>
          <Button href={backHref} size="sm" variant="ghost">
            {backHref === "/projects" ? "Back to projects" : "Go back"}
          </Button>
          <span aria-hidden className="text-line-strong">
            ·
          </span>
        </>
      ) : null}
      <Button external href="/logout" size="sm" variant="ghost">
        Sign out
      </Button>
    </div>
  );
}
