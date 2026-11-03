// The page kit (CONTRACT 5.2): what `ravi pages ship` sends its HTML files
// through. Resolves the theme, the widgets, the views and the charts the
// page's `ravi-view|ravi-widget|ravi-form|ravi-chart` tags name, matches widget fields to view
// columns, derives the connector ids the tags call, and rewrites each file:
// theme and pieces styles, the kit JSON and the pinned runtime in `<head>`,
// `data-ravi-id` on each tag, and prerendered content. Lookups come in as
// `PageKitDeps` (the database ones are in `service.ts`), so this module is
// pure apart from them. See `.ravi/specs/console/pages/publish` "Page Kit".

import { BASE_VIEW_LAYOUT_TYPES, type BaseViewDescribeResponse, type BaseViewLayoutWidget } from "@/shared/bases/types";
import { isBaseUuid } from "@/shared/bases/values";
import { matchFields, parseFieldsAttribute } from "@/shared/widgets/matching";
import { PIECES_CSS } from "@/shared/widgets/pieces.css";
import { messages } from "@/shared/widgets/render/messages";
import { normalizeStaticRecord } from "@/shared/widgets/render/static";
import { escapeHtml, toHtml } from "@/shared/widgets/render/vnode";
import { renderWidget } from "@/shared/widgets/render/widget";
import { isAuditPassing } from "@/shared/widgets/script/audit";
import { WIDGET_SCRIPT_FILE } from "@/shared/widgets/script/check";
import { escapeInlineScript, widgetScriptElementId } from "@/shared/widgets/script/inline";
import { compileWidget } from "@/shared/widgets/template/compile";
import { compileTheme } from "@/shared/widgets/theme/compile";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";
import {
  WIDGET_VARIANTS,
  type CompiledTheme,
  type CompiledWidget,
  type Diagnostic,
  type DiagnosticSeverity,
  type KitAction,
  type KitInstance,
  type LibraryFileText,
  type LibraryItemRef,
  type PageKit,
  type PagePresentation,
  type RenderColumn,
  type RenderContext,
  type TemplateNode,
  type WidgetFieldType,
  type WidgetScriptAudit,
  type WidgetVariant,
} from "@/shared/widgets/types";

import {
  ALWAYS_ALLOWLISTED_ACTION_IDS,
  BASES_CHARTS_DATA_ACTION_ID,
  BASES_VIEWS_DESCRIBE_ACTION_ID,
  BASES_VIEWS_QUERY_ACTION_ID,
  BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID,
  BASES_VIEWS_ROWS_CREATE_ACTION_ID,
  BASES_VIEWS_ROWS_GET_ACTION_ID,
  BASES_VIEWS_ROWS_UPDATE_ACTION_ID,
  BASES_VIEWS_VERSION_ACTION_ID,
  PAGES_THEME_GET_ACTION_ID,
} from "../connectors/catalog";
import { escapeAttribute, escapeKitJson, rewriteKitDocument, scanKitDocument, scriptBlock, styleBlock, type KitTagEdit, type KitTagSource } from "./html";
import { PAGES_RUNTIME_JS, PAGES_RUNTIME_SHA256, PAGES_RUNTIME_VERSION, PAGES_THEME_LIVE_JS, PAGES_THEME_LIVE_SHA256 } from "./runtime.generated";

/** Console-only catalog id the runtime calls on private routes to refresh the theme (CONTRACT 5.3). */
export { PAGES_THEME_GET_ACTION_ID };
export const PAGE_KIT_THEME_NONE = "none";
/** Kit tags one request may hold, across its files. */
export const PAGE_KIT_MAX_TAGS = 500;
/**
 * Rewritten HTML one response may carry, counted as the JSON strings it is
 * sent as. The Console's host caps a function response at 4.5 MB; the rest is
 * room for the other fields.
 */
export const PAGE_KIT_MAX_OUTPUT_BYTES = 4_000_000;
/** Rows a `ravi-view` loads at once at most; the runtime clamps `page-size` to it. */
export const PAGE_KIT_PAGE_SIZE_MAX = 200;
/** Widget field types whose static values identify a person. */
const PERSONAL_FIELD_TYPES: ReadonlySet<WidgetFieldType> = new Set(["person", "email", "phone"]);

export type KitDiagnostic = {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** Page file the diagnostic is about. */
  path?: string;
  line?: number;
  column?: number;
  /** `KIT_WIDGET_UNAUDITED`: the widget version, `<owner>/<slug>@<version>`. */
  widget?: string;
  /** `KIT_WIDGET_UNAUDITED`: the absolute Console URL where an org owner or admin runs the audit. */
  url?: string;
};

export type PageKitVisibility = "public" | "private" | "protected_link" | "password";

export type PageKitInput = {
  route: string;
  visibility: PageKitVisibility;
  /** null: the project's effective theme; `none`: no theme; else a theme ref. */
  theme: string | null;
  files: Array<{ path: string; html: string }>;
};

/**
 * A Library theme or widget at its current published version. A widget with
 * `widget.js` also carries its version's stored audit and the Console page
 * where an admin runs it.
 */
export type KitLibrarySource = {
  itemId: string;
  ref: string;
  version: number;
  files: LibraryFileText[];
  scriptAudit?: WidgetScriptAudit | null;
  auditUrl?: string | null;
};

export type KitLookup = { ok: true; source: KitLibrarySource } | { ok: false; code: string; message: string };

