import "reflect-metadata";
import { z } from "zod";
import { MerchantClient } from "../../apps/merchant/client.js";
import { merchantOfficialContract, merchantOperationMatrix } from "../../apps/merchant/contract.js";
import { fail } from "../context.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { jsonObjectSchema } from "../return-schemas.js";

const resultSchema = z.object({ result: jsonObjectSchema }).strict();
const idSchema = z.string().trim().min(1);
const accountSchema = z.string().regex(/^\d+$/, "Merchant account id must contain only digits.");
const pageSizeSchema = z.string().regex(/^\d+$/, "Page size must be a positive integer.");
const merchantRiskSchema = z.enum(["read", "write", "destructive", "financial", "setup"]);
const merchantDecisionSchema = z.enum(["migrar", "adicionar", "estudar", "ignorar", "aguardar"]);
const merchantOperationMatrixEntrySchema = z
  .object({
    operacao_sde: z.string(),
    categoria: z.string(),
    risco_read_write: merchantRiskSchema,
    endpoint_ou_recurso_oficial: z.string(),
    status_decisao: merchantDecisionSchema,
    justificativa: z.string(),
    fonte_oficial: z.string().url(),
    observacoes_para_ravi_dev: z.string(),
    operacao_ravi: z.string().nullable(),
  })
  .strict();
const merchantPaginationSchema = z
  .object({
    limit: z.number().int(),
    offset: z.number().int(),
    returned: z.number().int(),
    total: z.number().int(),
    hasMore: z.boolean(),
    nextOffset: z.number().int().nullable(),
    nextCommand: z.string().nullable(),
  })
  .strict();
const merchantContractReturnSchema = z
  .object({
    confirmed_official_contract: z.literal("yes"),
    official_contract: z.object({
      confirmed: z.literal(true),
      verifiedAt: z.string(),
      baseUrl: z.string().url(),
      oauthScope: z.string().url(),
      stableSubApis: z.array(z.string()),
      limitedSubApis: z.array(z.string()),
      sources: z.array(z.string().url()),
    }),
    summary: z.object({
      legacyOperations: z.number().int(),
      byRisk: z
        .object({
          read: z.number().int(),
          write: z.number().int(),
          destructive: z.number().int(),
          financial: z.number().int(),
          setup: z.number().int(),
        })
        .strict(),
      byDecision: z
        .object({
          migrar: z.number().int(),
          adicionar: z.number().int(),
          estudar: z.number().int(),
          ignorar: z.number().int(),
          aguardar: z.number().int(),
        })
        .strict(),
    }),
    pagination: merchantPaginationSchema,
    operation_matrix: z.array(merchantOperationMatrixEntrySchema),
  })
  .strict();

@Group({
  name: "merchant",
  description: "Operate Google Merchant API through the native Ravi App (Phase 1 authentication is closed)",
  scope: "open",
})
export class MerchantCommands {
  private client(connection?: string) {
    return new MerchantClient({ connection });
  }

