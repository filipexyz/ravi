import "reflect-metadata";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import {
  BASES_READ_SCOPE,
  BASES_WRITE_SCOPE,
  currentBasesClientHint,
  missingBasesScopes,
  openBasesClient,
  type BasesClientDeps,
  type BasesJsonObject,
  type RaviBasesClient,
} from "../../bases/client.js";
import {
  descriptorsFromProperties,
  descriptorsFromViewColumns,
  formatCellText,
  renderRowsTable,
  renderTable,
  rowsToCsv,
  type BasesColumnDescriptor,
} from "../../bases/format.js";
import {
  batchImportRecords,
  importBatchKey,
  importIdempotencyPrefix,
  parseColumnMap,
  planCsvImport,
  toRowInput,
  type CsvImportColumn,
} from "../../bases/import.js";
import {
  BASES_BATCH_ROWS_MAX,
  BASES_QUERY_LIMIT_MAX,
  BASES_ROWS_PER_BASE_MAX,
  buildRowValues,
  invalidInput,
  isPlainObject,
  parseAggregateOption,
  parseBooleanOption,
  parseGroupByOption,
  parseIntegerOption,
  parseOptionsShorthand,
  parseSortOption,
  readBodyInput,
  readJsonInput,
  readJsonObjectInput,
  requireConcurrencyChoice,
} from "../../bases/input.js";
import {
  baseAggregateGroupSchema,
  baseChartDataResponseSchema,
  baseChartSchema,
  baseDetailSchema,
  baseLedgerEntrySchema,
  basePropertyMigrationReportSchema,
  basePropertySchema,
  baseRowSchema,
  baseSubscriptionSchema,
  baseSummarySchema,
  basesUsersSchema,
  baseViewDescribeSchema,
  baseViewPublicSchema,
  baseViewSchema,
  isFullBaseView,
  type BaseApiErrorDetails,
  type BaseAnyView,
  type BaseChart,
  type BaseDetail,
  type BaseProperty,
  type BasePropertyMutationResponse,
  type BaseQueryResponse,
  type BaseRow,
  type BaseSubscription,
  type BaseSummary,
  type BasesUserRef,
} from "../../bases/schemas.js";
import { CloudAuthError, isCloudAuthError } from "../../cloud-auth/errors.js";
import { readCloudCredentials } from "../../cloud-auth/storage.js";
import { INBOX_NATS_SUBJECT } from "../../inbox/types.js";
import { quoteCommandToken } from "../../utils/pagination.js";
import { ContractError, contractDryRun, pickFields, sanitizePublicContractMessage } from "../agent-contract.js";
import { resolveCallerPath } from "../caller-cwd.js";
import { cloudErrorToContractError } from "../cloud-error-contract.js";
import { getContext } from "../context.js";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { projectPublicIssues, type PublicValidationIssue } from "../redaction.js";
import { strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

export interface BasesCommandDeps extends BasesClientDeps {}

const PROJECT_OPTION = {
  flags: "--project <ref>",
  description: "Console project id or slug; overrides the saved Console scope",
};
const CONSOLE_OPTION = { flags: "--console <url>", description: "Console base URL" };
const JSON_OPTION = { flags: "--json", description: "Print raw JSON result" };
const FIELDS_OPTION = { flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" };
const VIEW_OPTION = {
  flags: "--view <id>",
  description: "Read or write through this view (its columns, filter, and access apply)",
};
const IDEMPOTENCY_OPTION = {
  flags: "--idempotency-key <key>",
  description: "Idempotency key for safe retries (default: generated per call)",
};
// Agent sessions retry on their own; a generated key turns each retry into a new write.
const MISSING_IDEMPOTENCY_KEY_WARNING =
  "written without --idempotency-key: a retry would get a new generated key and could duplicate this write. " +
  "Pass --idempotency-key <stable key>, e.g. <base>:<row>:<step>, and reuse it on every retry.";
const VALUES_OPTION = {
  flags: "--values <json|@file>",
  description: "Row values as a JSON object keyed by property key, inline or @file",
};
const SET_OPTION = {
  flags: "--set <assignment...>",
  description: "Set one value: key=text or key:=<json>. Repeatable; overrides --values",
};
const BODY_OPTION = { flags: "--body <markdown>", description: "Row body (markdown)" };
const BODY_FILE_OPTION = { flags: "--body-file <path>", description: "Read the row body from a file" };
const EXPECTED_VERSION_OPTION = {
  flags: "--expected-version <n>",
  description: "Version you read; the write fails with VERSION_CONFLICT if it changed",
};
const LAST_WRITE_WINS_OPTION = {
  flags: "--last-write-wins",
  description: "Overwrite concurrent changes instead of passing --expected-version (recorded in the ledger)",
};
const FILTER_OPTION = { flags: "--filter <json|@file>", description: "Query AST filter, inline JSON or @file" };
// One comma-separated value. A placeholder ending in "..." would make the gateway
// schema expect an array while commander passes one string.
const SORT_OPTION = {
  flags: "--sort <key:dir[,key:dir]>",
  description: "Comma-separated sort keys, key[:asc|desc], e.g. amount:desc,created_time (max 3)",
};
const LIMIT_OPTION = { flags: "--limit <n>", description: "Rows per page, 1-500 (default 100)" };
const CURSOR_OPTION = { flags: "--cursor <cursor>", description: "Opaque cursor from a previous page" };
const ALL_OPTION = { flags: "--all", description: "Follow cursors until the end or --max-rows" };
const MAX_ROWS_OPTION = {
  flags: "--max-rows <n>",
  description: "Stop following cursors after this many rows (default 10000, max 100000)",
};
const INCLUDE_BODY_OPTION = { flags: "--include-body", description: "Include the row body when readable" };
const FORMAT_OPTION = { flags: "--format <format>", description: "Human output: table|csv|json (default table)" };
const EXPECTED_SCHEMA_VERSION_OPTION = {
  flags: "--expected-schema-version <n>",
  description: "Schema version you read (default: read the current one first)",
};
const LIST_LIMIT_OPTION = { flags: "--limit <n>", description: "Maximum items to return (default: 50)" };
const LIST_OFFSET_OPTION = { flags: "--offset <n>", description: "Number of items to skip (default: 0)" };

const DEFAULT_QUERY_LIMIT = 100;
const DEFAULT_ALL_MAX_ROWS = 10_000;
const HISTORY_LIMIT_MAX = 200;

// ---------------------------------------------------------------------------
// ravi bases

@Group({ name: "bases", description: "Typed project databases (Bases) in Ravi Console", scope: "open" })
export class BasesCommands {
  constructor(private readonly deps: BasesCommandDeps = {}) {}

  @Command({ name: "list", description: "List the bases of a Console project" })
  @CommandAccess({ kind: "read", resource: "bases", action: "list", risk: "low" })
  async list(
    @Option({ flags: "--include-archived", description: "Include archived bases (managers)" })
    includeArchived?: boolean,
    @Option(LIST_LIMIT_OPTION) limit?: string,
    @Option(LIST_OFFSET_OPTION) offset?: string,
    @Option(FIELDS_OPTION) fields?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases list", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const { bases } = await client.listBases({ includeArchived: includeArchived === true });
      const page = paginateCliItems(bases, { limit, offset });
      const items = pickFields(page.items, fields) as Partial<BaseSummary>[];
      const payload = {
        ...scope(client),
        total: page.total,
        pagination: buildCliOffsetPagination({
          baseCommand: ["ravi", "bases", "list"],
          fields,
          limit: page.limit,
          offset: page.offset,
          returned: page.items.length,
          total: page.total,
          options: [
            includeArchived ? "--include-archived" : null,
            "--project",
            client.projectRef,
            consoleUrl ? "--console" : null,
            consoleUrl,
          ],
        }),
        bases: items,
        items,
      };
      emit(payload, asJson, () => {
        if (page.items.length === 0) {
          console.log(`No bases in project ${client.projectRef}.`);
          return;
        }
        printTable(
          ["slug", "name", "rows", "schema", "status", "id"],
          page.items.map((base) => [
            base.slug,
            base.name,
            base.rowCount === null ? "-" : String(base.rowCount),
            `v${base.schemaVersion}`,
            base.status,
            base.id,
          ]),
        );
        printNextPage(payload.pagination.nextCommand);
      });
      return payload;
    });
  }

  @Command({ name: "show", description: "Show a base: schema, views, and charts" })
  @CommandAccess({ kind: "read", resource: "bases", action: "show", risk: "low" })
  async show(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases show", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const detail = await client.getBase(base);
      const payload = { ...scope(client), base: detail };
      emit(payload, asJson, () => printBaseDetail(detail));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create a base, optionally with an initial schema" })
  @CommandAccess({ kind: "mutate", resource: "bases", action: "create", risk: "medium" })
  async create(
    @Arg("name", { description: "Base display name" }) name: string,
    @Option({ flags: "--slug <slug>", description: "Base slug (default: derived from the name)" }) slug?: string,
    @Option({ flags: "--description <text>", description: "Base description" }) description?: string,
    @Option({ flags: "--icon <icon>", description: "Base icon (emoji or short name)" }) icon?: string,
    @Option({ flags: "--timezone <iana>", description: "IANA timezone for dates and $today (default: UTC)" })
    timezone?: string,
    @Option({
      flags: "--schema <json|@file>",
      description: "Initial properties: a JSON array of property definitions, or {properties:[...]}",
    })
    schema?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases create", asJson, this.deps, async () => {
      const properties = schema === undefined ? undefined : readSchemaProperties(schema);
      const body = compact({
        name: requireText(name, "name"),
        slug: optionalText(slug),
        description: optionalText(description),
        icon: optionalText(icon),
        timezone: optionalText(timezone),
        properties,
      });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const detail = await client.createBase(body);
      const payload = { ...scope(client), base: detail };
      emit(payload, asJson, () => {
        console.log(`✓ Base created: ${detail.slug} (${detail.id})`);
        printBaseDetail(detail);
      });
      return payload;
    });
  }

  @Command({ name: "update", description: "Update base metadata (name, slug, description, icon, timezone)" })
  @CommandAccess({ kind: "mutate", resource: "bases", action: "update", risk: "medium" })
  async update(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option({ flags: "--name <name>", description: "New name" }) name?: string,
    @Option({ flags: "--slug <slug>", description: "New slug" }) slug?: string,
    @Option({ flags: "--description <text>", description: "New description" }) description?: string,
    @Option({ flags: "--icon <icon>", description: "New icon" }) icon?: string,
    @Option({ flags: "--timezone <iana>", description: "New IANA timezone" }) timezone?: string,
    @Option({ flags: "--expected-version <n>", description: "Base version you read (default: current)" })
    expectedVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases update", asJson, this.deps, async () => {
      const changes = compact({
        name: optionalText(name),
        slug: optionalText(slug),
        description: description === undefined ? undefined : description.trim() || null,
        icon: icon === undefined ? undefined : icon.trim() || null,
        timezone: optionalText(timezone),
      });
      if (Object.keys(changes).length === 0) {
        throw invalidInput("Nothing to update: pass --name, --slug, --description, --icon, or --timezone.");
      }
      const version = parseIntegerOption(expectedVersion, "--expected-version", { min: 1 });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const current = version ?? (await client.getBase(base)).version;
      const summary = await client.updateBase(base, { ...changes, expectedVersion: current });
      const payload = { ...scope(client), base: summary };
      emit(payload, asJson, () => console.log(`✓ Base updated: ${summary.slug} (v${summary.version})`));
      return payload;
    });
  }

  @Command({ name: "archive", description: "Archive a base (read-only, hidden from lists)" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases",
    action: "archive",
    risk: "high",
    requiresConfirmation: true,
  })
  async archive(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option({ flags: "--expected-version <n>", description: "Base version you read (default: current)" })
    expectedVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually archive; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return setBaseArchived(
      this.deps,
      "bases archive",
      true,
      base,
      expectedVersion,
      project,
      consoleUrl,
      asJson,
      execute,
    );
  }

  @Command({ name: "restore", description: "Restore an archived base" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases",
    action: "restore",
    risk: "medium",
    requiresConfirmation: true,
  })
  async restore(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option({ flags: "--expected-version <n>", description: "Base version you read (default: current)" })
    expectedVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually restore; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return setBaseArchived(
      this.deps,
      "bases restore",
      false,
      base,
      expectedVersion,
      project,
      consoleUrl,
      asJson,
      execute,
    );
  }

  @Command({ name: "aggregate", description: "Group and aggregate rows on the server (direct readers)" })
  @CommandAccess({ kind: "read", resource: "bases", action: "aggregate", risk: "low", redactions: ["filter"] })
  async aggregate(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option({
      flags: "--group-by <key[:unit][,key[:unit]]>",
      description:
        "Comma-separated, up to 2 keys, e.g. created_time:month,status; dates need a unit: day|week|month|quarter|year",
    })
    groupBy?: string,
    @Option({
      flags: "--agg <op:key:as...>",
      description: "Measures: count, count::n, sum:amount, avg:amount:avg_deal (default: count)",
    })
    agg?: string[],
    @Option(FILTER_OPTION) filter?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases aggregate", asJson, this.deps, async () => {
      const request = compact({
        filter: filter === undefined ? undefined : readFilter(filter),
        groupBy: parseGroupByOption(groupBy),
        aggregate: parseAggregateOption(agg),
      });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.aggregateRows(base, request);
      const payload = { ...scope(client), baseRef: base, ...result };
      if (!asJson) {
        const descriptors = await loadDescriptors(client, base);
        const keyColumns = (request.groupBy as Array<{ prop: string }> | undefined)?.map((item) => item.prop) ?? [];
        const measures = (request.aggregate as Array<{ as: string }>).map((item) => item.as);
        printTable(
          [...keyColumns, ...measures],
          result.groups.map((group) => [
            ...keyColumns.map((key) => formatCellText(group.keys[key], descriptors.get(key), result.users, "table")),
            ...measures.map((as) => (group.values[as] === null ? "" : String(group.values[as] ?? ""))),
          ]),
        );
        if (result.suppressedGroups > 0) console.log(`(${result.suppressedGroups} small groups suppressed)`);
      } else {
        emit(payload, asJson, () => undefined);
      }
      return payload;
    });
  }

  @Command({ name: "subscribe", description: "Deliver this base's row events to this installation's inbox" })
  @CommandAccess({ kind: "mutate", resource: "bases", action: "subscribe", risk: "low" })
  async subscribe(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases subscribe", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const subscription = await client.subscribe(base);
      const payload = {
        ...scope(client),
        subscription,
        delivery: { natsSubject: INBOX_NATS_SUBJECT, category: "bases" },
      };
      emit(payload, asJson, () => {
        console.log(`✓ Subscribed this installation to ${base} (${subscription.id})`);
        console.log(`  Row events arrive on ${INBOX_NATS_SUBJECT} with category "bases" (ids and counts only).`);
        console.log("  Make sure the inbox poller runs: ravi inbox status / ravi inbox enable");
      });
      return payload;
    });
  }

  @Command({ name: "unsubscribe", description: "Stop delivering this base's row events to an installation" })
  @CommandAccess({ kind: "mutate", resource: "bases", action: "unsubscribe", risk: "low" })
  async unsubscribe(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("subscription", { description: "Subscription id" }) subscriptionId: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases unsubscribe", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const subscription = await client.unsubscribe(base, subscriptionId);
      const payload = { ...scope(client), subscription };
      emit(payload, asJson, () => console.log(`✓ Subscription ${subscription.id} is ${subscription.status}`));
      return payload;
    });
  }

  @Command({ name: "subscriptions", description: "List row-event subscriptions of a base" })
  @CommandAccess({ kind: "read", resource: "bases", action: "subscriptions", risk: "low" })
  async subscriptions(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases subscriptions", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const { subscriptions } = await client.listSubscriptions(base);
      const payload = { ...scope(client), baseRef: base, subscriptions };
      emit(payload, asJson, () => printSubscriptions(subscriptions));
      return payload;
    });
  }
}