export type PageKitDeps = {
  /** null: the effective pointer (`source: null` when none applies); a ref: that theme. */
  resolveTheme(ref: string | null): Promise<{ ok: true; source: KitLibrarySource | null } | { ok: false; code: string; message: string }>;
  /** A widget ref as written on a tag, in the page project's view. */
  resolveWidget(ref: string): Promise<KitLookup>;
  /** The widget a view's `layout.widget` names. */
  resolveWidgetItem(itemId: string): Promise<KitLookup>;
  /** The view described as the caller; `ok: false` when the caller cannot see it. */
  describeView(viewId: string): Promise<{ ok: true; view: BaseViewDescribeResponse } | { ok: false; message: string }>;
  /** The chart as the caller reads it (its name and view); `ok: false` when the caller cannot read its data. Absent: charts are not checked. */
  describeChart?(chartId: string): Promise<{ ok: true; chart: { name: string; viewId: string } } | { ok: false; message: string }>;
  /** Presentation stored on the route's current active release, if any. */
  previousPresentation(): Promise<PagePresentation | null>;
  now?: () => Date;
  runtime?: { version: string; js: string; sha256: string };
  /** The theme-live script that files without tags get on a live route, instead of the runtime. */
  themeLive?: { js: string; sha256: string };
};

/** `html` only when `changed`: an unchanged file is not sent back. */
export type PageKitFileResult = { path: string; html?: string; changed: boolean };

export type PageKitResult = {
  files: PageKitFileResult[];
  uses: string[];
  presentation: PagePresentation;
  diagnostics: KitDiagnostic[];
  warnings: string[];
};

const GLOBAL_ATTRIBUTES = new Set(["id", "class", "style", "hidden", "title", "lang", "dir", "slot"]);
const TAG_ATTRIBUTES: Record<KitTagSource["tag"], ReadonlySet<string>> = {
  "ravi-view": new Set([
    "view",
    "layout",
    "widget",
    "fields",
    "variant",
    "group-by",
    "card-title",
    "card-fields",
    "columns",
    "sort",
    "where",
    "search",
    "searchable",
    "create",
    "archive",
    "readonly",
    "heading-level",
    "page-size",
  ]),
  "ravi-widget": new Set(["use", "data", "variant", "heading-level"]),
  "ravi-form": new Set(["view", "fields", "submit-label", "success"]),
  "ravi-chart": new Set(["chart"]),
};
/**
 * Column types a `ravi-view` may write: inline editors (all of them in a
 * table; select, status and checkbox on cards), approval buttons and the
 * record dialog (which also edits the body).
 */
const EDITOR_COLUMN_TYPES = new Set(["text", "number", "date", "url", "email", "phone", "select", "multi_select", "status", "checkbox", "approval", "body"]);
const PRERENDER_HEADING_LEVEL = 2;

type ResolvedWidget = { key: string; compiled: CompiledWidget; source: KitLibrarySource };

type ResolvedTag = {
  edit: KitTagEdit;
  instance: KitInstance;
  widget: ResolvedWidget | null;
  viewId: string | null;
  chartId?: string | null;
  uses: Set<string>;
};

