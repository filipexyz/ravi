// Shared Bases contract: DTOs exchanged by the Console API, the Console UI,
// the CLI bridge, and Ravi Pages connector actions. See
// `.ravi/specs/console/bases/SPEC.md`.
//
// API objects always address properties by `key`. Stored specs use property
// ids; the server translates in both directions.

import type { WidgetVariant } from "@/shared/widgets/types";

export const BASE_PROPERTY_TYPES = [
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi_select",
  "status",
  "url",
  "email",
  "phone",
  "person",
  "ref",
  "approval",
  "agent",
] as const;
export type BasePropertyType = (typeof BASE_PROPERTY_TYPES)[number];

export const BASE_SYSTEM_COLUMNS = ["created_time", "created_by", "updated_time", "updated_by"] as const;
export type BaseSystemColumn = (typeof BASE_SYSTEM_COLUMNS)[number];

/** Pseudo-column for the markdown row body. Projectable, never filterable or sortable. */
export const BASE_BODY_COLUMN = "body";

export const BASE_RESERVED_KEYS = [
  "row_id",
  "version",
  "created_time",
  "created_by",
  "updated_time",
  "updated_by",
  "archived_at",
  "body",
  "id",
] as const;

export const BASE_OPTION_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
export type BaseOptionColor = (typeof BASE_OPTION_COLORS)[number];

export const BASE_STATUS_GROUPS = ["todo", "in_progress", "done"] as const;
export type BaseStatusGroup = (typeof BASE_STATUS_GROUPS)[number];

export type BaseSelectOption = {
  id: string;
  name: string;
  color: BaseOptionColor;
  /** Only on `status` properties. */
  group?: BaseStatusGroup;
  archived?: boolean;
};

export type BaseNumberFormat = "plain" | "percent" | "currency";

export type BaseProjectRole = "viewer" | "developer" | "project_admin";

export const BASE_APPROVAL_STATES = ["pending", "approved", "rejected"] as const;
export type BaseApprovalState = (typeof BASE_APPROVAL_STATES)[number];

/** Who may decide an approval: a user, or anyone whose effective project role is at least `minRole`. */
export type BaseApprovalPrincipal =
  | { kind: "project_role"; minRole: BaseProjectRole }
  | { kind: "user"; userId: string };

/** API value of an `approval` cell. The server fills `*By`/`*At`; clients send only the state and note. */
export type BaseApprovalValue = {
  state: BaseApprovalState;
  requestedBy: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
};

/** Input of an `approval` cell: `"pending"`, `{ state, note? }`, or null to clear. */
export type BaseApprovalInput = "pending" | { state: BaseApprovalState; note?: string | null } | null;

export const BASE_AGENT_STATES = ["pending", "done", "error"] as const;
export type BaseAgentState = (typeof BASE_AGENT_STATES)[number];

export const BASE_AGENT_OUTPUT_TYPES = ["text", "number", "checkbox", "select", "multi_select", "url", "date"] as const;
export type BaseAgentOutputType = (typeof BASE_AGENT_OUTPUT_TYPES)[number];

/** API value of an `agent` cell. `value` is shaped like a value of the `output` type. Never writable through rows or views. */
export type BaseAgentValue = {
  state: BaseAgentState;
  value: string | number | boolean | string[] | BaseDateValue | null;
  error: string | null;
  inputsHash: string;
  updatedAt: string;
};

export type BasePropertyConfig = {
  /** select, multi_select, status. */
  options?: BaseSelectOption[];
  /** number. Display only. */
  format?: BaseNumberFormat;
  /** number with `format: "currency"`, ISO 4217 code. */
  currency?: string;
  /** number. Display decimals, 0..8. */
  precision?: number;
  /** date. When true, values are UTC instants; otherwise `YYYY-MM-DD`. */
  includeTime?: boolean;
  /** approval. 1..20 principals who may decide. */
  approvers?: BaseApprovalPrincipal[];
  /** approval. Property keys (ids in storage) whose change sends a decided approval back to `pending`. */
  resetOn?: string[];
  /** agent. What the agent should produce, 1..4000 chars. */
  instructions?: string;
  /** agent. Property keys (ids in storage) the agent reads, 1..20; never agent or approval properties. */
  inputs?: string[];
  /** agent. Type of the filled value. Options live in `options` for select and multi_select. */
  output?: BaseAgentOutputType;
  /** agent. OSS agent id expected to fill the column (a label, <= 64 chars). */
  agent?: string | null;
};