// ---------------------------------------------------------------------------
// ravi bases props

@Group({ name: "bases.props", description: "Manage base properties (columns)", scope: "open" })
export class BasesPropsCommands {
  constructor(private readonly deps: BasesCommandDeps = {}) {}

  @Command({ name: "list", description: "List the properties of a base" })
  @CommandAccess({ kind: "read", resource: "bases.props", action: "list", risk: "low" })
  async list(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option({ flags: "--include-deleted", description: "Include soft-deleted properties" }) includeDeleted?: boolean,
    @Option(LIST_LIMIT_OPTION) limit?: string,
    @Option(LIST_OFFSET_OPTION) offset?: string,
    @Option(FIELDS_OPTION) fields?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases props list", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const detail = await client.getBase(base);
      const properties = detail.properties
        .filter((property) => includeDeleted === true || !property.deletedAt)
        .sort((left, right) => left.position - right.position);
      const page = paginateCliItems(properties, { limit, offset }, { defaultLimit: 100 });
      const items = pickFields(page.items, fields) as Partial<BaseProperty>[];
      const payload = {
        ...scope(client),
        baseRef: base,
        schemaVersion: detail.schemaVersion,
        total: page.total,
        pagination: buildCliOffsetPagination({
          baseCommand: ["ravi", "bases", "props", "list", base],
          fields,
          limit: page.limit,
          offset: page.offset,
          returned: page.items.length,
          total: page.total,
          options: [includeDeleted ? "--include-deleted" : null, "--project", client.projectRef],
        }),
        properties: items,
        items,
      };
      emit(payload, asJson, () => {
        if (detail.properties.length === 0 && !detail.capabilities.manage) {
          console.log(
            "Properties are visible to base managers only. Use `ravi bases views show` for a view's columns.",
          );
          return;
        }
        printProperties(page.items);
        printNextPage(payload.pagination.nextCommand);
      });
      return payload;
    });
  }

  @Command({ name: "add", description: "Add a property to a base" })
  @CommandAccess({ kind: "mutate", resource: "bases.props", action: "add", risk: "medium" })
  async add(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("name", { description: "Property display name" }) name: string,
    @Option({
      flags: "--type <type>",
      description: "text|number|checkbox|date|select|multi_select|status|url|email|phone|person|ref (default: text)",
    })
    type?: string,
    @Option({ flags: "--key <key>", description: "API key, ^[a-z][a-z0-9_]{0,62}$ (default: derived from the name)" })
    key?: string,
    @Option({ flags: "--description <text>", description: "Property description" }) description?: string,
    @Option({
      flags: "--options <names>",
      description: "Select/status options, comma-separated; status groups as Name:todo|in_progress|done",
    })
    options?: string,
    @Option({ flags: "--config <json|@file>", description: "Property config JSON (options, format, includeTime...)" })
    config?: string,
    @Option({ flags: "--required", description: "Require a value on create and on updates that touch it" })
    required?: boolean,
    @Option({ flags: "--position <n>", description: "Column position" }) position?: string,
    @Option(EXPECTED_SCHEMA_VERSION_OPTION) expectedSchemaVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases props add", asJson, this.deps, async () => {
      const body = compact({
        name: requireText(name, "name"),
        type: optionalText(type) ?? "text",
        key: optionalText(key),
        description: optionalText(description),
        config: buildPropertyConfig(config, options),
        required: required === true ? true : undefined,
        position: parseIntegerOption(position, "--position", { min: 0 }),
      });
      const schemaVersion = parseIntegerOption(expectedSchemaVersion, "--expected-schema-version", { min: 1 });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.createProperty(base, {
        ...body,
        expectedSchemaVersion: schemaVersion ?? (await client.getBase(base)).schemaVersion,
      });
      const payload = { ...scope(client), ...result };
      emit(payload, asJson, () => printPropertyMutation("added", result));
      return payload;
    });
  }

  @Command({ name: "update", description: "Update a property; type changes are dry-run unless --execute" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.props",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
  })
  async update(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("prop", { description: "Property key or id" }) prop: string,
    @Option({ flags: "--name <name>", description: "New name" }) name?: string,
    @Option({ flags: "--key <key>", description: "New API key" }) key?: string,
    @Option({ flags: "--description <text>", description: "New description" }) description?: string,
    @Option({ flags: "--type <type>", description: "New type (a migration: dry-run report unless --execute)" })
    type?: string,
    @Option({ flags: "--options <names>", description: "Replace select/status options by name (see props add)" })
    options?: string,
    @Option({ flags: "--config <json|@file>", description: "New config JSON (options keep ids when you pass them)" })
    config?: string,
    @Option({ flags: "--required <true|false>", description: "Require a value" }) required?: string,
    @Option({ flags: "--position <n>", description: "Column position" }) position?: string,
    @Option(EXPECTED_SCHEMA_VERSION_OPTION) expectedSchemaVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Confirm a type or includeTime migration; without it the Console only reports (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBasesCommand("bases props update", asJson, this.deps, async () => {
      const changes = compact({
        name: optionalText(name),
        key: optionalText(key),
        description: description === undefined ? undefined : description.trim() || null,
        type: optionalText(type),
        config: buildPropertyConfig(config, options),
        required: parseBooleanOption(required, "--required"),
        position: parseIntegerOption(position, "--position", { min: 0 }),
      });
      if (Object.keys(changes).length === 0) throw invalidInput("Nothing to update.");
      const schemaVersion = parseIntegerOption(expectedSchemaVersion, "--expected-schema-version", { min: 1 });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.updateProperty(base, prop, {
        ...changes,
        expectedSchemaVersion: schemaVersion ?? (await client.getBase(base)).schemaVersion,
        ...(execute === true ? { confirm: true } : {}),
      });
      if (result.report?.dryRun) {
        contractDryRun(
          "bases props update",
          { project: client.projectRef, base, property: result.property.key, migration: result.report },
          { asJson },
        );
      }
      const payload = { ...scope(client), ...result };
      emit(payload, asJson, () => printPropertyMutation("updated", result));
      return payload;
    });
  }

  @Command({ name: "delete", description: "Soft-delete a property; reports dependents unless --execute" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.props",
    action: "delete",
    risk: "high",
    requiresConfirmation: true,
  })
  async delete(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("prop", { description: "Property key or id" }) prop: string,
    @Option(EXPECTED_SCHEMA_VERSION_OPTION) expectedSchemaVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually delete; without it the Console only reports dependent views and charts (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBasesCommand("bases props delete", asJson, this.deps, async () => {
      const schemaVersion = parseIntegerOption(expectedSchemaVersion, "--expected-schema-version", { min: 1 });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.deleteProperty(base, prop, {
        expectedSchemaVersion: schemaVersion ?? (await client.getBase(base)).schemaVersion,
        ...(execute === true ? { confirm: true } : {}),
      });
      if (result.report?.dryRun || (execute !== true && !result.property.deletedAt)) {
        contractDryRun(
          "bases props delete",
          { project: client.projectRef, base, property: result.property.key, migration: result.report },
          { asJson },
        );
      }
      const payload = { ...scope(client), ...result };
      emit(payload, asJson, () => printPropertyMutation("deleted", result));
      return payload;
    });
  }

  @Command({ name: "restore", description: "Restore a soft-deleted property while its key is free" })
  @CommandAccess({ kind: "mutate", resource: "bases.props", action: "restore", risk: "low" })
  async restore(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("prop", { description: "Property key or id" }) prop: string,
    @Option(EXPECTED_SCHEMA_VERSION_OPTION) expectedSchemaVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases props restore", asJson, this.deps, async () => {
      const schemaVersion = parseIntegerOption(expectedSchemaVersion, "--expected-schema-version", { min: 1 });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.restoreProperty(base, prop, {
        expectedSchemaVersion: schemaVersion ?? (await client.getBase(base)).schemaVersion,
      });
      const payload = { ...scope(client), ...result };
      emit(payload, asJson, () => printPropertyMutation("restored", result));
      return payload;
    });
  }
}

