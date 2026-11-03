"use client";

import { FileText, Laptop, Plus, ReceiptText, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import { useMemo, useState } from "react";

import { ApiError, describeError } from "@/lib/api/client";
import type { ContractView } from "@/server/console/billing/contracts";
import type { InvoiceView } from "@/server/console/billing/invoices";
import type { ManageInstallationRow } from "@/server/console/billing/manage";
import { BILLABLE_METRICS, billableMetric } from "@/shared/billing/metrics";
import { Badge, type Tone } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { CopyValue } from "@/ui/copy";
import { Field, FormMessage, Input, Select, Switch, Textarea } from "@/ui/form";
import { DetailList, PageHeader, Panel, Section } from "@/ui/layout";
import { List, ListRow } from "@/ui/list";
import { Dialog, Drawer } from "@/ui/overlay";
import { EmptyState, ErrorState, ListSkeleton, Notice, Skeleton } from "@/ui/states";
import { RelativeTime } from "@/ui/time";
import { useToast } from "@/ui/toast";
import {
  accountState,
  centsToInput,
  formatDay,
  formatMoney,
  formatPeriod,
  invoiceState,
  metricLabel,
  parseMoneyToCents,
  quantityLabel,
  quantityText,
  shiftPeriod,
  unitLabel,
} from "./format";
import { InvoiceLines, PaymentOptions } from "./invoice-parts";
import {
  type ContractItemDraft,
  type ManageClientDetail,
  useAddAdjustment,
  useInvoiceAction,
  useManageClient,
  usePrepareInvoice,
  useRemoveAdjustment,
  useSaveContract,
  useSetInstallationBillable,
} from "./manage-queries";

const ERRORS: Record<string, string> = {
  billing_profile_incomplete:
    "The client hasn't filled in its billing details yet. An owner, admin or billing member does it in Settings, Billing.",
  invoice_already_issued: "This month's invoice was already issued. Cancel it first to prepare a new one.",
  invoice_total_not_positive: "The total must be above zero to issue. Check the lines and adjustments.",
  invoice_not_draft: "Only a draft can change.",
  no_contract_for_period: "No contract covers this month. Save a contract that starts on or before it.",
  payment_provider_not_configured: "Payments aren't set up on this Console yet: the payment provider's key is missing.",
  payment_provider_rejected: "The payment provider refused the charge. Check the billing details and try again.",
  payment_provider_unreachable: "Couldn't reach the payment provider. Try again in a moment.",
  period_already_invoiced: "A month from this start on was already invoiced. Start the new version after it.",
  invoice_not_cancelable: "Only a draft or an unpaid invoice can be canceled. Refund a paid one at the payment provider.",
  reason_required: "Say why. It stays in the audit trail.",
};

function errorText(error: unknown) {
  if (error instanceof ApiError && ERRORS[error.code]) return ERRORS[error.code] as string;
  return describeError(error);
}

export function ManageClientScreen({ organizationId }: { organizationId: string }) {
  const client = useManageClient(organizationId);

  if (client.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <Skeleton className="h-8 w-64" />
        <ListSkeleton rows={3} />
      </div>
    );
  }
  if (client.isError) {
    return (
      <div className="mx-auto max-w-5xl">
        <ErrorState error={client.error} onRetry={() => void client.refetch()} title="This client couldn't load" />
      </div>
    );
  }
  const data = client.data;
  const state = accountState(data.billing.status);

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <PageHeader
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] text-ink-3">{data.organization.slug}</span>
            <Badge tone={state.tone}>{state.label}</Badge>
          </span>
        }
        title={data.organization.name}
      />
      <ContractSection data={data} />
      <InvoicesSection data={data} />
      <InstallationsSection installations={data.installations} />
      <ProfileSection data={data} />
    </div>
  );
}

/* Contract */