export async function buildPageKit(input: PageKitInput, deps: PageKitDeps): Promise<PageKitResult> {
  const now = deps.now?.() ?? new Date();
  const runtime = deps.runtime ?? { version: PAGES_RUNTIME_VERSION, js: PAGES_RUNTIME_JS, sha256: PAGES_RUNTIME_SHA256 };
  const themeLive = deps.themeLive ?? { js: PAGES_THEME_LIVE_JS, sha256: PAGES_THEME_LIVE_SHA256 };
  const diagnostics: KitDiagnostic[] = [];
  const warnings: string[] = [];
  const documents = input.files.map((file) => ({ file, scanned: scanKitDocument(file.html) }));

  // Theme: the Library theme that applies, compiled; pages with tags and no theme get the default.
  let libraryTheme: { source: KitLibrarySource; compiled: CompiledTheme } | null = null;
  let noPointer = false;
  if (input.theme !== PAGE_KIT_THEME_NONE) {
    const resolved = await deps.resolveTheme(input.theme);
    noPointer = resolved.ok && !resolved.source;
    if (!resolved.ok) {
      diagnostics.push({ severity: "error", code: resolved.code, message: resolved.message });
    } else if (resolved.source) {
      const { source } = resolved;
      const compiled = compileTheme(source.files);
      if (compiled.theme) {
        libraryTheme = { source, compiled: compiled.theme };
      } else {
        for (const diagnostic of compiled.diagnostics.filter((item) => item.severity === "error")) {
          diagnostics.push({
            severity: "error",
            code: diagnostic.code,
            message: `Theme ${source.ref} v${source.version} no longer compiles (${diagnostic.file ?? "theme.json"}): ${diagnostic.message}`,
          });
        }
      }
    }
  }
  // No pointer applies to a page with tags (`--theme none` is a choice and says nothing).
  if (input.theme === null && noPointer && documents.some((document) => document.scanned.tags.length > 0)) {
    diagnostics.push({
      severity: "warning",
      code: "KIT_THEME_DEFAULT",
      message:
        "No Library theme is active for this org or project, so the page uses Ravi's default theme. " +
        "An admin can set one with `ravi themes use <ref> --execute`.",
    });
  }
  const tagTheme = libraryTheme?.compiled ?? defaultCompiledTheme();
  const live = input.visibility === "private" && input.theme === null;

  // Tags, resolved in document order with lookups cached per request.
  const widgetsByRef = new Map<string, Promise<KitLookup>>();
  const widgetsByItem = new Map<string, Promise<KitLookup>>();
  const views = new Map<string, ReturnType<PageKitDeps["describeView"]>>();
  const compiled = new Map<string, { widget: CompiledWidget | null; diagnostics: Diagnostic[] }>();
  const resolver: TagResolver = {
    deps,
    theme: tagTheme,
    visibility: input.visibility,
    now,
    widgetByRef: (ref) => cached(widgetsByRef, ref, () => deps.resolveWidget(ref)),
    widgetByItem: (itemId) => cached(widgetsByItem, itemId.toLowerCase(), () => deps.resolveWidgetItem(itemId)),
    describe: (viewId) => cached(views, viewId.toLowerCase(), () => deps.describeView(viewId)),
    compile: (source) => {
      const key = `${source.itemId}:${source.version}`;
      let result = compiled.get(key);
      if (!result) {
        const out = compileWidget(source.files, { ref: { itemId: source.itemId, ref: source.ref, version: source.version } });
        result = { widget: out.widget, diagnostics: out.diagnostics };
        compiled.set(key, result);
      }
      return result;
    },
  };

  const totalTags = documents.reduce((total, document) => total + document.scanned.tags.length, 0);
  if (totalTags > PAGE_KIT_MAX_TAGS) {
    diagnostics.push({
      severity: "error",
      code: "KIT_TOO_MANY_TAGS",
      message: `The page files hold ${totalTags} ravi-view, ravi-widget and ravi-form tags; one ship takes at most ${PAGE_KIT_MAX_TAGS}.`,
    });
  }

  const resolvedByFile: ResolvedTag[][] = [];
  for (const { file, scanned } of documents) {
    const resolved: ResolvedTag[] = [];
    if (totalTags <= PAGE_KIT_MAX_TAGS) {
      let counter = 0;
      for (const [index, tag] of scanned.tags.entries()) {
        const at: At = (severity, code, message, extra) =>
          diagnostics.push({ severity, code, message, path: file.path, line: tag.line, column: tag.column, ...extra });
        if (tag.parent !== null) {
          const parent = scanned.tags[tag.parent];
          at("error", "KIT_TAG_NESTED", `<${tag.tag}> is inside <${parent?.tag ?? "ravi-view"}>; kit tags cannot nest, so move it out.`);
          continue;
        }
        if (tag.closeStart === null) {
          at("error", "KIT_TAG_UNCLOSED", `<${tag.tag}> is not closed; write <${tag.tag} ...></${tag.tag}> (a trailing "/>" does not close it).`);
          continue;
        }
        counter += 1;
        const result = await resolveTag(resolver, tag, { index, id: `r${counter}` }, at);
        if (result) resolved.push(result);
      }
    }
    resolvedByFile.push(resolved);
  }

  // Files.
  const uses = new Set<string>();
  const presentationWidgets = new Map<string, LibraryItemRef>();
  let runtimeInjected = false;
  let themeLiveInjected = false;
  let themeInjected = false;
  const files: PageKitFileResult[] = documents.map(({ file, scanned }, fileIndex) => {
    const tags = resolvedByFile[fileIndex] ?? [];
    const hasTags = scanned.tags.length > 0;
    const theme = libraryTheme?.compiled ?? (hasTags ? tagTheme : null);
    if (!theme && scanned.injected.length === 0) return { path: file.path, changed: false };

    const fileLive = live && theme !== null;
    let head = "";
    if (theme) {
      head += styleBlock(`id="ravi-theme" data-ravi-theme="${escapeAttribute(theme.hash)}"`, theme.css);
      if (libraryTheme) themeInjected = true;
    }
    if (hasTags) head += styleBlock('id="ravi-pieces"', PIECES_CSS);
    if (hasTags || fileLive) {
      const fileUses = new Set<string>();
      const actions = new Map<string, KitAction>();
      const widgets: Record<string, CompiledWidget> = {};
      const instances: Record<string, KitInstance> = {};
      for (const tag of tags) {
        instances[tag.edit.id] = tag.instance;
        if (tag.widget) {
          widgets[tag.widget.key] = tag.widget.compiled;
          const { source } = tag.widget;
          presentationWidgets.set(source.itemId, { itemId: source.itemId, ref: source.ref, version: source.version });
        }
        for (const id of tag.uses) {
          fileUses.add(id);
          if (tag.viewId) actions.set(`${id} ${tag.viewId}`, { id, viewId: tag.viewId });
          else if (tag.chartId) actions.set(`${id} ${tag.chartId}`, { id, chartId: tag.chartId });
        }
      }
      if (fileLive) fileUses.add(PAGES_THEME_GET_ACTION_ID);
      // The exec host allows these on every release. Declaring one would give a
      // release that declares nothing an explicit allowlist, and the host would
      // lose the curated platform ids.
      for (const id of fileUses) if (!ALWAYS_ALLOWLISTED_ACTION_IDS.has(id)) uses.add(id);
      const kit: PageKit = {
        v: 1,
        runtime: runtime.version,
        locale: theme?.locale ?? tagTheme.locale,
        theme: theme
          ? {
              ref: libraryTheme ? libraryRef(libraryTheme.source) : null,
              hash: theme.hash,
              locale: theme.locale,
              density: theme.density,
              // The logo is not inlined (no runtime reads it), and the display
              // rules only matter to the runtime, not to the theme-live script.
              ...(hasTags ? { fields: theme.fields } : {}),
              live: fileLive,
            }
          : null,
        widgets,
        instances,
        actions: [...actions.values()].sort(
          (left, right) => left.id.localeCompare(right.id) || (left.viewId ?? left.chartId).localeCompare(right.viewId ?? right.chartId),
        ),
        uses: [...fileUses].sort(),
      };
      head += `<script type="application/json" id="ravi-kit">${escapeKitJson(kit)}</script>`;
      if (hasTags) {
        head += scriptBlock(`id="ravi-runtime" data-version="${escapeAttribute(runtime.version)}"`, runtime.js);
        runtimeInjected = true;
        head += widgetScriptBlocks(tags);
      } else {
        // Only the live theme refresh: a file without tags does not carry the whole runtime.
        head += scriptBlock('id="ravi-runtime" data-ravi-runtime="theme-live"', themeLive.js);
        themeLiveInjected = true;
      }
    }

    const html = rewriteKitDocument(scanned, { head, lang: theme?.locale ?? null, tags: tags.map((tag) => tag.edit) });
    return html === file.html ? { path: file.path, changed: false } : { path: file.path, html, changed: true };
  });
  checkOutputSize(files, diagnostics);

  const presentation: PagePresentation = {
    v: 1,
    // The script inlined: the runtime when any file has tags, else the theme-live script.
    runtime: runtimeInjected
      ? { version: runtime.version, sha256: runtime.sha256 }
      : themeLiveInjected
        ? { version: runtime.version, sha256: themeLive.sha256 }
        : null,
    theme: libraryTheme && themeInjected ? { ...libraryRef(libraryTheme.source), hash: libraryTheme.compiled.hash } : null,
    themeSource: input.theme === null ? "effective" : input.theme === PAGE_KIT_THEME_NONE ? "none" : "explicit",
    widgets: [...presentationWidgets.values()].sort((left, right) => left.ref.localeCompare(right.ref)),
  };

  const previous = await deps.previousPresentation();
  if (previous) {
    const before = previous.theme;
    const after = presentation.theme;
    if ((before?.itemId ?? null) !== (after?.itemId ?? null) || (before?.version ?? null) !== (after?.version ?? null)) {
      const label = (theme: PagePresentation["theme"], other: PagePresentation["theme"]) =>
        !theme ? "none" : other && other.itemId === theme.itemId ? `v${theme.version}` : `${theme.ref} v${theme.version}`;
      const sameItem = before && after && before.itemId === after.itemId;
      warnings.push(
        `Theme changed since the last publish of ${input.route}: ${sameItem ? `${after.ref} ` : ""}${label(before, after)} -> ${label(after, before)}.`,
      );
    }
  }

  return { files, uses: [...uses].sort(), presentation, diagnostics, warnings };
}

