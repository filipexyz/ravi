"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { InvoiceView } from "@/server/console/billing/invoices";
import type { OrgBillingOverview } from "@/server/console/billing/org-billing";
import type { PaymentInstructions } from "@/server/console/billing/payment-provider";
import type { BillingAddress, BillingProfileView } from "@/server/console/billing/profile";
import { useOrgKey } from "@/features/shell/workspace";

const BASE = "/api/console/billing";

export type OrgBillableInstallation = {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  raviVersion: string | null;
  lastSeenAt: string;
  ownerEmail: string;
};

export type BillingProfileInput = {
  legalName: string;
  taxId: string;
  billingEmail: string;
  phone: string | null;
  address: BillingAddress;
};

export function useOrgBilling() {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<OrgBillingOverview>(BASE),
    queryKey: orgKey("billing", "overview"),
  });
}

export function useOrgInvoices() {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ invoices: InvoiceView[] }>(`${BASE}/invoices`).then((data) => data.invoices),
    queryKey: orgKey("billing", "invoices"),
  });
}

export function useOrgInvoice(invoiceId: string | null) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled: Boolean(invoiceId),
    queryFn: () =>
      api.get<{ invoice: InvoiceView; payment: PaymentInstructions | null }>(
        `${BASE}/invoices/${encodeURIComponent(invoiceId ?? "")}`,
      ),
    queryKey: orgKey("billing", "invoices", invoiceId),
  });
}

export function useOrgBillableInstallations(enabled: boolean) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () =>
      api.get<{ installations: OrgBillableInstallation[] }>(`${BASE}/installations`).then((data) => data.installations),
    queryKey: orgKey("billing", "installations"),
  });
}

export function useSaveBillingProfile() {
  const queryClient = useQueryClient();
  const orgKey = useOrgKey();
  return useMutation({
    mutationFn: (input: BillingProfileInput) =>
      api.post<{ profile: BillingProfileView }>(`${BASE}/profile`, input).then((data) => data.profile),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orgKey("billing") });
    },
  });
}
