// Pure billing arithmetic: months, money and invoice lines. Kept free of the
// database so the rules in console/billing/contracts can be tested directly.

export type ContractItemKind = "fixed" | "metered";

export type ContractItemInput = {
  id?: string | null;
  kind: ContractItemKind;
  description: string;
  metricKey?: string | null;
  quantity?: number | null;
  includedQuantity?: number | null;
  capQuantity?: number | null;
  unit: string;
  unitPriceCents: number;
};

export type ComputedLine = {
  source: "contract_fixed" | "contract_metered";
  contractItemId: string | null;
  description: string;
  metricKey: string | null;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  amountCents: number;
  details: {
    used?: number;
    included?: number;
    cap?: number | null;
    overCap?: boolean;
  };
};

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Brazil has had no daylight saving since 2019: São Paulo is UTC-3 all year. */
const SAO_PAULO_OFFSET_HOURS = 3;

export function isPeriod(value: unknown): value is string {
  return typeof value === "string" && PERIOD_PATTERN.test(value);
}

export function parsePeriod(period: string): { year: number; month: number } {
  const match = PERIOD_PATTERN.exec(period);
  if (!match) throw new Error(`invalid_period:${period}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function formatPeriod(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function shiftPeriod(period: string, months: number): string {
  const { year, month } = parsePeriod(period);
  return formatPeriod(year, month + months);
}

/** The month a São Paulo clock shows at `now`. */
export function currentPeriod(now = new Date()): string {
  const local = new Date(now.getTime() - SAO_PAULO_OFFSET_HOURS * 3_600_000);
  return formatPeriod(local.getUTCFullYear(), local.getUTCMonth() + 1);
}

/** The São Paulo calendar day at `now`, as YYYY-MM-DD. */
export function saoPauloDate(now = new Date()): string {
  return new Date(now.getTime() - SAO_PAULO_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

/** [start, end) of a month in São Paulo time, as UTC instants. */
export function periodWindow(period: string): { start: Date; end: Date } {
  const { year, month } = parsePeriod(period);
  return {
    start: new Date(Date.UTC(year, month - 1, 1, SAO_PAULO_OFFSET_HOURS)),
    end: new Date(Date.UTC(year, month, 1, SAO_PAULO_OFFSET_HOURS)),
  };
}

export function comparePeriods(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a contract version with these bounds applies to `period`. */
export function contractCoversPeriod(
  contract: { startsPeriod: string; endsPeriod: string | null },
  period: string,
): boolean {
  if (comparePeriods(contract.startsPeriod, period) > 0) return false;
  return contract.endsPeriod === null || comparePeriods(contract.endsPeriod, period) >= 0;
}

/**
 * The due date of the invoice for `period`: `dueDay` of the following month,
 * or three days from today when that date already passed.
 */
export function invoiceDueDate(period: string, dueDay: number, now = new Date()): string {
  const { year, month } = parsePeriod(period);
  const day = Math.min(Math.max(Math.trunc(dueDay), 1), 28);
  const due = new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  const today = saoPauloDate(now);
  if (due > today) return due;
  const soonest = new Date(`${today}T00:00:00Z`);
  soonest.setUTCDate(soonest.getUTCDate() + 3);
  return soonest.toISOString().slice(0, 10);
}

/** Quantity x unit price in cents, rounded half away from zero. */
export function lineAmountCents(quantity: number, unitPriceCents: number): number {
  const raw = quantity * unitPriceCents;
  // Remove float noise (0.1 * 3 = 0.30000000000000004) before rounding.
  const cleaned = Math.round(raw * 1e6) / 1e6;
  return Math.sign(cleaned) * Math.round(Math.abs(cleaned));
}

/**
 * The lines a contract bills for a month. Fixed items bill their quantity
 * whatever is running; metered items bill the usage above what is included.
 * A cap only flags the line (`overCap`), it never trims it.
 */
export function computeContractLines(
  items: readonly ContractItemInput[],
  usageByMetric: ReadonlyMap<string, number>,
): ComputedLine[] {
  return items.map((item) => {
    if (item.kind === "fixed") {
      const quantity = item.quantity ?? 1;
      return {
        source: "contract_fixed",
        contractItemId: item.id ?? null,
        description: item.description,
        metricKey: null,
        quantity,
        unit: item.unit,
        unitPriceCents: item.unitPriceCents,
        amountCents: lineAmountCents(quantity, item.unitPriceCents),
        details: {},
      } satisfies ComputedLine;
    }

    const used = item.metricKey ? usageByMetric.get(item.metricKey) ?? 0 : 0;
    const included = item.includedQuantity ?? 0;
    const billable = Math.max(0, used - included);
    const cap = item.capQuantity ?? null;
    return {
      source: "contract_metered",
      contractItemId: item.id ?? null,
      description: item.description,
      metricKey: item.metricKey ?? null,
      quantity: billable,
      unit: item.unit,
      unitPriceCents: item.unitPriceCents,
      amountCents: lineAmountCents(billable, item.unitPriceCents),
      details: { used, included, cap, overCap: cap !== null && used > cap },
    } satisfies ComputedLine;
  });
}

export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}

export function formatBrl(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { currency: "BRL", style: "currency" }).format(cents / 100);
}
