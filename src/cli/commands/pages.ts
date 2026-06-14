import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, Group, Option } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import {
  publishArtifactToConsole,
  type ArtifactPublishDeps,
  type ArtifactPublishResult,
} from "../../artifacts/publish-client.js";
import {
  bindPageDomains,
  createPageSite,
  listPageSites,
  normalizePageVisibility,
  updatePageSite,
  type PageDomainBindResult,
  type PagesClientDeps,
  type PageSiteCreateResult,
  type PageSiteListResult,
  type PageSitePayload,
  type PageSiteUpdateResult,
} from "../../pages/client.js";
import { hasContext } from "../context.js";
import { jsonObjectSchema, jsonValueSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { artifactPublishReturnSchema, declareCommandReturns } from "./operational-return-schemas.js";

export interface PagesCommandDeps extends PagesClientDeps, Pick<ArtifactPublishDeps, "fetch"> {
  client?: ConsoleApiClient;
}

@Group({
  name: "pages",
  description: "Manage Ravi Pages sites and publish content through Console",
  scope: "open",
})
export class PagesCommands {
  constructor(private readonly deps: PagesCommandDeps = defaultPagesDeps()) {}

  @Command({ name: "list", description: "List Ravi Pages sites in a Console project" })
  async list(
    @Arg("project", { description: "Console project id or slug" }) project: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum sites to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of sites to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const result = await listPageSites({ project, console: consoleUrl }, this.deps);
      const page = paginateCliItems(result.sites, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "pages", "list", project],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: [consoleUrl ? "--console" : null, consoleUrl],
      });
      const payload = {
        ...result,
        total: page.total,
        pagination,
        sites: page.items,
        items: page.items,
      };
      printPayload(payload, asJson, () => printSiteList(payload));
      return payload;
    });
  }

  @Command({ name: "create", description: "Create a Ravi Pages site record; does not upload HTML or assets" })
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

  @Command({ name: "publish", description: "Publish a directory, file, or local artifact to a Ravi Pages site" })
  async publish(
    @Arg("project", { description: "Console project id or slug" }) project: string,
    @Arg("site", { description: "Pages site id or slug" }) site: string,
    @Arg("source", { description: "Local directory, file, or artifact id to publish" }) source: string,
    @Option({ flags: "--route <path>", description: "Pages route path to mount content at (default: /)" })
    route?: string,
    @Option({ flags: "--visibility <visibility>", description: "Pages visibility: private|protected_link|public" })
    visibility?: string,
    @Option({ flags: "--title <title>", description: "Published artifact title" }) title?: string,
    @Option({ flags: "--artifact-slug <slug>", description: "Published artifact slug" }) artifactSlug?: string,
    @Option({ flags: "--description <text>", description: "Published artifact description" }) description?: string,
    @Option({ flags: "--entrypoint <path>", description: "Package entrypoint path, usually index.html" })
    entrypoint?: string,
    @Option({ flags: "--artifact-version <n>", description: "Local artifact version number (default: latest)" })
    artifactVersion?: string,
    @Option({ flags: "--base-path <path>", description: "Package base path intent" }) basePath?: string,
    @Option({ flags: "--asset-base <path>", description: "Package asset base intent" }) assetBase?: string,
    @Option({ flags: "--upload-session <id>", description: "Use an existing Console upload session" })
    uploadSession?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Idempotency key for Console retries" })
    idempotencyKey?: string,
    @Option({ flags: "--reason <text>", description: "Release reason sent to Console" }) reason?: string,
    @Option({ flags: "--replace-release", description: "Replace the full active route map instead of merging" })
    replaceRelease?: boolean,
    @Option({ flags: "--no-activate", description: "Create publish records without activating a site release" })
    activate?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const result = await publishArtifactToConsole(
        source,
        {
          project,
          site,
          route,
          visibility: normalizePageVisibility(visibility),
          name: title,
          slug: artifactSlug,
          description,
          entrypoint,
          artifactVersion: artifactVersion ? parseInteger(artifactVersion, "--artifact-version") : undefined,
          basePath,
          assetBase,
          uploadSession,
          idempotencyKey,
          reason,
          replaceRelease,
          activate,
          console: consoleUrl,
          tool: "ravi pages publish",
          json: asJson,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printPagePublishResult(result));
      return result;
    });
  }

  @Command({ name: "update", description: "Update a Ravi Pages site in a Console project" })
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

  @Command({ name: "domains", description: "Bind custom hostnames to a Ravi Pages site" })
  async domains(
    @Arg("project", { description: "Console project id or slug" }) project: string,
    @Arg("site", { description: "Pages site id or slug" }) site: string,
    @Arg("hostnames", { variadic: true, description: "Custom hostname(s), e.g. www.example.com" })
    hostnames: string[],
    @Option({ flags: "--check", description: "Run provider readiness check after binding" }) check?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const result = await bindPageDomains(
        {
          project,
          site,
          hostnames,
          check,
          console: consoleUrl,
        },
        this.deps,
      );
      printPayload(result, asJson, () => printDomainBindings(result));
      return result;
    });
  }
}

