"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { ContractView } from "@/server/console/billing/contracts";
import type { InvoiceView } from "@/server/console/billing/invoices";
import type { ManageClientRow, ManageInstallationRow } from "@/server/console/billing/manage";
import type { BillingProfileView } from "@/server/console/billing/profile";

// Platform-operator billing, across organizations. Keys are not scoped to the
// selected organization: /manage is not inside one.

const BASE = "/api/console/manage/billing";

export type ManageClientDetail = {
  organization: { id: string; name: string; slug: string; status: string };
  billing: { status: string; provider: string | null; providerCustomerId: string | null; profile: BillingProfileView };
  contracts: ContractView[];
  currentContractId: string | null;
  invoices: InvoiceView[];
  installations: ManageInstallationRow[];
  periods: { current: string; previous: string };
};

export type ContractItemDraft =
  | { kind: "fixed"; description: string; quantity: number; unit: string; unitPriceCents: number }
  | {
      kind: "metered";
      description: string;
      metricKey: string;
      unit: string;
      includedQuantity: number;
      capQuantity: number | null;
      unitPriceCents: number;
    };

export type ContractDraft = {
  startsPeriod: string;
  dueDay: number;
  notes: string | null;
  items: ContractItemDraft[];
  reason: string;
};

const keys = {
  all: ["manage", "billing"] as const,
  clients: () => [...keys.all, "clients"] as const,
  client: (id: string) => [...keys.all, "clients", id] as const,
  installations: (filters: Record<string, string>) => [...keys.all, "installations", filters] as const,
};

export function useManageClients() {
  return useQuery({
    queryFn: () => api.get<{ clients: ManageClientRow[] }>(`${BASE}/clients`).then((data) => data.clients),
    queryKey: keys.clients(),
  });
}

export function useManageClient(id: string) {
  return useQuery({
    queryFn: () => api.get<ManageClientDetail>(`${BASE}/clients/${encodeURIComponent(id)}`),
    queryKey: keys.client(id),
  });
}

export function useManageInstallations(filters: { q?: string; billable?: string; status?: string }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const query = params.toString();
  return useQuery({
    queryFn: () =>
      api
        .get<{ installations: ManageInstallationRow[] }>(`${BASE}/installations${query ? `?${query}` : ""}`)
        .then((data) => data.installations),
    queryKey: keys.installations(Object.fromEntries(params)),
  });
}

/** Every billing change can move a client's numbers: refresh the whole area. */
function useBillingMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useCreateClient() {
  return useBillingMutation((input: { name: string; slug: string; ownerEmail: string; reason: string }) =>
    api.post<{ organization: { id: string; name: string; slug: string } }>(`${BASE}/clients`, input),
  );
}

export function useSaveContract(organizationId: string) {
  return useBillingMutation((input: ContractDraft) =>
    api.post<{ contract: ContractView }>(`${BASE}/clients/${encodeURIComponent(organizationId)}/contracts`, input),
  );
}

export function usePrepareInvoice(organizationId: string) {
  return useBillingMutation((input: { period: string }) =>
    api.post<{ invoice: InvoiceView }>(`${BASE}/clients/${encodeURIComponent(organizationId)}/invoices`, input),
  );
}

export function useSetInstallationBillable() {
  return useBillingMutation((input: { installationId: string; billable: boolean; note: string | null; reason: string }) =>
    api.post<{ installation: ManageInstallationRow }>(
      `${BASE}/installations/${encodeURIComponent(input.installationId)}/billable`,
      { billable: input.billable, note: input.note, reason: input.reason },
    ),
  );
}

export function useAddAdjustment() {
  return useBillingMutation((input: { invoiceId: string; description: string; amountCents: number; reason: string }) =>
    api.post<{ invoice: InvoiceView }>(`${BASE}/invoices/${encodeURIComponent(input.invoiceId)}/adjustments`, {
      description: input.description,
      amountCents: input.amountCents,
      reason: input.reason,
    }),
  );
}

export function useRemoveAdjustment() {
  return useBillingMutation((input: { invoiceId: string; lineId: string }) =>
    api.delete<{ invoice: InvoiceView }>(
      `${BASE}/invoices/${encodeURIComponent(input.invoiceId)}/adjustments/${encodeURIComponent(input.lineId)}`,
    ),
  );
}

export function useInvoiceAction(action: "issue" | "refresh" | "cancel") {
  return useBillingMutation((input: { invoiceId: string; reason?: string }) =>
    api.post<{ invoice: InvoiceView }>(
      `${BASE}/invoices/${encodeURIComponent(input.invoiceId)}/${action}`,
      input.reason ? { reason: input.reason } : {},
    ),
  );
}