export type BaseProperty = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: BasePropertyType;
  config: BasePropertyConfig;
  position: number;
  required: boolean;
  /** ISO timestamp when soft-deleted. Only managers see deleted properties. */
  deletedAt: string | null;
};

export type BaseActorType = "user" | "agent" | "api_key" | "cli" | "system" | "anonymous";
export type BaseSurface = "console" | "cli" | "page" | "system";

export type BaseCapabilities = {
  /** Create and change bases, properties, views, charts, access, subscriptions. */
  manage: boolean;
  /** Read all rows and columns without a view. */
  readDirect: boolean;
  /** Write rows without a view. */
  writeDirect: boolean;
};

export type BaseStatus = "active" | "archived";

export type BaseSummary = {
  id: string;
  organizationId: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  timezone: string;
  schemaVersion: number;
  version: number;
  status: BaseStatus;
  /** Active rows. Managers only; null for view-only callers. */
  rowCount: number | null;
  createdAt: string;
  updatedAt: string;
  capabilities: BaseCapabilities;
};

/**
 * `GET .../bases/<base>`.
 * Managers receive full properties, views, and charts.
 * View-only callers receive `properties: []`, `charts` limited to charts on
 * admitted views, and `views` as public shapes (`BaseViewPublic`).
 */
export type BaseDetail = BaseSummary & {
  properties: BaseProperty[];
  views: Array<BaseView | BaseViewPublic>;
  charts: Array<BaseChart | BaseChartPublic>;
  /** Active organization members for person pickers. Managers only; empty otherwise. */
  members: BaseUserRef[];
};

// ---------------------------------------------------------------------------
// Values

export type BaseDateValue = { start: string; end: string | null };
export type BaseRefValue = { type: string; id: string };

/**
 * Value of one cell as returned by the API. Empty cells are omitted from
 * `values`; `checkbox` is always present (false when empty).
 *
 * - text, url, email, phone: string
 * - number: number
 * - checkbox: boolean
 * - date: BaseDateValue
 * - select, status: option id
 * - multi_select: option ids
 * - person: user ids
 * - ref: BaseRefValue[]
 * - approval: BaseApprovalValue
 * - agent: BaseAgentValue
 * - created_time, updated_time: ISO instant
 * - created_by, updated_by: user id, or null for system writes
 */
export type BaseCellValue =
  | string
  | number
  | boolean
  | string[]
  | BaseDateValue
  | BaseRefValue[]
  | BaseApprovalValue
  | BaseAgentValue
  | null;

export type BaseRow = {
  rowId: string;
  version: number;
  /** Keyed by property key or system column name; only projected columns. */
  values: Record<string, BaseCellValue>;
  /** Present when the body is projected and requested (get-by-id always). */
  body?: string | null;
  /** Present only for direct readers with `includeArchived`. */
  archivedAt?: string | null;
};

export type BaseUserRef = {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
};

// ---------------------------------------------------------------------------
// Query AST

export const BASE_FILTER_OPS = [
  "eq",
  "neq",
  "contains",
  "not_contains",
  "starts_with",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "within",
  "in",
  "nin",
  "contains_any",
  "contains_all",
  "is_empty",
  "is_not_empty",
  "state_in",
] as const;
export type BaseFilterOp = (typeof BASE_FILTER_OPS)[number];

export type BaseFilterLeaf = {
  /** Property key, property id, or system column name. */
  prop: string;
  op: BaseFilterOp;
  value?: unknown;
};

export type BaseFilter =
  | BaseFilterLeaf
  | { and: BaseFilter[] }
  | { or: BaseFilter[] }
  | { not: BaseFilter };

export type BaseSortDirection = "asc" | "desc";
export type BaseSort = { prop: string; dir: BaseSortDirection };