/**
 * The code of each widget with `widget.js` used in a file, once per script:
 * `<script type="text/plain" id="ravi-widget-js-<sha16>" data-ravi-widget="<ref>@<version>">`.
 * Plain text, so the browser never runs it as a classic script; the runtime
 * imports it as a module when a card of that widget renders.
 */
function widgetScriptBlocks(tags: readonly ResolvedTag[]) {
  const seen = new Set<string>();
  let out = "";
  for (const tag of tags) {
    const script = tag.widget?.compiled.script;
    if (!tag.widget || !script || seen.has(script.sha256)) continue;
    const code = tag.widget.source.files.find((file) => file.path === WIDGET_SCRIPT_FILE)?.content;
    if (code === undefined) continue;
    seen.add(script.sha256);
    const label = `${tag.widget.source.ref}@${tag.widget.source.version}`;
    out += `<script type="text/plain" id="${widgetScriptElementId(script.sha256)}" data-ravi-widget="${escapeAttribute(label)}">${escapeInlineScript(code)}</script>`;
  }
  return out;
}

/** `KIT_TOO_LARGE` when the rewritten files, as the JSON strings the response carries, pass the budget. */
function checkOutputSize(files: readonly PageKitFileResult[], diagnostics: KitDiagnostic[]) {
  let total = 0;
  let fit = 0;
  let first: string | null = null;
  let rewritten = 0;
  for (const file of files) {
    if (file.html === undefined) continue;
    rewritten += 1;
    total += Buffer.byteLength(JSON.stringify(file.html), "utf8");
    if (total <= PAGE_KIT_MAX_OUTPUT_BYTES) fit += 1;
    else first ??= file.path;
  }
  if (first === null) return;
  const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
  diagnostics.push({
    severity: "error",
    code: "KIT_TOO_LARGE",
    path: first,
    message:
      `The rewritten HTML comes to ${mb(total)}, more than the ${mb(PAGE_KIT_MAX_OUTPUT_BYTES)} one ship carries back: ` +
      `${fit} of the ${rewritten} rewritten files fit. Ship with --theme none (files without tags then stay as written), or ship fewer HTML files per ship.`,
  });
}

// ---------------------------------------------------------------------------
// Tags

type At = (severity: DiagnosticSeverity, code: string, message: string, extra?: Pick<KitDiagnostic, "widget" | "url">) => void;

