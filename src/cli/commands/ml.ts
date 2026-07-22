import { z } from "zod";
import { MlClient, type MlJsonObject } from "../../apps/mercado-livre/client.js";
import { mlOfficialSources } from "../../apps/mercado-livre/contract.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { jsonValueSchema } from "../return-schemas.js";

const resultSchema = z.object({ result: jsonValueSchema }).strict();
const nonEmptySchema = z.string().trim().min(1);
const numericIdSchema = z.string().regex(/^\d+$/, "Expected a numeric Mercado Livre id.");
const itemIdSchema = z.string().regex(/^ML[A-Z]{1,2}\d+$/, "Expected an item id such as MLB1234567890.");
const siteIdSchema = z.string().regex(/^ML[A-Z]$/, "Expected a site id such as MLB, MLA or MLM.");
const categoryIdSchema = z.string().regex(/^ML[A-Z]\d+$/, "Expected a category id such as MLB1051.");
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected date in YYYY-MM-DD format.");
const mlJsonObjectSchema = z.object({}).catchall(jsonValueSchema);
const structuredArraySchema = z.array(mlJsonObjectSchema);
const itemPatchFields = [
  "title",
  "available_quantity",
  "seller_custom_field",
  "pictures",
  "attributes",
  "shipping",
  "sale_terms",
] as const;
const itemCreateSchema = mlJsonObjectSchema
  .extend({
    title: z.string().trim().min(1).max(60),
    category_id: categoryIdSchema,
    price: z.number().positive(),
    currency_id: z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter currency code such as BRL."),
    available_quantity: z.number().int().min(0),
    buying_mode: z.enum(["buy_it_now", "auction"]),
    listing_type_id: z.string().trim().min(1),
    pictures: structuredArraySchema.optional(),
    attributes: structuredArraySchema.optional(),
    shipping: mlJsonObjectSchema.optional(),
    sale_terms: structuredArraySchema.optional(),
    seller_custom_field: z.string().trim().min(1).optional(),
  })
  .passthrough();
const itemPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(60).optional(),
    available_quantity: z.number().int().min(0).optional(),
    seller_custom_field: z.string().trim().min(1).optional(),
    pictures: structuredArraySchema.optional(),
    attributes: structuredArraySchema.optional(),
    shipping: mlJsonObjectSchema.optional(),
    sale_terms: structuredArraySchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "--body must change at least one safe item field.");
const connectionOption = {
  flags: "--connection <id>",
  description: "Ravi credential connection reserved for Phase 2 (default: default)",
};
const confirmOption = { flags: "--confirm", description: "Confirm this external mutation explicitly" };
const dryRunOption = {
  flags: "--dry-run",
  description: "Validate and return a mutation plan without resolving credentials or calling Mercado Livre",
};
const offsetOption = { flags: "--offset <n>", description: "Provider result offset (default: 0)", defaultValue: "0" };

@Group({
  name: "ml",
  description: "Operate the native Mercado Livre App; Phase 1 authentication is intentionally closed",
  scope: "open",
})
export class MlCommands {
  private client(connection?: string) {
    return new MlClient({ connection });
  }

  @Command({
    name: "seller",
    description: "Get the seller profile authorized by the future Ravi credential",
    helpAfter: readHelp("ravi ml seller --json", "Inspect seller identity and reputation", mlOfficialSources.auth),
  })
  @CommandAccess({ kind: "read", resource: "ml.seller", action: "get", risk: "medium", redactions: ["email", "phone"] })
  @Returns(resultSchema)
  async seller(@Option(connectionOption) connection?: string) {
    return output(await this.client(connection).getSeller());
  }

