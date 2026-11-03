"use client";

import { Laptop, ReceiptText } from "lucide-react";
import { useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import type { OrgBillingOverview } from "@/server/console/billing/org-billing";
import type { BillingProfileView } from "@/server/console/billing/profile";
import { roleLabel, useWorkspace } from "@/features/shell/workspace";
import { accountState, formatDay, formatMoney, formatPeriod, invoiceState } from "@/features/billing/format";
import { InvoiceLines, PaymentOptions } from "@/features/billing/invoice-parts";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, FormMessage, Input } from "@/ui/form";
import { DetailList, Panel, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Drawer } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice, Skeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import {
  type BillingProfileInput,
  useOrgBillableInstallations,
  useOrgBilling,
  useOrgInvoice,
  useOrgInvoices,
  useSaveBillingProfile,
} from "./billing-queries";
import { OrgArea } from "./org-area";

export function OrgBillingScreen() {
  return (
    <OrgArea tab="billing">
      <BillingBody />
    </OrgArea>
  );
}

function BillingBody() {
  const { organization } = useWorkspace();
  const overview = useOrgBilling();

  if (overview.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-28 w-full" />
        <ListSkeleton rows={3} />
      </div>
    );
  }
  if (overview.isError) {
    return <ErrorState error={overview.error} onRetry={() => void overview.refetch()} role={roleLabel(organization.role)} />;
  }
  const data = overview.data;

  return (
    <div className="space-y-10">
      <ThisMonth data={data} />
      <InvoicesSection />
      <ProfileSection profile={data.profile} />
      {data.canSeeInstallations ? <InstallationsSection /> : null}
    </div>
  );
}

function ThisMonth({ data }: { data: OrgBillingOverview }) {
  const state = accountState(data.status);
  return (
    <Section
      actions={data.contract ? <Badge tone={state.tone}>{state.label}</Badge> : null}
      description={
        data.contract
          ? `So far in ${formatPeriod(data.period)}, by your contract. The invoice is prepared after the month ends and is due on day ${data.contract.dueDay}.`
          : undefined
      }
      title="This month"
    >
      {!data.contract || !data.preview ? (
        <EmptyState
          description="There's no contract for this organization yet, so nothing is billed. When Ravi sets one up, this month's amount shows here."
          icon={ReceiptText}
          title="No billing yet"
        />
      ) : (
        <InvoiceLines
          invoice={{
            lines: data.preview.lines.map((line, index) => ({
              ...line,
              id: `${line.contractItemId ?? "line"}-${index}`,
              position: index,
              details: line.details,
            })),
            totalCents: data.preview.totalCents,
          }}
        />
      )}
    </Section>
  );
}

function InvoicesSection() {
  const invoices = useOrgInvoices();
  const [openId, setOpenId] = useState<string | null>(null);
  const { organization } = useWorkspace();
  const open = invoices.data?.find((invoice) => invoice.id === openId) ?? null;

  return (
    <Section description="Pay by Pix or boleto. Paid invoices stay here." title="Invoices">
      {invoices.isPending ? (
        <ListSkeleton rows={2} />
      ) : invoices.isError ? (
        <ErrorState error={invoices.error} onRetry={() => void invoices.refetch()} role={roleLabel(organization.role)} />
      ) : invoices.data.length === 0 ? (
        <EmptyState description="Your first invoice shows here once it's issued." icon={ReceiptText} title="No invoices yet" />
      ) : (
        <List label="Invoices">
          {invoices.data.map((invoice) => {
            const state = invoiceState(invoice.status);
            return (
              <ListRow
                chevron
                description={
                  <>
                    {/* The badge is hidden on phones; the state leads the line there. */}
                    <span className="md:hidden">{state.label} · </span>
                    {invoice.status === "paid" && invoice.paidAt
                      ? `Paid ${formatDayFromIso(invoice.paidAt)}`
                      : invoice.dueDate
                        ? `Due ${formatDay(invoice.dueDate)}`
                        : null}
                  </>
                }
                key={invoice.id}
                meta={<Badge tone={state.tone}>{state.label}</Badge>}
                onClick={() => setOpenId(invoice.id)}
                title={
                  <span className="flex items-center gap-2">
                    {formatPeriod(invoice.period)}
                    <span className="font-normal tabular-nums text-ink-2">{formatMoney(invoice.totalCents)}</span>
                  </span>
                }
              />
            );
          })}
        </List>
      )}
      {open ? <InvoiceDrawer invoiceId={open.id} onClose={() => setOpenId(null)} period={open.period} /> : null}
    </Section>
  );
}