type TagResolver = {
  deps: PageKitDeps;
  theme: CompiledTheme;
  visibility: PageKitVisibility;
  now: Date;
  widgetByRef(ref: string): Promise<KitLookup>;
  widgetByItem(itemId: string): Promise<KitLookup>;
  describe(viewId: string): ReturnType<PageKitDeps["describeView"]>;
  compile(source: KitLibrarySource): { widget: CompiledWidget | null; diagnostics: Diagnostic[] };
};

async function resolveTag(resolver: TagResolver, tag: KitTagSource, edit: Omit<KitTagEdit, "inner">, at: At): Promise<ResolvedTag | null> {
  checkAttributes(tag, at);
  switch (tag.tag) {
    case "ravi-widget":
      return resolveStaticWidget(resolver, tag, edit, at);
    case "ravi-view":
      return resolveView(resolver, tag, edit, at);
    case "ravi-form":
      return resolveForm(resolver, tag, edit, at);
    case "ravi-chart":
      return resolveChart(resolver, tag, edit, at);
  }
}

async function resolveChart(resolver: TagResolver, tag: KitTagSource, edit: Omit<KitTagEdit, "inner">, at: At): Promise<ResolvedTag | null> {
  const chartId = tag.attrs.chart?.trim();
  if (!chartId) {
    at("error", "KIT_CHART_REQUIRED", '<ravi-chart> needs chart="<chart uuid>"; ravi bases charts list prints the ids.');
    return null;
  }
  if (!isBaseUuid(chartId)) {
    at("error", "KIT_CHART_INVALID", `chart="${chartId}" is not a chart id; use the chart's uuid (ravi bases charts list prints them).`);
    return null;
  }
  const id = chartId.toLowerCase();
  const described = (await resolver.deps.describeChart?.(id)) ?? { ok: true };
  if (!described.ok) {
    at("warning", "KIT_CHART_UNAVAILABLE", `Chart ${id} is not available to you (${described.message}); the page shows it only to viewers its view admits.`);
  }
  const loading = messages(resolver.theme.locale).loading;
  return {
    edit: { ...edit, inner: `<p class="ravi-status" role="status">${escapeHtml(loading)}</p>` },
    instance: { tag: "ravi-chart", view: null, widget: null, fields: {}, variant: "default", chart: id },
    widget: null,
    viewId: null,
    chartId: id,
    uses: new Set([BASES_CHARTS_DATA_ACTION_ID]),
  };
}

async function resolveStaticWidget(resolver: TagResolver, tag: KitTagSource, edit: Omit<KitTagEdit, "inner">, at: At): Promise<ResolvedTag | null> {
  const use = tag.attrs.use?.trim();
  if (!use) {
    at("error", "KIT_WIDGET_REQUIRED", '<ravi-widget> needs use="<widget>": a slug, org/<slug> or <project>/<slug>.');
    return null;
  }
  const widget = await loadWidget(resolver, await resolver.widgetByRef(use), at);
  if (!widget) return null;
  const variant = pickVariant(tag.attrs.variant, widget.compiled, null, at);
  // The runtime renders at the same level, so it keeps the prerender.
  const headingLevel = checkInteger(tag, "heading-level", 1, 6, at) ?? PRERENDER_HEADING_LEVEL;
  let inner: string | null = null;
  if (tag.attrs.data !== undefined) {
    const data = parseData(tag.attrs.data, at);
    if (data !== undefined) {
      if (resolver.visibility === "public") checkPersonalData(widget, data, at);
      checkActionsNeedView(widget, at);
      const normalized = normalizeStaticRecord(widget.compiled.fields, data);
      const errors = normalized.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      for (const diagnostic of normalized.diagnostics) at(diagnostic.severity, diagnostic.code, `data: ${diagnostic.message}`);
      if (errors.length === 0) {
        const ctx = renderContext(resolver, { columns: normalized.columns, users: normalized.users, variant, headingLevel, idPrefix: `ravi-${edit.id}` });
        inner = toHtml(renderWidget(widget.compiled, normalized.record, ctx));
      }
    }
  }
  return {
    edit: { ...edit, inner },
    instance: { tag: "ravi-widget", view: null, widget: widget.key, fields: {}, variant },
    widget,
    viewId: null,
    uses: new Set(),
  };
}