// ---------------------------------------------------------------------------
// ravi bases rows

@Group({ name: "bases.rows", description: "Query and write base rows", scope: "open" })
export class BasesRowsCommands {
  constructor(private readonly deps: BasesCommandDeps = {}) {}

  @Command({ name: "query", description: "Query rows with the Query AST (directly or through a view)" })
  @CommandAccess({ kind: "read", resource: "bases.rows", action: "query", risk: "low", redactions: ["filter"] })
  async query(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(VIEW_OPTION) view?: string,
    @Option(FILTER_OPTION) filter?: string,
    @Option(SORT_OPTION) sort?: string,
    @Option(LIMIT_OPTION) limit?: string,
    @Option(CURSOR_OPTION) cursor?: string,
    @Option(ALL_OPTION) all?: boolean,
    @Option(MAX_ROWS_OPTION) maxRows?: string,
    @Option(INCLUDE_BODY_OPTION) includeBody?: boolean,
    @Option({ flags: "--include-archived", description: "Include archived rows (direct readers only)" })
    includeArchived?: boolean,
    @Option(FORMAT_OPTION) format?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows query", asJson, this.deps, () =>
      runQueryCommand(this.deps, {
        command: ["ravi", "bases", "rows", "query", base],
        base,
        view,
        filter,
        sort,
        limit,
        cursor,
        all,
        maxRows,
        includeBody,
        includeArchived,
        format,
        project,
        consoleUrl,
        asJson,
      }),
    );
  }

  @Command({ name: "get", description: "Read one row (with its body)" })
  @CommandAccess({ kind: "read", resource: "bases.rows", action: "get", risk: "low" })
  async get(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("row", { description: "Row id" }) row: string,
    @Option(VIEW_OPTION) view?: string,
    @Option({ flags: "--include-archived", description: "Read an archived row (direct readers only)" })
    includeArchived?: boolean,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows get", asJson, this.deps, async () => {
      if (view && includeArchived) throw invalidInput("--include-archived is not available through a view.");
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = view
        ? await client.getViewRow(base, view, row)
        : await client.getRow(base, row, { includeArchived: includeArchived === true });
      const payload = { ...scope(client), baseRef: base, viewId: view ?? null, row: result.row, users: result.users };
      emit(payload, asJson, () => printRow(result.row));
      return payload;
    });
  }

  @Command({ name: "add", description: "Create a row (directly or through a view)" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.rows",
    action: "add",
    risk: "medium",
    redactions: ["values", "set", "body"],
  })
  async add(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(VIEW_OPTION) view?: string,
    @Option(VALUES_OPTION) values?: string,
    @Option(SET_OPTION) set?: string[],
    @Option(BODY_OPTION) body?: string,
    @Option(BODY_FILE_OPTION) bodyFile?: string,
    @Option(IDEMPOTENCY_OPTION) idempotencyKey?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows add", asJson, this.deps, async () => {
      const rowValues = buildRowValues(values, set);
      const rowBody = readBodyInput(body, bodyFile);
      const input = rowBody === undefined ? { values: rowValues } : { values: rowValues, body: rowBody };
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = view
        ? await client.createViewRow(base, view, input, { idempotencyKey })
        : await client.createRow(base, input, { idempotencyKey });
      const warnings = rowWriteWarnings(this.deps, idempotencyKey);
      const payload = {
        ...scope(client),
        baseRef: base,
        viewId: view ?? null,
        ...result.response,
        idempotencyKey: result.idempotencyKey,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      emit(payload, asJson, () =>
        printRowWrite("created", result.response.row, result.response.idempotentReplay, warnings),
      );
      return payload;
    });
  }

  @Command({ name: "update", description: "Patch a row; needs --expected-version or --last-write-wins" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.rows",
    action: "update",
    risk: "medium",
    redactions: ["values", "set", "body"],
  })
  async update(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("row", { description: "Row id" }) row: string,
    @Option(VIEW_OPTION) view?: string,
    @Option(VALUES_OPTION) values?: string,
    @Option(SET_OPTION) set?: string[],
    @Option(BODY_OPTION) body?: string,
    @Option(BODY_FILE_OPTION) bodyFile?: string,
    @Option(EXPECTED_VERSION_OPTION) expectedVersion?: string,
    @Option(LAST_WRITE_WINS_OPTION) lastWriteWins?: boolean,
    @Option(IDEMPOTENCY_OPTION) idempotencyKey?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows update", asJson, this.deps, async () => {
      const rowValues = buildRowValues(values, set);
      const rowBody = readBodyInput(body, bodyFile);
      if (Object.keys(rowValues).length === 0 && rowBody === undefined) {
        throw invalidInput("Nothing to update: pass --values, --set, --body, or --body-file.");
      }
      const concurrency = requireConcurrencyChoice(expectedVersion, lastWriteWins);
      const input = {
        ...(Object.keys(rowValues).length > 0 ? { values: rowValues } : {}),
        ...(rowBody !== undefined ? { body: rowBody } : {}),
        ...concurrency,
      };
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = view
        ? await client.updateViewRow(base, view, row, input, { idempotencyKey })
        : await client.updateRow(base, row, input, { idempotencyKey });
      const warnings = rowWriteWarnings(this.deps, idempotencyKey);
      const payload = {
        ...scope(client),
        baseRef: base,
        viewId: view ?? null,
        ...result.response,
        idempotencyKey: result.idempotencyKey,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      emit(payload, asJson, () =>
        printRowWrite("updated", result.response.row, result.response.idempotentReplay, warnings),
      );
      return payload;
    });
  }

  @Command({ name: "archive", description: "Archive a row (restorable)" })
  @CommandAccess({ kind: "mutate", resource: "bases.rows", action: "archive", risk: "medium" })
  async archive(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("row", { description: "Row id" }) row: string,
    @Option(VIEW_OPTION) view?: string,
    @Option(EXPECTED_VERSION_OPTION) expectedVersion?: string,
    @Option(LAST_WRITE_WINS_OPTION) lastWriteWins?: boolean,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows archive", asJson, this.deps, async () => {
      const concurrency = requireConcurrencyChoice(expectedVersion, lastWriteWins);
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = view
        ? await client.archiveViewRow(base, view, row, concurrency)
        : await client.setRowArchived(base, row, true, concurrency);
      const payload = { ...scope(client), baseRef: base, viewId: view ?? null, ...result };
      emit(payload, asJson, () => printRowWrite("archived", result.row, result.idempotentReplay));
      return payload;
    });
  }

  @Command({ name: "restore", description: "Restore an archived row (direct writers)" })
  @CommandAccess({ kind: "mutate", resource: "bases.rows", action: "restore", risk: "low" })
  async restore(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("row", { description: "Row id" }) row: string,
    @Option(EXPECTED_VERSION_OPTION) expectedVersion?: string,
    @Option(LAST_WRITE_WINS_OPTION) lastWriteWins?: boolean,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows restore", asJson, this.deps, async () => {
      const concurrency = requireConcurrencyChoice(expectedVersion, lastWriteWins);
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.setRowArchived(base, row, false, concurrency);
      const payload = { ...scope(client), baseRef: base, viewId: null, ...result };
      emit(payload, asJson, () => printRowWrite("restored", result.row, result.idempotentReplay));
      return payload;
    });
  }

  @Command({ name: "purge", description: "Hard-delete a row and its history (irreversible)" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.rows",
    action: "purge",
    risk: "destructive",
    requiresConfirmation: true,
  })
  async purge(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("row", { description: "Row id" }) row: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually purge the row and its ledger; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBasesCommand("bases rows purge", asJson, this.deps, async () => {
      requireText(row, "row");
      if (execute !== true) {
        contractDryRun(
          "bases rows purge",
          { project: project ?? "(Console scope default)", base, row, irreversible: true, deletesHistory: true },
          { asJson },
        );
      }
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.purgeRow(base, row);
      const payload = { ...scope(client), baseRef: base, purged: result.purged !== false, rowId: result.rowId };
      emit(payload, asJson, () => console.log(`✓ Row ${result.rowId} purged`));
      return payload;
    });
  }

  @Command({ name: "history", description: "Show the ledger of a row (who changed what, when)" })
  @CommandAccess({ kind: "read", resource: "bases.rows", action: "history", risk: "low" })
  async history(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("row", { description: "Row id" }) row: string,
    @Option(VIEW_OPTION) view?: string,
    @Option({ flags: "--limit <n>", description: "Entries per page, 1-200 (default 50)" }) limit?: string,
    @Option(CURSOR_OPTION) cursor?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows history", asJson, this.deps, async () => {
      const pageLimit = parseIntegerOption(limit, "--limit", { min: 1, max: HISTORY_LIMIT_MAX });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const page = { cursor: cursor ?? null, ...(pageLimit !== undefined ? { limit: pageLimit } : {}) };
      const result = view
        ? await client.viewRowHistory(base, view, row, page)
        : await client.rowHistory(base, row, page);
      const nextCommand = result.nextCursor
        ? commandLine([
            "ravi",
            "bases",
            "rows",
            "history",
            base,
            row,
            ["--view", view],
            ["--limit", pageLimit],
            ["--cursor", result.nextCursor],
            ["--project", client.projectRef],
            "--json",
          ])
        : null;
      const payload = {
        ...scope(client),
        baseRef: base,
        viewId: view ?? null,
        ...result,
        pagination: cursorPage(pageLimit ?? 50, result.entries.length, result.nextCursor, nextCommand),
      };
      emit(payload, asJson, () => {
        printTable(
          ["v", "action", "changed", "actor", "surface", "at"],
          result.entries.map((entry) => [
            String(entry.version),
            entry.action,
            [...entry.changedKeys, ...(entry.bodyChanged ? ["body"] : [])].join(", "),
            entry.actorId ? (result.users[entry.actorId]?.displayName ?? entry.actorId) : (entry.actorType ?? "-"),
            entry.surface ?? "-",
            entry.createdAt ?? "-",
          ]),
        );
        printNextPage(nextCommand);
      });
      return payload;
    });
  }

  @Command({ name: "import", description: "Import a CSV file as new rows in batches (dry-run unless --execute)" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.rows",
    action: "import",
    risk: "high",
    requiresConfirmation: true,
  })
  async import(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("file", { description: "CSV file with a header row" }) file: string,
    @Option({
      flags: "--map <column=key...>",
      description: 'Map a CSV column to a property key ("Deal Name=name"); "column=-" skips it. Repeatable',
    })
    map?: string[],
    @Option({ flags: "--batch <n>", description: "Rows per request, 1-500 (default 500)" }) batch?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually create the rows; default is a dry-run preview of the mapping (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBasesCommand("bases rows import", asJson, this.deps, async () => {
      const batchSize =
        parseIntegerOption(batch, "--batch", { min: 1, max: BASES_BATCH_ROWS_MAX }) ?? BASES_BATCH_ROWS_MAX;
      const columnMap = parseColumnMap(map);
      const path = resolveCallerPath(requireText(file, "file"));
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        throw invalidInput(`CSV file could not be read: ${file}`);
      }
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const detail = await client.getBase(base);
      if (!detail.capabilities.writeDirect) {
        throw invalidInput("Import writes rows directly and needs direct write access to this base.");
      }
      const plan = planCsvImport({ text: bytes.toString("utf8"), properties: detail.properties, columnMap });
      if (plan.issues.length > 0) {
        throw new CloudAuthError(
          "PAYLOAD_INVALID",
          `${plan.issues.length} CSV cell(s) do not match their property type. Fix them or skip the column with --map "column=-".`,
          {
            issues: plan.issues.slice(0, 32).map((issue) => ({
              path: ["rows", issue.line, issue.key],
              code: "invalid_type",
              message: `line ${issue.line}, column ${JSON.stringify(issue.column)}: ${issue.message}`,
            })),
          },
        );
      }
      if (plan.records.length > BASES_ROWS_PER_BASE_MAX) {
        throw invalidInput(`CSV has ${plan.records.length} rows; a base holds at most ${BASES_ROWS_PER_BASE_MAX}.`);
      }
      const batches = batchImportRecords(plan.records, batchSize);
      const prefix = importIdempotencyPrefix({
        fileBytes: bytes,
        projectRef: client.projectRef,
        baseRef: detail.id,
        columns: plan.columns,
      });
      if (execute !== true) {
        contractDryRun(
          "bases rows import",
          {
            project: client.projectRef,
            base: detail.slug,
            file: basename(path),
            rows: plan.records.length,
            emptyRowsSkipped: plan.emptyRows,
            batches: batches.length,
            batchSize,
            columns: plan.columns,
            idempotencyKeyPrefix: prefix,
          },
          { asJson },
        );
      }
      const results: Array<{
        index: number;
        rowCount: number;
        idempotencyKey: string;
        idempotentReplay: boolean;
        firstRowId: string | null;
        lastRowId: string | null;
      }> = [];
      for (const [index, records] of batches.entries()) {
        const idempotencyKey = importBatchKey(prefix, index);
        try {
          const { response } = await client.createRows(detail.id, records.map(toRowInput), { idempotencyKey });
          results.push({
            index,
            rowCount: response.rows.length,
            idempotencyKey,
            idempotentReplay: response.idempotentReplay,
            firstRowId: response.rows[0]?.rowId ?? null,
            lastRowId: response.rows.at(-1)?.rowId ?? null,
          });
        } catch (error) {
          if (!isCloudAuthError(error)) throw error;
          throw withImportProgress(error, {
            failedBatch: index,
            batches: batches.length,
            rowsCreated: results.reduce((sum, item) => sum + item.rowCount, 0),
            firstFailedLine: records[0]?.line ?? null,
          });
        }
      }
      const payload = {
        ...scope(client),
        baseRef: detail.slug,
        file: basename(path),
        rowCount: plan.records.length,
        created: results.reduce((sum, item) => sum + item.rowCount, 0),
        emptyRowsSkipped: plan.emptyRows,
        batchCount: batches.length,
        batches: results,
        columns: plan.columns,
      };
      emit(payload, asJson, () => {
        const replayed = results.filter((item) => item.idempotentReplay).length;
        console.log(
          `✓ Imported ${payload.created} rows into ${detail.slug} in ${batches.length} batch(es)${
            replayed ? ` (${replayed} replayed)` : ""
          }`,
        );
        printImportColumns(plan.columns);
      });
      return payload;
    });
  }

  @Command({ name: "export", description: "Export rows as CSV or JSON (follows every page)" })
  @CommandAccess({ kind: "read", resource: "bases.rows", action: "export", risk: "low", redactions: ["filter"] })
  async export(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(VIEW_OPTION) view?: string,
    @Option({ flags: "--format <format>", description: "csv|json (default csv)" }) format?: string,
    @Option({ flags: "--out <path>", description: "Write to this file instead of stdout" }) out?: string,
    @Option(FILTER_OPTION) filter?: string,
    @Option(SORT_OPTION) sort?: string,
    @Option(INCLUDE_BODY_OPTION) includeBody?: boolean,
    @Option({ flags: "--max-rows <n>", description: "Stop after this many rows (default and max 100000)" })
    maxRows?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases rows export", asJson, this.deps, async () => {
      const exportFormat = (optionalText(format) ?? "csv").toLowerCase();
      if (exportFormat !== "csv" && exportFormat !== "json") throw invalidInput("--format must be csv or json.");
      const cap =
        parseIntegerOption(maxRows, "--max-rows", { min: 1, max: BASES_ROWS_PER_BASE_MAX }) ?? BASES_ROWS_PER_BASE_MAX;
      const query = buildQueryBody({ filter, sort, limit: String(BASES_QUERY_LIMIT_MAX), includeBody });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await collectRows(client, base, view, query, { all: true, maxRows: cap });
      let content: string;
      if (exportFormat === "csv") {
        const descriptors = await loadDescriptors(client, base, view);
        content = rowsToCsv(result.response.columns, result.response.rows, descriptors, result.response.users);
      } else {
        content = `${JSON.stringify(
          { columns: result.response.columns, rows: result.response.rows, users: result.response.users },
          null,
          2,
        )}\n`;
      }
      let outFile: string | null = null;
      if (out) {
        outFile = resolveCallerPath(out);
        writeFileSync(outFile, content);
      }
      const payload = {
        ...scope(client),
        baseRef: base,
        viewId: view ?? null,
        format: exportFormat,
        rowCount: result.response.rows.length,
        columns: result.response.columns,
        truncated: result.response.nextCursor !== null,
        outFile: out ? basename(outFile ?? out) : null,
        content: out ? null : content,
      };
      if (asJson) emit(payload, asJson, () => undefined);
      else if (out)
        console.log(`✓ Exported ${payload.rowCount} rows to ${out}${payload.truncated ? " (truncated)" : ""}`);
      else process.stdout.write(content);
      return payload;
    });
  }
}

