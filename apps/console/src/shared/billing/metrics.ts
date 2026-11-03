// Metrics a contract can bill, in Ravi words. Each metric is recorded in a base
// unit (seconds, bytes, count) and billed in one of its billing units: a
// metered item stores the billing unit, and usage is divided by its size.
// Shared by the server (invoice math) and the Console (contract editor).

export type BillingUnit = { key: string; label: string; size: number };

export type BillableMetric = {
  key: string;
  label: string;
  units: readonly BillingUnit[];
};

export const BILLABLE_METRICS = [
  {
    key: "pages.chat.voice_seconds",
    label: "Page Chat voice",
    units: [
      { key: "minute", label: "minute", size: 60 },
      { key: "hour", label: "hour", size: 3_600 },
    ],
  },
  {
    key: "pages.chat.sessions",
    label: "Page Chat conversations",
    units: [{ key: "conversation", label: "conversation", size: 1 }],
  },
  {
    key: "meetings.recording_seconds",
    label: "Call recording",
    units: [
      { key: "minute", label: "minute", size: 60 },
      { key: "hour", label: "hour", size: 3_600 },
    ],
  },
  {
    key: "meetings.bots",
    label: "Calls recorded",
    units: [{ key: "call", label: "call", size: 1 }],
  },
  {
    key: "pages.requests.public",
    label: "Public page views",
    units: [{ key: "thousand", label: "1,000 views", size: 1_000 }],
  },
  {
    key: "pages.requests.private",
    label: "Private page views",
    units: [{ key: "thousand", label: "1,000 views", size: 1_000 }],
  },
  {
    key: "pages.bytes_served",
    label: "Page bandwidth",
    units: [{ key: "gb", label: "GB", size: 1_000_000_000 }],
  },
] as const satisfies readonly BillableMetric[];

export type BillableMetricKey = (typeof BILLABLE_METRICS)[number]["key"];

export const BILLABLE_METRIC_KEYS = BILLABLE_METRICS.map((metric) => metric.key) as [
  BillableMetricKey,
  ...BillableMetricKey[],
];

export function billableMetric(key: string | null | undefined): BillableMetric | undefined {
  return BILLABLE_METRICS.find((metric) => metric.key === key);
}

export function billingUnit(metricKey: string | null | undefined, unitKey: string): BillingUnit | undefined {
  return billableMetric(metricKey)?.units.find((unit) => unit.key === unitKey);
}

/** Usage in billing units: a metric's base-unit total divided by the unit's size. */
export function usageInBillingUnits(metricKey: string, unitKey: string, baseQuantity: number): number {
  const size = billingUnit(metricKey, unitKey)?.size ?? 1;
  return Math.round((baseQuantity / size) * 1_000_000) / 1_000_000;
}
