import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { resolveConsoleProjectRef, type ConsoleScopeResolverDeps } from "../../console-scope/resolver.js";
import type { ResolvedConsoleScope } from "../../console-scope/types.js";
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
  getContext?: ConsoleScopeResolverDeps["getContext"];
  listProjects?: ConsoleScopeResolverDeps["listProjects"];
  env?: ConsoleScopeResolverDeps["env"];
  cwd?: ConsoleScopeResolverDeps["cwd"];
}

@Group({
  name: "pages",
  description: "Manage Ravi Pages sites and publish content through Console",
  scope: "open",
})
export class PagesCommands {
  constructor(private readonly deps: PagesCommandDeps = defaultPagesDeps()) {}

  @Command({ name: "list", description: "List Ravi Pages sites in a Console project" })
  @CommandAccess({ kind: "read", resource: "pages", action: "list", risk: "low" })
  async list(
    @Arg("project", { required: false, description: "Console project id or slug; defaults to Ravi Console scope" })
    project?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum sites to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of sites to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const resolved = await resolvePagesProject(project, projectOption, consoleUrl, this.deps);
      const result = await listPageSites({ project: resolved.projectRef, console: consoleUrl }, this.deps);
      const page = paginateCliItems(result.sites, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "pages", "list"],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: ["--project", resolved.projectRef, consoleUrl ? "--console" : null, consoleUrl],
      });
      const payload = {
        ...result,
        scope: resolved.scope,
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
  @CommandAccess({ kind: "mutate", resource: "pages", action: "create", risk: "medium" })
  async create(
    @Arg("args", { variadic: true, description: "[project] <slug>; project defaults to Ravi Console scope" })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--visibility <visibility>", description: "Default visibility: private|protected_link|public" })
    visibility?: string,
    @Option({ flags: "--default-site", description: "Mark this as the project default site when available" })
    isDefault?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const parsed = parseCreateArgs(args, projectOption);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await createPageSite(
        {
          project: resolved.projectRef,
          slug: parsed.slug,
          defaultVisibility: normalizePageVisibility(visibility),
          isDefault,
          console: consoleUrl,
        },
        this.deps,
      );
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printCreatedSite(result));
      return payload;
    });
  }

  @Command({ name: "publish", description: "Publish a directory, file, or local artifact to a Ravi Pages site" })
  @CommandAccess({ kind: "mutate", resource: "pages", action: "publish", risk: "high" })
  async publish(
    @Arg("args", {
      variadic: true,
      description: "[project] <site> <source>; project defaults to Ravi Console scope",
    })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
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
      const parsed = parsePublishArgs(args, projectOption);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await publishArtifactToConsole(
        parsed.source,
        {
          project: resolved.projectRef,
          site: parsed.site,
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
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printPagePublishResult(result));
      return payload;
    });
  }

  @Command({ name: "update", description: "Update a Ravi Pages site in a Console project" })
  @CommandAccess({ kind: "mutate", resource: "pages", action: "update", risk: "medium" })
  async update(
    @Arg("args", { variadic: true, description: "[project] <site>; project defaults to Ravi Console scope" })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--visibility <visibility>", description: "Default visibility: private|protected_link|public" })
    visibility?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const parsed = parseSiteArgs(args, projectOption, "update");
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await updatePageSite(
        {
          project: resolved.projectRef,
          site: parsed.site,
          defaultVisibility: normalizePageVisibility(visibility),
          console: consoleUrl,
        },
        this.deps,
      );
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printUpdatedSite(result));
      return payload;
    });
  }

  @Command({ name: "visibility", description: "Set a Ravi Pages site default visibility" })
  @CommandAccess({ kind: "read", resource: "pages", action: "visibility", risk: "low" })
  async visibility(
    @Arg("args", {
      variadic: true,
      description: "[project] <site> <visibility>; project defaults to Ravi Console scope",
    })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const parsed = parseVisibilityArgs(args, projectOption);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await updatePageSite(
        {
          project: resolved.projectRef,
          site: parsed.site,
          defaultVisibility: normalizePageVisibility(parsed.visibility),
          console: consoleUrl,
        },
        this.deps,
      );
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printUpdatedSite(result));
      return payload;
    });
  }

  @Command({ name: "domains", description: "Bind custom hostnames to a Ravi Pages site" })
  @CommandAccess({ kind: "read", resource: "pages", action: "domains", risk: "low" })
  async domains(
    @Arg("args", {
      variadic: true,
      description: "[project] <site> <hostname...>; project defaults to scope only for the non-ambiguous form",
    })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--check", description: "Run provider readiness check after binding" }) check?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand(asJson, async () => {
      const parsed = parseDomainsArgs(args, projectOption);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await bindPageDomains(
        {
          project: resolved.projectRef,
          site: parsed.site,
          hostnames: parsed.hostnames,
          check,
          console: consoleUrl,
        },
        this.deps,
      );
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printDomainBindings(result));
      return payload;
    });
  }
}