async function resolveView(resolver: TagResolver, tag: KitTagSource, edit: Omit<KitTagEdit, "inner">, at: At): Promise<ResolvedTag | null> {
  const viewId = requireViewId(tag, at);
  const explicit = parseFieldsAttribute(tag.attrs.fields ?? "");
  for (const diagnostic of explicit.diagnostics) at(diagnostic.severity, diagnostic.code, diagnostic.message);

  const described = viewId ? await resolver.describe(viewId) : null;
  const view = described?.ok ? described.view : null;
  const layoutWidget = view ? layoutWidgetOf(view) : null;

  let widget: ResolvedWidget | null = null;
  let fromLayout = false;
  const widgetRef = tag.attrs.widget?.trim();
  if (tag.attrs.widget !== undefined && !widgetRef) {
    at("error", "KIT_WIDGET_REQUIRED", 'widget="" names no widget; write a slug, org/<slug> or <project>/<slug>, or remove the attribute for the view\'s own.');
  } else if (widgetRef) {
    // A failed lookup is already an error; the tag still resolves so its view is checked too.
    widget = await loadWidget(resolver, await resolver.widgetByRef(widgetRef), at);
  } else if (layoutWidget) {
    const lookup = await resolver.widgetByItem(layoutWidget.itemId);
    if (lookup.ok) {
      widget = await loadWidget(resolver, lookup, at);
      fromLayout = widget !== null;
    } else {
      at(
        "warning",
        "KIT_LAYOUT_WIDGET_UNAVAILABLE",
        `View "${view?.name}" binds widget ${layoutWidget.ref ?? layoutWidget.itemId}, which is unavailable (${lookup.message}); the page draws the default card.`,
      );
    }
  }

  const sameAsLayout = Boolean(widget && layoutWidget && widget.source.itemId === layoutWidget.itemId.toLowerCase());
  const columns = view ? view.columns.map((column): RenderColumn => ({ key: column.key, name: column.name, type: column.type, config: column.config })) : null;
  let mapping: Record<string, string> = { ...explicit.map };
  if (widget && columns) {
    const matched = matchFields({
      fields: widget.compiled.fields,
      columns,
      explicit: { ...(sameAsLayout && layoutWidget ? layoutWidget.fields : {}), ...explicit.map },
    });
    for (const diagnostic of matched.diagnostics) at(diagnostic.severity, diagnostic.code, `${widget.source.ref} on view "${view?.name}": ${diagnostic.message}`);
    mapping = matched.mapping;
  } else if (viewId && described && !described.ok) {
    const required = widget ? Object.entries(widget.compiled.fields).filter(([, field]) => field.required).map(([key]) => key) : [];
    if (required.length) {
      at(
        "error",
        "KIT_VIEW_UNAVAILABLE",
        `View ${viewId} is not available to you (${described.message}), so ${widget?.source.ref}'s required fields (${required.join(", ")}) cannot be matched to its columns.`,
      );
    } else {
      at(
        "warning",
        "KIT_VIEW_UNAVAILABLE",
        `View ${viewId} is not available to you (${described.message}); the page shows it only to viewers the view admits, and its fields were not checked.`,
      );
    }
  }
  if (!widget && Object.keys(explicit.map).length) {
    at("warning", "KIT_FIELDS_UNUSED", "fields maps widget fields, but this tag draws the default card; add widget=\"<widget>\" or remove fields.");
  }

  checkChoice(tag, "layout", BASE_VIEW_LAYOUT_TYPES, at);
  checkInteger(tag, "heading-level", 1, 6, at);
  checkPageSize(tag, at);
  const variant = pickVariant(tag.attrs.variant, widget?.compiled ?? null, sameAsLayout ? (layoutWidget?.variant ?? null) : null, at);

  const uses = viewUses({
    layout: tag.attrs.layout?.trim() || view?.layout.type || null,
    readonly: tag.attrs.readonly !== undefined,
    create: tag.attrs.create !== undefined,
    archive: tag.attrs.archive !== undefined,
    widget: widget?.compiled ?? null,
    mapping,
    columns,
  });
  const loading = messages(resolver.theme.locale).loading;
  return {
    edit: { ...edit, inner: `<p class="ravi-status" role="status">${escapeHtml(loading)}</p>` },
    instance: { tag: "ravi-view", view: viewId, widget: widget?.key ?? null, fields: mapping, variant },
    widget,
    viewId,
    uses: viewId ? uses : new Set(),
  };
}