function defaultPagesDeps(): PagesCommandDeps {
  return {};
}

const pageSiteSchema = jsonObjectSchema;

const pagesListReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  projectRef: z.string(),
  total: z.number(),
  pagination: strictCliOffsetPaginationSchema,
  sites: z.array(pageSiteSchema),
  items: z.array(pageSiteSchema),
});

const pageSiteCreateReturnSchema = z.object({
  success: z.literal(true),
  contentPublishCommand: z.string().nullable(),
  consoleUrl: z.string(),
  projectRef: z.string(),
  site: pageSiteSchema,
  url: z.string().nullable(),
});

const pageSiteUpdateReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  projectRef: z.string(),
  siteRef: z.string(),
  site: pageSiteSchema,
  edgeManifestRepair: jsonValueSchema,
  url: z.string().nullable(),
});

const pageDomainBindReturnSchema = z.object({
  success: z.literal(true),
  bindings: z.array(pageSiteSchema),
  consoleUrl: z.string(),
  hostnames: z.array(z.string()),
  projectRef: z.string(),
  site: pageSiteSchema,
  siteRef: z.string(),
  total: z.number(),
});

declareCommandReturns(PagesCommands, {
  list: pagesListReturnSchema,
  create: pageSiteCreateReturnSchema,
  publish: artifactPublishReturnSchema,
  update: pageSiteUpdateReturnSchema,
  visibility: pageSiteUpdateReturnSchema,
  domains: pageDomainBindReturnSchema,
});

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
    if (hasContext()) throw cloudError;
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

function printSiteList(
  result: PageSiteListResult & { pagination?: { limit: number; nextCommand: string | null; offset: number } },
): void {
  if (result.sites.length === 0) {
    console.log(`No Pages sites found for project ${result.projectRef}.`);
    return;
  }

  const pagination = result.pagination;
  console.log(
    `Pages sites (${result.sites.length} returned of ${result.total}${
      pagination ? `, limit ${pagination.limit}, offset ${pagination.offset}` : ""
    })`,
  );
  for (const site of result.sites) {
    console.log(`  - ${siteLabel(site)}`);
  }
  if (pagination?.nextCommand) {
    console.log("\nNext page:");
    console.log(`  ${pagination.nextCommand}`);
  }
}

function printCreatedSite(result: PageSiteCreateResult): void {
  console.log("✓ Pages site created");
  printSiteFields(result.site);
  if (result.url) console.log(`  URL:        ${result.url}`);
  if (result.contentPublishCommand) {
    console.log("  Publish:    upload content with Pages");
    console.log(`             ${result.contentPublishCommand}`);
  }
}

function printPagePublishResult(result: ArtifactPublishResult): void {
  const artifact = objectValue(result.artifact);
  const version = objectValue(result.artifactVersion);
  const publish = objectValue(result.publish);
  const release = objectValue(result.release);
  const site = objectValue(result.site);

  console.log("✓ Pages publish finalized");
  if (site) printSiteFields(site);
  if (stringValue(artifact?.id)) console.log(`  Artifact   ${stringValue(artifact?.id)}`);
  if (stringValue(version?.id)) console.log(`  Version    ${stringValue(version?.id)}`);
  if (stringValue(publish?.id)) console.log(`  Publish    ${stringValue(publish?.id)}`);
  if (stringValue(release?.id)) console.log(`  Release    ${stringValue(release?.id)}`);
  if (result.routes.length > 0) console.log(`  Routes     ${result.routes.length}`);
  console.log(`  Upload     ${result.upload.attempted} direct, ${result.upload.skipped} staged`);
  console.log(`  URL        ${result.url ?? "not returned by Console"}`);
  if (result.localSync.status === "recorded") {
    console.log(`  Local      recorded on ${result.localSync.artifactId} v${result.localSync.versionNumber}`);
  } else if (result.localSync.status === "failed") {
    console.log(`  Local      remote published, but local sync failed: ${result.localSync.error}`);
  }
}

function printUpdatedSite(result: PageSiteUpdateResult): void {
  console.log("✓ Pages site updated");
  printSiteFields(result.site);
  const repair = objectValue(result.edgeManifestRepair);
  if (repair?.status) console.log(`  Edge:       ${repair.status}`);
  if (result.url) console.log(`  URL:        ${result.url}`);
}

function printDomainBindings(result: PageDomainBindResult): void {
  console.log(`✓ Bound ${result.total} Pages domain${result.total === 1 ? "" : "s"}`);
  printSiteFields(result.site);
  for (const binding of result.bindings) {
    const hostname = stringValue(binding.hostname) ?? "hostname";
    const status = stringValue(binding.status);
    const mode = stringValue(objectValue(binding.readiness)?.mode);
    console.log(`  - ${hostname}${status ? `  status=${status}` : ""}${mode ? `  mode=${mode}` : ""}`);
  }
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

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", `${label} must be a non-negative integer.`);
  }
  return parsed;
}
