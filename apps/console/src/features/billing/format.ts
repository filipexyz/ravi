import type { Tone } from "@/ui/badge";
import { billableMetric, billingUnit } from "@/shared/billing/metrics";

// Words and money for the billing screens (console/billing/contracts).

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatMoney(cents: number): string {
  return brl.format(cents / 100);
}

/** "1.234,56", "1234.56" or "R$ 10" in cents; null when it isn't an amount. */
export function parseMoneyToCents(input: string, { allowNegative = false } = {}): number | null {
  let text = input.replace(/R\$/gi, "").replace(/\s/g, "");
  if (!text) return null;
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isFinite(cents)) return null;
  if (negative && !allowNegative) return null;
  return negative ? -cents : cents;
}

/** Cents as the editor shows them: "1234,50". */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10" as "Oct 2026". */
export function formatPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return `${MONTHS[month - 1]} ${year}`;
}

/** "2026-11-10" as "Nov 10, 2026". */
export function formatDay(day: string | null): string {
  if (!day) return "";
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return `${MONTHS[month - 1]} ${date}, ${year}`;
}

export function shiftPeriod(period: string, months: number): string {
  const [year, month] = period.split("-").map(Number);
  const index = (year ?? 0) * 12 + ((month ?? 1) - 1) + months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const INVOICE_STATES: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  issued: { label: "Waiting for payment", tone: "info" },
  paid: { label: "Paid", tone: "ok" },
  overdue: { label: "Overdue", tone: "err" },
  canceled: { label: "Canceled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "warn" },
};

export function invoiceState(status: string): { label: string; tone: Tone } {
  return INVOICE_STATES[status] ?? { label: status, tone: "neutral" };
}

const ACCOUNT_STATES: Record<string, { label: string; tone: Tone }> = {
  trialing: { label: "Not billed yet", tone: "neutral" },
  active: { label: "Up to date", tone: "ok" },
  past_due: { label: "Payment overdue", tone: "err" },
  canceled: { label: "Canceled", tone: "neutral" },
  disabled: { label: "Turned off", tone: "neutral" },
};

export function accountState(status: string): { label: string; tone: Tone } {
  return ACCOUNT_STATES[status] ?? { label: status, tone: "neutral" };
}

export function quantityText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** The billing unit's label, e.g. "minute" or "1,000 views". */
export function unitLabel(metricKey: string | null | undefined, unit: string): string {
  return billingUnit(metricKey, unit)?.label ?? unit;
}

export function metricLabel(metricKey: string | null | undefined): string {
  return billableMetric(metricKey)?.label ?? metricKey ?? "";
}

/**
 * "2 × installation" for a contract's own units (any language), "240 minutes"
 * for a metric's billing unit.
 */
export function quantityLabel(quantity: number, metricKey: string | null | undefined, unit: string): string {
  if (!billingUnit(metricKey, unit)) return `${quantityText(quantity)} × ${unit}`;
  const label = unitLabel(metricKey, unit);
  if (/^\d/.test(label)) return `${quantityText(quantity)} × ${label}`;
  return `${quantityText(quantity)} ${quantity !== 1 && /^[a-z]+$/.test(label) ? `${label}s` : label}`;
}
