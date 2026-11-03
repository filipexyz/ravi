// Zod schemas for Bases request bodies. Structural validation only: the server
// still resolves keys against the base schema, checks operator/type
// compatibility, and enforces access. See `.ravi/specs/console/bases/SPEC.md`.

import { z } from "zod";

import { MAX_WIDGET_FIELDS, WIDGET_FIELD_KEY_PATTERN } from "@/shared/widgets/template/manifest";
import { WIDGET_VARIANTS } from "@/shared/widgets/types";

import {
  BASE_DURATION_PATTERN,
  BASE_IDEMPOTENCY_KEY_PATTERN,
  BASE_PROPERTY_KEY_PATTERN,
  BASES_LIMITS,
} from "./limits";
import {
  BASE_AGENT_OUTPUT_TYPES,
  BASE_AGGREGATE_OPS,
  BASE_CHART_MARKS,
  BASE_OPTION_COLORS,
  BASE_PROPERTY_TYPES,
  BASE_STATUS_GROUPS,
  BASE_SUBSCRIPTION_EVENTS,
  BASE_TIME_UNITS,
  BASE_WITHIN_KEYWORDS,
  type BaseFilter,
} from "./types";

const nameSchema = z.string().trim().min(1).max(BASES_LIMITS.nameChars);
const descriptionSchema = z.string().trim().max(BASES_LIMITS.descriptionChars).nullable();
const columnRefSchema = z.string().trim().min(1).max(64);

export const basePropertyKeySchema = z
  .string()
  .regex(BASE_PROPERTY_KEY_PATTERN, "Use lowercase letters, digits, and underscores, starting with a letter.");

export const baseIdempotencyKeySchema = z
  .string()
  .regex(BASE_IDEMPOTENCY_KEY_PATTERN, "Idempotency keys are 8-128 characters of letters, digits, '.', '_', ':', '-'.");

export const baseDurationSchema = z.string().regex(BASE_DURATION_PATTERN, "Use Nd, Nw, Nmo, or Ny.");

// ---------------------------------------------------------------------------
// Query AST

/**
 * Request schemas accept any `filter` value. The server compiler checks its
 * structure on every surface that takes a filter, so an unknown operator or a
 * malformed node is `invalid_filter` naming the operator or the node key,
 * never a generic `payload_invalid` ("Invalid input").
 */
export const baseFilterSchema = z.custom<BaseFilter>(() => true);

export const baseSortSchema = z
  .object({ prop: columnRefSchema, dir: z.enum(["asc", "desc"]).default("asc") })
  .strict();

export const baseWithinValueSchema = z.union([
  z.enum(BASE_WITHIN_KEYWORDS),
  z.object({ past: baseDurationSchema }).strict(),
  z.object({ next: baseDurationSchema }).strict(),
]);

export const baseQueryRequestSchema = z
  .object({
    filter: baseFilterSchema.nullable().optional(),
    sort: z.array(baseSortSchema).max(BASES_LIMITS.sortKeys).optional(),
    limit: z.number().int().min(1).max(BASES_LIMITS.queryLimitMax).optional(),
    cursor: z.string().min(1).max(4096).nullable().optional(),
    includeBody: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    search: z.string().trim().min(1).max(BASES_LIMITS.searchChars).optional(),
    /** View query only; managers on the console and cli surfaces. */
    asUserId: z.string().uuid().optional(),
  })
  .strict();

export const baseAggregateRequestSchema = z
  .object({
    filter: baseFilterSchema.nullable().optional(),
    groupBy: z
      .array(z.object({ prop: columnRefSchema, timeUnit: z.enum(BASE_TIME_UNITS).optional() }).strict())
      .max(BASES_LIMITS.groupByDimensions)
      .optional(),
    aggregate: z
      .array(
        z
          .object({
            op: z.enum(BASE_AGGREGATE_OPS),
            prop: columnRefSchema.optional(),
            as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/),
          })
          .strict(),
      )
      .min(1)
      .max(BASES_LIMITS.aggregateMeasures),
  })
  .strict();

/** Count leaves and depth. Returns an error message or null. */
export function baseFilterShapeError(filter: BaseFilter | null | undefined): string | null {
  if (!filter) return null;
  let leaves = 0;
  let maxDepth = 0;
  const walk = (node: BaseFilter, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    if ("and" in node) node.and.forEach((child) => walk(child, depth + 1));
    else if ("or" in node) node.or.forEach((child) => walk(child, depth + 1));
    else if ("not" in node) walk(node.not, depth + 1);
    else leaves += 1;
  };
  walk(filter, 1);
  if (maxDepth > BASES_LIMITS.filterDepth) return `Filters may nest at most ${BASES_LIMITS.filterDepth} levels.`;
  if (leaves > BASES_LIMITS.filterLeaves) return `Filters may have at most ${BASES_LIMITS.filterLeaves} conditions.`;
  return null;
}