async function resolveForm(resolver: TagResolver, tag: KitTagSource, edit: Omit<KitTagEdit, "inner">, at: At): Promise<ResolvedTag | null> {
  const viewId = requireViewId(tag, at);
  const described = viewId ? await resolver.describe(viewId) : null;
  if (described?.ok) {
    const keys = new Set(described.view.columns.map((column) => column.key));
    const listed = (tag.attrs.fields ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    const missing = listed.filter((key) => !keys.has(key));
    if (missing.length) {
      at(
        "error",
        "KIT_FORM_FIELD_MISSING",
        `fields names ${missing.join(", ")}, which view "${described.view.name}" does not project. Columns: ${described.view.columns.map((column) => `${column.key}: ${column.type}`).join(", ")}.`,
      );
    }
  } else if (viewId && described && !described.ok) {
    at("warning", "KIT_VIEW_UNAVAILABLE", `View ${viewId} is not available to you (${described.message}); its form fields were not checked.`);
  }
  return {
    edit: { ...edit, inner: null },
    instance: { tag: "ravi-form", view: viewId, widget: null, fields: {}, variant: "default" },
    widget: null,
    viewId,
    uses: viewId ? new Set([BASES_VIEWS_DESCRIBE_ACTION_ID, BASES_VIEWS_ROWS_CREATE_ACTION_ID]) : new Set(),
  };
}

/** Bases ids a `ravi-view` needs (CONTRACT 5.4), as full catalog ids. */
export function viewUses(input: {
  layout: string | null;
  readonly: boolean;
  create: boolean;
  archive: boolean;
  widget: CompiledWidget | null;
  mapping: Record<string, string>;
  /** The view's columns, when the caller could describe it. */
  columns: readonly RenderColumn[] | null;
}): Set<string> {
  const uses = new Set([BASES_VIEWS_DESCRIBE_ACTION_ID, BASES_VIEWS_QUERY_ACTION_ID, BASES_VIEWS_VERSION_ACTION_ID]);
  const verbs = new Set(input.widget?.actions.map((action) => action.verb) ?? []);
  const columnTypes = new Map(input.columns?.map((column) => [column.key, column.type] as const) ?? []);
  let editable = false;
  if (!input.readonly) {
    if (input.widget) {
      const widget = input.widget;
      editable = editableFieldKeys(Object.values(widget.variants).flatMap((nodes) => nodes ?? [])).some((key) => {
        const columnKey = input.mapping[key];
        const type = (columnKey ? columnTypes.get(columnKey) : undefined) ?? widget.fields[key]?.type;
        return type !== undefined && EDITOR_COLUMN_TYPES.has(type);
      });
    } else if (input.columns) {
      editable = input.columns.some((column) => EDITOR_COLUMN_TYPES.has(column.type));
    }
  }
  if ((!input.readonly && input.layout === "board") || verbs.has("update") || editable) uses.add(BASES_VIEWS_ROWS_UPDATE_ACTION_ID);
  if (input.create || verbs.has("create") || (!input.readonly && input.layout === "form")) uses.add(BASES_VIEWS_ROWS_CREATE_ACTION_ID);
  if (input.archive || verbs.has("archive")) uses.add(BASES_VIEWS_ROWS_ARCHIVE_ACTION_ID);
  // The record dialog reads the row (and its body): opened from a calendar, a widget's open, or "Abrir" on a view the person may write.
  if (
    input.widget?.actions.some((action) => action.verb === "open" && action.href === null) ||
    input.layout === "calendar" ||
    uses.has(BASES_VIEWS_ROWS_UPDATE_ACTION_ID)
  ) {
    uses.add(BASES_VIEWS_ROWS_GET_ACTION_ID);
  }
  return uses;
}

/** Field keys of `ravi-field` pieces that may become editors (`editable` not `false`). */
function editableFieldKeys(nodes: readonly TemplateNode[]): string[] {
  const keys: string[] = [];
  const walk = (list: readonly TemplateNode[]) => {
    for (const node of list) {
      if (node.k === "el") {
        const name = node.attrs.name;
        const editable = node.attrs.editable;
        if (node.piece === "ravi-field" && name && "lit" in name && !(editable && "lit" in editable && editable.lit === "false")) keys.push(name.lit);
        walk(node.children);
      } else if (node.k === "if") {
        walk(node.then);
        walk(node.else);
      } else if (node.k === "each") {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return keys;
}

async function loadWidget(resolver: TagResolver, lookup: KitLookup, at: At): Promise<ResolvedWidget | null> {
  if (!lookup.ok) {
    at("error", lookup.code, lookup.message);
    return null;
  }
  const { source } = lookup;
  const result = resolver.compile(source);
  if (!result.widget) {
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const first = errors[0];
    at(
      "error",
      "KIT_WIDGET_INVALID",
      `Widget ${source.ref} v${source.version} no longer compiles${first ? ` (${first.file ?? "widget"}${first.line ? `:${first.line}` : ""}: ${first.message})` : ""}; publish a fixed version.`,
    );
    return null;
  }
  const script = result.widget.script;
  if (script && !isAuditPassing(source.scriptAudit, script.sha256)) {
    const label = `${source.ref}@${source.version}`;
    const failed = source.scriptAudit?.status === "fail" && source.scriptAudit.scriptSha256 === script.sha256;
    at(
      "error",
      "KIT_WIDGET_UNAUDITED",
      `Widget ${label} has widget.js ${failed ? "and failed its accessibility audit" : "without a passing accessibility audit"}; an organization owner or admin ${failed ? "publishes a fixed version and audits it" : "runs the audit"} in the Console${source.auditUrl ? `: ${source.auditUrl}` : ""}.`,
      { widget: label, ...(source.auditUrl ? { url: source.auditUrl } : {}) },
    );
    return null;
  }
  return { key: source.ref, compiled: result.widget, source };
}

function requireViewId(tag: KitTagSource, at: At): string | null {
  const viewId = tag.attrs.view?.trim();
  if (!viewId) {
    at("error", "KIT_VIEW_REQUIRED", `<${tag.tag}> needs view="<view uuid>"; ravi bases views list prints the ids.`);
    return null;
  }
  if (!isBaseUuid(viewId)) {
    at("error", "KIT_VIEW_INVALID", `view="${viewId}" is not a view id; use the view's uuid (ravi bases views list prints them).`);
    return null;
  }
  return viewId.toLowerCase();
}

function layoutWidgetOf(view: BaseViewDescribeResponse): BaseViewLayoutWidget | null {
  const layout = view.layout as { widget?: BaseViewLayoutWidget | null };
  return layout.widget ?? null;
}

function pickVariant(value: string | undefined, widget: CompiledWidget | null, fallback: WidgetVariant | null, at: At): WidgetVariant {
  const wanted = value?.trim();
  if (wanted) {
    if (!(WIDGET_VARIANTS as readonly string[]).includes(wanted)) {
      at("warning", "KIT_ATTRIBUTE_INVALID", `variant="${wanted}" is not one of ${WIDGET_VARIANTS.join(", ")}; default is used.`);
      return "default";
    }
    if (widget && !widget.variants[wanted as WidgetVariant]) {
      const declared = Object.keys(widget.variants).join(", ");
      at("warning", "KIT_VARIANT_UNKNOWN", `${widget.ref?.ref ?? "The widget"} has no ${wanted} variant (it has ${declared}); default is used.`);
      return "default";
    }
    return wanted as WidgetVariant;
  }
  if (fallback && (!widget || widget.variants[fallback])) return fallback;
  return "default";
}

function parseData(text: string, at: At): Record<string, unknown> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    at("error", "KIT_DATA_INVALID", `data is not valid JSON (${error instanceof Error ? error.message : "parse error"}); write one record object, such as data='{"valor":1200}'.`);
    return undefined;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    at("error", "KIT_DATA_INVALID", "data must be one record object keyed by widget field, such as data='{\"valor\":1200}'.");
    return undefined;
  }
  return data as Record<string, unknown>;
}

function checkAttributes(tag: KitTagSource, at: At) {
  const known = TAG_ATTRIBUTES[tag.tag];
  const reported = new Set<string>();
  for (const { name } of tag.attributes) {
    if (known.has(name) || GLOBAL_ATTRIBUTES.has(name) || name.startsWith("data-") || name.startsWith("aria-") || reported.has(name)) continue;
    reported.add(name);
    at("warning", "KIT_ATTRIBUTE_UNKNOWN", `<${tag.tag}> does not take ${name}; it takes ${[...known].join(", ")}.`);
  }
}

function checkChoice(tag: KitTagSource, name: string, values: readonly string[], at: At) {
  const value = tag.attrs[name]?.trim();
  if (value !== undefined && !values.includes(value)) {
    at("warning", "KIT_ATTRIBUTE_INVALID", `${name}="${value}" is not one of ${values.join(", ")}; the view's own layout is used.`);
  }
}

/** The attribute as a whole number in range, else null (a warning when it is set). */
function checkInteger(tag: KitTagSource, name: string, min: number, max: number, at: At): number | null {
  const value = tag.attrs[name]?.trim();
  if (value === undefined) return null;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || number > max) {
    at("warning", "KIT_ATTRIBUTE_INVALID", `${name}="${value}" must be a whole number from ${min} to ${max}; it is ignored.`);
    return null;
  }
  return number;
}

/** `page-size` above the most a view loads is clamped by the runtime, so it warns with what is used. */
function checkPageSize(tag: KitTagSource, at: At) {
  const value = tag.attrs["page-size"]?.trim();
  if (value !== undefined && /^\d+$/.test(value) && Number(value) > PAGE_KIT_PAGE_SIZE_MAX) {
    at("warning", "KIT_ATTRIBUTE_INVALID", `page-size="${value}" is more than the ${PAGE_KIT_PAGE_SIZE_MAX} rows a view loads at once; ${PAGE_KIT_PAGE_SIZE_MAX} is used.`);
    return;
  }
  checkInteger(tag, "page-size", 1, PAGE_KIT_PAGE_SIZE_MAX, at);
}

/** Static `data` on a public route ships in the HTML to anyone: warn about values of person, email and phone fields. */
function checkPersonalData(widget: ResolvedWidget, data: Record<string, unknown>, at: At) {
  const personal = Object.entries(widget.compiled.fields)
    .filter(([key, field]) => PERSONAL_FIELD_TYPES.has(field.type) && Object.hasOwn(data, key) && hasValue(data[key]))
    .map(([key, field]) => `${key} (${field.type})`);
  if (!personal.length) return;
  at(
    "warning",
    "KIT_PERSONAL_DATA_PUBLIC",
    `data holds ${personal.join(", ")} on a public route: anyone who opens the page reads it in the HTML. Ship to a private route, or leave personal data out of data.`,
  );
}

/**
 * `<ravi-widget data>` has no row, so the widget's row actions (update,
 * create, archive, and open without href) are left out: say so instead of
 * dropping its buttons silently.
 */
function checkActionsNeedView(widget: ResolvedWidget, at: At) {
  const dropped = widget.compiled.actions.filter((action) => action.verb !== "open" || action.href === null);
  if (!dropped.length) return;
  const labels = [...new Set(dropped.map((action) => action.label.trim() || action.verb))].map((label) => `"${label}"`);
  at(
    "warning",
    "KIT_ACTIONS_NEED_VIEW",
    `${widget.source.ref}'s actions (${labels.join(", ")}) only appear on a view's rows; with data they are left out. ` +
      `To show them, use <ravi-view view="<view uuid>" widget="${widget.source.ref}">.`,
  );
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.some(hasValue);
  if (typeof value === "object") return Object.values(value).some(hasValue);
  return true;
}

function renderContext(
  resolver: TagResolver,
  input: Pick<RenderContext, "columns" | "users" | "variant" | "headingLevel" | "idPrefix">,
): RenderContext {
  const { theme } = resolver;
  return {
    locale: theme.locale,
    // Prerendered text is the no-script fallback; the runtime renders again in the reader's zone.
    timeZone: /^pt(?:-|$)/i.test(theme.locale) ? "America/Sao_Paulo" : "UTC",
    now: resolver.now,
    fields: theme.fields,
    users: input.users,
    columns: input.columns,
    can: { write: new Set(), create: false, archive: false },
    variant: input.variant,
    headingLevel: input.headingLevel,
    idPrefix: input.idPrefix,
    interactive: false,
  };
}

function libraryRef(source: KitLibrarySource): LibraryItemRef {
  return { itemId: source.itemId, ref: source.ref, version: source.version };
}

function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let value = map.get(key);
  if (!value) {
    value = load();
    map.set(key, value);
  }
  return value;
}