function formatDayFromIso(value: string) {
  return formatDay(value.slice(0, 10));
}

function InvoiceDrawer({ invoiceId, onClose, period }: { invoiceId: string; onClose: () => void; period: string }) {
  const detail = useOrgInvoice(invoiceId);
  const invoice = detail.data?.invoice;
  const state = invoice ? invoiceState(invoice.status) : null;
  const payable = invoice && (invoice.status === "issued" || invoice.status === "overdue");

  return (
    <Drawer description={state?.label} onClose={onClose} open title={`Invoice for ${formatPeriod(period)}`}>
      {detail.isPending ? (
        <ListSkeleton rows={3} />
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="space-y-6">
          {invoice?.status === "overdue" ? (
            <Notice tone="err">This invoice is past its due date. Pay it below; the codes still work.</Notice>
          ) : null}
          {invoice ? <InvoiceLines invoice={invoice} /> : null}
          {invoice ? (
            <DetailList
              items={[
                invoice.dueDate ? { label: "Due", value: formatDay(invoice.dueDate) } : null,
                invoice.issuedAt ? { label: "Issued", value: <RelativeTime value={invoice.issuedAt} /> } : null,
                invoice.paidAt ? { label: "Paid", value: <RelativeTime value={invoice.paidAt} /> } : null,
              ]}
            />
          ) : null}
          {payable && detail.data.payment ? (
            <div className="space-y-3">
              <h3 className="text-[15px] font-semibold text-ink">How to pay</h3>
              <PaymentOptions payment={detail.data.payment} />
              <p className="text-[13px] text-ink-3">Payments can take a few minutes to show here; a boleto can take up to three business days.</p>
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}

const PROFILE_ERRORS: Record<string, string> = {
  invalid_tax_id: "This CPF or CNPJ isn't valid. Check the digits.",
  invalid_postal_code: "A CEP has 8 digits.",
};

function ProfileSection({ profile }: { profile: BillingProfileView }) {
  const [editing, setEditing] = useState(!profile.complete);
  return (
    <Section
      actions={
        profile.complete && !editing ? (
          <Button onClick={() => setEditing(true)} size="sm">
            Edit
          </Button>
        ) : null
      }
      description="Who the invoices are for. Owners, admins and billing members can change it."
      title="Billing details"
    >
      {editing ? (
        <ProfileForm onDone={() => setEditing(false)} profile={profile} />
      ) : (
        <Panel className="px-4">
          <DetailList
            items={[
              { label: "Legal name", value: profile.legalName },
              { label: profile.taxIdKind === "cnpj" ? "CNPJ" : "CPF", value: profile.taxId },
              { label: "Billing email", value: profile.billingEmail },
              profile.phone ? { label: "Phone", value: profile.phone } : null,
              addressLine(profile) ? { label: "Address", value: addressLine(profile) } : null,
            ]}
          />
        </Panel>
      )}
    </Section>
  );
}

function addressLine(profile: BillingProfileView) {
  const { address } = profile;
  return [
    [address.street, address.number].filter(Boolean).join(", "),
    address.complement,
    address.district,
    [address.city, address.state].filter(Boolean).join(" - "),
    address.postalCode,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ProfileForm({ onDone, profile }: { onDone: () => void; profile: BillingProfileView }) {
  const save = useSaveBillingProfile();
  const toast = useToast();
  const [form, setForm] = useState<BillingProfileInput>({
    address: { ...profile.address },
    billingEmail: profile.billingEmail ?? "",
    legalName: profile.legalName ?? "",
    phone: profile.phone ?? "",
    taxId: profile.taxId ?? "",
  });
  const fieldErrors = save.error instanceof ApiError ? (save.error.fieldErrors ?? {}) : {};
  const fieldError = (key: string) => {
    const code = fieldErrors[key];
    return code ? (PROFILE_ERRORS[code] ?? "Check this field.") : null;
  };
  const setAddress = (key: keyof BillingProfileInput["address"], value: string) =>
    setForm((current) => ({ ...current, address: { ...current.address, [key]: value } }));

  return (
    <Panel padded>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            { ...form, phone: form.phone?.trim() || null },
            {
              onSuccess: () => {
                toast.show("Billing details saved", "ok");
                onDone();
              },
            },
          );
        }}
      >
        {!profile.complete ? (
          <Notice>Fill these in so invoices can be issued to your organization.</Notice>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field error={fieldError("legalName")} label="Legal name">
            {(props) => (
              <Input {...props} onChange={(event) => setForm({ ...form, legalName: event.target.value })} required value={form.legalName} />
            )}
          </Field>
          <Field error={fieldError("taxId")} label="CPF or CNPJ">
            {(props) => (
              <Input
                {...props}
                inputMode="numeric"
                onChange={(event) => setForm({ ...form, taxId: event.target.value })}
                required
                value={form.taxId}
              />
            )}
          </Field>
          <Field error={fieldError("billingEmail")} hint="Where invoices and receipts go." label="Billing email">
            {(props) => (
              <Input
                {...props}
                onChange={(event) => setForm({ ...form, billingEmail: event.target.value })}
                required
                type="email"
                value={form.billingEmail}
              />
            )}
          </Field>
          <Field error={fieldError("phone")} label="Phone" optional>
            {(props) => (
              <Input {...props} inputMode="tel" onChange={(event) => setForm({ ...form, phone: event.target.value })} type="tel" value={form.phone ?? ""} />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)_120px]">
          <Field error={fieldError("address.postalCode")} label="CEP" optional>
            {(props) => (
              <Input {...props} inputMode="numeric" onChange={(event) => setAddress("postalCode", event.target.value)} value={form.address.postalCode ?? ""} />
            )}
          </Field>
          <Field label="Street" optional>
            {(props) => <Input {...props} onChange={(event) => setAddress("street", event.target.value)} value={form.address.street ?? ""} />}
          </Field>
          <Field label="Number" optional>
            {(props) => <Input {...props} onChange={(event) => setAddress("number", event.target.value)} value={form.address.number ?? ""} />}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_80px]">
          <Field label="Complement" optional>
            {(props) => <Input {...props} onChange={(event) => setAddress("complement", event.target.value)} value={form.address.complement ?? ""} />}
          </Field>
          <Field label="District" optional>
            {(props) => <Input {...props} onChange={(event) => setAddress("district", event.target.value)} value={form.address.district ?? ""} />}
          </Field>
          <Field label="City" optional>
            {(props) => <Input {...props} onChange={(event) => setAddress("city", event.target.value)} value={form.address.city ?? ""} />}
          </Field>
          <Field error={fieldError("address.state")} label="State" optional>
            {(props) => (
              <Input
                {...props}
                maxLength={2}
                onChange={(event) => setAddress("state", event.target.value.toUpperCase())}
                placeholder="SP"
                value={form.address.state ?? ""}
              />
            )}
          </Field>
        </div>
        {save.isError && !Object.keys(fieldErrors).length ? <FormMessage>{describeError(save.error)}</FormMessage> : null}
        <div className="flex justify-end gap-2">
          {profile.complete ? (
            <Button onClick={onDone} type="button">
              Cancel
            </Button>
          ) : null}
          <Button loading={save.isPending} type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function InstallationsSection() {
  const installations = useOrgBillableInstallations(true);
  return (
    <Section description="The Ravi installations your contract counts. Ask Ravi to change which ones." title="Billed installations">
      {installations.isPending ? (
        <ListSkeleton rows={2} />
      ) : installations.isError ? (
        <ErrorState error={installations.error} onRetry={() => void installations.refetch()} />
      ) : installations.data.length === 0 ? (
        <EmptyState
          description="None yet. Your contract may bill a flat amount instead."
          icon={Laptop}
          title="No billed installations"
        />
      ) : (
        <List label="Billed installations">
          {installations.data.map((installation) => (
            <ListRow
              description={[installation.ownerEmail, installation.hostname, installation.raviVersion ? `ravi ${installation.raviVersion}` : null]
                .filter(Boolean)
                .join(" · ")}
              key={installation.id}
              leading={<Laptop aria-hidden className="text-ink-3" size={18} />}
              meta={
                <span>
                  Seen <RelativeTime value={installation.lastSeenAt} />
                </span>
              }
              title={installation.name}
            />
          ))}
        </List>
      )}
    </Section>
  );
}