// ---------------------------------------------------------------------------
// ravi bases views

@Group({
  name: "bases.views",
  description: "Manage base views: queries, projections, and access contracts",
  scope: "open",
})
export class BasesViewsCommands {
  constructor(private readonly deps: BasesCommandDeps = {}) {}

  @Command({ name: "list", description: "List the views you can use on a base" })
  @CommandAccess({ kind: "read", resource: "bases.views", action: "list", risk: "low" })
  async list(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(LIST_LIMIT_OPTION) limit?: string,
    @Option(LIST_OFFSET_OPTION) offset?: string,
    @Option(FIELDS_OPTION) fields?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases views list", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const { views } = await client.listViews(base);
      const page = paginateCliItems(views, { limit, offset });
      const items = pickFields(page.items, fields) as Array<Partial<BaseAnyView>>;
      const payload = {
        ...scope(client),
        baseRef: base,
        total: page.total,
        pagination: buildCliOffsetPagination({
          baseCommand: ["ravi", "bases", "views", "list", base],
          fields,
          limit: page.limit,
          offset: page.offset,
          returned: page.items.length,
          total: page.total,
          options: ["--project", client.projectRef],
        }),
        views: items,
        items,
      };
      emit(payload, asJson, () => {
        printViews(page.items);
        printNextPage(payload.pagination.nextCommand);
      });
      return payload;
    });
  }

  @Command({
    name: "show",
    description: "Describe a view: columns, layout, your capabilities (and policy for managers)",
  })
  @CommandAccess({ kind: "read", resource: "bases.views", action: "show", risk: "low" })
  async show(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("view", { description: "View id" }) view: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases views show", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const described = await client.getView(base, view);
      const payload = { ...scope(client), baseRef: base, view: described };
      emit(payload, asJson, () => {
        console.log(`${described.name} (${described.id}) v${described.version}${described.valid ? "" : " INVALID"}`);
        console.log(`  Layout: ${String(described.layout.type ?? "table")}`);
        const caps = described.capabilities;
        console.log(
          `  You: read=${caps.read} aggregateOnly=${caps.aggregateOnly} create=${caps.create} archive=${caps.archive} manage=${caps.manage}`,
        );
        if (caps.writeColumns.length > 0) console.log(`  Writable: ${caps.writeColumns.join(", ")}`);
        printTable(
          ["key", "name", "type", "required"],
          described.columns.map((column) => [column.key, column.name, column.type, column.required ? "yes" : ""]),
        );
        if (described.view) {
          console.log("  Policy (managers):");
          console.log(indentJson({ query: described.view.query, access: described.view.access }));
        }
      });
      return payload;
    });
  }

  @Command({ name: "create", description: "Create a view from a JSON spec (columns, query, layout, access)" })
  @CommandAccess({ kind: "mutate", resource: "bases.views", action: "create", risk: "medium", redactions: ["spec"] })
  async create(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option({
      flags: "--spec <json|@file>",
      description: "View spec: {name, columns, query:{filter,sort}, layout, access}",
    })
    spec?: string,
    @Option({ flags: "--name <name>", description: "View name (overrides spec.name)" }) name?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases views create", asJson, this.deps, async () => {
      const body = spec === undefined ? {} : readSpec(spec, "--spec");
      if (name !== undefined) body.name = requireText(name, "name");
      if (typeof body.name !== "string" || !body.name.trim())
        throw invalidInput("A view needs a name (--name or spec.name).");
      delete body.expectedVersion;
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const created = await client.createView(base, body);
      const payload = { ...scope(client), baseRef: base, view: created };
      emit(payload, asJson, () => console.log(`✓ View created: ${created.name} (${created.id})`));
      return payload;
    });
  }

  @Command({ name: "update", description: "Update a view from a partial JSON spec" })
  @CommandAccess({ kind: "mutate", resource: "bases.views", action: "update", risk: "medium", redactions: ["spec"] })
  async update(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("view", { description: "View id" }) view: string,
    @Option({ flags: "--spec <json|@file>", description: "Fields to change: name, columns, query, layout, access" })
    spec?: string,
    @Option({ flags: "--name <name>", description: "New name" }) name?: string,
    @Option({ flags: "--expected-version <n>", description: "View version you read (default: current)" })
    expectedVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases views update", asJson, this.deps, async () => {
      const body = spec === undefined ? {} : readSpec(spec, "--spec");
      if (name !== undefined) body.name = requireText(name, "name");
      delete body.expectedVersion;
      if (Object.keys(body).length === 0) throw invalidInput("Nothing to update: pass --spec or --name.");
      const version = parseIntegerOption(expectedVersion, "--expected-version", { min: 1 });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const current = version ?? (await currentViewVersion(client, base, view));
      const updated = await client.updateView(base, view, { ...body, expectedVersion: current });
      const payload = { ...scope(client), baseRef: base, view: updated };
      emit(payload, asJson, () => console.log(`✓ View updated: ${updated.name} (v${updated.version})`));
      return payload;
    });
  }

  @Command({ name: "archive", description: "Archive a view (Pages and charts using it stop working)" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.views",
    action: "archive",
    risk: "high",
    requiresConfirmation: true,
  })
  async archive(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("view", { description: "View id" }) view: string,
    @Option({ flags: "--expected-version <n>", description: "View version you read (default: current)" })
    expectedVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually archive; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBasesCommand("bases views archive", asJson, this.deps, async () => {
      const version = parseIntegerOption(expectedVersion, "--expected-version", { min: 1 });
      if (execute !== true) {
        contractDryRun(
          "bases views archive",
          {
            project: project ?? "(Console scope default)",
            base,
            view,
            expectedVersion: version ?? "current",
            effect: "charts, forms, and Pages that use this view stop working",
          },
          { asJson },
        );
      }
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const archived = await client.archiveView(base, view, version ?? (await currentViewVersion(client, base, view)));
      const payload = { ...scope(client), baseRef: base, view: archived };
      emit(payload, asJson, () => console.log(`✓ View archived: ${archived.name} (${archived.id})`));
      return payload;
    });
  }

  @Command({ name: "query", description: "Query rows through a view (its filter and columns apply)" })
  @CommandAccess({ kind: "read", resource: "bases.views", action: "query", risk: "low", redactions: ["filter"] })
  async query(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("view", { description: "View id" }) view: string,
    @Option(FILTER_OPTION) filter?: string,
    @Option(SORT_OPTION) sort?: string,
    @Option(LIMIT_OPTION) limit?: string,
    @Option(CURSOR_OPTION) cursor?: string,
    @Option(ALL_OPTION) all?: boolean,
    @Option(MAX_ROWS_OPTION) maxRows?: string,
    @Option(INCLUDE_BODY_OPTION) includeBody?: boolean,
    @Option(FORMAT_OPTION) format?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases views query", asJson, this.deps, () =>
      runQueryCommand(this.deps, {
        command: ["ravi", "bases", "views", "query", base, view],
        base,
        view,
        filter,
        sort,
        limit,
        cursor,
        all,
        maxRows,
        includeBody,
        includeArchived: undefined,
        format,
        project,
        consoleUrl,
        asJson,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// ravi bases charts

@Group({ name: "bases.charts", description: "Manage base charts (Vega-Lite subset over a view)", scope: "open" })
export class BasesChartsCommands {
  constructor(private readonly deps: BasesCommandDeps = {}) {}

  @Command({ name: "list", description: "List the charts you can read on a base" })
  @CommandAccess({ kind: "read", resource: "bases.charts", action: "list", risk: "low" })
  async list(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option(LIST_LIMIT_OPTION) limit?: string,
    @Option(LIST_OFFSET_OPTION) offset?: string,
    @Option(FIELDS_OPTION) fields?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases charts list", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const { charts } = await client.listCharts(base);
      const page = paginateCliItems(charts, { limit, offset });
      const items = pickFields(page.items, fields) as Array<Partial<BaseChart>>;
      const payload = {
        ...scope(client),
        baseRef: base,
        total: page.total,
        pagination: buildCliOffsetPagination({
          baseCommand: ["ravi", "bases", "charts", "list", base],
          fields,
          limit: page.limit,
          offset: page.offset,
          returned: page.items.length,
          total: page.total,
          options: ["--project", client.projectRef],
        }),
        charts: items,
        items,
      };
      emit(payload, asJson, () => {
        printTable(
          ["name", "mark", "view", "id"],
          page.items.map((chart) => [chart.name, chartMark(chart), chart.viewId, chart.id]),
        );
        printNextPage(payload.pagination.nextCommand);
      });
      return payload;
    });
  }

  @Command({ name: "show", description: "Show a chart spec" })
  @CommandAccess({ kind: "read", resource: "bases.charts", action: "show", risk: "low" })
  async show(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("chart", { description: "Chart id" }) chart: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases charts show", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const found = await client.getChart(base, chart);
      const payload = { ...scope(client), baseRef: base, chart: found };
      emit(payload, asJson, () => {
        console.log(`${found.name} (${found.id}) v${found.version} on view ${found.viewId}`);
        console.log(indentJson(found.spec));
      });
      return payload;
    });
  }

  @Command({ name: "create", description: "Create a chart on a view from a Vega-Lite subset spec" })
  @CommandAccess({ kind: "mutate", resource: "bases.charts", action: "create", risk: "low" })
  async create(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Option({
      flags: "--spec <json|@file>",
      description: "Chart: {viewId, name, spec:{mark, encoding}}, or just {mark, encoding} with --view and --name",
    })
    spec?: string,
    @Option({ flags: "--view <id>", description: "View the chart reads (overrides spec.viewId)" }) view?: string,
    @Option({ flags: "--name <name>", description: "Chart name (overrides spec.name)" }) name?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases charts create", asJson, this.deps, async () => {
      const body = normalizeChartBody(spec === undefined ? {} : readSpec(spec, "--spec"));
      if (view !== undefined) body.viewId = requireText(view, "view");
      if (name !== undefined) body.name = requireText(name, "name");
      if (typeof body.viewId !== "string" || typeof body.name !== "string" || !isPlainObject(body.spec)) {
        throw invalidInput("A chart needs a view (--view or viewId), a name, and spec.mark/spec.encoding.");
      }
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const created = await client.createChart(base, body);
      const payload = { ...scope(client), baseRef: base, chart: created };
      emit(payload, asJson, () => console.log(`✓ Chart created: ${created.name} (${created.id})`));
      return payload;
    });
  }

  @Command({ name: "update", description: "Update a chart from a partial JSON spec" })
  @CommandAccess({ kind: "mutate", resource: "bases.charts", action: "update", risk: "low" })
  async update(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("chart", { description: "Chart id" }) chart: string,
    @Option({ flags: "--spec <json|@file>", description: "Fields to change: name, viewId, spec, description" })
    spec?: string,
    @Option({ flags: "--name <name>", description: "New name" }) name?: string,
    @Option({ flags: "--expected-version <n>", description: "Chart version you read (default: current)" })
    expectedVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases charts update", asJson, this.deps, async () => {
      const body = spec === undefined ? {} : readSpec(spec, "--spec");
      if (name !== undefined) body.name = requireText(name, "name");
      delete body.expectedVersion;
      if (Object.keys(body).length === 0) throw invalidInput("Nothing to update: pass --spec or --name.");
      const version = parseIntegerOption(expectedVersion, "--expected-version", { min: 1 });
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const current = version ?? (await client.getChart(base, chart)).version;
      const updated = await client.updateChart(base, chart, { ...body, expectedVersion: current });
      const payload = { ...scope(client), baseRef: base, chart: updated };
      emit(payload, asJson, () => console.log(`✓ Chart updated: ${updated.name} (v${updated.version})`));
      return payload;
    });
  }

  @Command({ name: "archive", description: "Archive a chart" })
  @CommandAccess({
    kind: "mutate",
    resource: "bases.charts",
    action: "archive",
    risk: "medium",
    requiresConfirmation: true,
  })
  async archive(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("chart", { description: "Chart id" }) chart: string,
    @Option({ flags: "--expected-version <n>", description: "Chart version you read (default: current)" })
    expectedVersion?: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually archive; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBasesCommand("bases charts archive", asJson, this.deps, async () => {
      const version = parseIntegerOption(expectedVersion, "--expected-version", { min: 1 });
      if (execute !== true) {
        contractDryRun(
          "bases charts archive",
          {
            project: project ?? "(Console scope default)",
            base,
            chart,
            expectedVersion: version ?? "current",
            effect: "generated Pages that render this chart stop working",
          },
          { asJson },
        );
      }
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const archived = await client.archiveChart(base, chart, version ?? (await client.getChart(base, chart)).version);
      const payload = { ...scope(client), baseRef: base, chart: archived };
      emit(payload, asJson, () => console.log(`✓ Chart archived: ${archived.name} (${archived.id})`));
      return payload;
    });
  }

  @Command({ name: "data", description: "Fetch the aggregated data of a chart" })
  @CommandAccess({ kind: "read", resource: "bases.charts", action: "data", risk: "low" })
  async data(
    @Arg("base", { description: "Base id or slug" }) base: string,
    @Arg("chart", { description: "Chart id" }) chart: string,
    @Option(PROJECT_OPTION) project?: string,
    @Option(CONSOLE_OPTION) consoleUrl?: string,
    @Option(JSON_OPTION) asJson?: boolean,
  ) {
    return runBasesCommand("bases charts data", asJson, this.deps, async () => {
      const client = await openBasesClient({ project, console: consoleUrl }, this.deps);
      const result = await client.chartData(base, chart);
      const payload = { ...scope(client), baseRef: base, ...result };
      emit(payload, asJson, () => {
        const channels = [...new Set(result.data.flatMap((datum) => Object.keys(datum)))];
        console.log(`${result.chart.name} (${chartMark(result.chart)})`);
        printTable(
          channels.map((channel) => {
            const field = (result.chart.spec.encoding as Record<string, { field?: string }> | undefined)?.[channel]
              ?.field;
            return field ? `${channel}:${field}` : channel;
          }),
          result.data.map((datum) =>
            channels.map((channel) => {
              const field = (result.chart.spec.encoding as Record<string, { field?: string }> | undefined)?.[channel]
                ?.field;
              const descriptor = field ? descriptorFromColumn(result.fields[field]) : undefined;
              return formatCellText(datum[channel], descriptor, result.users, "table");
            }),
          ),
        );
        if (result.suppressedGroups > 0) console.log(`(${result.suppressedGroups} small groups suppressed)`);
      });
      return payload;
    });
  }
}

