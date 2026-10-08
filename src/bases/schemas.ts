// Response shapes of the Console Bases CLI API (`/api/cli/projects/<project>/bases/...`).
// They mirror the public Console contract and stay lenient on enum-like strings
// so a new Console value does not break the CLI. Filters, layouts, access
// policies, and chart encodings are opaque JSON here: the Console validates and
// evaluates them, the OSS CLI only transports them.

import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../cli/return-schemas.js";

export const basesUserRefSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export const basesUsersSchema = z.record(z.string(), basesUserRefSchema);

export const basesCapabilitiesSchema = z.object({
  manage: z.boolean(),
  readDirect: z.boolean(),
  writeDirect: z.boolean(),
});

export const baseSummarySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  timezone: z.string(),
  schemaVersion: z.number(),
  version: z.number(),
  status: z.string(),
  rowCount: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  capabilities: basesCapabilitiesSchema,
});

export const baseSelectOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  group: z.string().optional(),
  archived: z.boolean().optional(),
});

export const basePropertyConfigSchema = z.object({
  options: z.array(baseSelectOptionSchema).optional(),
  format: z.string().optional(),
  currency: z.string().optional(),
  precision: z.number().optional(),
  includeTime: z.boolean().optional(),
});

export const basePropertySchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  config: basePropertyConfigSchema,
  position: z.number(),
  required: z.boolean(),
  deletedAt: z.string().nullable(),
});

export const baseSortSchema = z.object({ prop: z.string(), dir: z.string() });

export const baseViewCapabilitiesSchema = z.object({
  read: z.boolean(),
  aggregateOnly: z.boolean(),
  writeColumns: z.array(z.string()),
  create: z.boolean(),
  archive: z.boolean(),
  manage: z.boolean(),
});

export const baseViewColumnSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  config: basePropertyConfigSchema,
  required: z.boolean(),
});

/** Full view: managers only. */
export const baseViewSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  columns: z.array(z.string()),
  query: z.object({ filter: jsonValueSchema.nullable(), sort: z.array(baseSortSchema) }),
  layout: jsonObjectSchema,
  access: jsonObjectSchema,
  position: z.number(),
  version: z.number(),
  status: z.string(),
  valid: z.boolean(),
  invalidReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  capabilities: baseViewCapabilitiesSchema,
});

/** Public shape of a view, for callers without manage. */
export const baseViewPublicSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  layout: jsonObjectSchema,
  version: z.number(),
  columns: z.array(baseViewColumnSchema),
  capabilities: baseViewCapabilitiesSchema,
  valid: z.boolean(),
});

export const baseAnyViewSchema = z.union([baseViewSchema, baseViewPublicSchema]);

export const baseViewDescribeSchema = baseViewPublicSchema.extend({ view: baseViewSchema.optional() });

/** Charts: lifecycle fields are present for managers only. */
export const baseChartSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  viewId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  spec: jsonObjectSchema,
  version: z.number(),
  position: z.number().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const baseDetailSchema = baseSummarySchema.extend({
  properties: z.array(basePropertySchema),
  views: z.array(baseAnyViewSchema),
  charts: z.array(baseChartSchema),
  members: z.array(basesUserRefSchema),
});

export const baseRowSchema = z.object({
  rowId: z.string(),
  version: z.number(),
  values: z.record(z.string(), jsonValueSchema),
  body: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
});

export const baseQueryResponseSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(baseRowSchema),
  nextCursor: z.string().nullable(),
  users: basesUsersSchema,
});

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const baseAggregateGroupSchema = z.object({
  keys: z.record(z.string(), scalarSchema),
  values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
});

export const baseAggregateResponseSchema = z.object({
  groups: z.array(baseAggregateGroupSchema),
  suppressedGroups: z.number(),
  users: basesUsersSchema,
});

export const baseLedgerEntrySchema = z.object({
  id: z.string(),
  sequence: z.number(),
  rowId: z.string(),
  version: z.number(),
  action: z.string(),
  changedKeys: z.array(z.string()),
  before: z.record(z.string(), jsonValueSchema),
  after: z.record(z.string(), jsonValueSchema),
  bodyChanged: z.boolean(),
  /** Null through a view that does not project the actor columns. */
  actorType: z.string().nullable(),
  actorId: z.string().nullable(),
  surface: z.string().nullable(),
  viewId: z.string().nullable(),
  lastWriteWins: z.boolean(),
  /** Null through a view that does not project the time columns. */
  createdAt: z.string().nullable(),
});

