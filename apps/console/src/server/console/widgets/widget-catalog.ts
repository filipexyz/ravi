// `GET widgets/catalog?project=`: the shared catalog (pieces, filters, field
// types, roles, displays, tokens) plus the published widgets the caller sees
// in that view, with the Markdown agents read (`ravi widgets catalog`). The
// widgets are the ones `widgets` search lists: org widgets, and the project's
// when `project` is given; never archived or unpublished ones.

import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { selectItems, serializeLibraryItem, type LibraryWorkspace, type ProjectSummary } from "@/server/console/library/service";
import { db, schema } from "@/server/db";
import { catalogJson, type CatalogWidget, type WidgetCatalogJson } from "@/shared/widgets/template/catalog-text";
import { parseWidgetManifest, WIDGET_MANIFEST_FILE } from "@/shared/widgets/template/manifest";
import { WIDGET_SCRIPT_FILE } from "@/shared/widgets/script/check";

import { effectiveCompiledTheme } from "./live-theme";

/** Widgets listed in one catalog; the text stays readable for an agent. */
export const WIDGET_CATALOG_LIMIT = 200;

/**
 * The org's (and `project`'s) published widgets with the fields and variants
 * of each current version's widget.json. A version that no longer parses is
 * left out: it cannot be shipped either.
 */
export async function listCatalogWidgets(input: { organizationId: string; project: ProjectSummary | null }): Promise<CatalogWidget[]> {
  const items = schema.libraryItems;
  const rows = await selectItems(db, {
    where: and(
      eq(items.organizationId, input.organizationId),
      eq(items.kind, "widget"),
      isNull(items.archivedAt),
      isNotNull(items.currentVersionId),
      // The scope `searchLibrary` shows: org items, plus the project's when given.
      input.project ? or(isNull(items.projectId), eq(items.projectId, input.project.id)) : isNull(items.projectId),
    ),
    orderBy: [items.slug],
    limit: WIDGET_CATALOG_LIMIT,
  });
  const versionIds = rows.flatMap((row) => (row.item.currentVersionId ? [row.item.currentVersionId] : []));
  if (versionIds.length === 0) return [];
  const files = await db
    .select({ versionId: schema.libraryFiles.versionId, path: schema.libraryFiles.path, content: schema.libraryFiles.content })
    .from(schema.libraryFiles)
    .where(and(inArray(schema.libraryFiles.versionId, versionIds), inArray(schema.libraryFiles.path, [WIDGET_MANIFEST_FILE, WIDGET_SCRIPT_FILE])));
  const byVersion = new Map(files.filter((file) => file.path === WIDGET_MANIFEST_FILE).map((file) => [file.versionId, file.content] as const));
  const withScript = new Set(files.filter((file) => file.path === WIDGET_SCRIPT_FILE).map((file) => file.versionId));

  return rows.flatMap((row) => {
    const { manifest } = parseWidgetManifest(byVersion.get(row.item.currentVersionId ?? ""));
    if (!manifest) return [];
    const item = serializeLibraryItem(row);
    return [
      {
        ref: item.ref,
        name: item.name,
        description: item.description,
        fields: manifest.fields,
        variants: manifest.variants,
        script: withScript.has(row.item.currentVersionId ?? ""),
      },
    ];
  });
}

/** The catalog payload; `text` is written in the effective theme's locale (pt-BR without one). */
export async function widgetCatalog(input: { workspace: LibraryWorkspace; project: ProjectSummary | null }): Promise<WidgetCatalogJson> {
  const organizationId = input.workspace.organization.id;
  const [widgets, theme] = await Promise.all([
    listCatalogWidgets({ organizationId, project: input.project }),
    effectiveCompiledTheme({ organizationId, projectId: input.project?.id ?? null }),
  ]);
  return catalogJson({ widgets, locale: theme?.theme?.locale ?? "pt-BR" });
}