// ---------------------------------------------------------------------------
// Shared command flows

async function setBaseArchived(
  deps: BasesCommandDeps,
  op: string,
  archived: boolean,
  base: string,
  expectedVersion: string | undefined,
  project: string | undefined,
  consoleUrl: string | undefined,
  asJson: boolean | undefined,
  execute: boolean | undefined,
) {
  return runBasesCommand(op, asJson, deps, async () => {
    const version = parseIntegerOption(expectedVersion, "--expected-version", { min: 1 });
    if (execute !== true) {
      contractDryRun(
        op,
        {
          project: project ?? "(Console scope default)",
          base,
          action: archived ? "archive" : "restore",
          expectedVersion: version ?? "current",
          effect: archived
            ? "the base becomes read-only and hidden; views, charts, and Pages stop serving rows"
            : "the base becomes writable and listed again",
        },
        { asJson },
      );
    }
    const client = await openBasesClient({ project, console: consoleUrl }, deps);
    const current = version ?? (await client.getBase(base)).version;
    const summary = await client.setBaseArchived(base, archived, current);
    const payload = { ...scope(client), base: summary };
    emit(payload, asJson, () => console.log(`✓ Base ${summary.slug} is ${summary.status}`));
    return payload;
  });
}

interface QueryCommandInput {
  command: string[];
  base: string;
  view: string | undefined;
  filter: string | undefined;
  sort: string | undefined;
  limit: string | undefined;
  cursor: string | undefined;
  all: boolean | undefined;
  maxRows: string | undefined;
  includeBody: boolean | undefined;
  includeArchived: boolean | undefined;
  format: string | undefined;
  project: string | undefined;
  consoleUrl: string | undefined;
  asJson: boolean | undefined;
}

