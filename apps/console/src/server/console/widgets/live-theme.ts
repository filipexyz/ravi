// The compiled theme that applies to a project (its own pointer, else the
// organization's), for the Library tools (`widgets/catalog` locale,
// `widgets/preview`, `widgets/scaffold`) and the Pages exec id
// `ravi.pages.theme.get`. Versions are immutable, so a compile is cached per
// version id for the life of the process. See
// `.ravi/specs/console/pages/connectors` and `.ravi/specs/console/library`.

import { ConsoleApiError } from "@/server/console/api-error";
import { resolveEffectiveTheme, type EffectiveTheme } from "@/server/console/library/themes";
import type { PagesThemeGetOutput } from "@/server/console/pages/connectors/catalog";
import { compileTheme } from "@/shared/widgets/theme/compile";
import type { CompiledTheme, LibraryFileText } from "@/shared/widgets/types";

/** Compiles kept in memory; the oldest is dropped past this many versions. */
export const THEME_COMPILE_CACHE_LIMIT = 256;

const compiled = new Map<string, CompiledTheme | null>();

/**
 * A published theme version compiled with the current engine, or null when it
 * no longer compiles. Cached by `versionId`: the same id always has the same
 * files.
 */
export function compiledThemeForVersion(versionId: string, files: readonly LibraryFileText[]): CompiledTheme | null {
  if (compiled.has(versionId)) {
    const hit = compiled.get(versionId) ?? null;
    // Most recently used goes last, so eviction drops the least recently used.
    compiled.delete(versionId);
    compiled.set(versionId, hit);
    return hit;
  }
  const theme = compileTheme(files).theme;
  compiled.set(versionId, theme);
  if (compiled.size > THEME_COMPILE_CACHE_LIMIT) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  return theme;
}

export type EffectiveCompiledTheme = {
  effective: EffectiveTheme;
  /** Null when the current version no longer compiles. */
  theme: CompiledTheme | null;
};

/**
 * The project's effective theme (project pointer, else org pointer) at its
 * current published version, compiled. `projectId` null reads only the org
 * pointer. No access check: callers authorize the project first.
 */
export async function effectiveCompiledTheme(input: { organizationId: string; projectId: string | null }): Promise<EffectiveCompiledTheme | null> {
  const effective = await resolveEffectiveTheme(input);
  if (!effective) return null;
  const versionId = effective.item.currentVersionId ?? `${effective.item.id}:${effective.versionNumber}`;
  return { effective, theme: compiledThemeForVersion(versionId, effective.files) };
}

/**
 * `ravi.pages.theme.get` for a site's project: the effective theme's CSS, or
 * `{ none: true }`. A theme version that no longer compiles is
 * `connector_unavailable`, so the page keeps the theme it shipped with.
 */
export async function pagesThemeForProject(input: { organizationId: string; projectId: string }): Promise<PagesThemeGetOutput> {
  const resolved = await effectiveCompiledTheme(input);
  if (!resolved) return { none: true };
  if (!resolved.theme) throw new ConsoleApiError(503, { error: "connector_unavailable" });
  return {
    hash: resolved.theme.hash,
    css: resolved.theme.css,
    locale: resolved.theme.locale,
    version: resolved.effective.versionNumber,
    ref: resolved.effective.ref,
  };
}

/** Test hook: forget every cached compile. */
export function clearThemeCompileCache() {
  compiled.clear();
}