export const BASE_VIEWER_VARIABLES = [
  "$viewer.raviUserId",
  "$viewer.raviOrgId",
  "$viewer.email",
  "$now",
  "$today",
] as const;
export type BaseViewerVariable = (typeof BASE_VIEWER_VARIABLES)[number];

export const BASE_WITHIN_KEYWORDS = ["today", "this_week", "this_month", "this_year"] as const;
export type BaseWithinValue =
  | (typeof BASE_WITHIN_KEYWORDS)[number]
  | { past: string }
  | { next: string };

/** Body of `POST .../rows/query` and `POST .../views/<view>/query`. */
export type BaseQueryRequest = {
  filter?: BaseFilter | null;
  sort?: BaseSort[];
  /** 1..500, default 100. */
  limit?: number;
  cursor?: string | null;
  /** Include `body` when it is readable. Default false. */
  includeBody?: boolean;
  /** Direct reads only. */
  includeArchived?: boolean;
  /** 1..200 chars, trimmed: case-insensitive contains over the readable text-like columns, ANDed with the filter. */
  search?: string;
  /** View query only, managers on console and cli: evaluate the view as this organization member. */
  asUserId?: string;
};

/** Present when a manager evaluated a view as another member (`asUserId`). */
export type BaseViewingAs = { userId: string; admitted: boolean };

export type BaseQueryResponse = {
  /** Keys of the returned columns, in display order. */
  columns: string[];
  rows: BaseRow[];
  nextCursor: string | null;
  /** Users referenced by person, approval, created_by, and updated_by values. */
  users: Record<string, BaseUserRef>;
  viewingAs?: BaseViewingAs;
};

/** `POST .../views/<view>/version` and `ravi.bases.views.version`. Changes whenever a row the caller sees through the view changes. */
export type BaseViewVersionResponse = { fingerprint: string };

export const BASE_TIME_UNITS = ["day", "week", "month", "quarter", "year"] as const;
export type BaseTimeUnit = (typeof BASE_TIME_UNITS)[number];

export const BASE_AGGREGATE_OPS = ["count", "count_values", "sum", "avg", "min", "max"] as const;
export type BaseAggregateOp = (typeof BASE_AGGREGATE_OPS)[number];

export type BaseAggregateRequest = {
  filter?: BaseFilter | null;
  groupBy?: Array<{ prop: string; timeUnit?: BaseTimeUnit }>;
  aggregate: Array<{ op: BaseAggregateOp; prop?: string; as: string }>;
};

export type BaseAggregateGroup = {
  /** One entry per groupBy dimension, keyed by the dimension's prop key. Null is the empty group. Time buckets are ISO dates (`YYYY-MM-DD`) of the bucket start. */
  keys: Record<string, string | number | boolean | null>;
  /** Keyed by aggregate `as`. */
  values: Record<string, number | string | null>;
};

export type BaseAggregateResponse = {
  groups: BaseAggregateGroup[];
  /** Groups hidden because they had fewer than 5 rows (aggregate-mode callers). */
  suppressedGroups: number;
  users: Record<string, BaseUserRef>;
};

// ---------------------------------------------------------------------------
// Views

export const BASE_VIEW_LAYOUT_TYPES = ["table", "board", "list", "gallery", "calendar", "form", "chart"] as const;
export type BaseViewLayoutType = (typeof BASE_VIEW_LAYOUT_TYPES)[number];

/**
 * `layout.widget` as returned: the Library widget that draws each record on
 * board, list, gallery, and calendar layouts. `ref` is the item's current
 * `org/<slug>` or `<project-slug>/<slug>` (null when the item no longer
 * exists). `fields` maps widget field keys to projected column keys.
 */
export type BaseViewLayoutWidget = {
  itemId: string;
  ref: string | null;
  fields: Record<string, string>;
  variant: WidgetVariant;
};

/**
 * `layout.widget` as sent: `itemId` or `ref` (one required; when both are
 * sent they must name the same item; `ref: null` counts as absent, so a
 * response can be sent back). A bare slug `ref` resolves in the base's
 * project view: the project's widgets, then the organization's.
 */
export type BaseViewLayoutWidgetInput = {
  itemId?: string;
  ref?: string | null;
  fields?: Record<string, string>;
  variant?: WidgetVariant;
};

