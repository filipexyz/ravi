"use client";

import { AlertTriangle, Trash2 } from "lucide-react";

import type { InvoiceLineView, InvoiceView } from "@/server/console/billing/invoices";
import type { PaymentInstructions } from "@/server/console/billing/payment-provider";
import { IconButton } from "@/ui/button";
import { CopyButton } from "@/ui/copy";
import { formatMoney, quantityLabel, quantityText } from "./format";

/** The invoice's lines and total, as the client will read them. */
export function InvoiceLines({
  invoice,
  onRemoveAdjustment,
  removing,
}: {
  invoice: Pick<InvoiceView, "lines" | "totalCents">;
  onRemoveAdjustment?: (line: InvoiceLineView) => void;
  removing?: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <ul className="divide-y divide-line">
        {invoice.lines.map((line) => (
          <li className="flex items-start gap-3 px-4 py-3" key={line.id}>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink">{line.description}</div>
              <LineDetail line={line} />
            </div>
            <div className="shrink-0 text-right text-sm font-medium tabular-nums text-ink">{formatMoney(line.amountCents)}</div>
            {onRemoveAdjustment && line.source === "adjustment" ? (
              <IconButton
                className="-my-1 -mr-2"
                disabled={removing === line.id}
                icon={Trash2}
                label="Remove adjustment"
                onClick={() => onRemoveAdjustment(line)}
                size="sm"
              />
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between border-t border-line bg-sunken px-4 py-3">
        <span className="text-sm font-medium text-ink">Total</span>
        <span className="text-[15px] font-semibold tabular-nums text-ink">{formatMoney(invoice.totalCents)}</span>
      </div>
    </div>
  );
}

function LineDetail({ line }: { line: Pick<InvoiceLineView, "source" | "metricKey" | "quantity" | "unit" | "unitPriceCents" | "details"> }) {
  if (line.source === "adjustment") return <div className="mt-0.5 text-[13px] text-ink-3">Adjustment</div>;
  const price = `${formatMoney(line.unitPriceCents)} each`;
  if (line.source === "contract_fixed") {
    return (
      <div className="mt-0.5 text-[13px] text-ink-3">
        {quantityLabel(line.quantity, null, line.unit)} · {price}
      </div>
    );
  }
  const details = line.details as { used?: number; included?: number; cap?: number | null; overCap?: boolean };
  return (
    <div className="mt-0.5 space-y-0.5 text-[13px] text-ink-3">
      <div>
        Used {quantityLabel(details.used ?? 0, line.metricKey, line.unit)}
        {details.included ? `, ${quantityText(details.included)} included` : ""} · {quantityText(line.quantity)} billed at {price}
      </div>
      {details.overCap ? (
        <div className="flex items-center gap-1.5 text-warn">
          <AlertTriangle aria-hidden size={13} />
          Above the agreed limit of {quantityText(details.cap ?? 0)}
        </div>
      ) : null}
    </div>
  );
}

/** Pix (QR and copy-paste) and the boleto line for an open invoice. */
export function PaymentOptions({ payment }: { payment: Pick<PaymentInstructions, "pixCopyPaste" | "boletoLine"> & { pixQrCodePng?: string | null } }) {
  if (!payment.pixCopyPaste && !payment.boletoLine) {
    return <p className="text-sm text-ink-3">The payment codes aren&apos;t available right now. Try again in a moment.</p>;
  }
  return (
    <div className="space-y-5">
      {payment.pixCopyPaste ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-ink">Pix</h4>
          {payment.pixQrCodePng ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL from the server, nothing to optimize.
            <img
              alt="Pix QR code"
              className="size-44 rounded-md border border-line bg-white p-2"
              height={176}
              src={`data:image/png;base64,${payment.pixQrCodePng}`}
              width={176}
            />
          ) : null}
          <CodeLine label="Pix copy and paste" value={payment.pixCopyPaste} />
        </div>
      ) : null}
      {payment.boletoLine ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-ink">Boleto</h4>
          <CodeLine label="Boleto line" value={payment.boletoLine} />
        </div>
      ) : null}
    </div>
  );
}

function CodeLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-sunken px-3 py-2">
      <span className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed break-all text-ink">{value}</span>
      <CopyButton label={`Copy ${label.toLowerCase()}`} value={value} />
    </div>
  );
}