  @Command({
    name: "contract",
    description: "Show the verified official contract and the complete SDE migration decision matrix",
    helpAfter: `
USE
  Inspect what is implemented, deferred, under study, destructive, or financial before invoking Merchant operations.

NÃO USE
  This command does not validate credentials or call Google. Authentication remains a Phase 2 concern.

EXAMPLES
  ravi merchant contract --json --limit 50 --offset 0
  ravi merchant contract --json | jq '.summary, [.operation_matrix[] | select(.status_decisao == "estudar")]'

ON ERROR
  If the matrix no longer matches sde merchant --help, update the inventory from public help only; never read legacy token files.

FONTES
  Google Merchant API Discovery directory and versioning guide, verified 2026-07-13.`,
  })
  @CommandAccess({ kind: "read", resource: "merchant.contract", action: "show", risk: "low" })
  @Returns(merchantContractReturnSchema)
  async contract(
    @Option({ flags: "--limit <n>", description: "Matrix page size (default: 50, max: 160)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of legacy operations to skip (default: 0)" })
    offset?: string,
  ) {
    const page = paginateCliItems(merchantOperationMatrix, { limit, offset }, { maxLimit: 160 });
    const payload = {
      confirmed_official_contract: "yes" as const,
      official_contract: merchantOfficialContract,
      summary: {
        legacyOperations: merchantOperationMatrix.length,
        byRisk: countBy(
          merchantOperationMatrix.map((entry) => entry.risco_read_write),
          ["read", "write", "destructive", "financial", "setup"],
        ),
        byDecision: countBy(
          merchantOperationMatrix.map((entry) => entry.status_decisao),
          ["migrar", "adicionar", "estudar", "ignorar", "aguardar"],
        ),
      },
      pagination: buildCliOffsetPagination({
        baseCommand: ["ravi", "merchant", "contract"],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
      }),
      operation_matrix: page.items,
    };
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  @Command({ name: "accounts", description: "List Merchant Center accounts available to the future Ravi credential" })
  @CommandAccess({ kind: "read", resource: "merchant.accounts", action: "list", risk: "low" })
  @Returns(resultSchema)
  async accounts(
    @Option({ flags: "--page-size <n>", description: "Maximum accounts (1-500)", schema: pageSizeSchema })
    pageSize?: string,
    @Option({ flags: "--page-token <token>", description: "Token returned by the preceding page" })
    pageToken?: string,
    @Option({ flags: "--connection <id>", description: "Ravi credential connection reserved for Phase 2" })
    connection?: string,
  ) {
    return output(await this.client(connection).listAccounts(listOptions(pageSize, pageToken, 500)));
  }

  @Command({ name: "account-get", description: "Get one Merchant Center account by numeric account id" })
  @CommandAccess({ kind: "read", resource: "merchant.accounts", action: "get", risk: "low" })
  @Returns(resultSchema)
  async accountGet(
    @Arg("account", { description: "Numeric Merchant Center account id", schema: accountSchema }) account: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).getAccount(account));
  }

  @Command({ name: "account-issues", description: "List issues currently affecting a Merchant Center account" })
  @CommandAccess({ kind: "read", resource: "merchant.account-issues", action: "list", risk: "low" })
  @Returns(resultSchema)
  async accountIssues(
    @Arg("account", { schema: accountSchema }) account: string,
    @Option({ flags: "--page-size <n>", schema: pageSizeSchema }) pageSize?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).listAccountIssues(account, listOptions(pageSize, pageToken)));
  }

  @Command({ name: "products", description: "List processed products and their Merchant status" })
  @CommandAccess({ kind: "read", resource: "merchant.products", action: "list", risk: "low" })
  @Returns(resultSchema)
  async products(
    @Arg("account", { schema: accountSchema }) account: string,
    @Option({ flags: "--page-size <n>", schema: pageSizeSchema }) pageSize?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).listProducts(account, listOptions(pageSize, pageToken)));
  }

  @Command({ name: "product-get", description: "Get one processed product by plain or base64url product id" })
  @CommandAccess({ kind: "read", resource: "merchant.products", action: "get", risk: "low" })
  @Returns(resultSchema)
  async productGet(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("product", {
      description: "Product resource id; use Google's base64url form for reserved characters",
      schema: idSchema,
    })
    product: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).getProduct(account, product));
  }

  @Command({
    name: "report-search",
    description: "Run a Merchant API Query Language report with explicit query text",
  })
  @CommandAccess({ kind: "read", resource: "merchant.reports", action: "search", risk: "low" })
  @Returns(resultSchema)
  async reportSearch(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("query", { description: "Merchant API Query Language SELECT statement", schema: idSchema }) query: string,
    @Option({ flags: "--page-size <n>", description: "Rows, maximum 100000", schema: pageSizeSchema })
    pageSize?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(
      await this.client(connection).searchReports(account, {
        query,
        ...listOptions(pageSize, pageToken, 100_000),
      }),
    );
  }

  @Command({ name: "data-sources", description: "List product, inventory, promotion and review data sources" })
  @CommandAccess({ kind: "read", resource: "merchant.data-sources", action: "list", risk: "low" })
  @Returns(resultSchema)
  async dataSources(
    @Arg("account", { schema: accountSchema }) account: string,
    @Option({ flags: "--page-size <n>", schema: pageSizeSchema }) pageSize?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).listDataSources(account, listOptions(pageSize, pageToken)));
  }

  @Command({ name: "data-source-get", description: "Get one Merchant data source" })
  @CommandAccess({ kind: "read", resource: "merchant.data-sources", action: "get", risk: "low" })
  @Returns(resultSchema)
  async dataSourceGet(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).getDataSource(account, dataSource));
  }

  @Command({ name: "promotions", description: "List Merchant promotions" })
  @CommandAccess({ kind: "read", resource: "merchant.promotions", action: "list", risk: "low" })
  @Returns(resultSchema)
  async promotions(
    @Arg("account", { schema: accountSchema }) account: string,
    @Option({ flags: "--page-size <n>", schema: pageSizeSchema }) pageSize?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).listPromotions(account, listOptions(pageSize, pageToken)));
  }

  @Command({ name: "promotion-get", description: "Get one Merchant promotion" })
  @CommandAccess({ kind: "read", resource: "merchant.promotions", action: "get", risk: "low" })
  @Returns(resultSchema)
  async promotionGet(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("promotion", { schema: idSchema }) promotion: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return output(await this.client(connection).getPromotion(account, promotion));
  }

  @Command({
    name: "product-insert",
    description: "Insert or replace a product input (write; unavailable until Phase 2 credential onboarding)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.product-inputs",
    action: "insert",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async productInsert(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--body <json>", description: "ProductInput JSON body" }) body?: string,
    @Option({ flags: "--dry-run", description: "Return the write preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm", description: "Confirm this Merchant mutation" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const parsedBody = jsonObject(body);
    if (dryRun) return output(writePreview("product-insert", { account, dataSource, body: parsedBody }));
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).insertProduct(account, dataSource, parsedBody));
  }

  @Command({
    name: "product-patch",
    description: "Patch selected product input fields (write; unavailable until Phase 2 credential onboarding)",
    helpAfter: `
USE
  Patch explicit top-level ProductInput fields only when the API data source is authoritative.

NÃO USE
  Do not use for the primary Tray-managed feed. Change its source of truth instead.

REGRAS HARD
  --update-mask and --confirm are mandatory. Full replacement with '*' is rejected.

EXAMPLES
  ravi merchant product-patch 123 en~BR~sku 456 --update-mask productAttributes.title --body '{"productAttributes":{"title":"Example"}}' --confirm --json
  ravi merchant contract --json

ON ERROR
  Missing credential is expected in Phase 1. Do not import a legacy SDE token.

FONTES
  Google Merchant API products_v1 productInputs.patch, verified 2026-07-13.`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.product-inputs",
    action: "patch",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async productPatch(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("productInput", { schema: idSchema }) productInput: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--update-mask <fields>", description: "Required comma-separated top-level field mask" })
    updateMask?: string,
    @Option({ flags: "--body <json>", description: "ProductInput JSON body" }) body?: string,
    @Option({ flags: "--dry-run", description: "Return the write preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm", description: "Confirm this Merchant mutation" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    requireUpdateMask(updateMask);
    const parsedBody = jsonObject(body);
    if (dryRun) {
      return output(writePreview("product-patch", { account, productInput, dataSource, updateMask, body: parsedBody }));
    }
    requireWritePromotion(confirm, connection);
    return output(
      await this.client(connection).patchProduct(account, productInput, dataSource, updateMask, parsedBody),
    );
  }

  @Command({
    name: "product-delete",
    description: "Delete a product input from one data source (destructive; explicit confirmation required)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.product-inputs",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async productDelete(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("productInput", { schema: idSchema }) productInput: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--dry-run", description: "Return the destructive preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm", description: "Confirm destructive deletion" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    if (dryRun) return output(writePreview("product-delete", { account, productInput, dataSource }));
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).deleteProductInput(account, productInput, dataSource));
  }

  @Command({ name: "data-source-create", description: "Create a Merchant data source (write)" })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.data-sources",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async dataSourceCreate(
    @Arg("account", { schema: accountSchema }) account: string,
    @Option({ flags: "--body <json>", description: "DataSource JSON body" }) body?: string,
    @Option({ flags: "--dry-run", description: "Return the write preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const parsedBody = jsonObject(body);
    if (dryRun) return output(writePreview("data-source-create", { account, body: parsedBody }));
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).createDataSource(account, parsedBody));
  }

  @Command({ name: "data-source-update", description: "Patch explicitly selected fields of a Merchant data source" })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.data-sources",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async dataSourceUpdate(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--update-mask <fields>", description: "Required comma-separated field mask" })
    updateMask?: string,
    @Option({ flags: "--body <json>", description: "DataSource JSON body" }) body?: string,
    @Option({ flags: "--dry-run", description: "Return the write preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    requireUpdateMask(updateMask);
    const parsedBody = jsonObject(body);
    if (dryRun) {
      return output(writePreview("data-source-update", { account, dataSource, updateMask, body: parsedBody }));
    }
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).updateDataSource(account, dataSource, updateMask, parsedBody));
  }

  @Command({ name: "data-source-fetch", description: "Trigger the configured fetch for a file data source (write)" })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.data-sources",
    action: "fetch",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async dataSourceFetch(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--dry-run", description: "Return the write preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    if (dryRun) return output(writePreview("data-source-fetch", { account, dataSource }));
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).fetchDataSource(account, dataSource));
  }

  @Command({ name: "data-source-delete", description: "Delete a Merchant data source (destructive)" })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.data-sources",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async dataSourceDelete(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--dry-run", description: "Return the destructive preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm", description: "Confirm destructive deletion" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    if (dryRun) return output(writePreview("data-source-delete", { account, dataSource }));
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).deleteDataSource(account, dataSource));
  }

  @Command({ name: "promotion-insert", description: "Insert a Merchant promotion (write)" })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.promotions",
    action: "insert",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async promotionInsert(
    @Arg("account", { schema: accountSchema }) account: string,
    @Arg("dataSource", { schema: idSchema }) dataSource: string,
    @Option({ flags: "--body <json>", description: "Promotion JSON body" }) body?: string,
    @Option({ flags: "--dry-run", description: "Return the write preview without calling Google Merchant API" })
    dryRun?: boolean,
    @Option({ flags: "--confirm" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const parsedBody = jsonObject(body);
    if (dryRun) return output(writePreview("promotion-insert", { account, dataSource, promotion: parsedBody }));
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).insertPromotion(account, dataSource, parsedBody));
  }

  @Command({
    name: "order-tracking-create",
    description: "Submit an order tracking signal (financially sensitive; explicit confirmation required)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "merchant.order-tracking",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["orderId", "deliveryPostalCode", "shippingInfo", "lineItems"],
  })
  @Returns(resultSchema)
  async orderTrackingCreate(
    @Arg("account", { schema: accountSchema }) account: string,
    @Option({ flags: "--body <json>", description: "OrderTrackingSignal JSON body (never logged)" }) body?: string,
    @Option({
      flags: "--dry-run",
      description: "Return the financial write preview without calling Google Merchant API",
    })
    dryRun?: boolean,
    @Option({ flags: "--confirm" }) confirm?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const parsedBody = jsonObject(body);
    if (dryRun)
      return output(writePreview("order-tracking-create", { account, body: redactFinancialBody(parsedBody) }));
    requireWritePromotion(confirm, connection);
    return output(await this.client(connection).createOrderTrackingSignal(account, parsedBody));
  }
}