/** Layout union over the widget shape: response (`BaseViewLayout`), request (`BaseViewLayoutInput`), or storage. */
export type BaseViewLayoutWith<W> =
  | { type: "table"; columnWidths?: Record<string, number>; wrap?: boolean }
  | { type: "board"; groupBy: string; hideEmptyGroups?: boolean; widget?: W | null }
  | { type: "list"; widget?: W | null }
  | { type: "gallery"; coverProp?: string | null; cardSize?: "small" | "medium" | "large"; widget?: W | null }
  | { type: "calendar"; dateProp: string; widget?: W | null }
  | { type: "form"; title?: string; description?: string; submitLabel?: string; successMessage?: string }
  | { type: "chart"; chartId: string };

/** Layout properties name columns by key; each MUST be a projected column. */
export type BaseViewLayout = BaseViewLayoutWith<BaseViewLayoutWidget>;

/** Layout in a view create or update body. */
export type BaseViewLayoutInput = BaseViewLayoutWith<BaseViewLayoutWidgetInput>;

export type BasePrincipalMode = "rows" | "aggregate";

export type BaseViewPrincipal =
  | { kind: "project_role"; minRole: BaseProjectRole; mode?: BasePrincipalMode }
  | { kind: "user"; userId: string; mode?: BasePrincipalMode }
  | { kind: "page_viewer"; siteId: string; mode?: BasePrincipalMode };

/** Write principals never carry `mode`. */
export type BaseViewWritePrincipal =
  | { kind: "project_role"; minRole: BaseProjectRole }
  | { kind: "user"; userId: string }
  | { kind: "page_viewer"; siteId: string };

export type BaseViewAccess = {
  read: BaseViewPrincipal[];
  write: {
    principals: BaseViewWritePrincipal[];
    /** Keys the admitted writers may change. Subset of `view.columns`. */
    columns: string[];
    create: boolean;
    archive: boolean;
    /** Values applied on create; literals or `$viewer.raviUserId`, `$viewer.email`, `$now`, `$today`. */
    set: Record<string, unknown>;
    allowEscape: boolean;
  };
};

export type BaseViewQuery = {
  filter: BaseFilter | null;
  sort: BaseSort[];
};

export type BaseViewStatus = "active" | "archived";

/** Full view, returned only to managers. */
export type BaseView = {
  id: string;
  baseId: string;
  name: string;
  description: string | null;
  /** Property keys, system column names, or `body`. */
  columns: string[];
  query: BaseViewQuery;
  layout: BaseViewLayout;
  access: BaseViewAccess;
  position: number;
  version: number;
  status: BaseViewStatus;
  /** False when the view references a deleted or incompatible property. */
  valid: boolean;
  invalidReason: string | null;
  createdAt: string;
  updatedAt: string;
  capabilities: BaseViewCapabilities;
};

export type BaseViewColumn = {
  key: string;
  name: string;
  /** Property type, a system column name, or `body`. */
  type: BasePropertyType | BaseSystemColumn | "body";
  config: BasePropertyConfig;
  required: boolean;
};

export type BaseViewCapabilities = {
  /** May read rows through the view. */
  read: boolean;
  /** May only read chart data on this view. */
  aggregateOnly: boolean;
  /** Keys the caller may change through the view. */
  writeColumns: string[];
  create: boolean;
  archive: boolean;
  /** Caller has `base.manage`. */
  manage: boolean;
  /** Approval column keys in `writeColumns` the caller may decide (approve or reject). */
  approve: string[];
};

/** Public shape of a view, returned to callers without `base.manage`. */
export type BaseViewPublic = {
  id: string;
  baseId: string;
  name: string;
  description: string | null;
  layout: BaseViewLayout;
  version: number;
  columns: BaseViewColumn[];
  capabilities: BaseViewCapabilities;
  valid: boolean;
};

/** `GET .../views/<view>` and `ravi.bases.views.describe`: always includes the column descriptors. Managers also get `view`. */
export type BaseViewDescribeResponse = BaseViewPublic & {
  view?: BaseView;
};

// ---------------------------------------------------------------------------
// Charts (Vega-Lite subset)

