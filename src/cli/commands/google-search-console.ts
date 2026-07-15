import "reflect-metadata";
import { z } from "zod";
import { GoogleSearchConsoleClient } from "../../apps/google-search-console/client.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { jsonValueSchema } from "../return-schemas.js";

const resultSchema = z.object({ result: jsonValueSchema }).strict();
const wrap = (result: unknown) => {
  const payload = { result: result as never };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
};

@Group({
  name: "gsc",
  description: "Operate Google Search Console through a credential stored in Ravi",
  scope: "open",
})
export class GoogleSearchConsoleCommands {
  private client(connection?: string) {
    return new GoogleSearchConsoleClient({ connection });
  }

  @Command({ name: "sites", description: "List Search Console properties available to the credential" })
  @CommandAccess({ kind: "read", resource: "google-search-console.sites", action: "list", risk: "low" })
  @Returns(resultSchema)
  async sites(
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(await this.client(connection).listSites());
  }

  @Command({ name: "site-get", description: "Get one Search Console property and its permission level" })
  @CommandAccess({ kind: "read", resource: "google-search-console.sites", action: "get", risk: "low" })
  @Returns(resultSchema)
  async siteGet(
    @Arg("site", { description: "Property URL, for example sc-domain:example.com" }) site: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getSite(site));
  }

  @Command({ name: "site-add", description: "Add a Search Console property" })
  @CommandAccess({
    kind: "mutate",
    resource: "google-search-console.sites",
    action: "add",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async siteAdd(
    @Arg("site", { description: "Property URL" }) site: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).addSite(site));
  }

  @Command({ name: "site-delete", description: "Remove a Search Console property from this account" })
  @CommandAccess({
    kind: "mutate",
    resource: "google-search-console.sites",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async siteDelete(
    @Arg("site", { description: "Property URL" }) site: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).deleteSite(site));
  }

  @Command({ name: "query", description: "Run a Search Analytics query with explicit dates and dimensions" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "query", risk: "low" })
  @Returns(resultSchema)
  async query(
    @Arg("site", { description: "Search Console property URL" }) site: string,
    @Option({ flags: "--start <yyyy-mm-dd>", description: "First data date" }) start: string,
    @Option({ flags: "--end <yyyy-mm-dd>", description: "Last data date" }) end: string,
    @Option({ flags: "--dimensions <csv>", description: "query,page,country,device,date" }) dimensions?: string,
    @Option({ flags: "--limit <n>", description: "Rows, 1-25000", defaultValue: "1000" }) limit?: string,
    @Option({ flags: "--start-row <n>", description: "Pagination offset", defaultValue: "0" }) startRow?: string,
    @Option({ flags: "--type <type>", description: "web,image,video,news,discover,googleNews" }) type?: string,
    @Option({ flags: "--data-state <state>", description: "final,all,hourly_all" }) dataState?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    if (!start || !end) throw new Error("--start and --end are required");
    const rowLimit = integer(limit, 1000, 1, 25_000);
    return wrap(
      await this.client(connection).query(site, {
        startDate: start,
        endDate: end,
        dimensions: csv(dimensions),
        rowLimit,
        startRow: integer(startRow, 0, 0, Number.MAX_SAFE_INTEGER),
        type,
        dataState,
      }),
    );
  }

  @Command({ name: "top-queries", description: "Rank search queries by clicks for a recent period" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "top-queries", risk: "low" })
  @Returns(resultSchema)
  async topQueries(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "7" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "25" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return this.dimensionReport(site, "query", days, limit, connection);
  }

  @Command({ name: "top-pages", description: "Rank pages by clicks for a recent period" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "top-pages", risk: "low" })
  @Returns(resultSchema)
  async topPages(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "7" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "25" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return this.dimensionReport(site, "page", days, limit, connection);
  }

  @Command({ name: "devices", description: "Break down Search Analytics performance by device" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "devices", risk: "low" })
  @Returns(resultSchema)
  async devices(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "28" }) days?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return this.dimensionReport(site, "device", days, "25", connection);
  }

  @Command({ name: "countries", description: "Break down Search Analytics performance by country" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "countries", risk: "low" })
  @Returns(resultSchema)
  async countries(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "28" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "10" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return this.dimensionReport(site, "country", days, limit, connection);
  }

  @Command({ name: "date-series", description: "Return daily Search Analytics performance" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "date-series", risk: "low" })
  @Returns(resultSchema)
  async dateSeries(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "28" }) days?: string,
    @Option({ flags: "--query <text>" }) query?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const period = recentPeriod(integer(days, 28, 1, 365));
    return wrap(
      await this.client(connection).query(site, {
        startDate: period.start,
        endDate: period.end,
        dimensions: ["date"],
        rowLimit: 25_000,
        dimensionFilterGroups: query
          ? [{ filters: [{ dimension: "query", operator: "contains", expression: query }] }]
          : undefined,
      }),
    );
  }

  @Command({ name: "trends", description: "Compare query performance with the preceding period" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "trends", risk: "low" })
  @Returns(resultSchema)
  async trends(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "7" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "20" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.trendData(site, days, limit, connection));
  }

  private async trendData(site: string, days?: string, limit?: string, connection?: string) {
    const count = integer(days, 7, 1, 365);
    const current = recentPeriod(count);
    const previous = previousPeriod(current.start, count);
    const rowLimit = integer(limit, 20, 1, 25_000);
    const client = this.client(connection);
    const [now, before] = await Promise.all([
      client.query(site, { startDate: current.start, endDate: current.end, dimensions: ["query"], rowLimit }),
      client.query(site, { startDate: previous.start, endDate: previous.end, dimensions: ["query"], rowLimit }),
    ]);
    return { current, previous, rows: compareRows(now, before) };
  }

  @Command({ name: "rising", description: "List queries with the largest positive click change" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "rising", risk: "low" })
  @Returns(resultSchema)
  async rising(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "7" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "10" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const trend = await this.trendData(site, days, "25000", connection);
    return wrap(sortedTrendRows(trend, "desc", integer(limit, 10, 1, 1000)));
  }

  @Command({ name: "falling", description: "List queries with the largest negative click change" })
  @CommandAccess({ kind: "read", resource: "google-search-console.analytics", action: "falling", risk: "low" })
  @Returns(resultSchema)
  async falling(
    @Arg("site") site: string,
    @Option({ flags: "--days <n>", defaultValue: "7" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "10" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const trend = await this.trendData(site, days, "25000", connection);
    return wrap(sortedTrendRows(trend, "asc", integer(limit, 10, 1, 1000)));
  }

  private async dimensionReport(
    site: string,
    dimension: string,
    days: string | undefined,
    limit: string | undefined,
    connection?: string,
  ) {
    const period = recentPeriod(integer(days, 7, 1, 365));
    return wrap(
      await this.client(connection).query(site, {
        startDate: period.start,
        endDate: period.end,
        dimensions: [dimension],
        rowLimit: integer(limit, 25, 1, 25_000),
      }),
    );
  }

  @Command({ name: "inspect", description: "Inspect a URL index status in Google" })
  @CommandAccess({ kind: "read", resource: "google-search-console.inspection", action: "inspect", risk: "low" })
  @Returns(resultSchema)
  async inspect(
    @Arg("site", { description: "Search Console property URL" }) site: string,
    @Arg("url", { description: "Fully qualified URL to inspect" }) url: string,
    @Option({ flags: "--language <code>" }) language?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).inspect(site, url, language));
  }

  @Command({ name: "sitemaps", description: "List submitted sitemaps for a property" })
  @CommandAccess({ kind: "read", resource: "google-search-console.sitemaps", action: "list", risk: "low" })
  @Returns(resultSchema)
  async sitemaps(
    @Arg("site", { description: "Search Console property URL" }) site: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).listSitemaps(site));
  }

  @Command({ name: "sitemap-get", description: "Get one submitted sitemap" })
  @CommandAccess({ kind: "read", resource: "google-search-console.sitemaps", action: "get", risk: "low" })
  @Returns(resultSchema)
  async sitemapGet(
    @Arg("site") site: string,
    @Arg("url") url: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getSitemap(site, url));
  }

  @Command({ name: "sitemap-submit", description: "Submit a sitemap to Google" })
  @CommandAccess({
    kind: "mutate",
    resource: "google-search-console.sitemaps",
    action: "submit",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async sitemapSubmit(
    @Arg("site") site: string,
    @Arg("url") url: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).submitSitemap(site, url));
  }

  @Command({ name: "sitemap-delete", description: "Delete a submitted sitemap" })
  @CommandAccess({
    kind: "mutate",
    resource: "google-search-console.sitemaps",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async sitemapDelete(
    @Arg("site") site: string,
    @Arg("url") url: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).deleteSitemap(site, url));
  }

  @Command({ name: "verification-token", description: "Request a Google site-verification token" })
  @CommandAccess({ kind: "mutate", resource: "google-search-console.verification", action: "token", risk: "medium" })
  @Returns(resultSchema)
  async verificationToken(
    @Arg("identifier") identifier: string,
    @Option({ flags: "--method <method>", defaultValue: "DNS_TXT" }) method?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).verificationToken(siteIdentifier(identifier), method ?? "DNS_TXT"));
  }

  @Command({ name: "verify-site", description: "Ask Google to verify ownership of a site" })
  @CommandAccess({
    kind: "mutate",
    resource: "google-search-console.verification",
    action: "verify",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async verifySite(
    @Arg("identifier") identifier: string,
    @Option({ flags: "--method <method>", defaultValue: "DNS_TXT" }) method?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).verifySite(siteIdentifier(identifier), method ?? "DNS_TXT"));
  }
}