function defaultPagesDeps(): PagesCommandDeps {
  return {};
}

async function resolvePagesProject(
  positionalProject: string | undefined,
  optionProject: string | undefined,
  consoleUrl: string | undefined,
  deps: PagesCommandDeps,
): Promise<{ projectRef: string; scope: ResolvedConsoleScope }> {
  const explicitProject = mergedProjectRef(positionalProject, optionProject);
  return resolveConsoleProjectRef({ consoleUrl, explicitProject }, deps);
}

function mergedProjectRef(
  positionalProject: string | undefined,
  optionProject: string | undefined,
): string | undefined {
  const positional = stringValue(positionalProject);
  const option = stringValue(optionProject);
  if (positional && option && positional !== option) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Project conflict: positional project "${positional}" does not match --project "${option}".`,
    );
  }
  return option ?? positional ?? undefined;
}

function parseCreateArgs(args: string[], projectOption: string | undefined): { project?: string; slug: string } {
  const clean = cleanArgs(args);
  if (projectOption) {
    if (clean.length !== 1) {
      throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages create <slug> --project <project-ref>.");
    }
    return { project: projectOption, slug: clean[0] };
  }
  if (clean.length === 1) return { slug: clean[0] };
  if (clean.length === 2) return { project: clean[0], slug: clean[1] };
  throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages create [project] <slug>.");
}

function parsePublishArgs(
  args: string[],
  projectOption: string | undefined,
): { project?: string; site: string; source: string } {
  const clean = cleanArgs(args);
  if (projectOption) {
    if (clean.length !== 2) {
      throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages publish <site> <source> --project <project-ref>.");
    }
    return { project: projectOption, site: clean[0], source: clean[1] };
  }
  if (clean.length === 2) return { site: clean[0], source: clean[1] };
  if (clean.length === 3) return { project: clean[0], site: clean[1], source: clean[2] };
  throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages publish [project] <site> <source>.");
}

function parseSiteArgs(
  args: string[],
  projectOption: string | undefined,
  command: string,
): { project?: string; site: string } {
  const clean = cleanArgs(args);
  if (projectOption) {
    if (clean.length !== 1) {
      throw new CloudAuthError("PAYLOAD_INVALID", `Usage: ravi pages ${command} <site> --project <project-ref>.`);
    }
    return { project: projectOption, site: clean[0] };
  }
  if (clean.length === 1) return { site: clean[0] };
  if (clean.length === 2) return { project: clean[0], site: clean[1] };
  throw new CloudAuthError("PAYLOAD_INVALID", `Usage: ravi pages ${command} [project] <site>.`);
}

function parseVisibilityArgs(
  args: string[],
  projectOption: string | undefined,
): { project?: string; site: string; visibility: string } {
  const clean = cleanArgs(args);
  if (projectOption) {
    if (clean.length !== 2) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        "Usage: ravi pages visibility <site> <visibility> --project <project-ref>.",
      );
    }
    return { project: projectOption, site: clean[0], visibility: clean[1] };
  }
  if (clean.length === 2) return { site: clean[0], visibility: clean[1] };
  if (clean.length === 3) return { project: clean[0], site: clean[1], visibility: clean[2] };
  throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages visibility [project] <site> <visibility>.");
}

function parseDomainsArgs(
  args: string[],
  projectOption: string | undefined,
): { project?: string; site: string; hostnames: string[] } {
  const clean = cleanArgs(args);
  if (projectOption) {
    if (clean.length < 2) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        "Usage: ravi pages domains <site> <hostname...> --project <project-ref>.",
      );
    }
    return { project: projectOption, site: clean[0], hostnames: clean.slice(1) };
  }
  if (clean.length === 2) return { site: clean[0], hostnames: [clean[1]] };
  if (clean.length >= 3) return { project: clean[0], site: clean[1], hostnames: clean.slice(2) };
  throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages domains [project] <site> <hostname...>.");
}

function cleanArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter(Boolean);
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
