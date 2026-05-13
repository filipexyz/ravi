import "reflect-metadata";
import { Arg, CliOnly, Command, Group, Option } from "../decorators.js";
import { cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import {
  createPageSite,
  listPageSites,
  normalizePageVisibility,
  updatePageSite,
  type PagesClientDeps,
  type PageSiteCreateResult,
  type PageSiteListResult,
  type PageSitePayload,
  type PageSiteUpdateResult,
} from "../../pages/client.js";

export interface PagesCommandDeps extends PagesClientDeps {
  client?: ConsoleApiClient;
}

@Group({
  name: "pages",
  description: "Manage Ravi Pages sites through Console",
  scope: "open",
})
export class PagesCommands {
  constructor(private readonly deps: PagesCommandDeps = defaultPagesDeps()) {}

  @Command({ name: "list", description: "List Ravi Pages sites in a Console project" })
  @CliOnly()
  async list(
    @Arg("project", { description: "Console project id or slug" }) project: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const result = await listPageSites({ project, console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printSiteList(result));
      return result;
    });
  }

  @Command({ name: "create", description: "Create a Ravi Pages site in a Console project" })
  @CliOnly()
  async create(
    @Arg("project", { description: "Console project id or slug" }) project: string,
    @Arg("slug", { description: "Hosted subdomain slug, e.g. demo for demo.ravi.page" }) slug: string,
    @Option({ flags: "--visibility <visibility>", description: "Default visibility: private|protected_link|public" })
    visibility?: string,
    @Option({ flags: "--default-site", description: "Mark this as the project default site when available" })
    isDefault?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const result = await createPageSite(
        {
          project,
          slug,
          defaultVisibility: normalizePageVisibility(visibility),
          isDefault,
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printCreatedSite(result));
      return result;
    });
  }

  @Command({ name: "update", description: "Update a Ravi Pages site in a Console project" })
  @CliOnly()
  async update(
    @Arg("project", { description: "Console project id or slug" }) project: string,
    @Arg("site", { description: "Pages site id or slug" }) site: string,
    @Option({ flags: "--visibility <visibility>", description: "Default visibility: private|protected_link|public" })
    visibility?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const result = await updatePageSite(
        {
          project,
          site,
          defaultVisibility: normalizePageVisibility(visibility),
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printUpdatedSite(result));
      return result;
    });
  }

  @Command({ name: "visibility", description: "Set a Ravi Pages site default visibility" })
  @CliOnly()
  async visibility(
    @Arg("project", { description: "Console project id or slug" }) project: string,
    @Arg("site", { description: "Pages site id or slug" }) site: string,
    @Arg("visibility", { description: "private|protected_link|public" }) visibility: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const result = await updatePageSite(
        {
          project,
          site,
          defaultVisibility: normalizePageVisibility(visibility),
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printUpdatedSite(result));
      return result;
    });
  }
}

function defaultPagesDeps(): PagesCommandDeps {
  return {};
}

async function runPagesCommand<T>(asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      printJson(formatCloudAuthError(cloudError));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    process.exit(cloudError.exitCode);
  }
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    printJson(payload);
    return;
  }
  printHuman();
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printSiteList(result: PageSiteListResult): void {
  if (result.sites.length === 0) {
    console.log(`No Pages sites found for project ${result.projectRef}.`);
    return;
  }

  console.log(`Pages sites (${result.total})`);
  for (const site of result.sites) {
    console.log(`  - ${siteLabel(site)}`);
  }
}

function printCreatedSite(result: PageSiteCreateResult): void {
  console.log("✓ Pages site created");
  printSiteFields(result.site);
  if (result.url) console.log(`  URL:        ${result.url}`);
}

function printUpdatedSite(result: PageSiteUpdateResult): void {
  console.log("✓ Pages site updated");
  printSiteFields(result.site);
  const repair = objectValue(result.edgeManifestRepair);
  if (repair?.status) console.log(`  Edge:       ${repair.status}`);
  if (result.url) console.log(`  URL:        ${result.url}`);
}

function siteLabel(site: PageSitePayload): string {
  const slug = stringValue(site.slug) ?? stringValue(site.id) ?? "site";
  const hostname = stringValue(site.defaultHostname) ?? stringValue(site.hostname);
  const visibility = stringValue(site.defaultVisibility) ?? stringValue(site.visibility);
  const status = stringValue(site.status);
  const release = stringValue(site.activeReleaseId);
  return [
    slug,
    hostname ? `https://${hostname}/` : null,
    visibility ? `visibility=${visibility}` : null,
    status ? `status=${status}` : null,
    release ? `activeRelease=${release}` : null,
  ]
    .filter(Boolean)
    .join("  ");
}

function printSiteFields(site: PageSitePayload): void {
  const fields = [
    ["Site", stringValue(site.id)],
    ["Slug", stringValue(site.slug)],
    ["Host", stringValue(site.defaultHostname) ?? stringValue(site.hostname)],
    ["Visibility", stringValue(site.defaultVisibility) ?? stringValue(site.visibility)],
    ["Status", stringValue(site.status)],
    ["Default", booleanLabel(site.isDefault)],
  ] as const;

  for (const [label, value] of fields) {
    if (value) console.log(`  ${label.padEnd(10)} ${value}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function booleanLabel(value: unknown): string | null {
  return typeof value === "boolean" ? String(value) : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