// Every finite Ravi command is JSON-addressable. GSC emits the same stable
// JSON envelope in both modes, while --json makes that contract discoverable
// to agents, Apps and the generated SDK.
for (const command of [
  "sites",
  "siteGet",
  "siteAdd",
  "siteDelete",
  "query",
  "topQueries",
  "topPages",
  "devices",
  "countries",
  "dateSeries",
  "trends",
  "rising",
  "falling",
  "inspect",
  "sitemaps",
  "sitemapGet",
  "sitemapSubmit",
  "sitemapDelete",
  "verificationToken",
  "verifySite",
] as const) {
  const method = GoogleSearchConsoleCommands.prototype[command];
  Option({ flags: "--json", description: "Print the stable JSON response envelope" })(
    GoogleSearchConsoleCommands.prototype,
    command,
    method.length,
  );
}

function csv(value?: string): string[] | undefined {
  const values = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values?.length ? values : undefined;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`Expected integer from ${min} to ${max}.`);
  return parsed;
}

function siteIdentifier(identifier: string): { type: "SITE" | "INET_DOMAIN"; identifier: string } {
  return { type: identifier.startsWith("http") ? "SITE" : "INET_DOMAIN", identifier };
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function recentPeriod(days: number) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: iso(start), end: iso(end) };
}
function previousPeriod(currentStart: string, days: number) {
  const end = new Date(`${currentStart}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start: iso(start), end: iso(end) };
}
type AnalyticsRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };
function rows(value: unknown): AnalyticsRow[] {
  return (value as { rows?: AnalyticsRow[] })?.rows ?? [];
}
function compareRows(current: unknown, previous: unknown) {
  const old = new Map(rows(previous).map((row) => [row.keys?.[0] ?? "", row]));
  return rows(current).map((row) => {
    const key = row.keys?.[0] ?? "";
    const prior = old.get(key);
    return {
      key,
      clicks: row.clicks ?? 0,
      previousClicks: prior?.clicks ?? 0,
      clicksChange: (row.clicks ?? 0) - (prior?.clicks ?? 0),
      impressions: row.impressions ?? 0,
      previousImpressions: prior?.impressions ?? 0,
    };
  });
}
function sortedTrendRows(value: unknown, order: "asc" | "desc", limit: number) {
  const result = value as { rows?: Array<{ clicksChange: number }> };
  return [...(result.rows ?? [])]
    .sort((a, b) => (order === "asc" ? a.clicksChange - b.clicksChange : b.clicksChange - a.clicksChange))
    .slice(0, limit);
}