export const BASE_CHART_MARKS = ["bar", "line", "area", "point", "arc", "rect", "text"] as const;
export type BaseChartMarkType = (typeof BASE_CHART_MARKS)[number];

export type BaseChartFieldType = "nominal" | "ordinal" | "quantitative" | "temporal";

export type BaseChartFieldDef = {
  /** Column key of the chart's view. Omitted only with `aggregate: "count"`. */
  field?: string;
  type: BaseChartFieldType;
  aggregate?: BaseAggregateOp;
  timeUnit?: BaseTimeUnit;
  title?: string;
  sort?: "ascending" | "descending" | "x" | "-x" | "y" | "-y";
  /** y on bar and area. `null` disables stacking. */
  stack?: "zero" | "normalize" | null;
};

export type BaseChartEncoding = {
  x?: BaseChartFieldDef;
  y?: BaseChartFieldDef;
  color?: BaseChartFieldDef;
  theta?: BaseChartFieldDef;
  text?: BaseChartFieldDef;
};

export type BaseChartMark = BaseChartMarkType | { type: BaseChartMarkType; innerRadius?: number; point?: boolean };

export type BaseChartSpec = {
  mark: BaseChartMark;
  encoding: BaseChartEncoding;
  title?: string;
};

export type BaseChartStatus = "active" | "archived";

/** Full chart, managers. */
export type BaseChart = {
  id: string;
  baseId: string;
  viewId: string;
  name: string;
  description: string | null;
  spec: BaseChartSpec;
  position: number;
  version: number;
  status: BaseChartStatus;
  createdAt: string;
  updatedAt: string;
};

/** Chart as seen by callers admitted through its view. Same fields minus lifecycle metadata. */
export type BaseChartPublic = {
  id: string;
  baseId: string;
  viewId: string;
  name: string;
  description: string | null;
  spec: BaseChartSpec;
  version: number;
};

/**
 * One aggregated datum. Keys are encoding channel names (`x`, `y`, `color`,
 * `theta`, `text`). Dimension channels hold the group value (option id, user
 * id, number, boolean, ISO bucket start, or null); measure channels hold a
 * number (or an ISO string for min/max of dates).
 */
export type BaseChartDatum = Partial<Record<keyof BaseChartEncoding, string | number | boolean | null>>;

export type BaseChartDataResponse = {
  chart: BaseChartPublic;
  /** Column descriptors for the fields the chart uses (labels, options, formats). */
  fields: Record<string, BaseViewColumn>;
  data: BaseChartDatum[];
  suppressedGroups: number;
  users: Record<string, BaseUserRef>;
};

// ---------------------------------------------------------------------------
// Ledger

export type BaseLedgerAction = "created" | "updated" | "archived" | "restored" | "purged";

export type BaseLedgerEntry = {
  id: string;
  sequence: number;
  rowId: string;
  version: number;
  action: BaseLedgerAction;
  /** Keys of the changed properties visible to the caller. */
  changedKeys: string[];
  /** Before and after values of visible changed properties, keyed by key. */
  before: Record<string, BaseCellValue>;
  after: Record<string, BaseCellValue>;
  bodyChanged: boolean;
  /** Actor type, id, and surface are null through a view that does not project `updated_by` (or `created_by` for `created`). */
  actorType: BaseActorType | null;
  actorId: string | null;
  surface: BaseSurface | null;
  viewId: string | null;
  lastWriteWins: boolean;
  /** Null through a view that does not project `updated_time` (or `created_time` for `created`). */
  createdAt: string | null;
  /** Agent that made the write for the accountable actor (installation-asserted). Null where actors are hidden. `installationId` is null for view readers. */
  agent: { id: string; installationId: string | null } | null;
};

export type BaseRowHistoryResponse = {
  entries: BaseLedgerEntry[];
  nextCursor: string | null;
  users: Record<string, BaseUserRef>;
};

// ---------------------------------------------------------------------------
// Mutation results

export type BaseRowWriteResponse = {
  row: BaseRow;
  users: Record<string, BaseUserRef>;
  idempotentReplay: boolean;
  /** `GET views/<view>/rows/<row>?asUserId=`. */
  viewingAs?: BaseViewingAs;
};

