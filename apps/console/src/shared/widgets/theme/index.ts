// Public API of the theme engine. `logo.ts` (and so this barrel) pulls in
// htmlparser2: the Pages runtime imports `render/*` and `types.ts`, never this.

export { formatHexColor, parseHexColor, type Rgba } from "./color";
export { compileTheme, THEME_COMPACT_SCALE, THEME_FIXED_VARS, type ThemeCompileResult } from "./compile";
export {
  checkThemeContrast,
  compositeOver,
  contrastRatio,
  relativeLuminance,
  themeContrastPairs,
  type ContrastPair,
} from "./contrast";
export { DEFAULT_THEME_DESCRIPTION, DEFAULT_THEME_FILES, DEFAULT_THEME_NAME, defaultCompiledTheme } from "./default";
export { defaultFieldDisplayRules, FIELDS_FILE, fieldsJsonFromRules, parseFieldsJson } from "./fields";
export { base64FromUtf8, LOGO_FILE, LOGO_MAX_BYTES, sanitizeLogoMarkup, sanitizeLogoSvg } from "./logo";
export {
  canonicalizeLocale,
  defaultThemeMeta,
  defaultThemeTokens,
  parseThemeDocument,
  parseThemeJson,
  parseThemeTokenValue,
  scaleThemeDimension,
  THEME_DEFAULT_LOCALE,
  THEME_DENSITIES,
  THEME_FILE,
  THEME_MAX_ALIAS_DEPTH,
  THEME_TOKEN_BY_PATH,
  THEME_TOKEN_TYPES,
  THEME_TOKENS,
  themeAliasTarget,
  themeJsonFromTokens,
  themeJsonFromValues,
  type ParsedThemeDocument,
  type ThemeMeta,
  type ThemeMetaInput,
  type ThemeTokenSpec,
  type ThemeTokenType,
  type ThemeValueResult,
} from "./tokens";
