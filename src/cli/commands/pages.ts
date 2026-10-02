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
  normalizePageRoutePath,
  normalizePageVisibility,
  updatePageRouteVisibility,
  updatePageSite,
  type PageDomainBindResult,
  type PagePasswordManageResult,
  type PageRouteVisibilityUpdateResult,
  type PagesClientDeps,
  type PageSiteCreateResult,
  type PageSiteListResult,
  type PageSitePayload,
  type PageSiteUpdateResult,
  type PublishedPageListResult,
  type PublishedPagePayload,
} from "../../pages/client.js";
import {
  describeAssertionAudienceSetRejection,
  listPageAssertionAudiences,
  normalizeAssertionAud,
  normalizeAssertionOrigins,
  normalizePageUses,
  removePageAssertionAudience,
  setPageAssertionAudience,
  type PageAssertionAudienceListResult,
  type PageAssertionAudienceMutationResult,
} from "../../pages/assertion-audiences.js";
import {
  listPageAppGatewayTargets,
  normalizeTargetAppId,
  normalizeTargetAudience,
  normalizeTargetInstallationId,
  normalizeTargetOperations,
  normalizeTargetOrigins,
  removePageAppGatewayTarget,
  resolveConsoleInstallationId,
  setPageAppGatewayTarget,
  type PageAppGatewayTarget,
  type PageAppGatewayTargetListResult,
  type PageAppGatewayTargetRemoveResult,
  type PageAppGatewayTargetSetResult,
} from "../../pages/app-gateway-targets.js";
import {
  ensurePageCommentFollow,
  pageCommentCreatorFromContext,
  type PageCommentFollowDeps,
  type PageCommentFollowResult,
} from "../../pages/comment-follow.js";
import {
  isReservedPageHostSlug,
  materializeShipSource,
  projectOwnedHostSlug,
  requireShipTitle,
  selectProjectDefaultHost,
  validateShipSourceInput,
} from "../../pages/ship.js";
import { CONTRACT_EXIT_USAGE, ContractError, contractDryRun, contractFail, pickFields } from "../agent-contract.js";
import { jsonObjectSchema, jsonValueSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { readConfirmedSecret, type ConfirmedSecretInputOptions } from "../secret-input.js";
import { artifactPublishReturnSchema, declareCommandReturns } from "./operational-return-schemas.js";

export interface PagesCommandDeps extends PagesClientDeps, Pick<ArtifactPublishDeps, "fetch"> {
  client?: ConsoleApiClient;
  getContext?: ConsoleScopeResolverDeps["getContext"];
  listProjects?: ConsoleScopeResolverDeps["listProjects"];
  env?: ConsoleScopeResolverDeps["env"];
  cwd?: ConsoleScopeResolverDeps["cwd"];
  pageCommentFollow?: PageCommentFollowDeps;
}

export interface PagesPasswordCommandDeps extends PagesCommandDeps {
  readPassword?: (options: ConfirmedSecretInputOptions) => Promise<string>;
}

const PAGES_SHIP_HELP = `
Examples:
  ravi pages ship --title "Weekly report" --body "<h1>OK</h1>" --json
  ravi pages ship --project demo --title "Landing" --route /landing --html ./landing.html --visibility public
  ravi pages published --project demo --json

A successful ship arms or reuses a page.comment.created trigger for the current agent, filtered to this page.

Happy path:
  One command. Do not choreograph pages create + pages publish.
  Publishes a route on the project's default host (<orgSlug>-<projectSlug>.ravi.page).
  --title is the page title. It does not create a *.ravi.page host.
  --route defaults to /. Pass --route for any page that is not the project home.
  List routes with pages published before choosing a path.
  A positional slug is a legacy extra host. Prefixes ravi and ravi-* are reserved.
  --title is required. Pass exactly one of --body, --html, or --dir.
  Public visibility is allowed in the same call.
  --uses ravi.identity.assertion opts the page into the Console viewer assertion.
  It does not embed a JWT. Register audiences with pages assertion audiences.

Executes immediately:
  ship uploads and activates the release in the same call. --execute is
  accepted and ignored for compatibility. A failed ship returns the error; read
  it before retrying, and do not probe by re-shipping.

JSON:
  { url, site, slug, route, visibility, artifactId }
`;

const PAGES_CREATE_HELP = `
Advanced / compatibility:
  Host-only. Does not upload HTML or assets.
  Prefer \`ravi pages ship --title <title> --body|--html|--dir … --json\` to get a URL.

Examples:
  ravi pages create demo --json
  ravi pages create proj docs --visibility private --json

Write brake:
  Dry-run by default. Without --execute nothing is written; the command returns
  exit 3 with the planned host record. Creating a host registers a real Pages
  site, so it is never implied.
`;

const PAGES_PUBLISH_HELP = `
Advanced / compatibility:
  Upload onto an existing host, or publish a local art_* already in the ledger.
  Prefer \`ravi pages ship\` unless the HTML is already an art_* id.

Examples:
  ravi pages publish proj demo ./site --route / --json
  ravi pages publish proj demo art_demo_123 --route / --json

Write brake:
  Dry-run by default. Without --execute nothing is uploaded and no release is
  activated; the command returns exit 3 with the planned publish. Publishing
  creates content on a reachable route, so it is never implied.
`;

const PAGES_VISIBILITY_HELP = `
Examples:
  ravi pages visibility demo private
  ravi pages visibility demo public --execute
  ravi pages visibility demo public --route / --execute
  ravi pages visibility demo private --route /foo --json

Without --route:
  Updates the site defaultVisibility only. Routes published with an explicit
  visibility keep that policy and can still redirect visitors to login.

With --route / or /foo:
  Changes that route's visibility only. Does not upload files or ship content.

Write brake:
  Switching to public is dry-run by default (exit 3). Reducing visibility
  writes immediately. The plan shows site vs route and current vs target.

JSON:
  Site: { target: "site", defaultVisibility, effectiveVisibility, site, url }
  Route: { target: "route", route, defaultVisibility, effectiveVisibility, url }
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
    description: "Advanced/compat: host-only Pages record; does not upload HTML. Prefer pages ship to get a URL",
    helpAfter: PAGES_CREATE_HELP,
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
    @Option({
      flags: "--execute",
      description: "Write the host record. Without it, pages create only returns the planned host",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages create", asJson, async () => {
      const parsed = parseCreateArgs(args, projectOption);
      const normalizedVisibility = normalizePageVisibility(visibility);
      if (execute !== true) {
        // Write brake (Manual v2 7.8): creating a host registers a real Pages
        // site. Dry-run by default and exit 3 before any Console call.
        contractDryRun(
          "pages create",
          {
            project: parsed.project ?? "(Console scope default)",
            slug: parsed.slug,
            visibility: normalizedVisibility ?? "(provider default)",
            isDefault: Boolean(isDefault),
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
    description: "One-shot: publish a route on the project default Pages host",
    helpAfter: PAGES_SHIP_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "pages", action: "ship", risk: "high" })
  async ship(
    @Arg("args", {
      variadic: true,
      required: false,
      description:
        "[project] [slug]; project defaults to Console scope. A slug is a legacy extra host. Omit it to use the project default host",
    })
    args: string[] = [],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--title <title>", description: "Page title. Does not create a host slug" })
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
    @Option({
      flags: "--uses <id...>",
      description:
        "Capability ids to declare on the publish, such as ravi.identity.assertion. Repeat or comma-separate. Does not embed a JWT",
    })
    uses?: string[],
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Accepted and ignored for compatibility. pages ship always publishes",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages ship", asJson, async () => {
      const parsed = parseShipArgs(args, projectOption);
      const title = requireShipTitle(titleOption);
      const resolvedRoute = stringValue(route) ?? "/";
      const resolvedEntrypoint = stringValue(entrypoint) ?? "index.html";
      const normalizedVisibility = normalizePageVisibility(visibility) ?? "private";
      const normalizedUses = normalizePageUses(uses);
      const legacySlug = parsed.slug;
      if (legacySlug && isReservedPageHostSlug(legacySlug)) {
        throw new CloudAuthError(
          "PAYLOAD_INVALID",
          `Host slug "${legacySlug}" is reserved. Prefixes ravi and ravi-* cannot be created from pages ship. Publish a route on the project default host instead.`,
        );
      }
      // Ship is the agent happy path and executes immediately. --execute stays
      // accepted so callers that still pass it keep working.
      void execute;
      await validateShipSourceInput({ body, dir, html });
      if (legacySlug) warnLegacyPageHost(legacySlug);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      const host = await resolveShipHost(
        {
          console: consoleUrl,
          defaultVisibility: normalizedVisibility,
          legacySlug,
          project: resolved.projectRef,
          scope: resolved.scope,
        },
        this.deps,
      );
      const site = host.site;
      const slug = host.slug;
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
            uses: normalizedUses,
            visibility: normalizedVisibility,
          },
          this.deps,
        );
        const shippedSite = objectValue(result.site) ?? site;
        const commentFollow = await armPageCommentFollow(
          {
            site: shippedSite,
            ensuredSite: site,
            publish: result,
            organizationId: stringValue(resolved.scope.organization?.id),
            projectId: stringValue(resolved.scope.project?.id),
          },
          this.deps,
        );
        const payload = {
          artifactId: extractPublishedArtifactId(result),
          commentFollow,
          route: resolvedRoute,
          site: shippedSite,
          slug,
          success: true as const,
          url: result.url,
          ...(normalizedUses ? { uses: normalizedUses } : {}),
          visibility: normalizedVisibility,
        };
        printPayload(payload, asJson, () => printShipResult(payload));
        return payload;
      } finally {
        await source.cleanup?.();
      }
    });
  }

  @Command({
    name: "publish",
    description:
      "Advanced/compat: upload to an existing host or local art_*; prefer pages ship unless the HTML is already art_*",
    helpAfter: PAGES_PUBLISH_HELP,
  })
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
      description: "Upload and publish. Without it, pages publish only returns the planned publish",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages publish", asJson, async () => {
      const parsed = parsePublishArgs(args, projectOption, siteOption);
      const normalizedVisibility = normalizePageVisibility(visibility);
      const parsedArtifactVersion = artifactVersion ? parseInteger(artifactVersion, "--artifact-version") : undefined;
      if (execute !== true) {
        // Write brake (Manual v2 7.8): publishing uploads content and can
        // activate a release on a reachable route. Dry-run by default and exit 3
        // before any Console call.
        contractDryRun(
          "pages publish",
          {
            project: parsed.project ?? "(Console scope default)",
            site: parsed.site ?? "(project Pages host)",
            source: parsed.source,
            route: route ?? "/",
            visibility: normalizedVisibility ?? "(provider default)",
            entrypoint: entrypoint ?? "index.html",
            artifactVersion: parsedArtifactVersion ?? "latest",
            activate: noActivate !== true,
            replaceRelease: Boolean(replaceRelease),
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

  @Command({
    name: "visibility",
    description: "Set a Ravi Pages site default visibility, or one route with --route",
    helpAfter: PAGES_VISIBILITY_HELP,
  })
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
    @Option({
      flags: "--route <path>",
      description: "Change this route's visibility only, without uploading content. Omit to set site defaultVisibility",
    })
    route?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Required to switch visibility to public; other visibilities apply immediately",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages visibility", asJson, async () => {
      const parsed = parseVisibilityArgs(args, projectOption);
      const normalizedVisibility = normalizePageVisibility(parsed.visibility);
      const routePath = stringValue(route) ? normalizePageRoutePath(route) : undefined;
      brakePublicVisibility("pages visibility", parsed, normalizedVisibility, execute, asJson, routePath);
      const resolved = await resolvePagesProject(parsed.project, undefined, consoleUrl, this.deps);
      if (routePath) {
        const result = await updatePageRouteVisibility(
          {
            console: consoleUrl,
            path: routePath,
            project: resolved.projectRef,
            site: parsed.site,
            visibility: requireVisibilityValue(normalizedVisibility),
          },
          this.deps,
        );
        const payload = { ...result, scope: resolved.scope };
        printPayload(payload, asJson, () => printUpdatedRouteVisibility(result));
        return payload;
      }
      const result = await updatePageSite(
        {
          project: resolved.projectRef,
          site: parsed.site,
          defaultVisibility: normalizedVisibility,
          console: consoleUrl,
        },
        this.deps,
      );
      const defaultVisibility =
        stringValue(result.site.defaultVisibility) ?? stringValue(result.site.visibility) ?? normalizedVisibility;
      const payload = {
        ...result,
        defaultVisibility,
        effectiveVisibility: defaultVisibility,
        scope: resolved.scope,
        target: "site" as const,
      };
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

const PAGES_ASSERTION_AUDIENCES_SET_HELP = `
Examples:
  ravi pages assertion audiences set --site demo --aud https://api.example --origin https://demo.ravi.page --execute
  ravi pages assertion audiences set --site demo --aud https://api.example --origin https://demo.ravi.page --origin https://docs.example --json --execute

--origin must be an https origin of this Pages site: the default host
(https://<site>.ravi.page) or an active custom hostname on the same site.
It is not the third-party API. Put the API identifier in --aud.
A second --origin is another hostname of this site, such as an active custom hostname.

Write brake:
  Without --execute the command is a dry-run: it prints the plan and exits 3.
  Nothing is sent to Console.

Security:
  Registers which Pages host origins may receive a short-lived viewer assertion for one audience.
  Do not pass a JWT as --aud or --origin. Output never contains an assertion token.
`;

const PAGES_ASSERTION_AUDIENCES_REMOVE_HELP = `
Examples:
  ravi pages assertion audiences remove --site demo --aud https://api.example --execute

Without --execute the command is a dry-run (exit 3). Removing an audience stops
new viewer assertions for that aud. It does not change route visibility.
`;

@Group({
  name: "pages.assertion.audiences",
  description: "Register viewer-assertion audiences for a Pages host",
  scope: "open",
})
export class PagesAssertionAudienceCommands {
  constructor(private readonly deps: PagesCommandDeps = {}) {}

  @Command({ name: "list", description: "List viewer-assertion audiences registered on a Pages host" })
  @CommandAccess({ kind: "read", resource: "pages", action: "assertion-audiences", risk: "low" })
  async list(
    @Option({
      flags: "--site <host>",
      description: "Pages host slug, site id, or hostname. Console accepts all three as siteRef",
    })
    site?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum audiences to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of audiences to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand("pages assertion audiences list", asJson, async () => {
      const siteRef = requireAssertionSite(site);
      const resolved = await resolvePagesProject(undefined, projectOption, consoleUrl, this.deps);
      const result = await listPageAssertionAudiences(
        { console: consoleUrl, project: resolved.projectRef, site: siteRef },
        this.deps,
      );
      const page = paginateCliItems(result.audiences, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "pages", "assertion", "audiences", "list"],
        limit: page.limit,
        offset: page.offset,
        options: ["--site", siteRef, "--project", resolved.projectRef, consoleUrl ? "--console" : null, consoleUrl],
        returned: page.items.length,
        total: page.total,
      });
      const payload = {
        ...result,
        audiences: page.items,
        pagination,
        scope: resolved.scope,
        total: page.total,
      };
      printPayload(payload, asJson, () =>
        printAssertionAudienceList({ ...result, audiences: page.items, total: page.total }),
      );
      return payload;
    });
  }

  @Command({
    name: "set",
    description: "Replace the https origins of this Pages site that may receive a viewer assertion for one audience",
    helpAfter: PAGES_ASSERTION_AUDIENCES_SET_HELP,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "pages",
    action: "assertion-audiences",
    risk: "high",
    requiresConfirmation: true,
  })
  async set(
    @Option({
      flags: "--site <host>",
      description: "Pages host slug, site id, or hostname. Console accepts all three as siteRef",
    })
    site?: string,
    @Option({ flags: "--aud <aud>", description: "Assertion audience identifier for the third-party API" })
    aud?: string,
    @Option({
      flags: "--origin <origin...>",
      description:
        "HTTPS origin of this Pages site (default host or active custom hostname), not the third-party API. Repeat or comma-separate",
    })
    origins?: string[],
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print a token-free JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Register the audience; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages assertion audiences set", asJson, async () => {
      const siteRef = requireAssertionSite(site);
      const normalizedAud = normalizeAssertionAud(aud);
      const normalizedOrigins = normalizeAssertionOrigins(origins);
      if (execute !== true) {
        contractDryRun(
          "pages assertion audiences set",
          {
            project: projectOption ?? "(Console scope default)",
            site: siteRef,
            aud: normalizedAud,
            originCount: normalizedOrigins.length,
            origins: normalizedOrigins,
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(undefined, projectOption, consoleUrl, this.deps);
      let result: PageAssertionAudienceMutationResult;
      try {
        result = await setPageAssertionAudience(
          {
            aud: normalizedAud,
            console: consoleUrl,
            origins: normalizedOrigins,
            project: resolved.projectRef,
            site: siteRef,
          },
          this.deps,
        );
      } catch (error) {
        // Console owns the hostname allowlist. Forward a safe 400 body when it
        // explains the rejection. Otherwise state the Pages-host origin rule.
        const rejection = describeAssertionAudienceSetRejection(error);
        if (rejection) {
          contractFail("pages assertion audiences set", "PAYLOAD_INVALID", rejection.message, {
            asJson,
            exitCode: CONTRACT_EXIT_USAGE,
            details: {
              retryable: false,
              status: 400,
              suggestedAction: rejection.suggestedAction,
              ...(rejection.issues ? { issues: rejection.issues } : {}),
            },
          });
        }
        // Audience exclusivity: a gateway target row on this site, in any
        // status, reserves the audience. The shared Console error mapper
        // aliases 409 `CONFLICT` to a Ravi Link binding conflict, so name the
        // real cause here instead of suggesting `ravi unlink`.
        if (error instanceof CloudAuthError && error.status === 409) {
          contractFail(
            "pages assertion audiences set",
            "APP_GATEWAY_AUDIENCE_CONFLICT",
            "This audience is reserved for a Pages app gateway target on this site.",
            {
              asJson,
              exitCode: CONTRACT_EXIT_USAGE,
              details: {
                retryable: false,
                status: 409,
                suggestedAction:
                  "Use another --aud; gateway audiences stay reserved even after ravi pages apps targets remove",
              },
            },
          );
        }
        throw error;
      }
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printAssertionAudienceMutation(result));
      return payload;
    });
  }

  @Command({
    name: "remove",
    description: "Remove one viewer-assertion audience from a Pages host",
    helpAfter: PAGES_ASSERTION_AUDIENCES_REMOVE_HELP,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "pages",
    action: "assertion-audiences",
    risk: "high",
    requiresConfirmation: true,
  })
  async remove(
    @Option({
      flags: "--site <host>",
      description: "Pages host slug, site id, or hostname. Console accepts all three as siteRef",
    })
    site?: string,
    @Option({ flags: "--aud <aud>", description: "Assertion audience identifier to remove" }) aud?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print a token-free JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Remove the audience; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages assertion audiences remove", asJson, async () => {
      const siteRef = requireAssertionSite(site);
      const normalizedAud = normalizeAssertionAud(aud);
      if (execute !== true) {
        contractDryRun(
          "pages assertion audiences remove",
          {
            project: projectOption ?? "(Console scope default)",
            site: siteRef,
            aud: normalizedAud,
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(undefined, projectOption, consoleUrl, this.deps);
      const result = await removePageAssertionAudience(
        { aud: normalizedAud, console: consoleUrl, project: resolved.projectRef, site: siteRef },
        this.deps,
      );
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printAssertionAudienceMutation(result));
      return payload;
    });
  }
}

const PAGES_APP_TARGETS_SET_HELP = `
Examples:
  ravi pages apps targets set --site demo --aud https://apps.example.ravi.local/slides --app slides --op slides.list --origin https://demo.ravi.page --execute
  ravi pages apps targets set --site demo --aud https://apps.example.ravi.local/slides --app slides --op slides.list --op slides.get --origin https://demo.ravi.page --json --execute

A target lets pages on this site call /_ravi/apps/<app>/<op> with a viewer
assertion for --aud. Console signs a target grant and pushes it to the edge;
the grant itself is never printed.

--installation defaults to this installation's Console id (GET /api/cli/me).
--op is an exact manifest operation id; repeat it (1 to 16). --origin is an
https origin of this Pages site; repeat it (1 to 8).

This installation still runs nothing until RAVI_APP_GATEWAY_ENABLED=1 and
apps.gateway.allowed_operations lists <app>:<op>.

Write brake:
  Without --execute the command is a dry-run: it prints the plan and exits 3.
  Nothing is written to Console.
`;

const PAGES_APP_TARGETS_REMOVE_HELP = `
Examples:
  ravi pages apps targets remove --site demo --aud https://apps.example.ravi.local/slides --execute

Revokes the target and deletes its edge grant. The audience stays reserved for
the app gateway on this site. Without --execute the command is a dry-run (exit 3).
`;

@Group({
  name: "pages.apps.targets",
  description: "Register Pages app gateway targets (site audience to this installation's app operations)",
  scope: "open",
})
export class PagesAppTargetsCommands {
  constructor(private readonly deps: PagesCommandDeps = {}) {}

  @Command({ name: "list", description: "List app gateway targets on a Pages host, active and revoked" })
  @CommandAccess({ kind: "read", resource: "pages", action: "app-gateway-targets", risk: "low" })
  async list(
    @Option({
      flags: "--site <host>",
      description: "Pages host slug, site id, or hostname. Console accepts all three as siteRef",
    })
    site?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum targets to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of targets to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print a token-free JSON result" }) asJson?: boolean,
  ) {
    return runPagesCommand("pages apps targets list", asJson, async () => {
      const siteRef = requireAssertionSite(site);
      const resolved = await resolvePagesProject(undefined, projectOption, consoleUrl, this.deps);
      const result = await listPageAppGatewayTargets(
        { console: consoleUrl, project: resolved.projectRef, site: siteRef },
        this.deps,
      );
      const page = paginateCliItems(result.targets, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "pages", "apps", "targets", "list"],
        limit: page.limit,
        offset: page.offset,
        options: ["--site", siteRef, "--project", resolved.projectRef, consoleUrl ? "--console" : null, consoleUrl],
        returned: page.items.length,
        total: page.total,
      });
      const payload = { ...result, targets: page.items, pagination, scope: resolved.scope, total: page.total };
      printPayload(payload, asJson, () => printAppTargetList({ ...result, targets: page.items, total: page.total }));
      return payload;
    });
  }

  @Command({
    name: "set",
    description: "Create or replace the app gateway target for one audience on a Pages host",
    helpAfter: PAGES_APP_TARGETS_SET_HELP,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "pages",
    action: "app-gateway-targets",
    risk: "high",
    requiresConfirmation: true,
  })
  async set(
    @Option({
      flags: "--site <host>",
      description: "Pages host slug, site id, or hostname. Console accepts all three as siteRef",
    })
    site?: string,
    @Option({ flags: "--aud <aud>", description: "Viewer-assertion audience reserved for the app gateway" })
    aud?: string,
    @Option({ flags: "--app <appId>", description: "Ravi app id served by the target installation" }) app?: string,
    @Option({
      flags: "--op <operationId...>",
      description: "Exact manifest operation id (for example slides.list). Repeat for 1 to 16",
    })
    operations?: string[],
    @Option({
      flags: "--origin <origin...>",
      description: "HTTPS origin of this Pages site (default host or active custom hostname). Repeat for 1 to 8",
    })
    origins?: string[],
    @Option({
      flags: "--installation <id>",
      description: "Console installation id that serves the target (default: this installation)",
    })
    installation?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print a token-free JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Register the target; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages apps targets set", asJson, async () => {
      const siteRef = requireAssertionSite(site);
      const audience = normalizeTargetAudience(aud);
      const appId = normalizeTargetAppId(app);
      const normalizedOperations = normalizeTargetOperations(operations);
      const normalizedOrigins = normalizeTargetOrigins(origins);
      const explicitInstallation = normalizeTargetInstallationId(installation);
      const installationId =
        explicitInstallation ?? (await resolveConsoleInstallationId({ console: consoleUrl }, this.deps)) ?? undefined;
      if (execute !== true) {
        contractDryRun(
          "pages apps targets set",
          {
            project: projectOption ?? "(Console scope default)",
            site: siteRef,
            aud: audience,
            app: appId,
            operations: normalizedOperations,
            origins: normalizedOrigins,
            installation: installationId ?? "(this CLI session's Console installation)",
          },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(undefined, projectOption, consoleUrl, this.deps);
      let result: PageAppGatewayTargetSetResult;
      try {
        result = await setPageAppGatewayTarget(
          {
            appId,
            audience,
            console: consoleUrl,
            ...(installationId ? { installationId } : {}),
            operations: normalizedOperations,
            origins: normalizedOrigins,
            project: resolved.projectRef,
            site: siteRef,
          },
          this.deps,
        );
      } catch (error) {
        failAppTargetFromConsole("pages apps targets set", error, asJson);
        throw error;
      }
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printAppTargetSet(result));
      return payload;
    });
  }

  @Command({
    name: "remove",
    description: "Revoke the app gateway target for one audience on a Pages host",
    helpAfter: PAGES_APP_TARGETS_REMOVE_HELP,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "pages",
    action: "app-gateway-targets",
    risk: "high",
    requiresConfirmation: true,
  })
  async remove(
    @Option({
      flags: "--site <host>",
      description: "Pages host slug, site id, or hostname. Console accepts all three as siteRef",
    })
    site?: string,
    @Option({ flags: "--aud <aud>", description: "Audience of the target to revoke" }) aud?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug; overrides saved Console scope" })
    projectOption?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print a token-free JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Revoke the target; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runPagesCommand("pages apps targets remove", asJson, async () => {
      const siteRef = requireAssertionSite(site);
      const audience = normalizeTargetAudience(aud);
      if (execute !== true) {
        contractDryRun(
          "pages apps targets remove",
          { project: projectOption ?? "(Console scope default)", site: siteRef, aud: audience },
          { asJson },
        );
      }
      const resolved = await resolvePagesProject(undefined, projectOption, consoleUrl, this.deps);
      let result: PageAppGatewayTargetRemoveResult;
      try {
        result = await removePageAppGatewayTarget(
          { audience, console: consoleUrl, project: resolved.projectRef, site: siteRef },
          this.deps,
        );
      } catch (error) {
        failAppTargetFromConsole("pages apps targets remove", error, asJson);
        throw error;
      }
      const payload = { ...result, scope: resolved.scope };
      printPayload(payload, asJson, () => printAppTargetRemove(result));
      return payload;
    });
  }
}

/**
 * Console answers target conflicts with 409 `CONFLICT` and installation
 * refusals with 403 `INSTALLATION_ORG_MISMATCH`. The shared Console error
 * mapper aliases those for `ravi link`, so map them back by status here.
 */
function failAppTargetFromConsole(op: string, error: unknown, asJson: boolean | undefined): void {
  if (!(error instanceof CloudAuthError)) return;
  if (error.status === 409) {
    contractFail(op, "APP_GATEWAY_AUDIENCE_CONFLICT", "This audience is a viewer-assertion audience on this site.", {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        retryable: false,
        status: 409,
        suggestedAction:
          "Use another --aud for the app gateway, or remove the viewer-assertion audience first with ravi pages assertion audiences remove",
      },
    });
  }
  if (error.status === 403 && error.code === "ORG_ACCESS_DENIED") {
    contractFail(
      op,
      "INSTALLATION_ORG_MISMATCH",
      "The installation is not an active installation of this site's organization, or you cannot manage it.",
      {
        asJson,
        details: {
          retryable: false,
          status: 403,
          suggestedAction:
            "Omit --installation to use this installation, or ask an organization owner or admin to register the target",
        },
      },
    );
  }
  if (error.status === 404 && error.code === "PAYLOAD_INVALID") {
    contractFail(op, "TARGET_NOT_FOUND", "No app gateway target with this audience on this site.", {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        retryable: false,
        status: 404,
        suggestedAction: "List targets with: ravi pages apps targets list --site <site> --json",
      },
    });
  }
}

function requireAssertionSite(site: string | undefined): string {
  const text = site?.trim();
  if (!text) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Missing --site. Pass a Pages host slug, site id, or hostname.");
  }
  return text;
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
  brakePublicVisibility(op, parsed, visibility, execute, asJson);
}

/**
 * Same directional public brake as site updates. `--route` only changes what
 * the plan describes (site default vs one explicit route).
 */
function brakePublicVisibility(
  op: string,
  parsed: { project?: string; site: string },
  visibility: string | undefined,
  execute: boolean | undefined,
  asJson: boolean | undefined,
  routePath?: string,
): void {
  if (visibility !== "public" || execute === true) return;
  contractDryRun(
    op,
    routePath
      ? {
          project: parsed.project ?? "(Console scope default)",
          site: parsed.site,
          scope: "route",
          route: routePath,
          currentVisibility: "explicit route policy",
          targetVisibility: visibility,
          siteDefaultVisibility: "unchanged",
        }
      : {
          project: parsed.project ?? "(Console scope default)",
          site: parsed.site,
          scope: "site",
          currentVisibility: "site defaultVisibility",
          targetVisibility: visibility,
          defaultVisibility: visibility,
        },
    { asJson },
  );
}

function requireVisibilityValue(value: ReturnType<typeof normalizePageVisibility>) {
  if (!value) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Usage: ravi pages visibility [project] <site> <visibility>.");
  }
  return value;
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
  target: z.enum(["site", "route"]).optional(),
  path: z.string().optional(),
  route: jsonObjectSchema.optional(),
  defaultVisibility: z.string().nullable().optional(),
  effectiveVisibility: z.string().optional(),
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

const pageCommentFollowReturnSchema = z.object({
  ok: z.boolean(),
  topic: z.string(),
  session: z.literal("main"),
  filter: z.string().optional(),
  agentId: z.string().optional(),
  triggerId: z.string().optional(),
  reused: z.boolean().optional(),
  pageId: z.string().optional(),
  orgId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  warning: z.string().optional(),
  skipped: z.enum(["missing_page", "missing_creator", "invalid_filter", "unbound_agent"]).optional(),
});

const pageShipReturnSchema = z.object({
  artifactId: z.string().nullable(),
  commentFollow: pageCommentFollowReturnSchema,
  route: z.string(),
  site: pageSiteSchema,
  slug: z.string(),
  success: z.literal(true),
  url: z.string().nullable(),
  uses: z.array(z.string()).optional(),
  visibility: z.string(),
});

const pageAssertionAudienceSchema = z.object({
  aud: z.string(),
  origins: z.array(z.string()),
});

const pageAssertionAudienceListReturnSchema = z.object({
  audiences: z.array(pageAssertionAudienceSchema),
  consoleUrl: z.string(),
  jwksUrl: z.string(),
  pagination: strictCliOffsetPaginationSchema,
  projectRef: z.string(),
  siteRef: z.string(),
  success: z.literal(true),
  total: z.number(),
});

const pageAssertionAudienceMutationReturnSchema = z.object({
  action: z.enum(["remove", "set"]),
  aud: z.string(),
  audiences: z.array(pageAssertionAudienceSchema),
  consoleUrl: z.string(),
  jwksUrl: z.string(),
  origins: z.array(z.string()),
  projectRef: z.string(),
  siteRef: z.string(),
  success: z.literal(true),
});

const pageAppTargetSchema = z.object({
  id: z.string().nullable(),
  audience: z.string(),
  appId: z.string().nullable(),
  operations: z.array(z.string()),
  origins: z.array(z.string()),
  installationId: z.string().nullable(),
  organizationId: z.string().nullable(),
  projectId: z.string().nullable(),
  siteId: z.string().nullable(),
  status: z.string().nullable(),
  revision: z.number().nullable(),
  grantExpiresAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});

const pageAppTargetListReturnSchema = z.object({
  consoleUrl: z.string(),
  pagination: strictCliOffsetPaginationSchema,
  projectRef: z.string(),
  siteRef: z.string(),
  success: z.literal(true),
  targets: z.array(pageAppTargetSchema),
  total: z.number(),
});

const pageAppTargetSetReturnSchema = z.object({
  action: z.literal("set"),
  audience: z.string(),
  consoleUrl: z.string(),
  projectRef: z.string(),
  siteRef: z.string(),
  success: z.literal(true),
  target: pageAppTargetSchema.nullable(),
});

const pageAppTargetRemoveReturnSchema = z.object({
  action: z.literal("remove"),
  audience: z.string(),
  consoleUrl: z.string(),
  id: z.string().nullable(),
  projectRef: z.string(),
  siteRef: z.string(),
  status: z.string(),
  success: z.literal(true),
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

declareCommandReturns(PagesAssertionAudienceCommands, {
  list: pageAssertionAudienceListReturnSchema,
  set: pageAssertionAudienceMutationReturnSchema,
  remove: pageAssertionAudienceMutationReturnSchema,
});

declareCommandReturns(PagesAppTargetsCommands, {
  list: pageAppTargetListReturnSchema,
  set: pageAppTargetSetReturnSchema,
  remove: pageAppTargetRemoveReturnSchema,
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

const MISSING_DEFAULT_HOST =
  "This project has no default Pages host. pages ship publishes a route on that host and does not create a *.ravi.page host from --title. Mark the project-owned host <orgSlug>-<projectSlug> as default, or pass a positional slug only to target a legacy extra host.";

async function resolveShipHost(
  input: {
    console?: string;
    defaultVisibility: string;
    legacySlug?: string;
    project: string;
    scope: ResolvedConsoleScope;
  },
  deps: PagesCommandDeps,
): Promise<{ site: PageSitePayload; slug: string }> {
  if (input.legacySlug) {
    const site = await ensurePageSite(
      {
        console: input.console,
        defaultVisibility: input.defaultVisibility,
        project: input.project,
        slug: input.legacySlug,
      },
      deps,
    );
    return { site, slug: input.legacySlug };
  }

  const listed = await listPageSites({ console: input.console, project: input.project }, deps);
  const convention = projectOwnedHostSlug(input.scope.organization?.slug, input.scope.project?.slug);
  const existing = selectProjectDefaultHost(listed.sites, convention);
  if (existing) {
    const slug = stringValue(existing.slug) ?? stringValue(existing.id);
    if (!slug) {
      throw new CloudAuthError("PAYLOAD_INVALID", "Project default Pages host is missing a slug.");
    }
    return { site: existing, slug };
  }

  if (convention && isReservedPageHostSlug(convention)) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Project-owned host slug "${convention}" is reserved. Prefixes ravi and ravi-* are not user-creatable, and this project has no default Pages host.`,
    );
  }

  if (!convention) {
    throw new CloudAuthError("PAYLOAD_INVALID", MISSING_DEFAULT_HOST);
  }

  const created = await createPageSite(
    {
      console: input.console,
      defaultVisibility: normalizePageVisibility(input.defaultVisibility),
      isDefault: true,
      project: input.project,
      slug: convention,
    },
    deps,
  );
  return { site: created.site, slug: convention };
}

