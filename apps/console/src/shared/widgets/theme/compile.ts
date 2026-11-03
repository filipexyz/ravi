// Theme compiler: the Library version's files → CompiledTheme. Publish,
// proposals, `themes/check`, the page kit and the Console editor all go
// through here, so what a page gets is always the rewritten, contrast-checked
// form of the theme.

import { sha256Hex } from "../hash";
import { hasErrors, type CompiledTheme, type Diagnostic, type LibraryFileText, type ThemeDensity } from "../types";
import { checkThemeContrast } from "./contrast";
import { FIELDS_FILE, parseFieldsJson } from "./fields";
import { LOGO_FILE, sanitizeLogoSvg } from "./logo";
import { parseThemeDocument, scaleThemeDimension, THEME_FILE, THEME_TOKENS } from "./tokens";

/** Not themable: WCAG 2.4.13 focus indicator and 2.5.8 target size floors used by the pieces CSS. */
export const THEME_FIXED_VARS: Readonly<Record<string, string>> = {
  "--ravi-focus-width": "2px",
  "--ravi-touch-target": "24px",
};

/** Space scale applied by `density: compact` and `data-ravi-density="compact"`. */
export const THEME_COMPACT_SCALE = 0.75;

const KNOWN_FILES = new Set([THEME_FILE, FIELDS_FILE, LOGO_FILE, "README.md"]);
const SPACE_TOKENS = THEME_TOKENS.filter((token) => token.path.startsWith("space."));

export type ThemeCompileResult = {
  /** Null when any diagnostic is an error. */
  theme: CompiledTheme | null;
  diagnostics: Diagnostic[];
  /**
   * The theme compiled even when there are errors (invalid tokens take the
   * default value, so it is still safe CSS), for `themes/check` and editor
   * previews. Null only when theme.json is missing. Never publish it.
   */
  draft: CompiledTheme | null;
};

export function compileTheme(files: readonly LibraryFileText[]): ThemeCompileResult {
  const diagnostics: Diagnostic[] = [];
  const contents = new Map<string, string>();
  for (const file of files) {
    contents.set(file.path, file.content);
    if (!KNOWN_FILES.has(file.path)) {
      diagnostics.push({
        severity: "warning",
        code: "THEME_UNKNOWN_FILE",
        message: `${file.path} is not part of a theme and is ignored; a theme has theme.json, fields.json, logo.svg and README.md.`,
        file: file.path,
      });
    }
  }

  const themeJson = contents.get(THEME_FILE);
  if (themeJson === undefined) {
    diagnostics.unshift({
      severity: "error",
      code: "THEME_FILE_MISSING",
      message: "A theme needs theme.json; run `ravi themes init` for a complete starting point.",
      file: THEME_FILE,
    });
    return { theme: null, diagnostics, draft: null };
  }

  const document = parseThemeDocument(themeJson);
  diagnostics.push(...document.diagnostics);
  if (!document.meta.description) {
    diagnostics.push({
      severity: "warning",
      code: "THEME_DESCRIPTION_MISSING",
      message: "Add a root $description to theme.json; publishing needs a description.",
      file: THEME_FILE,
      line: 1,
    });
  }

  const fields = parseFieldsJson(contents.get(FIELDS_FILE));
  diagnostics.push(...fields.diagnostics);

  const logoText = contents.get(LOGO_FILE);
  const logo = logoText === undefined ? { dataUrl: null, diagnostics: [] } : sanitizeLogoSvg(logoText);
  diagnostics.push(...logo.diagnostics);

  const contrast = checkThemeContrast(document.tokens);
  for (const check of contrast.checks) {
    if (check.ok) continue;
    const [fg, bg] = check.pair;
    const line = document.lines.get(fg) ?? document.lines.get(bg);
    diagnostics.push({
      severity: "error",
      code: "THEME_CONTRAST",
      message: `${fg} on ${bg} has contrast ${check.ratio}:1 in ${check.mode} mode; it needs at least ${check.min}:1.`,
      file: THEME_FILE,
      ...(line ? { line } : {}),
    });
  }

  const vars = themeVars(document.tokens, document.meta.density);
  const css = themeCss(vars, document.tokens, document.meta.density);
  const draft: CompiledTheme = {
    v: 1,
    name: document.meta.name,
    description: document.meta.description,
    locale: document.meta.locale,
    density: document.meta.density,
    css,
    hash: sha256Hex(css),
    vars,
    fields: fields.rules,
    logo: logo.dataUrl,
    contrast,
  };
  return { theme: hasErrors(diagnostics) ? null : draft, diagnostics, draft };
}

function scaledSpace(tokens: Record<string, string>, factor: number): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const token of SPACE_TOKENS) {
    const value = tokens[token.path]!;
    vars[token.cssVar] = scaleThemeDimension(value, factor) ?? value;
  }
  return vars;
}

/** Custom properties as `:root` sets them: base (with the theme's density), light and dark. */
function themeVars(tokens: Record<string, string>, density: ThemeDensity): CompiledTheme["vars"] {
  const base: Record<string, string> = { ...THEME_FIXED_VARS };
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const target = token.mode === "light" ? light : token.mode === "dark" ? dark : base;
    target[token.cssVar] = tokens[token.path]!;
  }
  if (density === "compact") Object.assign(base, scaledSpace(tokens, THEME_COMPACT_SCALE));
  return { base, light, dark };
}

function declarations(vars: Record<string, string>, indent: string) {
  return Object.entries(vars).map(([name, value]) => `${indent}${name}: ${value};`);
}

/**
 * The only boxes whose `color-scheme` the theme sets: the kit tags, and the
 * runtime's dialogs, which mount on `<body>` outside them.
 */
const THEMED_BOXES = ":where(ravi-view, ravi-widget, ravi-form, .ravi-dialog)";

/**
 * The `@layer ravi.theme` stylesheet. Light values on `:root`, dark values
 * under the OS preference unless the page forces light, and under
 * `data-theme="dark"`; `data-ravi-density` overrides the theme's density.
 * `color-scheme` is set on the tags and dialogs only, switching with the dark
 * values: the page's own canvas, default text and controls stay as the page
 * sets them, so a page with `background: #fff` and no text color never turns
 * white on white.
 */
function themeCss(vars: CompiledTheme["vars"], tokens: Record<string, string>, density: ThemeDensity) {
  const lines = [
    "@layer ravi.theme, ravi.pieces;",
    "@layer ravi.theme {",
    "  :root {",
    ...declarations(vars.base, "    "),
    ...declarations(vars.light, "    "),
    "  }",
    `  ${THEMED_BOXES} {`,
    "    color-scheme: light;",
    "  }",
    "  @media (prefers-color-scheme: dark) {",
    '    :root:not([data-theme="light"]) {',
    ...declarations(vars.dark, "      "),
    "    }",
    `    :root:not([data-theme="light"]) ${THEMED_BOXES} {`,
    "      color-scheme: dark;",
    "    }",
    "  }",
    '  :root[data-theme="dark"] {',
    ...declarations(vars.dark, "    "),
    "  }",
    `  :root[data-theme="dark"] ${THEMED_BOXES} {`,
    "    color-scheme: dark;",
    "  }",
    '  :root[data-ravi-density="compact"] {',
    ...declarations(scaledSpace(tokens, THEME_COMPACT_SCALE), "    "),
    "  }",
  ];
  if (density === "compact") {
    lines.push('  :root[data-ravi-density="comfortable"] {', ...declarations(scaledSpace(tokens, 1), "    "), "  }");
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