  @Command({
    name: "items",
    description: "List a seller's item ids with bounded Mercado Livre pagination",
    helpAfter: readHelp(
      "ravi ml items 123456 --status active --limit 50 --json",
      "Find listings owned by one seller",
      mlOfficialSources.itemSearch,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.catalog", action: "list", risk: "low" })
  @Returns(resultSchema)
  async items(
    @Arg("seller", { description: "Numeric seller id", schema: numericIdSchema }) seller: string,
    @Option({ flags: "--status <status>", description: "Optional item status filter" }) status?: string,
    @Option({ flags: "--sku <sku>", description: "Optional seller SKU filter" }) sku?: string,
    @Option(limitOption(50)) limit?: string,
    @Option(offsetOption) offset?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).listItems(seller, { status, sku, ...page(limit, offset, 50) }));
  }

  @Command({
    name: "item-get",
    description: "Get one Mercado Livre item by id",
    helpAfter: readHelp(
      "ravi ml item-get MLB1234567890 --json",
      "Inspect one listing before a mutation",
      mlOfficialSources.items,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.catalog", action: "get", risk: "low" })
  @Returns(resultSchema)
  async itemGet(@Arg("item", { schema: itemIdSchema }) item: string, @Option(connectionOption) connection?: string) {
    return output(await this.client(connection).getItem(item));
  }

  @Command({
    name: "items-get",
    description: "Get up to 20 Mercado Livre items in one official multiget",
    helpAfter: readHelp(
      "ravi ml items-get MLB1234567890,MLB1234567891 --json",
      "Inspect several known item ids",
      mlOfficialSources.itemSearch,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.catalog", action: "multiget", risk: "low" })
  @Returns(resultSchema)
  async itemsGet(
    @Arg("items", { description: "Comma-separated item ids" }) items: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getItems(csvIds(items, 20, itemIdSchema, "item ids")));
  }

  @Command({
    name: "item-description",
    description: "Get the plain-text description resource for an item",
    helpAfter: readHelp(
      "ravi ml item-description MLB1234567890 --json",
      "Read the description omitted from /items",
      mlOfficialSources.descriptions,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.catalog", action: "description.get", risk: "low" })
  @Returns(resultSchema)
  async itemDescription(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getItemDescription(item));
  }

  @Command({
    name: "item-visits",
    description: "Get daily visits for one item over at most 150 days",
    helpAfter: readHelp(
      "ravi ml item-visits MLB1234567890 --last 30 --json",
      "Inspect listing traffic",
      mlOfficialSources.visits,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.metrics", action: "item-visits", risk: "low" })
  @Returns(resultSchema)
  async itemVisits(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Option({ flags: "--last <days>", description: "Days in the window, 1-150", defaultValue: "30" }) last?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getItemVisits(item, integer(last, 30, 1, 150, "--last")));
  }

  @Command({
    name: "items-visits",
    description: "Get total visits for up to 50 item ids",
    helpAfter: readHelp(
      "ravi ml items-visits MLB1234567890,MLB1234567891 --json",
      "Compare traffic for known items",
      mlOfficialSources.visits,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.metrics", action: "items-visits", risk: "low" })
  @Returns(resultSchema)
  async itemsVisits(
    @Arg("items", { description: "Comma-separated item ids" }) items: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getItemsVisits(csvIds(items, 50, itemIdSchema, "item ids")));
  }

  @Command({
    name: "item-prices",
    description: "Read current standard and promotional prices; price writes are not available in Phase 1",
    helpAfter: readHelp(
      "ravi ml item-prices MLB1234567890 --json",
      "Use the current Prices resource instead of deprecated /items fields",
      mlOfficialSources.prices,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.financial", action: "item-prices", risk: "medium" })
  @Returns(resultSchema)
  async itemPrices(@Arg("item", { schema: itemIdSchema }) item: string, @Option(connectionOption) connection?: string) {
    return output(await this.client(connection).getItemPrices(item));
  }

  @Command({
    name: "orders",
    description: "Search seller orders with official filters and bounded pagination",
    helpAfter: readHelp(
      "ravi ml orders 123456 --status paid --from 2026-07-01 --limit 50 --json",
      "Find seller orders for fulfillment or audit",
      mlOfficialSources.orders,
    ),
  })
  @CommandAccess({
    kind: "read",
    resource: "ml.sales",
    action: "orders.search",
    risk: "medium",
    redactions: ["buyer", "shipping"],
  })
  @Returns(resultSchema)
  async orders(
    @Arg("seller", { schema: numericIdSchema }) seller: string,
    @Option({ flags: "--status <status>", description: "Order status such as paid or cancelled" }) status?: string,
    @Option({ flags: "--from <date>", description: "Created from YYYY-MM-DD", schema: dateSchema }) from?: string,
    @Option({ flags: "--to <date>", description: "Created through YYYY-MM-DD", schema: dateSchema }) to?: string,
    @Option(limitOption(50)) limit?: string,
    @Option(offsetOption) offset?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(
      await this.client(connection).listOrders(seller, {
        status,
        dateFrom: from ? `${from}T00:00:00.000-00:00` : undefined,
        dateTo: to ? `${to}T23:59:59.999-00:00` : undefined,
        ...page(limit, offset, 50),
      }),
    );
  }

  @Command({
    name: "order-get",
    description: "Get one order by numeric id",
    helpAfter: readHelp(
      "ravi ml order-get 2000010733434062 --json",
      "Inspect a selected order",
      mlOfficialSources.orders,
    ),
  })
  @CommandAccess({
    kind: "read",
    resource: "ml.sales",
    action: "order.get",
    risk: "medium",
    redactions: ["buyer", "shipping"],
  })
  @Returns(resultSchema)
  async orderGet(
    @Arg("order", { schema: numericIdSchema }) order: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getOrder(order));
  }

  @Command({
    name: "order-billing",
    description: "Resolve buyer.billing_info.id and read the current billing-info resource",
    helpAfter: readHelp(
      "ravi ml order-billing 2000010733434062 --site MLB --json",
      "Obtain fiscal buyer data through the replacement for the deprecated endpoint",
      mlOfficialSources.billing,
    ),
  })
  @CommandAccess({
    kind: "read",
    resource: "ml.financial",
    action: "billing.get",
    risk: "high",
    redactions: ["identification", "address", "doc_number"],
  })
  @Returns(resultSchema)
  async orderBilling(
    @Arg("order", { schema: numericIdSchema }) order: string,
    @Option({ flags: "--site <id>", description: "Mercado Livre site id", defaultValue: "MLB", schema: siteIdSchema })
    site?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getOrderBillingInfo(order, site ?? "MLB"));
  }

  @Command({
    name: "order-notes",
    description: "List seller notes attached to one order",
    helpAfter: readHelp(
      "ravi ml order-notes 2000010733434062 --json",
      "Read operational notes without modifying them",
      mlOfficialSources.orderNotes,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.sales", action: "order-notes.list", risk: "low" })
  @Returns(resultSchema)
  async orderNotes(
    @Arg("order", { schema: numericIdSchema }) order: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getOrderNotes(order));
  }

  @Command({
    name: "shipment-get",
    description: "Get one shipment using the current x-format-new contract",
    helpAfter: readHelp(
      "ravi ml shipment-get 40000123456 --json",
      "Inspect logistics status for one shipment",
      mlOfficialSources.shipments,
    ),
  })
  @CommandAccess({
    kind: "read",
    resource: "ml.shipping",
    action: "get",
    risk: "medium",
    redactions: ["receiver_address", "destination"],
  })
  @Returns(resultSchema)
  async shipmentGet(
    @Arg("shipment", { schema: numericIdSchema }) shipment: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getShipment(shipment));
  }

  @Command({
    name: "shipment-costs",
    description: "Read final receiver and seller shipment costs",
    helpAfter: readHelp(
      "ravi ml shipment-costs 40000123456 --json",
      "Reconcile who paid shipment costs",
      mlOfficialSources.shipments,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.financial", action: "shipment-costs.get", risk: "medium" })
  @Returns(resultSchema)
  async shipmentCosts(
    @Arg("shipment", { schema: numericIdSchema }) shipment: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getShipmentCosts(shipment));
  }

  @Command({
    name: "shipment-history",
    description: "Read the status history for one shipment",
    helpAfter: readHelp(
      "ravi ml shipment-history 40000123456 --json",
      "Diagnose shipment transitions",
      mlOfficialSources.shipments,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.shipping", action: "history", risk: "low" })
  @Returns(resultSchema)
  async shipmentHistory(
    @Arg("shipment", { schema: numericIdSchema }) shipment: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getShipmentHistory(shipment));
  }

  @Command({
    name: "questions",
    description: "List seller questions through api_version=4",
    helpAfter: readHelp(
      "ravi ml questions 123456 --status UNANSWERED --limit 50 --json",
      "Find questions awaiting an answer",
      mlOfficialSources.questions,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.communication", action: "questions.list", risk: "medium" })
  @Returns(resultSchema)
  async questions(
    @Arg("seller", { schema: numericIdSchema }) seller: string,
    @Option({ flags: "--status <status>", description: "Question status such as UNANSWERED" }) status?: string,
    @Option(limitOption(50)) limit?: string,
    @Option(offsetOption) offset?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).listQuestions(seller, { status, ...page(limit, offset, 50) }));
  }

  @Command({
    name: "pack-get",
    description: "Get the orders and optional shipment associated with one pack",
    helpAfter: readHelp(
      "ravi ml pack-get 2000006181551917 --json",
      "Resolve pack relationships before reading orders",
      mlOfficialSources.packs,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.sales", action: "pack.get", risk: "medium" })
  @Returns(resultSchema)
  async packGet(@Arg("pack", { schema: numericIdSchema }) pack: string, @Option(connectionOption) connection?: string) {
    return output(await this.client(connection).getPack(pack));
  }

  @Command({
    name: "category-get",
    description: "Get category hierarchy and constraints by category id",
    helpAfter: readHelp(
      "ravi ml category-get MLB1051 --json",
      "Inspect category constraints before item creation",
      mlOfficialSources.categories,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.catalog", action: "category.get", risk: "low" })
  @Returns(resultSchema)
  async categoryGet(
    @Arg("category", { schema: categoryIdSchema }) category: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getCategory(category));
  }

  @Command({
    name: "trends",
    description: "Get weekly search trends for a site and optional category",
    helpAfter: readHelp(
      "ravi ml trends --site MLB --category MLB1051 --json",
      "Explore official weekly search trends",
      mlOfficialSources.trends,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.metrics", action: "trends", risk: "low" })
  @Returns(resultSchema)
  async trends(
    @Option({ flags: "--site <id>", defaultValue: "MLB", schema: siteIdSchema }) site?: string,
    @Option({ flags: "--category <id>", schema: categoryIdSchema }) category?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getTrends(site ?? "MLB", category));
  }

  @Command({
    name: "highlights",
    description: "Get the official best-selling highlights for one category",
    helpAfter: readHelp(
      "ravi ml highlights MLB432825 --site MLB --json",
      "Read the official top products for a category",
      mlOfficialSources.highlights,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.metrics", action: "highlights", risk: "low" })
  @Returns(resultSchema)
  async highlights(
    @Arg("category", { schema: categoryIdSchema }) category: string,
    @Option({ flags: "--site <id>", defaultValue: "MLB", schema: siteIdSchema }) site?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getHighlights(site ?? "MLB", category));
  }

  @Command({
    name: "messages",
    description: "List post-sale messages for a pack and seller",
    helpAfter: readHelp(
      "ravi ml messages 2000000089077943 415458330 --limit 50 --json",
      "Read an existing post-sale conversation",
      mlOfficialSources.messages,
    ),
  })
  @CommandAccess({
    kind: "read",
    resource: "ml.communication",
    action: "messages.list",
    risk: "medium",
    redactions: ["text", "attachments"],
  })
  @Returns(resultSchema)
  async messages(
    @Arg("pack", { schema: numericIdSchema }) pack: string,
    @Arg("seller", { schema: numericIdSchema }) seller: string,
    @Option(limitOption(50)) limit?: string,
    @Option(offsetOption) offset?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).listMessages(pack, seller, page(limit, offset, 50)));
  }

  @Command({
    name: "claims",
    description: "Search seller claims with the required bounded respondent filter",
    helpAfter: readHelp(
      "ravi ml claims 123456 --status opened --limit 30 --json",
      "Find claims associated with one seller",
      mlOfficialSources.claims,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.claims", action: "search", risk: "medium" })
  @Returns(resultSchema)
  async claims(
    @Arg("seller", { schema: numericIdSchema }) seller: string,
    @Option({ flags: "--status <status>", defaultValue: "opened" }) status?: string,
    @Option({ flags: "--stage <stage>", description: "Optional claim stage" }) stage?: string,
    @Option(limitOption(100)) limit?: string,
    @Option(offsetOption) offset?: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).listClaims(seller, { status, stage, ...page(limit, offset, 100) }));
  }

  @Command({
    name: "claim-get",
    description: "Get one post-purchase claim",
    helpAfter: readHelp(
      "ravi ml claim-get 5281510459 --json",
      "Inspect claim status and available actions",
      mlOfficialSources.claims,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.claims", action: "get", risk: "medium" })
  @Returns(resultSchema)
  async claimGet(
    @Arg("claim", { schema: numericIdSchema }) claim: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getClaim(claim));
  }

  @Command({
    name: "claim-messages",
    description: "List messages belonging to one claim",
    helpAfter: readHelp(
      "ravi ml claim-messages 5281510459 --json",
      "Read the moderated claim conversation",
      mlOfficialSources.claimMessages,
    ),
  })
  @CommandAccess({
    kind: "read",
    resource: "ml.claims",
    action: "messages.list",
    risk: "medium",
    redactions: ["message"],
  })
  @Returns(resultSchema)
  async claimMessages(
    @Arg("claim", { schema: numericIdSchema }) claim: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getClaimMessages(claim));
  }

  @Command({
    name: "claim-return",
    description: "Get the v2 return associated with one claim",
    helpAfter: readHelp(
      "ravi ml claim-return 5281510459 --json",
      "Inspect return status without taking action",
      mlOfficialSources.returns,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.claims", action: "return.get", risk: "medium" })
  @Returns(resultSchema)
  async claimReturn(
    @Arg("claim", { schema: numericIdSchema }) claim: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(await this.client(connection).getClaimReturn(claim));
  }

  @Command({
    name: "ads-advertisers",
    description: "List Product Ads advertisers using Api-Version 1",
    helpAfter: readHelp(
      "ravi ml ads-advertisers --json",
      "Resolve advertiser and site ids without hard-coded account data",
      mlOfficialSources.productAds,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.financial", action: "ads.advertisers", risk: "medium" })
  @Returns(resultSchema)
  async adsAdvertisers(@Option(connectionOption) connection?: string) {
    return output(await this.client(connection).listAdsAdvertisers());
  }

  @Command({
    name: "ads-campaigns",
    description: "List current Product Ads campaigns and optional metrics using Api-Version 2",
    helpAfter: readHelp(
      "ravi ml ads-campaigns MLB 12345 --from 2026-06-01 --to 2026-06-30 --metrics clicks,cost --json",
      "Audit Product Ads campaigns without mutating budget",
      mlOfficialSources.productAdsCurrent,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.financial", action: "ads.campaigns", risk: "medium" })
  @Returns(resultSchema)
  async adsCampaigns(
    @Arg("site", { schema: siteIdSchema }) site: string,
    @Arg("advertiser", { schema: numericIdSchema }) advertiser: string,
    @Option({ flags: "--status <status>", description: "active or paused campaign filter" }) status?: string,
    @Option({ flags: "--from <date>", schema: dateSchema }) from?: string,
    @Option({ flags: "--to <date>", schema: dateSchema }) to?: string,
    @Option({ flags: "--metrics <names>", description: "Comma-separated official metric names" }) metrics?: string,
    @Option(limitOption(50)) limit?: string,
    @Option(offsetOption) offset?: string,
    @Option(connectionOption) connection?: string,
  ) {
    if (metrics && (!from || !to)) throw new Error("--metrics requires both --from and --to (YYYY-MM-DD).");
    return output(
      await this.client(connection).listAdsCampaigns(site, advertiser, {
        status,
        dateFrom: from,
        dateTo: to,
        metrics,
        ...page(limit, offset, 50),
      }),
    );
  }

  @Command({
    name: "ads-ad-groups",
    description: "Resolve current Product Ads ad_group ids from one or more item ids",
    helpAfter: readHelp(
      "ravi ml ads-ad-groups MLB 12345 MLB1234567890 --json",
      "Replace removed ads/search endpoints with the current ad-group model",
      mlOfficialSources.productAdsCurrent,
    ),
  })
  @CommandAccess({ kind: "read", resource: "ml.financial", action: "ads.ad-groups", risk: "medium" })
  @Returns(resultSchema)
  async adsAdGroups(
    @Arg("site", { schema: siteIdSchema }) site: string,
    @Arg("advertiser", { schema: numericIdSchema }) advertiser: string,
    @Arg("items", { description: "Comma-separated item ids" }) items: string,
    @Option(connectionOption) connection?: string,
  ) {
    return output(
      await this.client(connection).listAdsAdGroups(site, advertiser, csvIds(items, 50, itemIdSchema, "item ids")),
    );
  }

  @Command({
    name: "item-create",
    description: "Create a public item from an explicit official JSON body (Phase 1 auth remains closed)",
    helpAfter: mutationHelp(
      'ravi ml item-create --body \'{"title":"Test","category_id":"MLB1051","price":100,"currency_id":"BRL","available_quantity":1,"buying_mode":"buy_it_now","listing_type_id":"gold_special"}\' --confirm --json',
      "Creates a public sellable listing and is not idempotent",
      mlOfficialSources.items,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "item.create",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["body"],
  })
  @Returns(resultSchema)
  async itemCreate(
    @Option({ flags: "--body <json>", description: "Official item JSON object; never persisted by Ravi" })
    body?: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    const parsedBody = itemCreateBody(body);
    if (dryRun) return output(writeDryRunPlan("item-create", connection, "ml:catalog:write", "high", parsedBody));
    requireConfirmation(confirm);
    return output(await this.client(connection).createItem(parsedBody));
  }

  @Command({
    name: "item-update",
    description: "Update only safe catalog fields; price, status and deletion are rejected",
    helpAfter: mutationHelp(
      "ravi ml item-update MLB1234567890 --body '{\"available_quantity\":10}' --confirm --json",
      "Changes a public listing; use dedicated status commands for lifecycle changes",
      mlOfficialSources.itemUpdate,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "item.update",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["body"],
  })
  @Returns(resultSchema)
  async itemUpdate(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Option({
      flags: "--body <json>",
      description:
        "Allowed fields: title, available_quantity, seller_custom_field, pictures, attributes, shipping, sale_terms",
    })
    body?: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    const parsedBody = safeItemPatch(body);
    if (dryRun) return output(writeDryRunPlan("item-update", connection, "ml:catalog:write", "high", parsedBody, item));
    requireConfirmation(confirm);
    return output(await this.client(connection).updateItem(item, parsedBody));
  }

  @Command({
    name: "description-create",
    description: "Create the initial plain-text item description",
    helpAfter: mutationHelp(
      "ravi ml description-create MLB1234567890 'Descricao em texto simples' --confirm --json",
      "POST fails if the item already has a description; use description-update then",
      mlOfficialSources.descriptions,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "description.create",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["text"],
  })
  @Returns(resultSchema)
  async descriptionCreate(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Arg("text", { schema: nonEmptySchema }) text: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(
        writeDryRunPlan("description-create", connection, "ml:catalog:write", "high", { plain_text: text }, item),
      );
    requireConfirmation(confirm);
    return output(await this.client(connection).createDescription(item, text));
  }

  @Command({
    name: "description-update",
    description: "Replace an existing plain-text item description using api_version=2",
    helpAfter: mutationHelp(
      "ravi ml description-update MLB1234567890 'Nova descricao' --confirm --json",
      "Replaces the complete public description",
      mlOfficialSources.descriptions,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "description.update",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["text"],
  })
  @Returns(resultSchema)
  async descriptionUpdate(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Arg("text", { schema: nonEmptySchema }) text: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(
        writeDryRunPlan("description-update", connection, "ml:catalog:write", "high", { plain_text: text }, item),
      );
    requireConfirmation(confirm);
    return output(await this.client(connection).updateDescription(item, text));
  }

  @Command({
    name: "item-pause",
    description: "Pause an active item through the dedicated reversible status command",
    helpAfter: mutationHelp(
      "ravi ml item-pause MLB1234567890 --confirm --json",
      "Hides the item until reactivated",
      mlOfficialSources.itemUpdate,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "item.pause",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async itemPause(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(writeDryRunPlan("item-pause", connection, "ml:catalog:write", "high", { status: "paused" }, item));
    requireConfirmation(confirm);
    return output(await this.client(connection).setItemStatus(item, "paused"));
  }

  @Command({
    name: "item-activate",
    description: "Reactivate a paused item through the dedicated reversible status command",
    helpAfter: mutationHelp(
      "ravi ml item-activate MLB1234567890 --confirm --json",
      "Makes the item public and sellable again",
      mlOfficialSources.itemUpdate,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "item.activate",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async itemActivate(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(
        writeDryRunPlan("item-activate", connection, "ml:catalog:write", "high", { status: "active" }, item),
      );
    requireConfirmation(confirm);
    return output(await this.client(connection).setItemStatus(item, "active"));
  }

  @Command({
    name: "item-close",
    description: "Close an item permanently; a closed item cannot be reactivated",
    helpAfter: destructiveHelp(
      "ravi ml item-close MLB1234567890 --confirm --json",
      "Permanently ends the listing but does not mark it deleted",
      mlOfficialSources.itemUpdate,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "item.close",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async itemClose(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(
        writeDryRunPlan("item-close", connection, "ml:catalog:destructive", "destructive", { status: "closed" }, item),
      );
    requireConfirmation(confirm);
    return output(await this.client(connection).setItemStatus(item, "closed"));
  }

  @Command({
    name: "item-delete",
    description: "Close and permanently delete an item in the official two-step flow",
    helpAfter: destructiveHelp(
      "ravi ml item-delete MLB1234567890 --confirm --json",
      "Runs close then deleted=true; failure between steps can leave the item closed",
      mlOfficialSources.itemUpdate,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.catalog",
    action: "item.delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async itemDelete(
    @Arg("item", { schema: itemIdSchema }) item: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(
        writeDryRunPlan(
          "item-delete",
          connection,
          "ml:catalog:destructive",
          "destructive",
          { status: "closed", deleted: true },
          item,
        ),
      );
    requireConfirmation(confirm);
    return output(await this.client(connection).deleteItem(item));
  }

  @Command({
    name: "question-answer",
    description: "Publish an irreversible answer to one marketplace question",
    helpAfter: mutationHelp(
      "ravi ml question-answer 3957150025 'Resposta revisada' --confirm --json",
      "External communication cannot be retracted through this command",
      mlOfficialSources.questions,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.communication",
    action: "question.answer",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["text"],
  })
  @Returns(resultSchema)
  async questionAnswer(
    @Arg("question", { schema: numericIdSchema }) question: string,
    @Arg("text", { schema: nonEmptySchema }) text: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(
        writeDryRunPlan("question-answer", connection, "ml:communication:write", "high", {
          question_id: question,
          text,
        }),
      );
    requireConfirmation(confirm);
    return output(await this.client(connection).answerQuestion(question, text));
  }

  @Command({
    name: "message-send",
    description: "Send one post-sale message using the current explicit recipient contract",
    helpAfter: mutationHelp(
      "ravi ml message-send 2000000089077943 415458330 3037675074 'Mensagem revisada' --confirm --json",
      "MLB may require the official messaging Agent User ID instead of the buyer id",
      mlOfficialSources.messages,
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ml.communication",
    action: "message.send",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["text"],
  })
  @Returns(resultSchema)
  async messageSend(
    @Arg("pack", { schema: numericIdSchema }) pack: string,
    @Arg("seller", { schema: numericIdSchema }) seller: string,
    @Arg("to-user", { description: "Current official recipient/agent user id", schema: numericIdSchema })
    toUser: string,
    @Arg("text", { schema: z.string().trim().min(1).max(350) }) text: string,
    @Option(confirmOption) confirm?: boolean,
    @Option(connectionOption) connection?: string,
    @Option(dryRunOption) dryRun?: boolean,
  ) {
    if (dryRun)
      return output(
        writeDryRunPlan(
          "message-send",
          connection,
          "ml:communication:write",
          "high",
          { pack_id: pack, seller_id: seller, to_user_id: toUser, text },
          pack,
        ),
      );
    requireConfirmation(confirm);
    return output(await this.client(connection).sendMessage(pack, seller, toUser, text));
  }
}

const jsonCommands = [
  "seller",
  "items",
  "itemGet",
  "itemsGet",
  "itemDescription",
  "itemVisits",
  "itemsVisits",
  "itemPrices",
  "orders",
  "orderGet",
  "orderBilling",
  "orderNotes",
  "shipmentGet",
  "shipmentCosts",
  "shipmentHistory",
  "questions",
  "packGet",
  "categoryGet",
  "trends",
  "highlights",
  "messages",
  "claims",
  "claimGet",
  "claimMessages",
  "claimReturn",
  "adsAdvertisers",
  "adsCampaigns",
  "adsAdGroups",
  "itemCreate",
  "itemUpdate",
  "descriptionCreate",
  "descriptionUpdate",
  "itemPause",
  "itemActivate",
  "itemClose",
  "itemDelete",
  "questionAnswer",
  "messageSend",
] as const;

for (const command of jsonCommands) {
  const method = MlCommands.prototype[command];
  Option({ flags: "--json", description: "Print the stable JSON response envelope" })(
    MlCommands.prototype,
    command,
    method.length,
  );
}

function limitOption(maximum: number) {
  return {
    flags: "--limit <n>",
    description: `Maximum results in this provider page, 1-${maximum} (default: ${Math.min(50, maximum)})`,
    defaultValue: String(Math.min(50, maximum)),
  };
}

function output(result: unknown) {
  const payload = { result: result as never };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

function page(limit: string | undefined, offset: string | undefined, maximum: number) {
  return {
    limit: integer(limit, Math.min(50, maximum), 1, maximum, "--limit"),
    offset: integer(offset, 0, 0, Number.MAX_SAFE_INTEGER, "--offset"),
  };
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function csvIds(value: string, maximum: number, schema: z.ZodType<string>, label: string): string[] {
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length > maximum)
    throw new Error(`${label} requires 1-${maximum} comma-separated values.`);
  return values.map((entry) => schema.parse(entry));
}

function jsonObject(value?: string): MlJsonObject {
  if (!value?.trim()) throw new Error("--body must contain a JSON object.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--body must contain valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--body must contain a JSON object.");
  }
  return parsed as MlJsonObject;
}

function itemCreateBody(value?: string): MlJsonObject {
  const body = jsonObject(value);
  for (const key of [
    "title",
    "category_id",
    "price",
    "currency_id",
    "available_quantity",
    "buying_mode",
    "listing_type_id",
  ]) {
    if (body[key] === undefined) throw new Error(`--body misses required item field ${key}.`);
  }
  for (const key of ["description", "status", "deleted"]) {
    if (key in body) throw new Error(`--body field ${key} is not allowed in item-create; use the dedicated command.`);
  }
  return parseBody(itemCreateSchema, body, "--body item-create");
}

function safeItemPatch(value?: string): MlJsonObject {
  const body = jsonObject(value);
  const allowed = new Set<string>(itemPatchFields);
  const fields = Object.keys(body);
  if (fields.length === 0) throw new Error("--body must change at least one safe item field.");
  const forbidden = fields.filter((field) => !allowed.has(field));
  if (forbidden.length > 0) {
    throw new Error(
      `item-update rejects fields: ${forbidden.join(", ")}. Use dedicated status/description commands; price writes are unavailable.`,
    );
  }
  return parseBody(itemPatchSchema, body, "--body item-update");
}

function parseBody(schema: z.ZodType, body: MlJsonObject, label: string): MlJsonObject {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} is invalid: ${message}.`);
  }
  return parsed.data as MlJsonObject;
}

function requireConfirmation(confirm?: boolean): void {
  if (confirm !== true) throw new Error("This Mercado Livre mutation requires explicit --confirm.");
}

function writeDryRunPlan(
  operation: string,
  connection: string | undefined,
  permission: string,
  risk: "high" | "destructive",
  body: MlJsonObject,
  targetId?: string,
) {
  return {
    ok: true,
    dryRun: true,
    executionEnabled: false,
    networkCalled: false,
    secretResolved: false,
    app: "mercado-livre",
    operation,
    targetId,
    connection: connection ?? "default",
    permission,
    risk,
    hitlRequired: true,
    confirmationRequired: true,
    idempotent: false,
    retry: "disabled-for-writes",
    input: {
      validated: true,
      topLevelFields: Object.keys(body).sort(),
      valuesExposed: true,
      target: targetId,
      proposed: body,
      textLength:
        typeof body.text === "string"
          ? body.text.length
          : typeof body.plain_text === "string"
            ? body.plain_text.length
            : undefined,
    },
    nextAction:
      "Request explicit approval before any future live execution; app router live execution remains disabled.",
  };
}

function readHelp(example: string, use: string, source: string): string {
  return `
USE
  ${use}.
NAO USE
  Do not use for writes; choose a dedicated mutating command and read its HITL contract.
EXAMPLES
  ${example}
  ${example.replace(" --json", " --connection sandbox --json")}
ON ERROR
  Missing credential -> Phase 1 is working as designed; configure a Ravi connection only in Phase 2.
  401/403 -> verify the future credential owner and provider permissions. 429 -> retry with bounded backoff.
FORMATO
  stdout is one stable JSON envelope: { result: <provider-json> }. Exit 0 on success, 1 on error.
FONTES
  Official Mercado Livre documentation verified 2026-07-13: ${source}
`;
}

function mutationHelp(example: string, impact: string, source: string): string {
  return `
USE
  Use only after reading the current resource and reviewing the exact proposed change.
NAO USE
  Do not use for price, payment, cancellation, fiscal issuance or any operation not named by this command.
REGRAS HARD
  ${impact}. --confirm is mandatory. Phase 1 authentication fails before network access.
HITL OBRIGATORIO
  Show the target id and complete change to a human, then run only after explicit approval.
EXAMPLES
  ${example}
  ${example.replace(" --json", " --connection sandbox --json")}
ON ERROR
  Missing --confirm -> review and repeat with approval. Missing credential -> wait for Phase 2 onboarding.
FORMATO
  stdout is { result: <provider-json> }. Exit 0 on success, 1 on validation/provider failure.
FONTES
  Official Mercado Livre documentation verified 2026-07-13: ${source}
`;
}

function destructiveHelp(example: string, impact: string, source: string): string {
  return mutationHelp(example, `DESTRUCTIVE: ${impact}`, source);
}
