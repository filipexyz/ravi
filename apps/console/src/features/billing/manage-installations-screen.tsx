"use client";

import { Laptop, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";

import type { ManageInstallationRow } from "@/server/console/billing/manage";
import { Input } from "@/ui/form";
import { PageHeader } from "@/ui/layout";
import { EmptyState, ErrorState, ListSkeleton } from "@/ui/states";
import { Segmented } from "@/ui/tabs";
import { BillableDialog, InstallationList } from "./manage-client-screen";
import { useManageInstallations } from "./manage-queries";

type Filter = "all" | "billable" | "not_billable";

export function ManageInstallationsScreen() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const query = useDeferredValue(q.trim());
  const installations = useManageInstallations({
    billable: filter === "all" ? "" : filter === "billable" ? "true" : "false",
    q: query,
    status: "active",
  });
  const [changing, setChanging] = useState<ManageInstallationRow | null>(null);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        description="Every Ravi linked to the Console with ravi login, in every organization. Mark the ones your contracts bill."
        title="Installations"
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" size={15} />
          <Input
            aria-label="Search installations"
            className="pl-9"
            onChange={(event) => setQ(event.target.value)}
            placeholder="Organization, name, host or owner"
            value={q}
          />
        </div>
        <Segmented<Filter>
          label="Billable"
          onChange={setFilter}
          options={[
            { label: "All", value: "all" },
            { label: "Billable", value: "billable" },
            { label: "Not billable", value: "not_billable" },
          ]}
          value={filter}
        />
      </div>
      {installations.isPending ? (
        <ListSkeleton rows={5} />
      ) : installations.isError ? (
        <ErrorState error={installations.error} onRetry={() => void installations.refetch()} />
      ) : installations.data.length === 0 ? (
        <EmptyState
          description={
            query || filter !== "all"
              ? "Nothing matches. Clear the search or the filter."
              : "When someone runs ravi login on a machine, the installation shows up here under their organization."
          }
          icon={Laptop}
          title="No installations"
        />
      ) : (
        <InstallationList installations={installations.data} onToggle={setChanging} showOrganization />
      )}
      <BillableDialog installation={changing} onClose={() => setChanging(null)} />
    </div>
  );
}