async function runQueryCommand(deps: BasesCommandDeps, input: QueryCommandInput) {
  const format = (optionalText(input.format) ?? "table").toLowerCase();
  if (format !== "table" && format !== "csv" && format !== "json") {
    throw invalidInput("--format must be table, csv, or json.");
  }
  if (input.view && input.includeArchived) throw invalidInput("--include-archived is not available through a view.");
  const all = input.all === true;
  const maxRows =
    parseIntegerOption(input.maxRows, "--max-rows", { min: 1, max: BASES_ROWS_PER_BASE_MAX }) ?? DEFAULT_ALL_MAX_ROWS;
  const body = buildQueryBody({
    filter: input.filter,
    sort: input.sort,
    limit: input.limit ?? (all ? String(BASES_QUERY_LIMIT_MAX) : undefined),
    cursor: input.cursor,
    includeBody: input.includeBody,
    includeArchived: input.includeArchived,
  });
  const client = await openBasesClient({ project: input.project, console: input.consoleUrl }, deps);
  const result = await collectRows(client, input.base, input.view, body, { all, maxRows });
  const response = result.response;
  const pageLimit = typeof body.limit === "number" ? body.limit : DEFAULT_QUERY_LIMIT;
  const viewToken: CommandToken[] =
    input.view && input.command[3] === "query" && input.command[2] === "rows" ? [["--view", input.view]] : [];
  const nextCommand = response.nextCursor
    ? commandLine([
        ...input.command,
        ...viewToken,
        ["--filter", input.filter],
        ["--sort", input.sort],
        ["--limit", pageLimit],
        input.includeBody ? "--include-body" : null,
        input.includeArchived ? "--include-archived" : null,
        ["--cursor", response.nextCursor],
        ["--project", client.projectRef],
        ["--console", input.consoleUrl],
        "--json",
      ])
    : null;
  const payload = {
    ...scope(client),
    baseRef: input.base,
    viewId: input.view ?? null,
    ...response,
    truncated: all && response.nextCursor !== null,
    pagination: cursorPage(pageLimit, response.rows.length, response.nextCursor, nextCommand),
  };
  if (input.asJson) {
    emit(payload, true, () => undefined);
    return payload;
  }
  if (format === "json") {
    console.log(JSON.stringify(response, null, 2));
    return payload;
  }
  const descriptors = await loadDescriptors(client, input.base, input.view);
  if (format === "csv") {
    process.stdout.write(rowsToCsv(response.columns, response.rows, descriptors, response.users));
    return payload;
  }
  if (response.rows.length === 0) {
    console.log("No rows.");
  } else {
    for (const line of renderRowsTable(response.columns, response.rows, descriptors, response.users)) console.log(line);
    console.log(`(${response.rows.length} row${response.rows.length === 1 ? "" : "s"})`);
  }
  printNextPage(nextCommand);
  return payload;
}

function buildQueryBody(input: {
  filter?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
  includeBody?: boolean;
  includeArchived?: boolean;
}): BasesJsonObject {
  return compact({
    filter: input.filter === undefined ? undefined : readFilter(input.filter),
    sort: parseSortOption(input.sort),
    limit: parseIntegerOption(input.limit, "--limit", { min: 1, max: BASES_QUERY_LIMIT_MAX }),
    cursor: optionalText(input.cursor),
    includeBody: input.includeBody === true ? true : undefined,
    includeArchived: input.includeArchived === true ? true : undefined,
  });
}

/**
 * Follow cursors without changing the request between pages (the cursor binds
 * the query). With `maxRows`, stop after the page that reaches it; the returned
 * `nextCursor` still continues from there.
 */
async function collectRows(
  client: RaviBasesClient,
  base: string,
  view: string | undefined,
  body: BasesJsonObject,
  options: { all: boolean; maxRows: number },
): Promise<{ response: BaseQueryResponse; pages: number }> {
  const fetchPage = (pageBody: BasesJsonObject) =>
    view ? client.queryView(base, view, pageBody) : client.queryRows(base, pageBody);
  const first = await fetchPage(body);
  if (!options.all) return { response: first, pages: 1 };
  const rows: BaseRow[] = [...first.rows];
  const users: Record<string, BasesUserRef> = { ...first.users };
  let nextCursor = first.nextCursor;
  let pages = 1;
  while (nextCursor && rows.length < options.maxRows) {
    const page = await fetchPage({ ...body, cursor: nextCursor });
    rows.push(...page.rows);
    Object.assign(users, page.users);
    nextCursor = page.nextCursor;
    pages += 1;
  }
  return { response: { columns: first.columns, rows, users, nextCursor }, pages };
}

async function loadDescriptors(
  client: RaviBasesClient,
  base: string,
  view?: string,
): Promise<Map<string, BasesColumnDescriptor>> {
  try {
    if (view) return descriptorsFromViewColumns((await client.getView(base, view)).columns);
    return descriptorsFromProperties((await client.getBase(base)).properties);
  } catch (error) {
    if (isCloudAuthError(error)) return descriptorsFromProperties([]);
    throw error;
  }
}

async function currentViewVersion(client: RaviBasesClient, base: string, view: string): Promise<number> {
  const described = await client.getView(base, view);
  return described.view?.version ?? described.version;
}