function ContractSection({ data }: { data: ManageClientDetail }) {
  const [editing, setEditing] = useState(false);
  const current = data.contracts.find((contract) => contract.id === data.currentContractId) ?? null;
  const latest = data.contracts[0] ?? null;
  const upcoming = latest && latest.id !== current?.id && latest.status === "active" ? latest : null;
  const history = data.contracts.filter((contract) => contract.id !== current?.id && contract.id !== upcoming?.id);

  const editButton = (
    <Button icon={latest ? FileText : Plus} onClick={() => setEditing(true)} variant={latest ? "secondary" : "primary"}>
      {latest ? "New version" : "Create contract"}
    </Button>
  );

  return (
    <Section
      actions={latest ? editButton : null}
      description="What the client pays each month. Changing it saves a new version; past invoices keep theirs."
      title="Contract"
    >
      {!latest ? (
        <EmptyState
          action={editButton}
          description="Add the fixed lines you negotiated (per installation, per agent, a flat fee) and, if agreed, metered items billed by usage."
          icon={FileText}
          title="No contract yet"
        />
      ) : (
        <div className="space-y-4">
          {current ? <ContractCard contract={current} label="In effect" /> : null}
          {upcoming ? <ContractCard contract={upcoming} label={`Starts ${formatPeriod(upcoming.startsPeriod)}`} /> : null}
          {!current && !upcoming ? (
            <Notice tone="warn">No contract covers {formatPeriod(data.periods.current)}. Save a new version to bill it.</Notice>
          ) : null}
          {history.length ? (
            <details className="group">
              <summary className="cursor-pointer text-sm text-ink-3 hover:text-ink">
                {history.length} earlier {history.length === 1 ? "version" : "versions"}
              </summary>
              <div className="mt-3 space-y-3">
                {history.map((contract) => (
                  <ContractCard contract={contract} key={contract.id} label="Ended" muted />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
      <ContractEditor
        base={upcoming ?? current ?? latest}
        currentPeriod={data.periods.current}
        onClose={() => setEditing(false)}
        open={editing}
        organizationId={data.organization.id}
      />
    </Section>
  );
}

function contractSpan(contract: ContractView) {
  const end = contract.endsPeriod ? formatPeriod(contract.endsPeriod) : "open-ended";
  return `${formatPeriod(contract.startsPeriod)} to ${end}`;
}

function ContractCard({ contract, label, muted }: { contract: ContractView; label: string; muted?: boolean }) {
  const fixed = contract.items
    .filter((item) => item.kind === "fixed")
    .reduce((sum, item) => sum + Math.round((item.quantity ?? 0) * item.unitPriceCents), 0);
  return (
    <Panel className={muted ? "opacity-80" : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <span className="text-sm font-medium text-ink">Version {contract.version}</span>
        <Badge tone={muted ? "neutral" : "ok"}>{label}</Badge>
        <span className="text-[13px] text-ink-3">{contractSpan(contract)}</span>
        <span className="ml-auto text-[13px] text-ink-3">
          Due on day {contract.dueDay} · {formatMoney(fixed)} fixed a month
        </span>
      </div>
      <ul className="divide-y divide-line">
        {contract.items.map((item) => (
          <li className="flex items-start gap-3 px-4 py-2.5" key={item.id}>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink">{item.description}</div>
              <div className="text-[13px] text-ink-3">
                {item.kind === "fixed"
                  ? quantityLabel(item.quantity ?? 0, null, item.unit)
                  : `${metricLabel(item.metricKey)}, per ${unitLabel(item.metricKey, item.unit)}${
                      item.includedQuantity ? `, ${quantityText(item.includedQuantity)} included` : ""
                    }${item.capQuantity ? `, alert above ${quantityText(item.capQuantity)}` : ""}`}
              </div>
            </div>
            <div className="shrink-0 text-right text-sm tabular-nums text-ink">
              {formatMoney(item.unitPriceCents)}
              <span className="text-ink-3"> / {unitLabel(item.metricKey, item.unit)}</span>
            </div>
          </li>
        ))}
      </ul>
      {contract.notes ? <div className="border-t border-line px-4 py-2.5 text-[13px] text-ink-2">{contract.notes}</div> : null}
    </Panel>
  );
}

type ItemForm = {
  key: number;
  kind: "fixed" | "metered";
  description: string;
  quantity: string;
  unit: string;
  metricKey: string;
  included: string;
  cap: string;
  price: string;
};

let itemKey = 0;

function itemForm(item?: ContractView["items"][number]): ItemForm {
  itemKey += 1;
  const metric = BILLABLE_METRICS[0];
  if (!item) {
    return { cap: "", description: "", included: "", key: itemKey, kind: "fixed", metricKey: metric.key, price: "", quantity: "1", unit: "installation" };
  }
  return {
    cap: item.capQuantity ? String(item.capQuantity) : "",
    description: item.description,
    included: item.includedQuantity ? String(item.includedQuantity) : "",
    key: itemKey,
    kind: item.kind,
    metricKey: item.metricKey ?? metric.key,
    price: centsToInput(item.unitPriceCents),
    quantity: item.quantity ? String(item.quantity) : "1",
    unit: item.unit,
  };
}

function toNumber(value: string) {
  const parsed = Number(value.replace(",", "."));
  return value.trim() && Number.isFinite(parsed) ? parsed : null;
}

function buildItems(items: ItemForm[]): { items: ContractItemDraft[]; error: string | null } {
  const result: ContractItemDraft[] = [];
  for (const [index, item] of items.entries()) {
    const label = `Line ${index + 1}`;
    const price = parseMoneyToCents(item.price);
    if (!item.description.trim()) return { error: `${label} needs a description.`, items: [] };
    if (price === null) return { error: `${label} needs a price, like 1.500,00.`, items: [] };
    if (item.kind === "fixed") {
      const quantity = toNumber(item.quantity);
      if (!quantity || quantity <= 0) return { error: `${label} needs a quantity above zero.`, items: [] };
      if (!item.unit.trim()) return { error: `${label} needs a unit, like installation or agent.`, items: [] };
      result.push({ description: item.description.trim(), kind: "fixed", quantity, unit: item.unit.trim(), unitPriceCents: price });
    } else {
      const included = item.included.trim() ? toNumber(item.included) : 0;
      const cap = item.cap.trim() ? toNumber(item.cap) : null;
      if (included === null || included < 0) return { error: `${label}: the included amount must be a number.`, items: [] };
      if (item.cap.trim() && (!cap || cap <= 0)) return { error: `${label}: the alert limit must be above zero.`, items: [] };
      result.push({
        capQuantity: cap,
        description: item.description.trim(),
        includedQuantity: included,
        kind: "metered",
        metricKey: item.metricKey,
        unit: item.unit,
        unitPriceCents: price,
      });
    }
  }
  return { error: result.length ? null : "Add at least one line.", items: result };
}

function ContractEditor({
  base,
  currentPeriod,
  onClose,
  open,
  organizationId,
}: {
  base: ContractView | null;
  currentPeriod: string;
  onClose: () => void;
  open: boolean;
  organizationId: string;
}) {
  return open ? (
    <ContractEditorForm base={base} currentPeriod={currentPeriod} onClose={onClose} organizationId={organizationId} />
  ) : null;
}

function ContractEditorForm({
  base,
  currentPeriod,
  onClose,
  organizationId,
}: {
  base: ContractView | null;
  currentPeriod: string;
  onClose: () => void;
  organizationId: string;
}) {
  const save = useSaveContract(organizationId);
  const toast = useToast();
  const months = useMemo(() => [-1, 0, 1, 2, 3].map((offset) => shiftPeriod(currentPeriod, offset)), [currentPeriod]);
  const [startsPeriod, setStartsPeriod] = useState(currentPeriod);
  const [dueDay, setDueDay] = useState(String(base?.dueDay ?? 10));
  const [notes, setNotes] = useState(base?.notes ?? "");
  const [reason, setReason] = useState("");
  const [items, setItems] = useState<ItemForm[]>(() => (base?.items.length ? base.items.map(itemForm) : [itemForm()]));
  const [localError, setLocalError] = useState<string | null>(null);

  function update(key: number, patch: Partial<ItemForm>) {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function submit() {
    const built = buildItems(items);
    const day = Number(dueDay);
    if (built.error) return setLocalError(built.error);
    if (!Number.isInteger(day) || day < 1 || day > 28) return setLocalError("The due day must be between 1 and 28.");
    if (reason.trim().length < 3) return setLocalError("Say why the contract changes. It stays in the audit trail.");
    setLocalError(null);
    save.mutate(
      { dueDay: day, items: built.items, notes: notes.trim() || null, reason: reason.trim(), startsPeriod },
      {
        onSuccess: (data) => {
          toast.show(`Contract version ${data.contract.version} saved`, "ok");
          onClose();
        },
      },
    );
  }

  return (
    <Drawer
      description={base ? `Based on version ${base.version}` : "First version"}
      onClose={onClose}
      open
      title={base ? "New contract version" : "New contract"}
    >
      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field hint="The previous version ends the month before." label="Starts in">
            {(props) => (
              <Select {...props} onChange={(event) => setStartsPeriod(event.target.value)} value={startsPeriod}>
                {months.map((month) => (
                  <option key={month} value={month}>
                    {formatPeriod(month)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field hint="Of the month after the one billed." label="Due day">
            {(props) => (
              <Input {...props} inputMode="numeric" max={28} min={1} onChange={(event) => setDueDay(event.target.value)} type="number" value={dueDay} />
            )}
          </Field>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-ink">Lines</h3>
          {items.map((item, index) => (
            <ItemEditor
              index={index}
              item={item}
              key={item.key}
              onChange={(patch) => update(item.key, patch)}
              onRemove={items.length > 1 ? () => setItems((current) => current.filter((entry) => entry.key !== item.key)) : undefined}
            />
          ))}
          <Button icon={Plus} onClick={() => setItems((current) => [...current, itemForm()])} size="sm" type="button">
            Add line
          </Button>
        </div>

        <Field label="Notes" optional>
          {(props) => <Textarea {...props} className="min-h-16" onChange={(event) => setNotes(event.target.value)} value={notes} />}
        </Field>
        <Field hint="Kept in the audit trail." label="Reason">
          {(props) => <Input {...props} onChange={(event) => setReason(event.target.value)} placeholder="Signed proposal of Oct 10" value={reason} />}
        </Field>

        {localError ? <FormMessage>{localError}</FormMessage> : save.isError ? <FormMessage>{errorText(save.error)}</FormMessage> : null}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose} type="button">
            Cancel
          </Button>
          <Button loading={save.isPending} type="submit" variant="primary">
            Save version
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function ItemEditor({
  index,
  item,
  onChange,
  onRemove,
}: {
  index: number;
  item: ItemForm;
  onChange: (patch: Partial<ItemForm>) => void;
  onRemove?: () => void;
}) {
  const metric = billableMetric(item.metricKey) ?? BILLABLE_METRICS[0];
  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-ink-3">Line {index + 1}</span>
        <Select
          aria-label={`Line ${index + 1} kind`}
          className="h-8 w-auto"
          onChange={(event) => {
            const kind = event.target.value as ItemForm["kind"];
            onChange(kind === "metered" ? { kind, unit: metric.units[0].key } : { kind, unit: "installation" });
          }}
          value={item.kind}
        >
          <option value="fixed">Fixed</option>
          <option value="metered">Metered</option>
        </Select>
        <span className="flex-1" />
        {onRemove ? <IconButton icon={Trash2} label={`Remove line ${index + 1}`} onClick={onRemove} size="sm" /> : null}
      </div>
      <Field label="Description">
        {(props) => (
          <Input
            {...props}
            onChange={(event) => onChange({ description: event.target.value })}
            placeholder={item.kind === "fixed" ? "Ravi installation" : "Call recording above the plan"}
            value={item.description}
          />
        )}
      </Field>
      {item.kind === "fixed" ? (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Quantity">
            {(props) => <Input {...props} inputMode="decimal" onChange={(event) => onChange({ quantity: event.target.value })} value={item.quantity} />}
          </Field>
          <Field label="Unit">
            {(props) => <Input {...props} onChange={(event) => onChange({ unit: event.target.value })} placeholder="agent" value={item.unit} />}
          </Field>
          <Field label="Price (R$)">
            {(props) => <Input {...props} inputMode="decimal" onChange={(event) => onChange({ price: event.target.value })} placeholder="1.500,00" value={item.price} />}
          </Field>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Metric">
              {(props) => (
                <Select
                  {...props}
                  onChange={(event) => {
                    const next = billableMetric(event.target.value) ?? BILLABLE_METRICS[0];
                    onChange({ metricKey: next.key, unit: next.units[0].key });
                  }}
                  value={item.metricKey}
                >
                  {BILLABLE_METRICS.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                      {entry.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Per">
              {(props) => (
                <Select {...props} onChange={(event) => onChange({ unit: event.target.value })} value={item.unit}>
                  {metric.units.map((unit) => (
                    <option key={unit.key} value={unit.key}>
                      {unit.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Included" optional>
              {(props) => <Input {...props} inputMode="decimal" onChange={(event) => onChange({ included: event.target.value })} placeholder="0" value={item.included} />}
            </Field>
            <Field hint="Only alerts." label="Limit" optional>
              {(props) => <Input {...props} inputMode="decimal" onChange={(event) => onChange({ cap: event.target.value })} value={item.cap} />}
            </Field>
            <Field label="Price (R$)">
              {(props) => <Input {...props} inputMode="decimal" onChange={(event) => onChange({ price: event.target.value })} placeholder="0,50" value={item.price} />}
            </Field>
          </div>
        </>
      )}
    </div>
  );
}

/* Invoices */

function InvoicesSection({ data }: { data: ManageClientDetail }) {
  const prepare = usePrepareInvoice(data.organization.id);
  const toast = useToast();
  const [period, setPeriod] = useState(data.periods.previous);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = data.invoices.find((invoice) => invoice.id === openId) ?? null;
  const months = [data.periods.previous, data.periods.current, shiftPeriod(data.periods.previous, -1)];

  return (
    <Section
      actions={
        <div className="flex items-center gap-2">
          <Select aria-label="Month to bill" className="h-9 w-auto" onChange={(event) => setPeriod(event.target.value)} value={period}>
            {months.map((month) => (
              <option key={month} value={month}>
                {formatPeriod(month)}
              </option>
            ))}
          </Select>
          <Button
            icon={ReceiptText}
            loading={prepare.isPending}
            onClick={() =>
              prepare.mutate(
                { period },
                {
                  onError: (error) => toast.show(errorText(error), "err"),
                  onSuccess: (result) => setOpenId(result.invoice.id),
                },
              )
            }
            variant="primary"
          >
            Prepare invoice
          </Button>
        </div>
      }
      description="A draft is built from the contract and the month's usage. Review it, adjust it, then issue it. The client sees an invoice only once it's issued."
      title="Invoices"
    >
      {data.invoices.length === 0 ? (
        <EmptyState
          description="Prepare the first invoice for a month the contract covers."
          icon={ReceiptText}
          title="No invoices yet"
        />
      ) : (
        <List label="Invoices">
          {data.invoices.map((invoice) => {
            const state = invoiceState(invoice.status);
            return (
              <ListRow
                chevron
                description={
                  <>
                    <span className="md:hidden">{state.label} · </span>
                    {invoice.status === "draft" ? "Not issued yet" : invoice.dueDate ? `Due ${formatDay(invoice.dueDate)}` : null}
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
      {open ? (
        <InvoiceDrawer
          invoice={open}
          onClose={() => setOpenId(null)}
          onRecompute={() => prepare.mutate({ period: open.period })}
          profileComplete={data.billing.profile.complete}
          recomputeError={prepare.isError ? prepare.error : null}
          recomputing={prepare.isPending}
        />
      ) : null}
    </Section>
  );
}

function InvoiceDrawer({
  invoice,
  onClose,
  onRecompute,
  profileComplete,
  recomputeError,
  recomputing,
}: {
  invoice: InvoiceView;
  onClose: () => void;
  onRecompute: () => void;
  profileComplete: boolean;
  recomputeError: unknown;
  recomputing: boolean;
}) {
  // Toasts sit under the drawer's modal layer, so failures here are shown inline.
  const toast = useToast();
  const removeAdjustment = useRemoveAdjustment();
  const issue = useInvoiceAction("issue");
  const refresh = useInvoiceAction("refresh");
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [adding, setAdding] = useState(false);
  const state = invoiceState(invoice.status);
  const draft = invoice.status === "draft";
  const open = invoice.status === "issued" || invoice.status === "overdue";
  const actionError = recomputeError ?? (removeAdjustment.isError ? removeAdjustment.error : null) ?? (refresh.isError ? refresh.error : null);

  return (
    <Drawer description={state.label} onClose={onClose} open title={`Invoice for ${formatPeriod(invoice.period)}`}>
      <div className="space-y-6">
        <InvoiceLines
          invoice={invoice}
          onRemoveAdjustment={
            draft
              ? (line) =>
                  removeAdjustment.mutate({ invoiceId: invoice.id, lineId: line.id })
              : undefined
          }
          removing={removeAdjustment.isPending ? removeAdjustment.variables?.lineId : null}
        />

        {draft ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button icon={Plus} onClick={() => setAdding(true)} size="sm">
                Add adjustment
              </Button>
              <Button icon={RefreshCw} loading={recomputing} onClick={onRecompute} size="sm">
                Recompute from usage
              </Button>
            </div>
            {!profileComplete ? (
              <Notice tone="warn">
                It can&apos;t be issued yet: the client hasn&apos;t filled in its billing details (legal name, CPF or CNPJ, billing email).
              </Notice>
            ) : null}
          </div>
        ) : null}

        <DetailList
          items={[
            invoice.dueDate ? { label: draft ? "Due if issued today" : "Due", value: formatDay(invoice.dueDate) } : null,
            invoice.preparedAt ? { label: "Prepared", value: <RelativeTime value={invoice.preparedAt} /> } : null,
            invoice.issuedAt ? { label: "Issued", value: <RelativeTime value={invoice.issuedAt} /> } : null,
            invoice.paidAt ? { label: "Paid", value: <RelativeTime value={invoice.paidAt} /> } : null,
            invoice.canceledAt ? { label: "Canceled", value: <RelativeTime value={invoice.canceledAt} /> } : null,
            invoice.providerPaymentId ? { label: "Charge", value: <CopyValue value={invoice.providerPaymentId} /> } : null,
            invoice.invoiceUrl
              ? {
                  label: "Payment page",
                  value: (
                    <a className="text-ink underline decoration-line-strong underline-offset-2" href={invoice.invoiceUrl} rel="noreferrer" target="_blank">
                      Open
                    </a>
                  ),
                }
              : null,
          ]}
        />

        {open ? <PaymentOptions payment={invoice} /> : null}

        {actionError ? <FormMessage>{errorText(actionError)}</FormMessage> : null}

        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          {invoice.status !== "canceled" && invoice.status !== "paid" && invoice.status !== "refunded" ? (
            <Button icon={XCircle} onClick={() => setCanceling(true)} variant="danger">
              Cancel invoice
            </Button>
          ) : null}
          {invoice.providerPaymentId ? (
            <Button
              icon={RefreshCw}
              loading={refresh.isPending}
              onClick={() =>
                refresh.mutate({ invoiceId: invoice.id })
              }
            >
              Check payment
            </Button>
          ) : null}
          {draft ? (
            <Button disabled={!profileComplete || invoice.totalCents <= 0} icon={Send} onClick={() => setConfirmIssue(true)} variant="primary">
              Issue invoice
            </Button>
          ) : null}
        </div>
      </div>

      <Dialog
        description={`The client gets a ${formatMoney(invoice.totalCents)} charge, payable by Pix or boleto, and sees it in Settings, Billing. Lines can't change after this.`}
        footer={
          <>
            <Button onClick={() => setConfirmIssue(false)}>Not yet</Button>
            <Button
              icon={Send}
              loading={issue.isPending}
              onClick={() =>
                issue.mutate(
                  { invoiceId: invoice.id },
                  {
                    onSuccess: () => {
                      setConfirmIssue(false);
                      toast.show("Invoice issued", "ok");
                    },
                  },
                )
              }
              variant="primary"
            >
              Issue {formatMoney(invoice.totalCents)}
            </Button>
          </>
        }
        onClose={() => {
          issue.reset();
          setConfirmIssue(false);
        }}
        open={confirmIssue}
        title={`Issue the ${formatPeriod(invoice.period)} invoice?`}
      >
        {issue.isError ? <FormMessage>{errorText(issue.error)}</FormMessage> : null}
      </Dialog>
      <AdjustmentDialog invoiceId={invoice.id} onClose={() => setAdding(false)} open={adding} />
      <CancelDialog invoice={invoice} onClose={() => setCanceling(false)} open={canceling} />
    </Drawer>
  );
}

function AdjustmentDialog({ invoiceId, onClose, open }: { invoiceId: string; onClose: () => void; open: boolean }) {
  const add = useAddAdjustment();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  function close() {
    add.reset();
    setLocalError(null);
    onClose();
  }

  return (
    <Dialog
      description="A credit or an extra charge on this draft. Use a minus sign for a discount."
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button form="add-adjustment" loading={add.isPending} type="submit" variant="primary">
            Add
          </Button>
        </>
      }
      onClose={close}
      open={open}
      title="Add adjustment"
    >
      <form
        className="space-y-4"
        id="add-adjustment"
        onSubmit={(event) => {
          event.preventDefault();
          const cents = parseMoneyToCents(amount, { allowNegative: true });
          if (!description.trim()) return setLocalError("Add the description the client will read.");
          if (!cents) return setLocalError("Enter an amount, like -200,00 or 150,00.");
          if (reason.trim().length < 3) return setLocalError("Say why. It stays in the audit trail.");
          setLocalError(null);
          add.mutate(
            { amountCents: cents, description: description.trim(), invoiceId, reason: reason.trim() },
            {
              onSuccess: () => {
                setDescription("");
                setAmount("");
                setReason("");
                close();
              },
            },
          );
        }}
      >
        <Field hint="The client reads this on the invoice." label="Description">
          {(props) => <Input {...props} onChange={(event) => setDescription(event.target.value)} placeholder="Onboarding discount" value={description} />}
        </Field>
        <Field label="Amount (R$)">
          {(props) => <Input {...props} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} placeholder="-200,00" value={amount} />}
        </Field>
        <Field hint="Only in the audit trail." label="Reason">
          {(props) => <Input {...props} onChange={(event) => setReason(event.target.value)} value={reason} />}
        </Field>
        {localError ? <FormMessage>{localError}</FormMessage> : add.isError ? <FormMessage>{errorText(add.error)}</FormMessage> : null}
      </form>
    </Dialog>
  );
}

function CancelDialog({ invoice, onClose, open }: { invoice: InvoiceView; onClose: () => void; open: boolean }) {
  const cancel = useInvoiceAction("cancel");
  const toast = useToast();
  const [reason, setReason] = useState("");
  const issued = invoice.status !== "draft";

  return (
    <Dialog
      description={
        issued
          ? "The charge is canceled too, so the Pix and boleto codes stop working. You can prepare the month again afterwards."
          : "The draft is discarded. You can prepare the month again afterwards."
      }
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(
                { invoiceId: invoice.id, reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast.show("Invoice canceled", "ok");
                    onClose();
                  },
                },
              )
            }
            disabled={reason.trim().length < 3}
            variant="danger"
          >
            Cancel invoice
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={`Cancel the ${formatPeriod(invoice.period)} invoice?`}
    >
      <div className="space-y-3">
        <Field hint="Kept in the audit trail." label="Reason">
          {(props) => <Input {...props} onChange={(event) => setReason(event.target.value)} value={reason} />}
        </Field>
        {cancel.isError ? <FormMessage>{errorText(cancel.error)}</FormMessage> : null}
      </div>
    </Dialog>
  );
}

/* Installations */

export function InstallationsSection({
  installations,
  showOrganization,
}: {
  installations: ManageInstallationRow[];
  showOrganization?: boolean;
}) {
  const [changing, setChanging] = useState<ManageInstallationRow | null>(null);
  return (
    <Section
      description="Ravi installations linked to this organization with ravi login. Only the ones marked billable count for the contract."
      title="Installations"
    >
      {installations.length === 0 ? (
        <EmptyState
          description="When someone in the organization runs ravi login on a machine, it shows up here."
          icon={Laptop}
          title="No installations yet"
        />
      ) : (
        <InstallationList installations={installations} onToggle={setChanging} showOrganization={showOrganization} />
      )}
      <BillableDialog installation={changing} onClose={() => setChanging(null)} />
    </Section>
  );
}

function shortHash(hash: string) {
  const value = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return value.slice(0, 10);
}

function installStateTone(state: string): Tone {
  if (state === "live" || state === "healthy" || state === "configured") return "ok";
  if (state === "blocked_human" || state === "drifted" || state === "degraded") return "warn";
  if (state === "revoked" || state === "decommissioned") return "err";
  return "info";
}

export function InstallationList({
  installations,
  onToggle,
  showOrganization,
}: {
  installations: ManageInstallationRow[];
  onToggle: (installation: ManageInstallationRow) => void;
  showOrganization?: boolean;
}) {
  return (
    <List label="Installations">
      {installations.map((installation) => (
        <ListRow
          actions={
            installation.status === "active" ? (
              <Switch checked={installation.billable} label={<span className="sr-only">Billable</span>} onChange={() => onToggle(installation)} />
            ) : (
              <Badge tone={installation.status === "decommissioned" ? "err" : "neutral"}>
                {installation.status === "decommissioned" ? "Decommissioned" : "Revoked"}
              </Badge>
            )
          }
          description={[
            showOrganization ? installation.organizationName : null,
            installation.ownerName ?? installation.ownerEmail ?? (installation.subjectType === "installation" ? "organization installation" : null),
            installation.hostname,
            installation.raviVersion ? `ravi ${installation.raviVersion}` : null,
            installation.desiredVersion ? `desired v${installation.desiredVersion}` : null,
            installation.appliedHash ? `applied ${shortHash(installation.appliedHash)}` : null,
            installation.billableNote,
          ]
            .filter(Boolean)
            .join(" · ")}
          key={installation.id}
          leading={<Laptop aria-hidden className="text-ink-3" size={18} />}
          meta={
            <span className="flex items-center gap-2">
              {installation.stateReportedAt ? (
                <Badge
                  tone={installStateTone(installation.installState)}
                  title={installation.installStateReason ?? undefined}
                >
                  {installation.installState.replaceAll("_", " ")}
                </Badge>
              ) : null}
              <span>
                Seen <RelativeTime value={installation.lastSeenAt} />
              </span>
            </span>
          }
          title={
            <span className="flex items-center gap-2">
              <span className="truncate">{installation.name}</span>
              {installation.billable ? <Badge tone="ok">Billable</Badge> : null}
            </span>
          }
        />
      ))}
    </List>
  );
}

export function BillableDialog({ installation, onClose }: { installation: ManageInstallationRow | null; onClose: () => void }) {
  const set = useSetInstallationBillable();
  const toast = useToast();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const next = installation ? !installation.billable : false;

  function close() {
    set.reset();
    setNote("");
    setReason("");
    onClose();
  }

  return (
    <Dialog
      description={
        next
          ? "It will count for this organization's contract from now on. Usage it reports stays visible either way."
          : "It stops counting for the contract. Invoices already issued don't change."
      }
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            disabled={reason.trim().length < 3}
            loading={set.isPending}
            onClick={() => {
              if (!installation) return;
              set.mutate(
                { billable: next, installationId: installation.id, note: note.trim() || null, reason: reason.trim() },
                {
                  onSuccess: () => {
                    toast.show(next ? "Marked billable" : "No longer billable", "ok");
                    close();
                  },
                },
              );
            }}
            variant="primary"
          >
            {next ? "Mark billable" : "Stop billing"}
          </Button>
        </>
      }
      onClose={close}
      open={Boolean(installation)}
      title={installation ? `${next ? "Bill" : "Stop billing"} ${installation.name}?` : ""}
    >
      <div className="space-y-4">
        {next ? (
          <Field hint="Shown next to the installation, e.g. which contract line it belongs to." label="Note" optional>
            {(props) => <Input {...props} onChange={(event) => setNote(event.target.value)} value={note} />}
          </Field>
        ) : null}
        <Field hint="Kept in the audit trail." label="Reason">
          {(props) => <Input {...props} onChange={(event) => setReason(event.target.value)} value={reason} />}
        </Field>
        {set.isError ? <FormMessage>{errorText(set.error)}</FormMessage> : null}
      </div>
    </Dialog>
  );
}

/* Billing details */

function ProfileSection({ data }: { data: ManageClientDetail }) {
  const { profile } = data.billing;
  const address = [
    [profile.address.street, profile.address.number].filter(Boolean).join(", "),
    profile.address.complement,
    profile.address.district,
    [profile.address.city, profile.address.state].filter(Boolean).join(" - "),
    profile.address.postalCode,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Section
      description="Filled in by the client's owner, admin or billing member in Settings, Billing. Invoices go to this name and email."
      title="Billing details"
    >
      {profile.legalName || profile.taxId || profile.billingEmail ? (
        <Panel className="px-4">
          <DetailList
            items={[
              { label: "Legal name", value: profile.legalName ?? "Missing" },
              { label: profile.taxIdKind === "cnpj" ? "CNPJ" : "CPF or CNPJ", value: profile.taxId ?? "Missing" },
              { label: "Billing email", value: profile.billingEmail ?? "Missing" },
              profile.phone ? { label: "Phone", value: profile.phone } : null,
              address ? { label: "Address", value: address } : null,
              profile.updatedAt ? { label: "Updated", value: <RelativeTime value={profile.updatedAt} /> } : null,
            ]}
          />
        </Panel>
      ) : (
        <Notice tone="warn">Not filled in yet. Invoices can be prepared, but not issued, until it is.</Notice>
      )}
    </Section>
  );
}