// ---------------------------------------------------------------------------
// Properties

export const baseSelectOptionInputSchema = z
  .object({
    /** Omit to reuse the existing option with the same name (archived ones come back), or create one. */
    id: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(100),
    color: z.enum(BASE_OPTION_COLORS).optional(),
    group: z.enum(BASE_STATUS_GROUPS).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

const projectRoleSchema = z.enum(["viewer", "developer", "project_admin"]);

export const baseApprovalPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project_role"), minRole: projectRoleSchema }).strict(),
  z.object({ kind: z.literal("user"), userId: z.string().uuid() }).strict(),
]);

export const basePropertyConfigInputSchema = z
  .object({
    options: z.array(baseSelectOptionInputSchema).max(BASES_LIMITS.optionsPerProperty).optional(),
    format: z.enum(["plain", "percent", "currency"]).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    precision: z.number().int().min(0).max(8).optional(),
    includeTime: z.boolean().optional(),
    /** approval */
    approvers: z.array(baseApprovalPrincipalSchema).min(1).max(BASES_LIMITS.approversPerProperty).optional(),
    resetOn: z.array(columnRefSchema).max(BASES_LIMITS.propertiesPerBase).optional(),
    /** agent */
    instructions: z.string().trim().min(1).max(BASES_LIMITS.agentInstructionsChars).optional(),
    inputs: z.array(columnRefSchema).min(1).max(BASES_LIMITS.agentInputs).optional(),
    output: z.enum(BASE_AGENT_OUTPUT_TYPES).optional(),
    agent: z.string().trim().max(BASES_LIMITS.agentLabelChars).nullable().optional(),
  })
  .strict();