function readFilter(value: string): BasesJsonObject {
  const filter = readJsonInput(value, "--filter");
  if (!isPlainObject(filter))
    throw invalidInput('--filter must be a Query AST object, e.g. {"prop":"status","op":"eq","value":"Done"}.');
  // A full query object ({filter, sort}) is accepted too.
  if ("filter" in filter && !("prop" in filter) && !("and" in filter) && !("or" in filter) && !("not" in filter)) {
    const nested = filter.filter;
    if (!isPlainObject(nested)) throw invalidInput("--filter.filter must be a Query AST object.");
    return nested;
  }
  return filter;
}

function readSpec(value: string, label: string): BasesJsonObject {
  return { ...readJsonObjectInput(value, label) };
}

function readSchemaProperties(value: string): unknown[] {
  const parsed = readJsonInput(value, "--schema");
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed) && Array.isArray(parsed.properties)) return parsed.properties;
  throw invalidInput("--schema must be a JSON array of properties or an object with a properties array.");
}

function buildPropertyConfig(config: string | undefined, options: string | undefined): BasesJsonObject | undefined {
  const parsed = config === undefined ? undefined : readJsonObjectInput(config, "--config");
  const shorthand = parseOptionsShorthand(options);
  if (!shorthand) return parsed;
  if (parsed && "options" in parsed) throw invalidInput("Use either --options or config.options, not both.");
  return { ...(parsed ?? {}), options: shorthand };
}

/** Accept a bare `{mark, encoding}` spec as the chart spec. */
function normalizeChartBody(input: BasesJsonObject): BasesJsonObject {
  if ("mark" in input && "encoding" in input && !("spec" in input)) {
    const { mark, encoding, title, ...rest } = input;
    return { ...rest, spec: compact({ mark, encoding, title }) };
  }
  delete input.expectedVersion;
  return input;
}