export const baseRowHistoryResponseSchema = z.object({
  entries: z.array(baseLedgerEntrySchema),
  nextCursor: z.string().nullable(),
  users: basesUsersSchema,
});

export const baseRowWriteResponseSchema = z.object({
  row: baseRowSchema,
  users: basesUsersSchema,
  idempotentReplay: z.boolean(),
});

export const baseRowBatchWriteResponseSchema = z.object({
  rows: z.array(baseRowSchema),
  users: basesUsersSchema,
  idempotentReplay: z.boolean(),
});

export const basePropertyMigrationReportSchema = z.object({
  dryRun: z.boolean(),
  activeRows: z.number(),
  converted: z.number(),
  cleared: z.number(),
  missing: z.number(),
  dependents: z.object({
    views: z.array(z.object({ id: z.string(), name: z.string() })),
    charts: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
});

export const basePropertyMutationResponseSchema = z.object({
  base: baseSummarySchema,
  property: basePropertySchema,
  report: basePropertyMigrationReportSchema.nullable(),
});

export const baseSubscriptionSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  localInstallationId: z.string(),
  installationName: z.string().nullable(),
  userId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

export const baseChartDataResponseSchema = z.object({
  chart: baseChartSchema,
  fields: z.record(z.string(), baseViewColumnSchema),
  data: z.array(z.record(z.string(), scalarSchema)),
  suppressedGroups: z.number(),
  users: basesUsersSchema,
});

export const baseRowPurgeResponseSchema = z.object({ purged: z.boolean(), rowId: z.string() });

export type BasesUserRef = z.infer<typeof basesUserRefSchema>;
export type BaseSummary = z.infer<typeof baseSummarySchema>;
export type BaseDetail = z.infer<typeof baseDetailSchema>;
export type BaseProperty = z.infer<typeof basePropertySchema>;
export type BasePropertyConfig = z.infer<typeof basePropertyConfigSchema>;
export type BaseView = z.infer<typeof baseViewSchema>;
export type BaseViewPublic = z.infer<typeof baseViewPublicSchema>;
export type BaseAnyView = z.infer<typeof baseAnyViewSchema>;
export type BaseViewDescribe = z.infer<typeof baseViewDescribeSchema>;
export type BaseViewColumn = z.infer<typeof baseViewColumnSchema>;
export type BaseChart = z.infer<typeof baseChartSchema>;
export type BaseRow = z.infer<typeof baseRowSchema>;
export type BaseQueryResponse = z.infer<typeof baseQueryResponseSchema>;
export type BaseAggregateResponse = z.infer<typeof baseAggregateResponseSchema>;
export type BaseRowHistoryResponse = z.infer<typeof baseRowHistoryResponseSchema>;
export type BaseRowWriteResponse = z.infer<typeof baseRowWriteResponseSchema>;
export type BaseRowBatchWriteResponse = z.infer<typeof baseRowBatchWriteResponseSchema>;
export type BasePropertyMigrationReport = z.infer<typeof basePropertyMigrationReportSchema>;
export type BasePropertyMutationResponse = z.infer<typeof basePropertyMutationResponseSchema>;
export type BaseSubscription = z.infer<typeof baseSubscriptionSchema>;
export type BaseChartDataResponse = z.infer<typeof baseChartDataResponseSchema>;
export type BaseRowPurgeResponse = z.infer<typeof baseRowPurgeResponseSchema>;

/** Error `details` on the CLI envelope (`{ error: { code, message, requestId, details } }`). */
export interface BaseApiErrorDetails {
  error?: string;
  reason?: string;
  fieldErrors?: Record<string, string>;
  current?: BaseRow;
  schemaVersion?: number;
}

/** True when a view object is the full manager shape (columns are keys). */
export function isFullBaseView(view: BaseAnyView): view is BaseView {
  return "access" in view && "query" in view;
}
