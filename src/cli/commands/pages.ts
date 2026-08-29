import "reflect-metadata";
import { z } from "zod";
import { Arg, CliOnly, Command, CommandAccess, Group, Option } from "../decorators.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { CloudAuthError, cloudAuthErrorFromUnknown } from "../../cloud-auth/errors.js";
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
  listPublishedPages,
  managePagePassword,
  normalizePagePasswordReplacementVisibility,
  normalizePageVisibility,
  updatePageSite,
  type PageDomainBindResult,
  type PagePasswordManageResult,
  type PagesClientDeps,
  type PageSiteCreateResult,
  type PageSiteListResult,
  type PageSitePayload,
  type PageSiteUpdateResult,
  type PublishedPageListResult,
  type PublishedPagePayload,
} from "../../pages/client.js";
import {
  materializeShipSource,
  requireShipTitle,
  slugifyPageTitle,
  validateShipSourceInput,
} from "../../pages/ship.js";
import { ContractError, contractDryRun, contractFail, pickFields } from "../agent-contract.js";
import { jsonObjectSchema, jsonValueSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { readConfirmedSecret, type ConfirmedSecretInputOptions } from "../secret-input.js";
import { artifactPublishReturnSchema, declareCommandReturns } from "./operational-return-schemas.js";

export interface PagesCommandDeps extends PagesClientDeps, Pick<ArtifactPublishDeps, "fetch"> {
  client?: ConsoleApiClient;
  getContext?: ConsoleScopeResolverDeps["getContext"];
  listProjects?: ConsoleScopeResolverDeps["listProjects"];
  env?: ConsoleScopeResolverDeps["env"];
  cwd?: ConsoleScopeResolverDeps["cwd"];
}

export interface PagesPasswordCommandDeps extends PagesCommandDeps {
  readPassword?: (options: ConfirmedSecretInputOptions) => Promise<string>;
}

const PAGES_SHIP_HELP = `
Examples:
  ravi pages ship --title "Weekly report" --body "<h1>OK</h1>" --json --execute
  ravi pages ship demo --title "Landing" --html ./landing.html --visibility public --execute
  ravi pages ship proj docs --title "Docs" --dir ./site --route / --execute --json

Happy path:
  One command. Do not choreograph pages create + pages publish.
  --title is required. Pass exactly one of --body, --html, or --dir.
  Omit <slug> to generate it from --title. Existing slugs are reused.

Write brake:
  Without --execute the command is a dry-run (exit 3) and never talks to Console.
  Public visibility still requires --execute.

JSON:
  { url, site, slug, route, visibility, artifactId }
`;

@Group({
  name: "pages",
  description: "Manage project-owned Ravi Pages and publish content through Console",
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
    @Option({ flags: "--fields <list>", description: "Comma-separated fields to keep on each listed site" })
    fields?: string,
  ) {
    return runPagesCommand("pages list", asJson, async () => {
      const resolved = await resolvePagesProject(project, projectOption, consoleUrl, this.deps);
      const result = await listPageSites({ project: resolved.projectRef, console: consoleUrl }, this.deps);
      const page = paginateCliItems(result.sites, { limit, offset });
      const pagination = buildCliOffsetPagination({
        fields,
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
        sites: pickFields(page.items, fields),
        items: pickFields(page.items, fields),
      };
      printPayload(payload, asJson, () => printSiteList(payload));
      return payload;
    });
  }

  @Command({ name: "published", description: "List published Ravi Pages URLs in a Console project" })
  @CommandAccess({ kind: "read", resource: "pages", action: "list", risk: "low" })
  async published(
    @Arg("project", { required: false, description: "Console project id or slug; defaults to Ravi Console scope" })
    project?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum pages to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of pages to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <list>", description: "Comma-separated fields to keep on each listed page" })
    fields?: string,
  ) {
    return runPagesCommand("pages published", asJson, async () => {
      const resolved = await resolvePagesProject(project, projectOption, consoleUrl, this.deps);
      const result = await listPublishedPages({ project: resolved.projectRef, console: consoleUrl }, this.deps);
      const page = paginateCliItems(result.pages, { limit, offset });
      const pagination = buildCliOffsetPagination({
        fields,
        baseCommand: ["ravi", "pages", "published"],
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
        pages: pickFields(page.items, fields),
        items: pickFields(page.items, fields),
      };
      printPayload(payload, asJson, () => printPublishedPageList(payload));
      return payload;
    });
  }

  @Command({
    name: "create",
    description: "Compatibility: ensure a Ravi Pages host record; does not upload HTML or assets",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "pages",
    action: "create",
    risk: "medium",
    requiresConfirmation: true,
  })
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
    @Option({ flags: "--execute", description: "Create the external Pages host record" }) execute?: boolean,
  ) {
    // Creating a Pages host record mutates Ravi Console, so confirmation must
    // happen before credential and project resolution.
    return runPagesCommand("pages create", asJson, async () => {
      const parsed = parseCreateArgs(args, projectOption);
      const normalizedVisibility = normalizePageVisibility(visibility);
      if (execute !== true) {
        contractDryRun(
          "pages create",
          {
            project: parsed.project ?? "(Console scope default)",
            slug: parsed.slug,
            defaultVisibility: normalizedVisibility ?? null,
            defaultSite: Boolean(isDefault),
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await createPageSite(
        {
          project: resolved.projectRef,
          slug: parsed.slug,
          defaultVisibility: normalizedVisibility,
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

  @Command({
    name: "ship",
    description: "One-shot: ensure a Pages host and publish HTML or a site directory",
    helpAfter: PAGES_SHIP_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "pages", action: "ship", risk: "high", requiresConfirmation: true })
  async ship(
    @Arg("args", {
      variadic: true,
      required: false,
      description: "[project] [slug]; project defaults to Console scope and slug defaults from --title",
    })
    args: string[] = [],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--title <title>", description: "Page title; also used to generate the slug when omitted" })
    titleOption?: string,
    @Option({ flags: "--body <html>", description: "HTML body fragment wrapped in a simple HTML5 document" })
    body?: string,
    @Option({ flags: "--html <file>", description: "Path to an HTML file to publish" }) html?: string,
    @Option({ flags: "--dir <path>", description: "Directory with an entrypoint (default index.html)" }) dir?: string,
    @Option({
      flags: "--visibility <visibility>",
      description: "Pages visibility: private|protected_link|public (default: private)",
    })
    visibility?: string,
    @Option({ flags: "--route <path>", description: "Pages route path to mount content at (default: /)" })
    route?: string,
    @Option({ flags: "--entrypoint <path>", description: "Package entrypoint path (default: index.html)" })
    entrypoint?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually ensure the host and publish; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages ship", asJson, async () => {
      const parsed = parseShipArgs(args, projectOption);
      const title = requireShipTitle(titleOption);
      const resolvedRoute = stringValue(route) ?? "/";
      const resolvedEntrypoint = stringValue(entrypoint) ?? "index.html";
      const normalizedVisibility = normalizePageVisibility(visibility) ?? "private";
      const slug = parsed.slug ?? slugifyPageTitle(title);
      const contentKind = await validateShipSourceInput({ body, dir, html });
      if (execute !== true) {
        // Write brake (Manual v2 7.8): ship creates/reuses a Console host and
        // publishes bytes onto a hosted route. Dry-run before any Console call,
        // including project scope resolution. The plan never carries body text
        // or filesystem paths.
        contractDryRun(
          "pages ship",
          {
            project: parsed.project ?? "(Console scope default)",
            slug,
            titlePresent: true,
            contentKind,
            route: resolvedRoute,
            visibility: normalizedVisibility,
            entrypoint: resolvedEntrypoint,
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const site = await ensurePageSite(
        {
          console: consoleUrl,
          defaultVisibility: normalizedVisibility,
          project: resolved.projectRef,
          slug,
        },
        this.deps,
      );
      const source = await materializeShipSource({
        body,
        dir,
        entrypoint: resolvedEntrypoint,
        html,
        title,
      });
      try {
        const result = await publishArtifactToConsole(
          source.path,
          {
            activate: true,
            console: consoleUrl,
            entrypoint: resolvedEntrypoint,
            json: asJson,
            name: title,
            project: resolved.projectRef,
            publishToPages: true,
            route: resolvedRoute,
            site: slug,
            tool: "ravi pages ship",
            visibility: normalizedVisibility,
          },
          this.deps,
        );
        const payload = {
          artifactId: extractPublishedArtifactId(result),
          route: resolvedRoute,
          site: objectValue(result.site) ?? site,
          slug,
          success: true as const,
          url: result.url,
          visibility: normalizedVisibility,
        };
        printPayload(payload, asJson, () => printShipResult(payload));
        return payload;
      } finally {
        await source.cleanup?.();
      }
    });
  }

  @Command({ name: "publish", description: "Publish a directory, file, or local artifact to a project Pages host" })
  @CommandAccess({ kind: "mutate", resource: "pages", action: "publish", risk: "high", requiresConfirmation: true })
  async publish(
    @Arg("args", {
      variadic: true,
      description:
        "[project] [site] <source>; project defaults to Ravi Console scope and site defaults to the project Pages host",
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
    noActivate?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--site <site>", description: "Legacy site slug/id; defaults to the project Pages host" })
    siteOption?: string,
    @Option({
      flags: "--execute",
      description: "Actually upload/publish to Pages; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages publish", asJson, async () => {
      const parsed = parsePublishArgs(args, projectOption, siteOption);
      const normalizedVisibility = normalizePageVisibility(visibility);
      const parsedArtifactVersion = artifactVersion ? parseInteger(artifactVersion, "--artifact-version") : undefined;
      if (execute !== true) {
        // Write brake (Manual v2 7.8): publish uploads local bytes and (unless
        // --no-activate) exposes them on a hosted Pages URL — external
        // exposure. Dry-run by default and exit 3 before any Console call,
        // including the project scope resolution.
        contractDryRun(
          "pages publish",
          {
            project: parsed.project ?? "(Console scope default)",
            site: parsed.site ?? "(project default Pages host)",
            sourceKind: /^art_[a-z0-9]+_[a-z0-9]+$/.test(parsed.source) ? "artifact" : "path",
            sourceName: parsed.source.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? parsed.source,
            route: route ?? "/",
            visibility: normalizedVisibility ?? null,
            entrypointPresent: Boolean(entrypoint),
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await publishArtifactToConsole(
        parsed.source,
        {
          project: resolved.projectRef,
          site: parsed.site,
          route,
          visibility: normalizedVisibility,
          name: title,
          slug: artifactSlug,
          description,
          entrypoint,
          artifactVersion: parsedArtifactVersion,
          basePath,
          assetBase,
          uploadSession,
          idempotencyKey,
          reason,
          replaceRelease,
          activate: !noActivate,
          console: consoleUrl,
          tool: "ravi pages publish",
          publishToPages: true,
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
  @CommandAccess({ kind: "mutate", resource: "pages", action: "update", risk: "medium", requiresConfirmation: true })
  async update(
    @Arg("args", { variadic: true, description: "[project] <site>; project defaults to Ravi Console scope" })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--visibility <visibility>", description: "Default visibility: private|protected_link|public" })
    visibility?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Required to switch a site to public visibility; other updates apply immediately",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages update", asJson, async () => {
      const parsed = parseSiteArgs(args, projectOption, "update");
      const normalizedVisibility = normalizePageVisibility(visibility);
      brakePublicSiteVisibility("pages update", parsed, normalizedVisibility, execute, asJson);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await updatePageSite(
        {
          project: resolved.projectRef,
          site: parsed.site,
          defaultVisibility: normalizedVisibility,
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
  @CommandAccess({
    kind: "mutate",
    resource: "pages",
    action: "visibility",
    risk: "medium",
    requiresConfirmation: true,
  })
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
    @Option({
      flags: "--execute",
      description: "Required to switch a site to public visibility; other visibilities apply immediately",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages visibility", asJson, async () => {
      const parsed = parseVisibilityArgs(args, projectOption);
      const normalizedVisibility = normalizePageVisibility(parsed.visibility);
      brakePublicSiteVisibility("pages visibility", parsed, normalizedVisibility, execute, asJson);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await updatePageSite(
        {
          project: resolved.projectRef,
          site: parsed.site,
          defaultVisibility: normalizedVisibility,
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
  @CommandAccess({
    kind: "mutate",
    resource: "pages",
    action: "domains",
    risk: "medium",
    requiresConfirmation: true,
  })
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
    @Option({ flags: "--execute", description: "Bind hostnames through the external Pages provider" })
    execute?: boolean,
  ) {
    // Domain binding mutates Ravi Console and may change external routing, so
    // confirmation must happen before credential and project resolution.
    return runPagesCommand("pages domains", asJson, async () => {
      const parsed = parseDomainsArgs(args, projectOption);
      if (execute !== true) {
        contractDryRun(
          "pages domains",
          {
            project: parsed.project ?? "(Console scope default)",
            site: parsed.site,
            hostnameCount: parsed.hostnames.length,
            readinessCheck: Boolean(check),
          },
          { asJson },
        );
      }
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

const PAGES_PASSWORD_SET_HELP = `
Examples:
  ravi pages password set demo --execute
  ravi pages password set project demo --route /report --execute
  ravi pages password set demo --stdin --execute < /secure/path/page-password

Write brake:
  Without --execute the command is a dry-run: it prints the plan, exits 3 and
  never prompts for the password.

Security:
  Interactive input is hidden and confirmed. Automation must use redirected
  stdin. Password flags, positional passwords, and environment input are not
  supported. Output never contains the password.
`;

const PAGES_PASSWORD_REMOVE_HELP = `
Examples:
  ravi pages password remove demo --visibility private --execute
  ravi pages password remove project demo --route /report --visibility protected_link --execute

Without --execute the command is a dry-run (exit 3). The replacement visibility
is required so removing a password can never make a page public accidentally.
`;

@Group({
  name: "pages.password",
  description: "Manage route password protection without exposing password material",
  scope: "open",
})
export class PagesPasswordCommands {
  constructor(private readonly deps: PagesPasswordCommandDeps = {}) {}

  @Command({
    name: "set",
    description: "Set or rotate a route password and enable password access in one operation",
    helpAfter: PAGES_PASSWORD_SET_HELP,
  })
  @CliOnly()
  @CommandAccess({ kind: "mutate", resource: "pages", action: "password", risk: "high", requiresConfirmation: true })
  async set(
    @Arg("args", { variadic: true, description: "[project] <site>; project defaults to Ravi Console scope" })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--route <path>", description: "Stable Pages route to protect (default: /)" })
    route?: string,
    @Option({ flags: "--stdin", description: "Read the password from redirected stdin instead of prompting" })
    fromStdin?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print a secret-free JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually set/rotate the route password; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages password set", asJson, async () => {
      const parsed = parseSiteArgs(args, projectOption, "password set");
      if (execute !== true) {
        // Write brake (Manual v2 7.8): setting/rotating a password flips the
        // route access policy on the hosted site. Braked BEFORE the hidden
        // password prompt — a dry-run must never read secret material — and
        // before any Console call. The plan never carries the password.
        contractDryRun(
          "pages password set",
          {
            project: parsed.project ?? "(Console scope default)",
            site: parsed.site,
            routePresent: route !== undefined,
            action: "set",
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const password = await (this.deps.readPassword ?? readConfirmedSecret)({
        confirmPrompt: "Confirm page password: ",
        fromStdin: Boolean(fromStdin),
        prompt: "Page password: ",
      });
      const result = await managePagePassword(
        {
          action: "set",
          console: consoleUrl,
          password,
          path: route ?? "/",
          project: resolved.projectRef,
          site: parsed.site,
        },
        this.deps,
      );
      const payload = { ...result, projectScope: resolved.scope };
      printPayload(payload, asJson, () => printPasswordResult(result));
      return payload;
    });
  }

  @Command({ name: "status", description: "Show safe route password status without revealing the password" })
  @CommandAccess({ kind: "read", resource: "pages", action: "password", risk: "low" })
  async status(
    @Arg("args", { variadic: true, description: "[project] <site>; project defaults to Ravi Console scope" })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--route <path>", description: "Stable Pages route to inspect (default: /)" })
    route?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print a secret-free JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand("pages password status", asJson, async () => {
      const parsed = parseSiteArgs(args, projectOption, "password status");
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await managePagePassword(
        {
          action: "status",
          console: consoleUrl,
          path: route ?? "/",
          project: resolved.projectRef,
          site: parsed.site,
        },
        this.deps,
      );
      const payload = { ...result, projectScope: resolved.scope };
      printPayload(payload, asJson, () => printPasswordResult(result));
      return payload;
    });
  }

  @Command({
    name: "remove",
    description: "Remove a route password after activating an explicit replacement visibility",
    helpAfter: PAGES_PASSWORD_REMOVE_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "pages", action: "password", risk: "high", requiresConfirmation: true })
  async remove(
    @Arg("args", { variadic: true, description: "[project] <site>; project defaults to Ravi Console scope" })
    args: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--route <path>", description: "Stable Pages route to update (default: /)" })
    route?: string,
    @Option({
      flags: "--visibility <visibility>",
      description: "Required replacement visibility: private|protected_link|public",
    })
    visibility?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print a secret-free JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually remove the route password; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages password remove", asJson, async () => {
      const parsed = parseSiteArgs(args, projectOption, "password remove");
      // Validation stays BEFORE the brake: a missing replacement visibility is
      // a payload error even on the dry-run path.
      const replacementVisibility = normalizePagePasswordReplacementVisibility(visibility);
      if (execute !== true) {
        // Write brake (Manual v2 7.8): removing the password changes who can
        // reach the route (up to fully public). Dry-run by default and exit 3
        // before any Console call.
        contractDryRun(
          "pages password remove",
          {
            project: parsed.project ?? "(Console scope default)",
            site: parsed.site,
            routePresent: route !== undefined,
            replacementVisibility,
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const result = await managePagePassword(
        {
          action: "remove",
          console: consoleUrl,
          path: route ?? "/",
          project: resolved.projectRef,
          site: parsed.site,
          visibility: replacementVisibility,
        },
        this.deps,
      );
      const payload = { ...result, projectScope: resolved.scope };
      printPayload(payload, asJson, () => printPasswordResult(result));
      return payload;
    });
  }
}

function defaultPagesDeps(): PagesCommandDeps {
  return {};
}

/**
 * Conditional write brake (Manual v2 7.8): switching a site default to
 * `public` exposes every already-hosted route to the open web, so it is
 * dry-run by default. Reducing visibility (private/protected_link) stays
 * unbraked on purpose — lockdowns must never be slowed down.
 */
function brakePublicSiteVisibility(
  op: string,
  parsed: { project?: string; site: string },
  visibility: string | undefined,
  execute: boolean | undefined,
  asJson: boolean | undefined,
): void {
  if (visibility !== "public" || execute === true) return;
  contractDryRun(
    op,
    {
      project: parsed.project ?? "(Console scope default)",
      site: parsed.site,
      defaultVisibility: visibility,
    },
    { asJson },
  );
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

function parseShipArgs(args: string[], projectOption: string | undefined): { project?: string; slug?: string } {
  const clean = cleanArgs(args ?? []);
  if (projectOption) {
    if (clean.length === 0) return { project: projectOption };
    if (clean.length === 1) return { project: projectOption, slug: clean[0] };
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Usage: ravi pages ship [slug] --title <title> --project <project-ref> plus --body, --html, or --dir.",
    );
  }
  if (clean.length === 0) return {};
  if (clean.length === 1) return { slug: clean[0] };
  if (clean.length === 2) return { project: clean[0], slug: clean[1] };
  throw new CloudAuthError(
    "PAYLOAD_INVALID",
    "Usage: ravi pages ship [project] [slug] --title <title> plus --body, --html, or --dir.",
  );
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
  siteOption?: string,
): { project?: string; site?: string; source: string } {
  const clean = cleanArgs(args);
  const explicitSite = stringValue(siteOption);
  if (projectOption) {
    if (explicitSite) {
      if (clean.length !== 1) {
        throw new CloudAuthError(
          "PAYLOAD_INVALID",
          "Usage: ravi pages publish <source> --project <project-ref> --site <site>.",
        );
      }
      return { project: projectOption, site: explicitSite, source: clean[0] };
    }
    if (clean.length === 1) {
      return { project: projectOption, source: clean[0] };
    }
    if (clean.length === 2) return { project: projectOption, site: clean[0], source: clean[1] };
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Usage: ravi pages publish <source> --project <project-ref> or ravi pages publish <site> <source> --project <project-ref>.",
    );
  }

  if (explicitSite) {
    if (clean.length === 1) return { site: explicitSite, source: clean[0] };
    if (clean.length === 2) return { project: clean[0], site: explicitSite, source: clean[1] };
    throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages publish [project] <source> --site <site>.");
  }

  if (clean.length === 1) return { source: clean[0] };
  if (clean.length === 2) return { project: clean[0], source: clean[1] };
  if (clean.length === 3) return { project: clean[0], site: clean[1], source: clean[2] };
  throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages publish [project] [site] <source>.");
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
const publishedPageSchema = jsonObjectSchema;

const pagesListReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  projectRef: z.string(),
  total: z.number(),
  pagination: strictCliOffsetPaginationSchema,
  sites: z.array(pageSiteSchema),
  items: z.array(pageSiteSchema),
});

const publishedPagesListReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  projectRef: z.string(),
  total: z.number(),
  pagination: strictCliOffsetPaginationSchema,
  pages: z.array(publishedPageSchema),
  items: z.array(publishedPageSchema),
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

const pagePasswordReturnSchema = z.object({
  success: z.literal(true),
  action: z.enum(["remove", "set", "status"]),
  configured: z.boolean(),
  consoleUrl: z.string(),
  path: z.string(),
  policy: jsonObjectSchema.nullable(),
  projectRef: z.string(),
  release: jsonObjectSchema,
  route: jsonObjectSchema,
  scope: z.literal("route"),
  site: jsonObjectSchema,
  siteRef: z.string(),
  url: z.string(),
});

const pageShipReturnSchema = z.object({
  artifactId: z.string().nullable(),
  route: z.string(),
  site: pageSiteSchema,
  slug: z.string(),
  success: z.literal(true),
  url: z.string().nullable(),
  visibility: z.string(),
});

declareCommandReturns(PagesCommands, {
  list: pagesListReturnSchema,
  published: publishedPagesListReturnSchema,
  create: pageSiteCreateReturnSchema,
  ship: pageShipReturnSchema,
  publish: artifactPublishReturnSchema,
  update: pageSiteUpdateReturnSchema,
  visibility: pageSiteUpdateReturnSchema,
  domains: pageDomainBindReturnSchema,
});

declareCommandReturns(PagesPasswordCommands, {
  set: pagePasswordReturnSchema,
  status: pagePasswordReturnSchema,
  remove: pagePasswordReturnSchema,
});

async function runPagesCommand<T>(op: string, asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Manual v2 contract: contractFail/contractDryRun already emitted their
    // envelope (or legacy text) and carry the exit taxonomy (1/2/3). Never let
    // the legacy CloudAuthError funnel swallow them (model: mail.ts).
    if (error instanceof ContractError) throw error;
    const cloudError = cloudAuthErrorFromUnknown(error);
    failPagesNotFoundFromConsole(op, cloudError, asJson);
    throw cloudError;
  }
}

/**
 * Sites and routes live only in Console (no cheap local candidate source), so
 * unknown refs come back as generic Console errors. Map the recognizable
 * "not found" shapes to the Manual v2 envelope with a listing suggestedAction
 * instead of similarity suggestions; anything else keeps the legacy
 * CloudAuthError funnel untouched.
 */
function failPagesNotFoundFromConsole(op: string, error: CloudAuthError, asJson?: boolean): void {
  const message = error.message;
  if (/route\b.*not.?found|not.?found.*\broute/i.test(message)) {
    contractFail(op, "ROUTE_NOT_FOUND", "Pages route was not found.", {
      asJson,
      details: { suggestedAction: "List published routes with: ravi pages published --json" },
    });
  }
  if (/(site|pages host)\b.*not.?found|not.?found.*\bsite/i.test(message)) {
    contractFail(op, "SITE_NOT_FOUND", "Pages site was not found.", {
      asJson,
      details: { suggestedAction: "List Pages sites with: ravi pages list --json" },
    });
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

function printPublishedPageList(
  result: PublishedPageListResult & { pagination?: { limit: number; nextCommand: string | null; offset: number } },
): void {
  if (result.pages.length === 0) {
    console.log(`No published Pages found for project ${result.projectRef}.`);
    return;
  }

  const pagination = result.pagination;
  console.log(
    `Published Pages (${result.pages.length} returned of ${result.total}${
      pagination ? `, limit ${pagination.limit}, offset ${pagination.offset}` : ""
    })`,
  );
  for (const page of result.pages) {
    console.log(`  - ${publishedPageLabel(page)}`);
    for (const url of stringArrayValue(page.urls)) {
      console.log(`      ${url}`);
    }
  }
  if (pagination?.nextCommand) {
    console.log("\nNext page:");
    console.log(`  ${pagination.nextCommand}`);
  }
}

async function ensurePageSite(
  input: { console?: string; defaultVisibility: string; project: string; slug: string },
  deps: PagesCommandDeps,
): Promise<PageSitePayload> {
  const listed = await listPageSites({ console: input.console, project: input.project }, deps);
  const existing = listed.sites.find((site) => {
    const slug = stringValue(site.slug);
    const id = stringValue(site.id);
    return slug === input.slug || id === input.slug;
  });
  if (existing) return existing;
  const created = await createPageSite(
    {
      console: input.console,
      defaultVisibility: normalizePageVisibility(input.defaultVisibility),
      project: input.project,
      slug: input.slug,
    },
    deps,
  );
  return created.site;
}

function extractPublishedArtifactId(result: ArtifactPublishResult): string | null {
  return stringValue(objectValue(result.artifact)?.id);
}

function printShipResult(result: {
  artifactId: string | null;
  route: string;
  site: PageSitePayload;
  slug: string;
  url: string | null;
  visibility: string;
}): void {
  console.log("✓ Pages shipped");
  printSiteFields(result.site);
  console.log(`  Slug       ${result.slug}`);
  console.log(`  Route      ${result.route}`);
  console.log(`  Visibility ${result.visibility}`);
  if (result.artifactId) console.log(`  Artifact   ${result.artifactId}`);
  console.log(`  URL        ${result.url ?? "not returned by Console"}`);
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

function publishedPageLabel(page: PublishedPagePayload): string {
  const title = stringValue(page.title) ?? stringValue(page.path) ?? stringValue(page.id) ?? "page";
  const host = stringValue(page.defaultHostname);
  const path = stringValue(page.path);
  const status = stringValue(page.status);
  const version = stringValue(page.artifactVersion);
  const visibility = stringValue(page.visibility);
  return [
    title,
    host && path ? `${host}${path === "/" ? "/" : path}` : (host ?? path),
    status ?? [version, visibility].filter(Boolean).join(" · "),
  ]
    .filter(Boolean)
    .join("  ");
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

function printPasswordResult(result: PagePasswordManageResult): void {
  const state =
    result.action === "remove"
      ? "removed"
      : result.action === "set"
        ? "enabled"
        : result.configured
          ? "configured"
          : "not configured";
  console.log(`✓ Pages password protection ${state}`);
  console.log(`  URL        ${result.url}`);
  console.log(`  Route      ${result.path}`);
  console.log(`  Visibility ${result.route.effectiveVisibility}`);
  if (result.policy) console.log(`  Policy     ${result.policy.status} · version ${result.policy.version}`);
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

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
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