export const basePropertyDefinitionSchema = z
  .object({
    key: basePropertyKeySchema.optional(),
    name: nameSchema,
    type: z.enum(BASE_PROPERTY_TYPES),
    description: descriptionSchema.optional(),
    config: basePropertyConfigInputSchema.optional(),
    required: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const baseCreatePropertySchema = basePropertyDefinitionSchema
  .extend({ expectedSchemaVersion: z.number().int().min(1), idempotencyKey: baseIdempotencyKeySchema.optional() })
  .strict();

export const baseUpdatePropertySchema = z
  .object({
    expectedSchemaVersion: z.number().int().min(1),
    key: basePropertyKeySchema.optional(),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    type: z.enum(BASE_PROPERTY_TYPES).optional(),
    config: basePropertyConfigInputSchema.optional(),
    required: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    /** Required to run a type or includeTime migration. Without it the call is a dry-run. */
    confirm: z.boolean().optional(),
  })
  .strict();

export const baseDeletePropertySchema = z
  .object({
    expectedSchemaVersion: z.number().int().min(1),
    confirm: z.boolean().optional(),
  })
  .strict();

export const baseRestorePropertySchema = z.object({ expectedSchemaVersion: z.number().int().min(1) }).strict();

// ---------------------------------------------------------------------------
// Bases

export const baseCreateSchema = z
  .object({
    slug: z.string().trim().min(1).max(63).optional(),
    name: nameSchema,
    description: descriptionSchema.optional(),
    icon: z.string().trim().max(32).nullable().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    /** Initial schema. Keys default to a slug of the name. */
    properties: z.array(basePropertyDefinitionSchema).max(BASES_LIMITS.propertiesPerBase).optional(),
    idempotencyKey: baseIdempotencyKeySchema.optional(),
  })
  .strict();

export const baseUpdateSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    slug: z.string().trim().min(1).max(63).optional(),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    icon: z.string().trim().max(32).nullable().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const baseLifecycleSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();

// ---------------------------------------------------------------------------
// Rows

const rowValuesSchema = z.record(z.string().min(1).max(64), z.unknown());

export const baseRowInputSchema = z
  .object({
    values: rowValuesSchema.default({}),
    body: z.string().nullable().optional(),
  })
  .strict();

export const baseCreateRowsSchema = z.union([
  baseRowInputSchema
    .extend({ idempotencyKey: baseIdempotencyKeySchema.optional(), clientHint: z.record(z.string(), z.unknown()).optional() })
    .strict(),
  z
    .object({
      rows: z.array(baseRowInputSchema).min(1).max(BASES_LIMITS.batchRows),
      idempotencyKey: baseIdempotencyKeySchema.optional(),
      clientHint: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);

export const baseUpdateRowSchema = z
  .object({
    values: rowValuesSchema.optional(),
    body: z.string().nullable().optional(),
    expectedVersion: z.number().int().min(1).optional(),
    lastWriteWins: z.boolean().optional(),
    idempotencyKey: baseIdempotencyKeySchema.optional(),
    clientHint: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const baseRowLifecycleSchema = z
  .object({
    expectedVersion: z.number().int().min(1).optional(),
    lastWriteWins: z.boolean().optional(),
    clientHint: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const baseRowPurgeSchema = z.object({ confirm: z.literal(true) }).strict();

/** `POST .../rows/<row>/agent/<prop>`: exactly one of `value` or `error`. */
export const baseAgentFillSchema = z
  .object({
    inputsHash: z.string().regex(/^[0-9a-f]{16}$/, "inputsHash is 16 lowercase hex characters."),
    value: z.unknown().optional(),
    error: z.string().trim().min(1).max(BASES_LIMITS.agentErrorChars).optional(),
    idempotencyKey: baseIdempotencyKeySchema.optional(),
  })
  .strict()
  .refine((body) => (body.value !== undefined) !== (body.error !== undefined), {
    message: "Send value or error, not both.",
    path: ["value"],
  });

export const baseAgentRerunSchema = z.object({ idempotencyKey: baseIdempotencyKeySchema.optional() }).strict();

// ---------------------------------------------------------------------------
// Subscriptions

export const baseSubscriptionCreateSchema = z
  .object({
    viewId: z.string().uuid().optional(),
    properties: z.array(columnRefSchema).min(1).max(BASES_LIMITS.subscriptionProperties).optional(),
    events: z.array(z.enum(BASE_SUBSCRIPTION_EVENTS)).max(BASE_SUBSCRIPTION_EVENTS.length).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Views

const principalModeSchema = z.enum(["rows", "aggregate"]);

export const baseViewPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project_role"), minRole: projectRoleSchema, mode: principalModeSchema.optional() }).strict(),
  z.object({ kind: z.literal("user"), userId: z.string().uuid(), mode: principalModeSchema.optional() }).strict(),
  z.object({ kind: z.literal("page_viewer"), siteId: z.string().uuid(), mode: principalModeSchema.optional() }).strict(),
]);

export const baseViewWritePrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project_role"), minRole: projectRoleSchema }).strict(),
  z.object({ kind: z.literal("user"), userId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("page_viewer"), siteId: z.string().uuid() }).strict(),
]);

export const baseViewAccessSchema = z
  .object({
    read: z.array(baseViewPrincipalSchema).max(50).default([]),
    write: z
      .object({
        principals: z.array(baseViewWritePrincipalSchema).max(50).default([]),
        columns: z.array(columnRefSchema).max(BASES_LIMITS.viewColumns).default([]),
        create: z.boolean().default(false),
        archive: z.boolean().default(false),
        set: z.record(columnRefSchema, z.unknown()).default({}),
        allowEscape: z.boolean().default(false),
      })
      .strict()
      .default({ principals: [], columns: [], create: false, archive: false, set: {}, allowEscape: false }),
  })
  .strict();

/**
 * `layout.widget` on board, list, gallery, and calendar: a Library widget by
 * `itemId` or `ref` (one required), widget field key -> column, and variant.
 * `null` removes it. The item and the mapping are checked when the view is saved.
 */
export const baseViewLayoutWidgetSchema = z
  .object({
    itemId: z.string().uuid().optional(),
    /** Responses carry `ref: null` for a deleted item; null counts as absent. */
    ref: z.string().trim().min(1).max(200).nullable().optional(),
    fields: z
      .record(z.string().regex(WIDGET_FIELD_KEY_PATTERN, "Widget field keys are lowercase letters, digits, and underscores."), columnRefSchema)
      .refine((fields) => Object.keys(fields).length <= MAX_WIDGET_FIELDS, { message: `A widget has at most ${MAX_WIDGET_FIELDS} fields.` })
      .optional(),
    variant: z.enum(WIDGET_VARIANTS).optional(),
  })
  .strict()
  .refine((widget) => widget.itemId !== undefined || (widget.ref !== undefined && widget.ref !== null), {
    message: "Name the widget with itemId or ref.",
    path: ["itemId"],
  });

const layoutWidgetField = baseViewLayoutWidgetSchema.nullable().optional();

export const baseViewLayoutSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("table"),
      columnWidths: z.record(columnRefSchema, z.number().int().min(40).max(1200)).optional(),
      wrap: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("board"), groupBy: columnRefSchema, hideEmptyGroups: z.boolean().optional(), widget: layoutWidgetField })
    .strict(),
  z.object({ type: z.literal("list"), widget: layoutWidgetField }).strict(),
  z
    .object({
      type: z.literal("gallery"),
      coverProp: columnRefSchema.nullable().optional(),
      cardSize: z.enum(["small", "medium", "large"]).optional(),
      widget: layoutWidgetField,
    })
    .strict(),
  z.object({ type: z.literal("calendar"), dateProp: columnRefSchema, widget: layoutWidgetField }).strict(),
  z
    .object({
      type: z.literal("form"),
      title: z.string().trim().max(200).optional(),
      description: z.string().trim().max(2000).optional(),
      submitLabel: z.string().trim().max(60).optional(),
      successMessage: z.string().trim().max(500).optional(),
    })
    .strict(),
  z.object({ type: z.literal("chart"), chartId: z.string().uuid() }).strict(),
]);

export const baseViewQuerySchema = z
  .object({
    filter: baseFilterSchema.nullable().default(null),
    sort: z.array(baseSortSchema).max(BASES_LIMITS.sortKeys).default([]),
  })
  .strict();

export const baseCreateViewSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    /** Defaults to every active property. */
    columns: z.array(columnRefSchema).min(1).max(BASES_LIMITS.viewColumns).optional(),
    query: baseViewQuerySchema.optional(),
    layout: baseViewLayoutSchema.optional(),
    access: baseViewAccessSchema.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    idempotencyKey: baseIdempotencyKeySchema.optional(),
  })
  .strict();

export const baseUpdateViewSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    columns: z.array(columnRefSchema).min(1).max(BASES_LIMITS.viewColumns).optional(),
    query: baseViewQuerySchema.optional(),
    layout: baseViewLayoutSchema.optional(),
    access: baseViewAccessSchema.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Charts

const chartFieldDefSchema = z
  .object({
    field: columnRefSchema.optional(),
    type: z.enum(["nominal", "ordinal", "quantitative", "temporal"]),
    aggregate: z.enum(BASE_AGGREGATE_OPS).optional(),
    timeUnit: z.enum(BASE_TIME_UNITS).optional(),
    title: z.string().trim().max(120).optional(),
    sort: z.enum(["ascending", "descending", "x", "-x", "y", "-y"]).optional(),
    stack: z.enum(["zero", "normalize"]).nullable().optional(),
  })
  .strict();

export const baseChartSpecSchema = z
  .object({
    mark: z.union([
      z.enum(BASE_CHART_MARKS),
      z
        .object({
          type: z.enum(BASE_CHART_MARKS),
          innerRadius: z.number().min(0).max(400).optional(),
          point: z.boolean().optional(),
        })
        .strict(),
    ]),
    encoding: z
      .object({
        x: chartFieldDefSchema.optional(),
        y: chartFieldDefSchema.optional(),
        color: chartFieldDefSchema.optional(),
        theta: chartFieldDefSchema.optional(),
        text: chartFieldDefSchema.optional(),
      })
      .strict(),
    title: z.string().trim().max(200).optional(),
  })
  .strict();

export const baseCreateChartSchema = z
  .object({
    viewId: z.string().uuid(),
    name: nameSchema,
    description: descriptionSchema.optional(),
    spec: baseChartSpecSchema,
    position: z.number().int().min(0).max(10_000).optional(),
    idempotencyKey: baseIdempotencyKeySchema.optional(),
  })
  .strict();

export const baseUpdateChartSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    viewId: z.string().uuid().optional(),
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    spec: baseChartSpecSchema.optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const baseVersionedLifecycleSchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();

// ---------------------------------------------------------------------------
// Inferred input types

export type BaseQueryRequestInput = z.input<typeof baseQueryRequestSchema>;
export type BaseAggregateRequestInput = z.input<typeof baseAggregateRequestSchema>;
export type BasePropertyDefinitionInput = z.input<typeof basePropertyDefinitionSchema>;
export type BaseCreatePropertyInput = z.input<typeof baseCreatePropertySchema>;
export type BaseUpdatePropertyInput = z.input<typeof baseUpdatePropertySchema>;
export type BaseCreateInput = z.input<typeof baseCreateSchema>;
export type BaseUpdateInput = z.input<typeof baseUpdateSchema>;
export type BaseCreateRowsInput = z.input<typeof baseCreateRowsSchema>;
export type BaseUpdateRowInput = z.input<typeof baseUpdateRowSchema>;
export type BaseRowLifecycleInput = z.input<typeof baseRowLifecycleSchema>;
export type BaseCreateViewInput = z.input<typeof baseCreateViewSchema>;
export type BaseUpdateViewInput = z.input<typeof baseUpdateViewSchema>;
export type BaseCreateChartInput = z.input<typeof baseCreateChartSchema>;
export type BaseUpdateChartInput = z.input<typeof baseUpdateChartSchema>;
export type BaseAgentFillRequestInput = z.input<typeof baseAgentFillSchema>;