/** Body of `POST .../rows/<row>/agent/<prop>`: exactly one of `value` or `error`. */
export type BaseAgentFillInput =
  | { inputsHash: string; value: unknown; error?: never; idempotencyKey?: string }
  | { inputsHash: string; error: string; value?: never; idempotencyKey?: string };

export type BaseRowBatchWriteResponse = {
  rows: BaseRow[];
  users: Record<string, BaseUserRef>;
  idempotentReplay: boolean;
};

/** Dry-run report for property type changes, includeTime changes, and deletes. */
export type BasePropertyMigrationReport = {
  dryRun: boolean;
  activeRows: number;
  /** Rows whose value converts (cleanly, or with fewer values: see `truncated`). */
  converted: number;
  /**
   * Rows, also counted in `converted`, whose value converts but keeps fewer
   * values than the source (a `multi_select` becoming a `select` keeps its
   * first option; options or parts with no match in the target are dropped).
   */
  truncated: number;
  /** Rows whose value would be cleared. */
  cleared: number;
  /** Rows without a value (for `required`). */
  missing: number;
  dependents: {
    views: Array<{ id: string; name: string }>;
    charts: Array<{ id: string; name: string }>;
  };
};

export type BasePropertyMutationResponse = {
  base: BaseSummary;
  property: BaseProperty;
  report: BasePropertyMigrationReport | null;
};

export const BASE_SUBSCRIPTION_EVENTS = [
  "row.created",
  "row.updated",
  "row.archived",
  "row.restored",
  "approval.requested",
  "approval.decided",
  "agent.requested",
  "agent.backfill",
] as const;
export type BaseSubscriptionEvent = (typeof BASE_SUBSCRIPTION_EVENTS)[number];

/** Body of `POST .../bases/<base>/subscriptions`. Empty keeps every event of the base. */
export type BaseSubscriptionCreateInput = {
  viewId?: string;
  /** Property keys or ids, 1..20. */
  properties?: string[];
  events?: BaseSubscriptionEvent[];
};

export type BaseSubscription = {
  id: string;
  baseId: string;
  localInstallationId: string;
  installationName: string | null;
  userId: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
  /** Filter: deliver only rows that pass this view's filter for the subscribing user. */
  viewId: string | null;
  /** Filter: property keys; empty means any property. */
  properties: string[];
  /** Filter: event names; empty means every event. */
  events: BaseSubscriptionEvent[];
};

// ---------------------------------------------------------------------------
// Activity

/** One `bases.*` audit event of a base, in the shape the Console activity screen reads. */
export type BaseActivityEvent = {
  id: string;
  /** Epoch milliseconds (as the project events the screen read before). */
  t: number;
  /** Audit action, e.g. `bases.view.updated`. */
  type: string;
  project: string;
  target: string;
  actor: string;
  actorMark: string;
  color: string;
  note?: string;
};

export type BaseActivityResponse = {
  events: BaseActivityEvent[];
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// Errors

export const BASE_ERROR_CODES = [
  "validation_failed",
  "payload_invalid",
  "not_found",
  "project_forbidden",
  "base_forbidden",
  "unknown_property",
  "invalid_filter",
  "view_invalid",
  "version_conflict",
  "schema_version_conflict",
  "write_escapes_view",
  "cursor_invalid",
  "aggregate_too_large",
  "migration_too_large",
  "idempotency_conflict",
  "limit_exceeded",
  "slug_taken",
  "key_taken",
  "base_archived",
  "query_timeout",
  "feature_unavailable",
  "feature_forbidden",
  "approval_forbidden",
  "agent_stale",
] as const;
export type BaseErrorCode = (typeof BASE_ERROR_CODES)[number];

/** JSON error body on the Console envelope. */
export type BaseApiErrorBody = {
  error: BaseErrorCode | string;
  reason?: string;
  fieldErrors?: Record<string, string>;
  /** `version_conflict`: the current row projected like the caller's read (ids and version only without row read). */
  current?: BaseRow;
  /** `schema_version_conflict`: the current schema version. */
  schemaVersion?: number;
  /** `agent_stale`: the current inputs hash. */
  inputsHash?: string;
};