function withImportProgress(error: CloudAuthError, progress: Record<string, unknown>): CloudAuthError {
  return new CloudAuthError(error.code, error.message, {
    status: error.status,
    issues: error.issues,
    retryAfterMs: error.retryAfterMs,
    retryable: error.retryable,
    requestId: error.requestId,
    details: { ...(error.details ?? {}), importProgress: progress },
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// Errors

const CONSOLE_MESSAGE_CODES = new Set([
  "NOT_FOUND",
  "CONFLICT",
  "VERSION_CONFLICT",
  "PAYLOAD_INVALID",
  "PROJECT_ACCESS_DENIED",
]);

async function runBasesCommand<T>(
  op: string,
  asJson: boolean | undefined,
  deps: BasesCommandDeps,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (!isCloudAuthError(error)) throw error;
    const contract = basesContractError(op, error, deps);
    renderBasesError(contract, asJson);
    throw contract;
  }
}

function basesContractError(op: string, error: CloudAuthError, deps: BasesCommandDeps): ContractError {
  const base = cloudErrorToContractError(op, error);
  const details = (error.details ?? {}) as BaseApiErrorDetails & { importProgress?: Record<string, unknown> };
  const consoleError = typeof details.error === "string" ? details.error : undefined;
  // Bases messages are actionable: local validation text from this CLI, or Console
  // Bases API messages (sanitized). Other codes keep the generic cloud copy.
  const message = CONSOLE_MESSAGE_CODES.has(error.code)
    ? (sanitizePublicContractMessage(error.message) ?? base.message)
    : base.message;
  const issues = mergeIssues(base.details.issues as PublicValidationIssue[] | undefined, details.fieldErrors);
  const missingScopes =
    error.code === "PROJECT_ACCESS_DENIED" || error.code === "ORG_ACCESS_DENIED"
      ? missingBasesScopes(safeCredentials(deps))
      : [];
  return new ContractError(op, error.code, message, base.exitCode, {
    ...base.details,
    ...(consoleError ? { consoleError } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(details.current ? { current: details.current } : {}),
    ...(typeof details.schemaVersion === "number" ? { schemaVersion: details.schemaVersion } : {}),
    ...(details.importProgress ? { importProgress: details.importProgress } : {}),
    ...(missingScopes.length > 0 ? { missingScopes } : {}),
    ...(issues ? { issues } : {}),
    suggestedAction:
      basesSuggestedAction(error.code, consoleError, details, missingScopes) ?? base.details.suggestedAction,
  });
}

function basesSuggestedAction(
  code: string,
  consoleError: string | undefined,
  details: BaseApiErrorDetails & { importProgress?: Record<string, unknown> },
  missingScopes: string[],
): string | undefined {
  if (details.importProgress) {
    return "re-run the same import command with the same file, --map, and --batch; finished batches replay without duplicates";
  }
  if (code === "PROJECT_ACCESS_DENIED" || code === "ORG_ACCESS_DENIED") {
    if (missingScopes.length > 0) {
      return `run 'ravi login' again so this installation gets ${missingScopes.join(" and ")}, then retry`;
    }
    return `ask a project admin for access or read through a view that admits you (--view); a login from before Bases needs 'ravi login' again for ${BASES_READ_SCOPE} and ${BASES_WRITE_SCOPE}`;
  }
  switch (consoleError ?? code.toLowerCase()) {
    case "version_conflict": {
      const version = details.current?.version;
      return version
        ? `the current row is in error.current; merge your change and retry with --expected-version ${version}`
        : "re-read the row with 'ravi bases rows get' and retry with its current --expected-version";
    }
    case "schema_version_conflict":
      return "the schema changed concurrently; re-read it with 'ravi bases props list' and retry";
    case "idempotency_conflict":
      return "this idempotency key was already used with a different body; retry with a new --idempotency-key";
    case "cursor_invalid":
      return "re-run the query without --cursor; cursors expire after 15 minutes and only continue the same query";
    case "unknown_property":
      return "use keys from 'ravi bases props list <base>' or, through a view, from 'ravi bases views show <base> <view>'";
    case "invalid_filter":
      return "fix the Query AST (operators by type are in the bases skill) and retry";
    case "view_invalid":
      return "a base manager must fix the view ('ravi bases views show' then 'ravi bases views update')";
    case "write_escapes_view":
      return "the write would move the row out of the view's filter; change only values the view keeps";
    case "aggregate_too_large":
      return "group by fewer or coarser dimensions, or add a filter";
    case "migration_too_large":
      return "add a new property of the target type and copy values in batches instead of changing the type";
    case "base_archived":
      return "restore the base with 'ravi bases restore <base> --execute' first";
    case "slug_taken":
    case "key_taken":
      return "choose another slug or key and retry";
    case "limit_exceeded":
      return "stay within the Bases limits (rows, properties, views, batch size) and retry";
    case "feature_unavailable":
    case "feature_forbidden":
      return "Bases is not enabled for this organization or project; ask an organization admin to enable it";
    case "validation_failed":
      return "fix the values listed in error.issues and retry";
    default:
      return undefined;
  }
}

function mergeIssues(
  existing: PublicValidationIssue[] | undefined,
  fieldErrors: Record<string, string> | undefined,
): PublicValidationIssue[] | undefined {
  const fromFields = isPlainObject(fieldErrors)
    ? projectPublicIssues(
        Object.entries(fieldErrors).map(([key, message]) => ({
          path: ["values", key],
          code: "invalid",
          message: String(message),
        })),
      )
    : undefined;
  // Field errors replace the generic whole-payload issue derived from the message.
  const rest = fromFields?.length ? (existing ?? []).filter((issue) => issue.path.length > 0) : (existing ?? []);
  const merged = [...(fromFields ?? []), ...rest];
  return merged.length > 0 ? merged.slice(0, 32) : undefined;
}

function safeCredentials(deps: BasesCommandDeps) {
  try {
    return (deps.readCredentials ?? readCloudCredentials)();
  } catch {
    return null;
  }
}

function renderBasesError(error: ContractError, asJson: boolean | undefined): void {
  if (getContext({ localOnly: true })?.suppressCliOutput === true) return;
  const envelope = error.envelope();
  if (asJson) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  console.error(`${error.code}: ${envelope.error.message}`);
  const issues = Array.isArray(envelope.error.issues) ? (envelope.error.issues as PublicValidationIssue[]) : [];
  for (const issue of issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  if (typeof envelope.error.suggestedAction === "string") console.error(`Next: ${envelope.error.suggestedAction}.`);
}

// ---------------------------------------------------------------------------
// Output helpers

/**
 * Single-row writes from an agent session without --idempotency-key still run, with a
 * warning. "Agent session" is the same check that attaches the ledger client hint.
 */
function rowWriteWarnings(deps: BasesCommandDeps, idempotencyKey: string | undefined): string[] {
  if (idempotencyKey) return [];
  return (deps.clientHint ?? currentBasesClientHint)() ? [MISSING_IDEMPOTENCY_KEY_WARNING] : [];
}

function scope(client: RaviBasesClient) {
  return { success: true as const, consoleUrl: client.consoleUrl, projectRef: client.projectRef };
}

function emit(payload: unknown, asJson: boolean | undefined, human: () => void): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  human();
}

function printTable(header: string[], rows: string[][]): void {
  for (const line of renderTable(header, rows)) console.log(line);
}

function printNextPage(nextCommand: string | null | undefined): void {
  if (!nextCommand) return;
  console.log("\nNext page:");
  console.log(`  ${nextCommand}`);
}

function printBaseDetail(detail: BaseDetail): void {
  console.log(`${detail.icon ? `${detail.icon} ` : ""}${detail.name}  (${detail.slug}, ${detail.id})`);
  if (detail.description) console.log(`  ${detail.description}`);
  console.log(
    `  status=${detail.status} rows=${detail.rowCount ?? "-"} schema=v${detail.schemaVersion} version=v${detail.version} timezone=${detail.timezone}`,
  );
  const caps = detail.capabilities;
  console.log(`  You: manage=${caps.manage} readDirect=${caps.readDirect} writeDirect=${caps.writeDirect}`);
  if (detail.properties.length > 0) {
    console.log("\nProperties:");
    printProperties(detail.properties.filter((property) => !property.deletedAt));
  }
  if (detail.views.length > 0) {
    console.log("\nViews:");
    printViews(detail.views);
  }
  if (detail.charts.length > 0) {
    console.log("\nCharts:");
    printTable(
      ["name", "mark", "view", "id"],
      detail.charts.map((chart) => [chart.name, chartMark(chart), chart.viewId, chart.id]),
    );
  }
}

function printProperties(properties: readonly BaseProperty[]): void {
  printTable(
    ["key", "name", "type", "required", "options", "id"],
    properties.map((property) => [
      property.key,
      property.name,
      property.deletedAt ? `${property.type} (deleted)` : property.type,
      property.required ? "yes" : "",
      (property.config.options ?? [])
        .filter((option) => !option.archived)
        .map((option) => option.name)
        .join(", "),
      property.id,
    ]),
  );
}

function printViews(views: readonly BaseAnyView[]): void {
  printTable(
    ["name", "layout", "columns", "access", "id"],
    views.map((view) => [
      view.name,
      String(view.layout.type ?? "table"),
      String(view.columns.length),
      isFullBaseView(view) ? summarizeAccess(view.access) : summarizeCapabilities(view.capabilities),
      view.id,
    ]),
  );
}

function summarizeAccess(access: Record<string, unknown>): string {
  const read = Array.isArray(access.read) ? access.read.length : 0;
  const write =
    isPlainObject(access.write) && Array.isArray(access.write.principals) ? access.write.principals.length : 0;
  return `read:${read} write:${write}`;
}

function summarizeCapabilities(caps: BaseAnyView["capabilities"]): string {
  if (caps.aggregateOnly) return "charts only";
  const parts = [
    caps.read ? "read" : null,
    caps.writeColumns.length > 0 ? "write" : null,
    caps.create ? "create" : null,
  ];
  return parts.filter(Boolean).join("+") || "-";
}

function printRow(row: BaseRow): void {
  console.log(`Row ${row.rowId} v${row.version}${row.archivedAt ? ` (archived ${row.archivedAt})` : ""}`);
  for (const [key, value] of Object.entries(row.values)) console.log(`  ${key}: ${JSON.stringify(value)}`);
  if (row.body) console.log(`\n${row.body}`);
}

function printRowWrite(verb: string, row: BaseRow, replay: boolean, warnings: readonly string[] = []): void {
  console.log(`✓ Row ${verb}: ${row.rowId} v${row.version}${replay ? " (idempotent replay)" : ""}`);
  for (const warning of warnings) console.log(`warning: ${warning}`);
}

function printPropertyMutation(verb: string, result: BasePropertyMutationResponse): void {
  console.log(
    `✓ Property ${verb}: ${result.property.key} (${result.property.type}); schema v${result.base.schemaVersion}`,
  );
  if (result.report) {
    console.log(
      `  rows=${result.report.activeRows} converted=${result.report.converted} cleared=${result.report.cleared} missing=${result.report.missing}`,
    );
  }
}

function printSubscriptions(subscriptions: readonly BaseSubscription[]): void {
  if (subscriptions.length === 0) {
    console.log("No subscriptions.");
    return;
  }
  printTable(
    ["id", "installation", "status", "created"],
    subscriptions.map((subscription) => [
      subscription.id,
      subscription.installationName ?? subscription.localInstallationId,
      subscription.status,
      subscription.createdAt,
    ]),
  );
}

function printImportColumns(columns: readonly CsvImportColumn[]): void {
  printTable(
    ["column", "key", "type", "note"],
    columns.map((column) => [column.column, column.key ?? "-", column.type ?? "-", column.reason ?? ""]),
  );
}

function chartMark(chart: Pick<BaseChart, "spec">): string {
  const mark = chart.spec.mark;
  if (typeof mark === "string") return mark;
  if (isPlainObject(mark) && typeof mark.type === "string") return mark.type;
  return "?";
}

function descriptorFromColumn(
  column: { key: string; name: string; type: string; config: BaseProperty["config"] } | undefined,
) {
  if (!column) return undefined;
  return descriptorsFromViewColumns([{ ...column, required: false }]).get(column.key);
}

function indentJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function cursorPage(limit: number, count: number, nextCursor: string | null, nextCommand: string | null) {
  return { limit, count, hasMore: nextCursor !== null, nextCursor, nextCommand };
}

type CommandToken = string | null | [string, string | number | null | undefined];

/** Shell-quoted command line; flag pairs with an empty value are dropped. */
function commandLine(tokens: ReadonlyArray<CommandToken>): string {
  const parts: string[] = [];
  for (const token of tokens) {
    if (token === null) continue;
    if (Array.isArray(token)) {
      const [flag, value] = token;
      if (value === undefined || value === null || value === "") continue;
      parts.push(flag, String(value));
      continue;
    }
    parts.push(token);
  }
  return parts.map(quoteCommandToken).join(" ");
}

function compact<T extends Record<string, unknown>>(input: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) if (value !== undefined) result[key] = value;
  return result as T;
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw invalidInput(`Missing ${label}.`);
  return text;
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

// ---------------------------------------------------------------------------
// Return contracts

const scopeShape = {
  success: z.literal(true),
  consoleUrl: z.string(),
  projectRef: z.string(),
};

const cursorPageSchema = z.object({
  limit: z.number(),
  count: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  nextCommand: z.string().nullable(),
});

const queryReturnSchema = z.object({
  ...scopeShape,
  baseRef: z.string(),
  viewId: z.string().nullable(),
  columns: z.array(z.string()),
  rows: z.array(baseRowSchema),
  users: basesUsersSchema,
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  pagination: cursorPageSchema,
});

const rowWriteReturnSchema = z.object({
  ...scopeShape,
  baseRef: z.string(),
  viewId: z.string().nullable(),
  row: baseRowSchema,
  users: basesUsersSchema,
  idempotentReplay: z.boolean(),
});

const keyedRowWriteReturnSchema = rowWriteReturnSchema.extend({
  idempotencyKey: z.string(),
  /** Present when an agent session wrote without --idempotency-key. */
  warnings: z.array(z.string()).optional(),
});

const propertyMutationReturnSchema = z.object({
  ...scopeShape,
  base: baseSummarySchema,
  property: basePropertySchema,
  report: basePropertyMigrationReportSchema.nullable(),
});

const baseSummaryReturnSchema = z.object({ ...scopeShape, base: baseSummarySchema });
const viewReturnSchema = z.object({ ...scopeShape, baseRef: z.string(), view: baseViewSchema });
const chartReturnSchema = z.object({ ...scopeShape, baseRef: z.string(), chart: baseChartSchema });
const partialViewSchema = z.union([baseViewSchema.partial(), baseViewPublicSchema.partial()]);
const importColumnSchema = z.object({
  column: z.string(),
  key: z.string().nullable(),
  type: z.string().nullable(),
  skipped: z.boolean(),
  reason: z.string().optional(),
});

declareCommandReturns(BasesCommands, {
  list: z.object({
    ...scopeShape,
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    bases: z.array(baseSummarySchema.partial()),
    items: z.array(baseSummarySchema.partial()),
  }),
  show: z.object({ ...scopeShape, base: baseDetailSchema }),
  create: z.object({ ...scopeShape, base: baseDetailSchema }),
  update: baseSummaryReturnSchema,
  archive: baseSummaryReturnSchema,
  restore: baseSummaryReturnSchema,
  aggregate: z.object({
    ...scopeShape,
    baseRef: z.string(),
    groups: z.array(baseAggregateGroupSchema),
    suppressedGroups: z.number(),
    users: basesUsersSchema,
  }),
  subscribe: z.object({
    ...scopeShape,
    subscription: baseSubscriptionSchema,
    delivery: z.object({ natsSubject: z.string(), category: z.string() }),
  }),
  unsubscribe: z.object({ ...scopeShape, subscription: baseSubscriptionSchema }),
  subscriptions: z.object({ ...scopeShape, baseRef: z.string(), subscriptions: z.array(baseSubscriptionSchema) }),
});

declareCommandReturns(BasesPropsCommands, {
  list: z.object({
    ...scopeShape,
    baseRef: z.string(),
    schemaVersion: z.number(),
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    properties: z.array(basePropertySchema.partial()),
    items: z.array(basePropertySchema.partial()),
  }),
  add: propertyMutationReturnSchema,
  update: propertyMutationReturnSchema,
  delete: propertyMutationReturnSchema,
  restore: propertyMutationReturnSchema,
});

declareCommandReturns(BasesRowsCommands, {
  query: queryReturnSchema,
  get: z.object({
    ...scopeShape,
    baseRef: z.string(),
    viewId: z.string().nullable(),
    row: baseRowSchema,
    users: basesUsersSchema,
  }),
  add: keyedRowWriteReturnSchema,
  update: keyedRowWriteReturnSchema,
  archive: rowWriteReturnSchema,
  restore: rowWriteReturnSchema,
  purge: z.object({ ...scopeShape, baseRef: z.string(), purged: z.boolean(), rowId: z.string() }),
  history: z.object({
    ...scopeShape,
    baseRef: z.string(),
    viewId: z.string().nullable(),
    entries: z.array(baseLedgerEntrySchema),
    users: basesUsersSchema,
    nextCursor: z.string().nullable(),
    pagination: cursorPageSchema,
  }),
  import: z.object({
    ...scopeShape,
    baseRef: z.string(),
    file: z.string(),
    rowCount: z.number(),
    created: z.number(),
    emptyRowsSkipped: z.number(),
    batchCount: z.number(),
    batches: z.array(
      z.object({
        index: z.number(),
        rowCount: z.number(),
        idempotencyKey: z.string(),
        idempotentReplay: z.boolean(),
        firstRowId: z.string().nullable(),
        lastRowId: z.string().nullable(),
      }),
    ),
    columns: z.array(importColumnSchema),
  }),
  export: z.object({
    ...scopeShape,
    baseRef: z.string(),
    viewId: z.string().nullable(),
    format: z.string(),
    rowCount: z.number(),
    columns: z.array(z.string()),
    truncated: z.boolean(),
    outFile: z.string().nullable(),
    content: z.string().nullable(),
  }),
});

declareCommandReturns(BasesViewsCommands, {
  list: z.object({
    ...scopeShape,
    baseRef: z.string(),
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    views: z.array(partialViewSchema),
    items: z.array(partialViewSchema),
  }),
  show: z.object({ ...scopeShape, baseRef: z.string(), view: baseViewDescribeSchema }),
  create: viewReturnSchema,
  update: viewReturnSchema,
  archive: viewReturnSchema,
  query: queryReturnSchema,
});

declareCommandReturns(BasesChartsCommands, {
  list: z.object({
    ...scopeShape,
    baseRef: z.string(),
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    charts: z.array(baseChartSchema.partial()),
    items: z.array(baseChartSchema.partial()),
  }),
  show: chartReturnSchema,
  create: chartReturnSchema,
  update: chartReturnSchema,
  archive: chartReturnSchema,
  data: baseChartDataResponseSchema.extend({ ...scopeShape, baseRef: z.string() }),
});
