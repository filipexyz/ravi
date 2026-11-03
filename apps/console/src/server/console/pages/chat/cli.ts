// `ravi pages chat show|set`: read and change one site's Page Chat settings.

import { eq } from "drizzle-orm";

import { cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import {
  resolveViewerAssertionCliSite,
  type ViewerAssertionCliSite,
  type ViewerAssertionCliWorkspace,
} from "@/server/console/pages/viewer-assertions/cli";
import { db, schema } from "@/server/db";

import {
  applyPageChatSiteSettingsPatch,
  PAGE_CHAT_VOICES,
  parsePageChatSiteSettings,
  parsePageChatSiteSettingsPatch,
  type PageChatSiteSettings,
  type PageChatSiteSettingsPatch,
} from "./site-settings";
import { PAGE_CHAT_FEATURE_KEY } from "./usage";
import { requirePageChatEngine } from "./engine";

export const PAGE_CHAT_CLI_READ_SCOPES = ["console.projects.read"] as const;
export const PAGE_CHAT_CLI_WRITE_SCOPES = ["console.projects.link", "artifacts.publish"] as const;

export type PageChatCliWorkspace = ViewerAssertionCliWorkspace;

export type PageChatCliDeps = {
  resolveSite?: (input: {
    action: "read" | "write";
    projectRef: string;
    siteRef: string;
    workspace: PageChatCliWorkspace;
  }) => Promise<ViewerAssertionCliSite>;
  loadMetadata?: (siteId: string) => Promise<unknown>;
  /** Applies the patch to the current row and audits it; returns the new settings. */
  updateSettings?: (input: {
    actorId: string;
    organizationId: string;
    patch: PageChatSiteSettingsPatch;
    requestId: string;
    siteId: string;
  }) => Promise<PageChatSiteSettings>;
  featureEnabled?: (input: { organizationId: string; role: string }) => Promise<boolean>;
};

export function cliHasPageChatReadScopes(scopes: readonly string[]) {
  return PAGE_CHAT_CLI_READ_SCOPES.every((scope) => scopes.includes(scope));
}

export function cliHasPageChatWriteScopes(scopes: readonly string[]) {
  return PAGE_CHAT_CLI_WRITE_SCOPES.every((scope) => scopes.includes(scope));
}

export function pageChatCliError(error: ConsoleApiError) {
  if (error.payload.error === "payload_invalid") {
    const detail = Object.entries(error.payload.fieldErrors ?? {})
      .map(([field, message]) => `${field}: ${message}`)
      .join("; ");
    return cliApiError(400, "PAYLOAD_INVALID", detail || undefined);
  }
  if (
    error.payload.error === "forbidden" ||
    error.payload.error === "not_found" ||
    error.payload.error === "project_forbidden" ||
    error.payload.error === "project_not_found" ||
    error.payload.error === "site_not_found"
  ) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return cliApiError(503, "SERVER_UNAVAILABLE", "Page Chat settings are temporarily unavailable.");
}

export async function showPageChatSettingsFromCli(
  input: { projectRef: string; siteRef: string; workspace: PageChatCliWorkspace },
  deps: PageChatCliDeps = {},
) {
  const site = await (deps.resolveSite ?? resolveViewerAssertionCliSite)({ ...input, action: "read" });
  const settings = parsePageChatSiteSettings(await (deps.loadMetadata ?? loadSiteMetadata)(site.id));
  return serialize(input, site, settings, await featureEnabled(input.workspace, deps));
}

export async function updatePageChatSettingsFromCli(
  input: {
    body: unknown;
    projectRef: string;
    requestId: string;
    siteRef: string;
    workspace: PageChatCliWorkspace;
  },
  deps: PageChatCliDeps = {},
) {
  requirePageChatEngine();
  const patch = parsePageChatSiteSettingsPatch(input.body);
  const site = await (deps.resolveSite ?? resolveViewerAssertionCliSite)({ ...input, action: "write" });
  const settings = await (deps.updateSettings ?? updateSiteSettings)({
    actorId: input.workspace.user.id,
    organizationId: site.organizationId,
    patch,
    requestId: input.requestId,
    siteId: site.id,
  });
  return serialize(input, site, settings, await featureEnabled(input.workspace, deps));
}

function serialize(
  input: { projectRef: string; siteRef: string },
  site: ViewerAssertionCliSite,
  settings: PageChatSiteSettings,
  featureEnabled: boolean,
) {
  return {
    projectRef: input.projectRef,
    siteRef: input.siteRef,
    siteId: site.id,
    host: site.defaultHostname,
    featureEnabled,
    settings,
    voices: [...PAGE_CHAT_VOICES],
  };
}

async function featureEnabled(workspace: PageChatCliWorkspace, deps: PageChatCliDeps) {
  if (deps.featureEnabled) {
    return deps.featureEnabled({ organizationId: workspace.organization.id, role: workspace.membership.role });
  }
  const access = await getConsoleFeatureAccessForOrganizationRole({
    organizationId: workspace.organization.id,
    role: workspace.membership.role,
  });
  return access.byKey[PAGE_CHAT_FEATURE_KEY].enabled;
}

async function loadSiteMetadata(siteId: string): Promise<unknown> {
  const [row] = await db
    .select({ metadataJson: schema.pageSites.metadataJson })
    .from(schema.pageSites)
    .where(eq(schema.pageSites.id, siteId))
    .limit(1);
  if (!row) throw new ConsoleApiError(404, { error: "site_not_found" });
  return row.metadataJson;
}

// Reads, patches and writes the row under one lock, so a concurrent writer of
// metadata_json cannot lose its keys and the audit's before matches the write.
async function updateSiteSettings(input: {
  actorId: string;
  organizationId: string;
  patch: PageChatSiteSettingsPatch;
  requestId: string;
  siteId: string;
}): Promise<PageChatSiteSettings> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadataJson: schema.pageSites.metadataJson })
      .from(schema.pageSites)
      .where(eq(schema.pageSites.id, input.siteId))
      .limit(1)
      .for("update");
    if (!row) throw new ConsoleApiError(404, { error: "site_not_found" });
    const previous = parsePageChatSiteSettings(row.metadataJson);
    const next = applyPageChatSiteSettingsPatch(row.metadataJson, input.patch);
    await tx
      .update(schema.pageSites)
      .set({ metadataJson: next.metadataJson, updatedAt: new Date() })
      .where(eq(schema.pageSites.id, input.siteId));
    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      actorType: "user",
      actorId: input.actorId,
      targetType: "page_site",
      targetId: input.siteId,
      action: "pages.chat.settings.updated",
      beforeJson: { pageChat: previous },
      afterJson: { pageChat: next.settings },
      metadataJson: { source: "cli" },
      requestId: input.requestId,
    });
    return next.settings;
  });
}
