// Public API of the widget template engine (compiler side: `parse.ts` uses
// htmlparser2, so the Pages runtime imports render modules, not this barrel).

export { hasText, lintTemplateAccessibility } from "./a11y";
export {
  allDisplays,
  displaysForField,
  EACH_FIELD_TYPES,
  FILTERS,
  isEachFieldType,
  isForbiddenAttribute,
  isTemplateFilter,
  ITEM_PROPERTIES,
  ITEM_PROPERTY_NAMES,
  ITEM_TYPES,
  MAX_BLOCK_DEPTH,
  MAX_ELEMENT_DEPTH,
  MAX_FILTERS,
  PAGE_TAGS,
  PIECE_NAMES,
  PIECES,
  VARIANT_TAG,
  type AttrSpec,
  type EachFieldType,
  type FilterSpec,
  type PieceContent,
  type PieceSpec,
} from "./catalog";
export {
  catalogJson,
  catalogText,
  EXAMPLE_WIDGET_FILES,
  type CatalogInput,
  type CatalogWidget,
  type WidgetCatalogJson,
} from "./catalog-text";
export {
  canonicalJson,
  compiledWidgetHash,
  compileWidget,
  looksLikeEmail,
  looksLikePhone,
  MAX_EXAMPLE_RECORDS,
  WIDGET_EXAMPLE_FILE,
  type CompileWidgetResult,
} from "./compile";
export {
  humanizeFieldKey,
  MAX_FIELD_DESCRIPTION_LENGTH,
  MAX_FIELD_LABEL_LENGTH,
  MAX_WIDGET_DESCRIPTION_LENGTH,
  MAX_WIDGET_FIELDS,
  MAX_WIDGET_NAME_LENGTH,
  parseWidgetManifest,
  RESERVED_FIELD_KEYS,
  WIDGET_FIELD_KEY_PATTERN,
  WIDGET_MANIFEST_FILE,
} from "./manifest";
export {
  attrOf,
  literalAttr,
  parseWidgetTemplate,
  sortDiagnostics,
  WIDGET_TEMPLATE_FILE,
  type AstAttr,
  type AstEach,
  type AstElement,
  type AstExpr,
  type AstIf,
  type AstNode,
  type AstText,
  type AstVariant,
  type ParsedTemplate,
  type SourcePosition,
} from "./parse";
export { parseSetExpression, type SetParseOptions } from "./set";