function warnLegacyPageHost(slug: string): void {
  console.error(
    `Legacy Pages host "${slug}": publishing to an extra *.ravi.page host. The happy path publishes a route on the project default host. Do not create one host per page.`,
  );
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

async function armPageCommentFollow(
  input: Parameters<typeof ensurePageCommentFollow>[0],
  deps: PagesCommandDeps,
): Promise<PageCommentFollowResult> {
  try {
    return await ensurePageCommentFollow(input, {
      ...deps.pageCommentFollow,
      getCreator: deps.pageCommentFollow?.getCreator ?? (() => pageCommentCreatorFromContext(deps.getContext)),
    });
  } catch (error) {
    return {
      ok: false,
      topic: "ravi.watch.console.page.comment.created",
      session: "main",
      warning: `Page comment trigger failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function printShipResult(result: {
  artifactId: string | null;
  commentFollow?: PageCommentFollowResult;
  route: string;
  site: PageSitePayload;
  slug: string;
  url: string | null;
  uses?: string[];
  visibility: string;
}): void {
  console.log("✓ Pages shipped");
  printSiteFields(result.site);
  console.log(`  Slug       ${result.slug}`);
  console.log(`  Route      ${result.route}`);
  console.log(`  Visibility ${result.visibility}`);
  if (result.uses?.length) console.log(`  Uses       ${result.uses.join(", ")}`);
  if (result.artifactId) console.log(`  Artifact   ${result.artifactId}`);
  console.log(`  URL        ${result.url ?? "not returned by Console"}`);
  printCommentFollow(result.commentFollow);
}

function printAssertionAudienceList(result: PageAssertionAudienceListResult): void {
  console.log(`Viewer assertion audiences for ${result.siteRef} (${result.total})`);
  if (result.audiences.length === 0) {
    console.log("  No audiences registered.");
  }
  for (const audience of result.audiences) {
    console.log(`  - ${audience.aud}`);
    console.log(`      origins: ${audience.origins.join(", ") || "(none)"}`);
  }
  console.log(`JWKS ${result.jwksUrl}`);
}

function printAssertionAudienceMutation(result: PageAssertionAudienceMutationResult): void {
  const verb = result.action === "set" ? "set" : "removed";
  console.log(`✓ Assertion audience ${verb}`);
  console.log(`  Site    ${result.siteRef}`);
  console.log(`  Aud     ${result.aud}`);
  if (result.action === "set") console.log(`  Origins ${result.origins.join(", ")}`);
  console.log(`  JWKS    ${result.jwksUrl}`);
}

function printAppTargetList(result: PageAppGatewayTargetListResult): void {
  console.log(`App gateway targets for ${result.siteRef} (${result.total})`);
  if (result.targets.length === 0) console.log("  No targets registered.");
  for (const target of result.targets) printAppTargetFields(target);
}

function printAppTargetSet(result: PageAppGatewayTargetSetResult): void {
  console.log("✓ App gateway target set");
  console.log(`  Site    ${result.siteRef}`);
  if (result.target) printAppTargetFields(result.target);
  else console.log(`  Aud     ${result.audience}`);
}

function printAppTargetRemove(result: PageAppGatewayTargetRemoveResult): void {
  console.log("✓ App gateway target revoked");
  console.log(`  Site    ${result.siteRef}`);
  console.log(`  Aud     ${result.audience}`);
  console.log(`  Status  ${result.status}`);
}

function printAppTargetFields(target: PageAppGatewayTarget): void {
  console.log(`  - ${target.audience} [${target.status ?? "unknown"}]`);
  console.log(`      app: ${target.appId ?? "(unknown)"}  operations: ${target.operations.join(", ") || "(none)"}`);
  console.log(`      origins: ${target.origins.join(", ") || "(none)"}`);
  console.log(`      installation: ${target.installationId ?? "(unknown)"}`);
  console.log(`      grant expires: ${target.grantExpiresAt ?? "not pushed for this revision"}`);
}

function printCommentFollow(follow: PageCommentFollowResult | undefined): void {
  if (!follow) return;
  if (follow.triggerId) {
    const action = follow.reused ? "reused" : "created";
    console.log(`  Comments   ${action} trigger ${follow.triggerId} for agent ${follow.agentId ?? "(unbound)"}`);
    return;
  }
  if (follow.warning) console.log(`  Comments   ${follow.warning}`);
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

function printUpdatedRouteVisibility(result: PageRouteVisibilityUpdateResult): void {
  console.log("✓ Pages route visibility updated");
  printSiteFields(result.site);
  console.log(`  Route      ${result.route.path}`);
  console.log(`  Visibility ${result.effectiveVisibility}`);
  if (result.defaultVisibility) console.log(`  Default    ${result.defaultVisibility} (site)`);
  const repair = objectValue(result.edgeManifestRepair);
  if (repair?.status) console.log(`  Edge:      ${repair.status}`);
  if (result.url) console.log(`  URL        ${result.url}`);
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