for (const command of [
  "contract",
  "accounts",
  "accountGet",
  "accountIssues",
  "products",
  "productGet",
  "reportSearch",
  "dataSources",
  "dataSourceGet",
  "promotions",
  "promotionGet",
  "productInsert",
  "productPatch",
  "productDelete",
  "dataSourceCreate",
  "dataSourceUpdate",
  "dataSourceFetch",
  "dataSourceDelete",
  "promotionInsert",
  "orderTrackingCreate",
] as const) {
  const method = MerchantCommands.prototype[command];
  Option({ flags: "--json", description: "Print the stable JSON response envelope" })(
    MerchantCommands.prototype,
    command,
    method.length,
  );
}

function output(result: Record<string, unknown>) {
  const payload = { result };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

function listOptions(pageSize?: string, pageToken?: string, maximum = 1000) {
  const parsed = pageSize === undefined ? undefined : Number(pageSize);
  if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum)) {
    fail(`--page-size must be an integer from 1 to ${maximum}.`);
  }
  return { pageSize: parsed, pageToken };
}

function jsonObject(value?: string): Record<string, unknown> {
  if (!value?.trim()) fail("--body must contain a JSON object.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("--body must contain valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("--body must contain a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireWritePromotion(confirm?: boolean, connection?: string): void {
  if (confirm !== true) fail("This Merchant mutation requires explicit --confirm.");
  fail(
    `Merchant writes are promotion-blocked in this task${connection ? ` (connection: ${connection})` : ""}. ` +
      "Use --dry-run for contract validation; live writes require separate credential, permission and cutover approval.",
  );
}

function requireUpdateMask(updateMask?: string): asserts updateMask is string {
  if (!updateMask?.trim() || updateMask.trim() === "*") {
    fail("--update-mask is required and '*' full replacement is not supported by Merchant API v1.");
  }
}

function countBy<const T extends string>(values: T[], keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, values.filter((value) => value === key).length])) as Record<
    T,
    number
  >;
}

function writePreview(operation: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    dryRun: true,
    liveRequestBlocked: true,
    operation,
    input,
    nextAction:
      "Review the normalized request and keep this in dry-run until Merchant credentials, permissions, quota policy and HITL promotion are approved.",
  };
}

function redactFinancialBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) =>
      ["orderId", "deliveryPostalCode", "shippingInfo", "lineItems"].includes(key) ? [key, "[REDACTED]"] : [key, value],
    ),
  );
}
