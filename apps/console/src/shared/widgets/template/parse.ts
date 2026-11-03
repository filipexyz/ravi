// `widget.html` → AST with a line and column for every node and diagnostic.
//
// Two passes. htmlparser2 tokenizes the HTML into a raw tree (elements with
// attribute offsets, text with the source offset of every character); then
// the raw tree is checked against the piece catalog and the text is split
// into interpolations and `{#if}`/`{#each}` blocks. Blocks live in the text
// between sibling nodes, so they may wrap elements but must open and close
// inside the same parent. This pass knows the catalog but not the widget's
// fields: unknown field keys and field types are checked by the compiler.

import { Parser, type Handler } from "htmlparser2";

import {
  CSS_LENGTH_PATTERN,
  isForbiddenAttribute,
  isTemplateFilter,
  ITEM_PROPERTY_NAMES,
  MAX_BLOCK_DEPTH,
  MAX_ELEMENT_DEPTH,
  MAX_FILTERS,
  PAGE_TAGS,
  PIECE_NAMES,
  PIECES,
  VARIANT_TAG,
  type AttrSpec,
  type PieceSpec,
} from "./catalog";
import { WIDGET_FIELD_KEY_PATTERN } from "./manifest";
import {
  TEMPLATE_FILTERS,
  WIDGET_VARIANTS,
  type Diagnostic,
  type TemplateAttrValue,
  type TemplateFilter,
  type WidgetVariant,
} from "../types";

export const WIDGET_TEMPLATE_FILE = "widget.html";

export type SourcePosition = { line: number; column: number };

export type AstAttr = {
  name: string;
  /** Literal (boolean attributes written bare read as `"true"`) or one whole `{path}`. */
  value: TemplateAttrValue;
  pos: SourcePosition;
  valuePos: SourcePosition;
};

export type AstText = { k: "text"; v: string; pos: SourcePosition };
export type AstExpr = { k: "expr"; path: string[]; filters: TemplateFilter[]; pos: SourcePosition; pathPos: SourcePosition };
export type AstElement = { k: "el"; piece: string; attrs: AstAttr[]; children: AstNode[]; pos: SourcePosition };
export type AstIf = {
  k: "if";
  path: string[];
  not: boolean;
  then: AstNode[];
  else: AstNode[];
  pos: SourcePosition;
  pathPos: SourcePosition;
};
export type AstEach = { k: "each"; path: string[]; as: string; children: AstNode[]; pos: SourcePosition; pathPos: SourcePosition };
export type AstNode = AstText | AstExpr | AstElement | AstIf | AstEach;

export type AstVariant = {
  name: WidgetVariant;
  nodes: AstNode[];
  /** The `<ravi-variant>` tag, or null when the file has no variant blocks. */
  pos: SourcePosition | null;
};

export type ParsedTemplate = {
  /** In source order. Without variant blocks: one `default` entry holding the whole file. */
  variants: AstVariant[];
  hasVariantBlocks: boolean;
  diagnostics: Diagnostic[];
};

export function attrOf(node: AstElement, name: string): AstAttr | undefined {
  return node.attrs.find((attr) => attr.name === name);
}

export function literalAttr(node: AstElement, name: string): string | undefined {
  const value = attrOf(node, name)?.value;
  return value && "lit" in value ? value.lit : undefined;
}

export function parseWidgetTemplate(source: string): ParsedTemplate {
  const builder = new TemplateBuilder(source);
  return builder.build();
}

// ---------------------------------------------------------------------------
// Raw tree (pass 1)

type RawText = { type: "text"; data: string; offsets: number[]; escaped: boolean[] };
type RawAttr = { name: string; value: string; hasValue: boolean; nameStart: number; valueStart: number };
type RawElement = {
  type: "el";
  name: string;
  start: number;
  attrs: RawAttr[];
  children: RawNode[];
  selfClosing: boolean;
  closed: boolean;
};
type RawNode = RawText | RawElement | { type: "comment" } | { type: "declaration"; start: number };

type ParserHooks = {
  /** Return false to drop a closing tag that matches no open element. */
  closeTag(start: number, endIndex: number): boolean;
  selfClosing(active: boolean): void;
};

class TemplateParser extends Parser {
  constructor(
    private readonly hooks: ParserHooks,
    handler: Partial<Handler>,
  ) {
    super(handler, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true });
  }

  override onclosetag(start: number, endIndex: number): void {
    if (this.hooks.closeTag(start, endIndex)) {
      super.onclosetag(start, endIndex);
      return;
    }
    this.endIndex = endIndex;
    this.startIndex = endIndex + 1;
  }

  override onselfclosingtag(endIndex: number): void {
    this.hooks.selfClosing(true);
    super.onselfclosingtag(endIndex);
    this.hooks.selfClosing(false);
  }
}

function valueStartOf(source: string, nameStart: number, name: string, quote: string | undefined | null) {
  if (quote === undefined) return nameStart;
  let index = nameStart + name.length;
  while (index < source.length && source[index] !== "=") index++;
  index++;
  while (index < source.length && /\s/.test(source[index] ?? "")) index++;
  return quote ? index + 1 : index;
}

// ---------------------------------------------------------------------------
// Tokens of one element's content (pass 2)

type Token =
  | { t: "text"; v: string; at: number }
  | { t: "expr"; path: string[]; filters: TemplateFilter[]; at: number; pathAt: number }
  | { t: "if"; path: string[]; not: boolean; at: number; pathAt: number; source: string }
  | { t: "else"; at: number }
  | { t: "endif"; at: number }
  | { t: "each"; path: string[]; as: string; at: number; pathAt: number; source: string }
  | { t: "endeach"; at: number }
  | { t: "el"; el: RawElement }
  | { t: "declaration"; at: number };

type Frame =
  | { kind: "root"; list: AstNode[] }
  | { kind: "if"; node: AstIf; list: AstNode[]; hasElse: boolean; at: number; source: string }
  | { kind: "each"; node: AstEach; list: AstNode[]; at: number; source: string };

type Ctx = {
  /** Where unclosed blocks must close, for messages: `</ravi-row>`, `</ravi-variant>`, `the end of the file`. */
  boundary: string;
  phrasing: boolean;
  interactive: boolean;
  blockDepth: number;
  elementDepth: number;
  aliases: readonly string[];
};

const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;
const HTML_SPACE = /[ \t\n\r\f]+/g;
const ONLY_HTML_SPACE = /^[ \t\n\r\f]*$/;
const BLOCK_HELP = "blocks are {#if field}, {#if !field}, {:else}, {/if}, {#each field as item} and {/each}";

const HTML_SUGGESTIONS: Record<string, string> = {
  div: "<ravi-stack> or <ravi-row>",
  section: "<ravi-stack>",
  article: "<ravi-card>",
  header: "<ravi-row>",
  footer: "<ravi-row>",
  p: "<ravi-text>",
  span: "<ravi-text>",
  strong: '<ravi-text weight="bold">',
  b: '<ravi-text weight="bold">',
  em: "<ravi-text>",
  small: '<ravi-text size="sm">',
  h1: "<ravi-title>",
  h2: "<ravi-title>",
  h3: "<ravi-title>",
  h4: "<ravi-title>",
  h5: "<ravi-title>",
  h6: "<ravi-title>",
  img: "<ravi-image>",
  a: "<ravi-link>",
  button: "<ravi-button>",
  hr: "<ravi-divider>",
  ul: "{#each field as item}",
  ol: "{#each field as item}",
  li: "{#each field as item}",
  meter: "<ravi-progress>",
  progress: "<ravi-progress>",
};

const INLINE_PIECES = PIECE_NAMES.filter((name) => PIECES[name]?.inline);

/** Unknown elements whose content is raw text or foreign markup: not checked further. */
const OPAQUE_ELEMENTS = new Set(["script", "style", "template", "textarea", "title", "svg", "math", "iframe", "noscript", "xmp", "object"]);

class TemplateBuilder {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly lineStarts: number[] = [0];

  constructor(private readonly source: string) {
    for (let index = 0; index < source.length; index++) {
      if (source.charCodeAt(index) === 0x0a) this.lineStarts.push(index + 1);
    }
  }

  build(): ParsedTemplate {
    const root = this.rawTree();
    const rootCtx: Ctx = {
      boundary: "the end of the file",
      phrasing: false,
      interactive: false,
      blockDepth: 0,
      elementDepth: 0,
      aliases: [],
    };
    const hasVariantBlocks = root.children.some((child) => child.type === "el" && child.name === VARIANT_TAG);

    if (!hasVariantBlocks) {
      const nodes = this.children(root.children, rootCtx);
      if (nodes.length === 0) {
        this.error("TEMPLATE_EMPTY", "widget.html renders nothing; add pieces such as <ravi-card>…</ravi-card>.", 0);
      }
      return { variants: [{ name: "default", nodes, pos: null }], hasVariantBlocks, diagnostics: this.sorted() };
    }

    const variants: AstVariant[] = [];
    const seen = new Set<string>();
    for (const child of root.children) {
      if (child.type === "comment") continue;
      if (child.type === "text") {
        const index = child.data.search(/[^ \t\n\r\f]/);
        if (index >= 0) this.outsideVariant(child.offsets[index] ?? 0);
        continue;
      }
      if (child.type === "declaration") {
        this.declaration(child.start);
        continue;
      }
      if (child.name !== VARIANT_TAG) {
        this.outsideVariant(child.start);
        continue;
      }
      this.closing(child);
      let name: string | null = null;
      for (const attr of child.attrs) {
        if (attr.name === "name") name = attr.value.trim();
        else this.error("TEMPLATE_UNKNOWN_ATTRIBUTE", `<ravi-variant> takes only name; remove ${attr.name}.`, attr.nameStart);
      }
      const nodes = this.children(child.children, { ...rootCtx, boundary: "</ravi-variant>" });
      if (name === null || !(WIDGET_VARIANTS as readonly string[]).includes(name)) {
        this.error(
          "TEMPLATE_VARIANT_NAME",
          `<ravi-variant> needs name set to one of: ${WIDGET_VARIANTS.join(", ")}.`,
          child.attrs.find((attr) => attr.name === "name")?.valueStart ?? child.start,
        );
        continue;
      }
      if (seen.has(name)) {
        this.error("TEMPLATE_VARIANT_DUPLICATE", `The variant "${name}" already has a block; keep one <ravi-variant name="${name}">.`, child.start);
        continue;
      }
      seen.add(name);
      if (nodes.length === 0) {
        this.error("TEMPLATE_EMPTY", `<ravi-variant name="${name}"> renders nothing; add pieces or remove the block.`, child.start);
      }
      variants.push({ name: name as WidgetVariant, nodes, pos: this.pos(child.start) });
    }
    return { variants, hasVariantBlocks, diagnostics: this.sorted() };
  }

  // -- pass 1 ---------------------------------------------------------------

  private rawTree(): RawElement {
    const source = this.source;
    const root: RawElement = { type: "el", name: "#root", start: 0, attrs: [], children: [], selfClosing: false, closed: true };
    const stack: RawElement[] = [root];
    const top = () => stack[stack.length - 1] ?? root;
    let selfClosing = false;

    const handler: Partial<Handler> = {
      onopentagname: (name) => {
        const element: RawElement = {
          type: "el",
          name,
          start: parser.startIndex,
          attrs: [],
          children: [],
          selfClosing: false,
          closed: false,
        };
        top().children.push(element);
        stack.push(element);
      },
      onattribute: (name, value, quote) => {
        const nameStart = parser.startIndex;
        top().attrs.push({
          name,
          value,
          hasValue: quote !== undefined,
          nameStart,
          valueStart: valueStartOf(source, nameStart, name, quote),
        });
      },
      onclosetag: (_name, isImplied) => {
        if (stack.length <= 1) return;
        const element = stack.pop();
        if (!element) return;
        if (!isImplied) element.closed = true;
        else if (selfClosing) element.selfClosing = true;
      },
      ontext: (data) => {
        const start = parser.startIndex;
        const end = parser.endIndex;
        const escaped = source.slice(start, end + 1) !== data;
        const parent = top();
        let text = parent.children[parent.children.length - 1];
        if (!text || text.type !== "text") {
          text = { type: "text", data: "", offsets: [], escaped: [] };
          parent.children.push(text);
        }
        for (let index = 0; index < data.length; index++) {
          text.offsets.push(escaped ? start : start + index);
          text.escaped.push(escaped);
        }
        text.data += data;
      },
      oncomment: () => {
        top().children.push({ type: "comment" });
      },
      onprocessinginstruction: () => {
        top().children.push({ type: "declaration", start: parser.startIndex });
      },
    };

    const parser = new TemplateParser(
      {
        closeTag: (start, endIndex) => {
          const name = source.slice(start, endIndex).toLowerCase();
          for (let index = stack.length - 1; index > 0; index--) if (stack[index]?.name === name) return true;
          this.error(
            "TEMPLATE_STRAY_CLOSING_TAG",
            `</${name}> closes nothing: no <${name}> is open here. Remove it or add the opening tag.`,
            Math.max(0, start - 2),
          );
          return false;
        },
        selfClosing: (active) => {
          selfClosing = active;
        },
      },
      handler,
    );
    parser.end(source);
    return root;
  }

  // -- pass 2 ---------------------------------------------------------------

  private children(raw: RawNode[], ctx: Ctx): AstNode[] {
    const tokens: Token[] = [];
    for (const child of raw) {
      if (child.type === "text") this.tokenize(child, tokens);
      else if (child.type === "el") tokens.push({ t: "el", el: child });
      else if (child.type === "declaration") tokens.push({ t: "declaration", at: child.start });
    }

    const root: AstNode[] = [];
    const frames: Frame[] = [{ kind: "root", list: root }];
    const current = () => frames[frames.length - 1] as Frame;
    const aliases = () => [...ctx.aliases, ...frames.flatMap((frame) => (frame.kind === "each" ? [frame.node.as] : []))];
    const depth = () => ctx.blockDepth + frames.length - 1;

    for (const token of tokens) {
      switch (token.t) {
        case "text":
          current().list.push({ k: "text", v: token.v, pos: this.pos(token.at) });
          break;
        case "expr":
          this.checkPath(token.path, token.pathAt, aliases());
          current().list.push({
            k: "expr",
            path: token.path,
            filters: token.filters,
            pos: this.pos(token.at),
            pathPos: this.pos(token.pathAt),
          });
          break;
        case "if": {
          this.checkDepth(depth(), token.at);
          this.checkPath(token.path, token.pathAt, aliases());
          const node: AstIf = {
            k: "if",
            path: token.path,
            not: token.not,
            then: [],
            else: [],
            pos: this.pos(token.at),
            pathPos: this.pos(token.pathAt),
          };
          current().list.push(node);
          frames.push({ kind: "if", node, list: node.then, hasElse: false, at: token.at, source: token.source });
          break;
        }
        case "else": {
          const frame = current();
          if (frame.kind === "if" && !frame.hasElse) {
            frame.hasElse = true;
            frame.list = frame.node.else;
          } else if (frame.kind === "if") {
            this.error("TEMPLATE_BLOCK_UNEXPECTED", "This {#if} already has an {:else}; remove the second one.", token.at);
          } else if (frame.kind === "each") {
            this.error("TEMPLATE_BLOCK_UNEXPECTED", "{#each} has no {:else}; wrap it in {#if field}…{:else}…{/if} instead.", token.at);
          } else {
            this.error(
              "TEMPLATE_BLOCK_UNEXPECTED",
              "{:else} must be inside an {#if} opened in the same element; blocks open and close inside one element.",
              token.at,
            );
          }
          break;
        }
        case "endif":
          this.closeFrame("if", token.at, frames);
          break;
        case "each": {
          this.checkDepth(depth(), token.at);
          const scope = aliases();
          if (scope.includes(token.path[0] ?? "")) {
            this.error("TEMPLATE_EACH_TYPE", `{#each} iterates a widget field; ${token.path.join(".")} is an item, not a list.`, token.pathAt);
          } else {
            this.checkPath(token.path, token.pathAt, scope);
          }
          if (scope.includes(token.as)) {
            this.error(
              "TEMPLATE_EACH_ALIAS",
              `"as ${token.as}" hides the ${token.as} of an outer {#each}; choose another name, e.g. "as tag".`,
              token.at,
            );
          }
          const node: AstEach = {
            k: "each",
            path: token.path,
            as: token.as,
            children: [],
            pos: this.pos(token.at),
            pathPos: this.pos(token.pathAt),
          };
          current().list.push(node);
          frames.push({ kind: "each", node, list: node.children, at: token.at, source: token.source });
          break;
        }
        case "endeach":
          this.closeFrame("each", token.at, frames);
          break;
        case "el": {
          const node = this.element(token.el, { ...ctx, blockDepth: depth(), aliases: aliases() });
          if (Array.isArray(node)) current().list.push(...node);
          else if (node) current().list.push(node);
          break;
        }
        case "declaration":
          this.declaration(token.at);
          break;
      }
    }

    while (frames.length > 1) {
      const frame = frames.pop() as Exclude<Frame, { kind: "root" }>;
      this.error(
        "TEMPLATE_BLOCK_UNCLOSED",
        `Close {${frame.source}} with {/${frame.kind}} before ${ctx.boundary}; a block opens and closes inside the same element.`,
        frame.at,
      );
    }
    normalizeWhitespace(root, true, ctx.phrasing);
    return root;
  }

  private closeFrame(kind: "if" | "each", at: number, frames: Frame[]) {
    const index = frames.map((frame) => frame.kind).lastIndexOf(kind);
    if (index <= 0) {
      this.error(
        "TEMPLATE_BLOCK_UNEXPECTED",
        `{/${kind}} has no matching {#${kind}} in this element; a block opens and closes inside the same element.`,
        at,
      );
      return;
    }
    for (let inner = frames.length - 1; inner > index; inner--) {
      const frame = frames[inner] as Exclude<Frame, { kind: "root" }>;
      this.error("TEMPLATE_BLOCK_UNCLOSED", `Close {${frame.source}} with {/${frame.kind}} before this {/${kind}}.`, frame.at);
    }
    frames.length = index;
  }

  private checkDepth(depth: number, at: number) {
    if (depth + 1 > MAX_BLOCK_DEPTH) {
      this.error("TEMPLATE_BLOCK_DEPTH", `Blocks nest at most ${MAX_BLOCK_DEPTH} deep; flatten this {#if}/{#each}.`, at);
    }
  }

  /** Checks scope and shape of a path; field existence is the compiler's. */
  private checkPath(path: string[], at: number, aliases: readonly string[]) {
    const [head, property] = path;
    if (head !== undefined && aliases.includes(head)) {
      if (path.length > 2 || (property !== undefined && !(ITEM_PROPERTY_NAMES as readonly string[]).includes(property))) {
        this.error(
          "TEMPLATE_ITEM_PATH",
          `${path.join(".")} is not an item property; use ${head} or ${head}.<${ITEM_PROPERTY_NAMES.join("|")}>.`,
          at,
        );
        return false;
      }
      return true;
    }
    if (head === "item") {
      this.error("TEMPLATE_ITEM_PATH", "item exists only inside {#each field as item}…{/each}.", at);
      return false;
    }
    if (path.length > 1) {
      this.error(
        "TEMPLATE_EXPRESSION",
        `Fields have no properties: write {${head}} or a filter such as {${head} | initials}; inside {#each} use item.name.`,
        at,
      );
      return false;
    }
    return true;
  }

  private tokenize(text: RawText, out: Token[]) {
    const { data, offsets, escaped } = text;
    const offsetOf = (index: number) => offsets[index] ?? offsets[offsets.length - 1] ?? 0;
    let literalStart = 0;
    const flush = (end: number) => {
      if (end > literalStart) out.push({ t: "text", v: data.slice(literalStart, end), at: offsetOf(literalStart) });
    };

    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (escaped[index] || (char !== "{" && char !== "}")) {
        index++;
        continue;
      }
      flush(index);
      if (char === "}") {
        this.error("TEMPLATE_EXPRESSION", "Unexpected } in text; write &#125; for a literal brace.", offsetOf(index));
        index++;
        literalStart = index;
        continue;
      }
      let end = index + 1;
      while (end < data.length && !((data[end] === "}" || data[end] === "{") && !escaped[end])) end++;
      if (end >= data.length || data[end] === "{") {
        this.error("TEMPLATE_EXPRESSION", "Close this { with }; write &#123; for a literal brace.", offsetOf(index));
        index = end;
        literalStart = end;
        continue;
      }
      const token = this.classify(data.slice(index + 1, end), offsetOf(index), (inner) => offsetOf(index + 1 + inner));
      if (token) out.push(token);
      index = end + 1;
      literalStart = index;
    }
    flush(data.length);
  }

  private classify(inner: string, at: number, offsetIn: (index: number) => number): Token | null {
    const body = inner.trim();
    const bodyStart = inner.length - inner.trimStart().length;
    const pathAt = (path: string, from: number) => offsetIn(bodyStart + Math.max(0, body.indexOf(path, from)));

    if (body.startsWith("#if")) {
      const match = /^#if\s+(!?)\s*(\S+)$/.exec(body);
      const path = match?.[2];
      if (!match || path === undefined || !PATH_PATTERN.test(path)) {
        this.error("TEMPLATE_EXPRESSION", `Write {#if field} or {#if !field}; a condition is one field, without operators: {${body}}.`, at);
        return null;
      }
      return { t: "if", path: path.split("."), not: match[1] === "!", at, pathAt: pathAt(path, 3), source: body };
    }
    if (body.startsWith("#each")) {
      const match = /^#each\s+(\S+)\s+as\s+(\S+)$/.exec(body);
      const path = match?.[1];
      const alias = match?.[2];
      if (!match || path === undefined || alias === undefined || !PATH_PATTERN.test(path)) {
        this.error("TEMPLATE_EXPRESSION", `Write {#each field as item}: {${body}}.`, at);
        return null;
      }
      if (!ALIAS_PATTERN.test(alias)) {
        this.error("TEMPLATE_EACH_ALIAS", `"as ${alias}" must be a lowercase name such as item.`, at);
        return null;
      }
      return { t: "each", path: path.split("."), as: alias, at, pathAt: pathAt(path, 5), source: body };
    }
    if (body === ":else") return { t: "else", at };
    if (body === "/if") return { t: "endif", at };
    if (body === "/each") return { t: "endeach", at };
    if (/^:else\s+if\b/.test(body)) {
      this.error("TEMPLATE_EXPRESSION", "There is no {:else if}; put an {#if} inside {:else}.", at);
      return null;
    }
    if (/^[#:/]/.test(body)) {
      this.error("TEMPLATE_EXPRESSION", `Unknown block {${body}}; ${BLOCK_HELP}.`, at);
      return null;
    }
    if (!body) {
      this.error("TEMPLATE_EXPRESSION", "Empty {}; write {field}, or &#123;&#125; for literal braces.", at);
      return null;
    }

    const [pathText = "", ...filterTexts] = body.split("|").map((part) => part.trim());
    if (!PATH_PATTERN.test(pathText)) {
      this.error(
        "TEMPLATE_EXPRESSION",
        `{${body}} is not an interpolation; write {field}, {field | filter}, {item} or {item.name}: no operators, quotes or calls.`,
        at,
      );
      return null;
    }
    if (filterTexts.length > MAX_FILTERS) {
      this.error("TEMPLATE_EXPRESSION", `Use at most ${MAX_FILTERS} filters in {${body}}.`, at);
      return null;
    }
    const filters: TemplateFilter[] = [];
    for (const filter of filterTexts) {
      if (!isTemplateFilter(filter)) {
        this.error(
          "TEMPLATE_UNKNOWN_FILTER",
          `Unknown filter "${filter}" in {${body}}; filters: ${TEMPLATE_FILTERS.join(", ")}.`,
          pathAt(filter, pathText.length),
        );
        return null;
      }
      filters.push(filter);
    }
    return { t: "expr", path: pathText.split("."), filters, at, pathAt: pathAt(pathText, 0) };
  }

  /** One piece, or for an unknown element (an error) its checked content, so one pass reports everything inside. */
  private element(raw: RawElement, ctx: Ctx): AstElement | AstNode[] | null {
    const name = raw.name;
    if (name === VARIANT_TAG) {
      this.error(
        "TEMPLATE_VARIANT_NESTED",
        "<ravi-variant> blocks go only at the top level of widget.html, outside other pieces and blocks.",
        raw.start,
      );
      return null;
    }
    const spec = Object.hasOwn(PIECES, name) ? PIECES[name] : undefined;
    if (!spec) {
      this.unknownElement(name, raw.start);
      if (OPAQUE_ELEMENTS.has(name) || ctx.elementDepth + 1 > MAX_ELEMENT_DEPTH) return null;
      return this.children(raw.children, { ...ctx, boundary: `</${name}>`, elementDepth: ctx.elementDepth + 1 });
    }
    this.closing(raw);
    if (ctx.elementDepth + 1 > MAX_ELEMENT_DEPTH) {
      this.error("TEMPLATE_ELEMENT_DEPTH", `Pieces nest at most ${MAX_ELEMENT_DEPTH} deep; flatten this part of the template.`, raw.start);
      return null;
    }
    if (ctx.interactive && spec.interactive) {
      this.error("TEMPLATE_CONTENT_NOT_ALLOWED", `<${name}> cannot go inside a link or a button: controls do not nest.`, raw.start);
    } else if (ctx.phrasing && !spec.inline) {
      this.error(
        "TEMPLATE_CONTENT_NOT_ALLOWED",
        `<${name}> cannot go inside text, titles, badges, links or buttons; they hold text and ${INLINE_PIECES.map((piece) => `<${piece}>`).join(", ")}.`,
        raw.start,
      );
    }

    const attrs = this.attributes(raw, spec, ctx);
    let children: AstNode[] = [];
    if (!spec.children) {
      if (raw.children.some(hasContent)) {
        this.error(
          "TEMPLATE_CHILDREN_NOT_ALLOWED",
          `<${name}> takes no content; write <${name} …></${name}> with nothing between the tags.`,
          raw.start,
        );
      }
    } else {
      children = this.children(raw.children, {
        boundary: `</${name}>`,
        phrasing: spec.content === "phrasing",
        interactive: ctx.interactive || spec.interactive,
        blockDepth: ctx.blockDepth,
        elementDepth: ctx.elementDepth + 1,
        aliases: ctx.aliases,
      });
    }
    return { k: "el", piece: name, attrs, children, pos: this.pos(raw.start) };
  }

  private attributes(raw: RawElement, spec: PieceSpec, ctx: Ctx): AstAttr[] {
    const piece = raw.name;
    const present = new Set<string>();
    const out: AstAttr[] = [];
    for (const attr of raw.attrs) {
      if (present.has(attr.name)) {
        this.error("TEMPLATE_DUPLICATE_ATTRIBUTE", `${attr.name} appears twice on <${piece}>; keep one.`, attr.nameStart);
        continue;
      }
      if (isForbiddenAttribute(attr.name)) {
        this.error("TEMPLATE_FORBIDDEN_ATTRIBUTE", forbiddenMessage(attr.name, piece), attr.nameStart);
        continue;
      }
      const attrSpec = Object.hasOwn(spec.attrs, attr.name) ? spec.attrs[attr.name] : undefined;
      if (!attrSpec) {
        const known = Object.keys(spec.attrs);
        this.error(
          "TEMPLATE_UNKNOWN_ATTRIBUTE",
          known.length
            ? `<${piece}> has no attribute ${attr.name}; its attributes: ${known.join(", ")}.`
            : `<${piece}> takes no attributes; remove ${attr.name}.`,
          attr.nameStart,
        );
        continue;
      }
      present.add(attr.name);
      const value = this.attributeValue(piece, attr, attrSpec, ctx);
      if (value) out.push({ name: attr.name, value, pos: this.pos(attr.nameStart), valuePos: this.pos(attr.valueStart) });
    }

    for (const [name, attrSpec] of Object.entries(spec.attrs)) {
      if (attrSpec.required && !attrSpec.a11y && !present.has(name)) {
        this.error("TEMPLATE_REQUIRED_ATTRIBUTE", `<${piece}> needs ${name}: ${describeAccepted(attrSpec)}.`, raw.start);
      }
    }

    const at = (name: string) => raw.attrs.find((attr) => attr.name === name)?.nameStart ?? raw.start;
    if (piece === "ravi-badge" && present.has("tone") && present.has("color")) {
      this.error("TEMPLATE_ATTRIBUTE_CONFLICT", "<ravi-badge> takes tone or color, not both.", at("color"));
    }
    if (piece === "ravi-button") {
      const action = out.find((attr) => attr.name === "action")?.value;
      const verb = action && "lit" in action ? action.lit : null;
      if (verb) {
        if (present.has("set") && verb !== "update" && verb !== "create") {
          this.error("TEMPLATE_ATTRIBUTE_CONFLICT", `set applies to update and create; remove it from this ${verb} button.`, at("set"));
        }
        if (present.has("href") && verb !== "open") {
          this.error("TEMPLATE_ATTRIBUTE_CONFLICT", `href applies to open; remove it from this ${verb} button.`, at("href"));
        }
        if (present.has("confirm") && verb === "open") {
          this.error("TEMPLATE_ATTRIBUTE_CONFLICT", "confirm applies to update, create and archive; open changes nothing.", at("confirm"));
        }
        if (verb === "update" && !present.has("set")) {
          this.error("TEMPLATE_REQUIRED_ATTRIBUTE", 'An update button needs set="field=value", e.g. set="status=@done".', raw.start);
        }
      }
    }
    return out;
  }

  private attributeValue(piece: string, attr: RawAttr, spec: AttrSpec, ctx: Ctx): TemplateAttrValue | null {
    const { name, value } = attr;
    const at = attr.valueStart;
    if (value.includes("{") || value.includes("}")) {
      const match = /^\s*\{([^{}]*)\}\s*$/.exec(value);
      if (!match) {
        this.error(
          "TEMPLATE_ATTRIBUTE_INTERPOLATION",
          `${name}="${value}" mixes text and {…}; an attribute is a literal or exactly one whole {field}.`,
          at,
        );
        return null;
      }
      const inner = (match[1] ?? "").trim();
      if (spec.literal === "field-key") {
        this.error("TEMPLATE_ATTRIBUTE_VALUE", `Write ${name}="${inner}" without braces: it takes the field key.`, at);
        return null;
      }
      if (!spec.fields) {
        this.error("TEMPLATE_ATTRIBUTE_FIELD", `${name} on <${piece}> takes ${describeAccepted(spec)}, not a field.`, at);
        return null;
      }
      if (inner.includes("|")) {
        this.error("TEMPLATE_ATTRIBUTE_FIELD", `Filters do not apply in attributes; write ${name}="{${inner.split("|")[0]?.trim()}}".`, at);
        return null;
      }
      if (!PATH_PATTERN.test(inner)) {
        this.error("TEMPLATE_EXPRESSION", `${name}="${value}" must name one field, e.g. ${name}="{capa}".`, at);
        return null;
      }
      const path = inner.split(".");
      return this.checkPath(path, at, ctx.aliases) ? { ref: path } : null;
    }
    if (!attr.hasValue) {
      if (spec.values?.length === 1 && spec.values[0] === "true") return { lit: "true" };
      this.error("TEMPLATE_ATTRIBUTE_VALUE", `${name} on <${piece}> needs a value: ${describeAccepted(spec)}.`, attr.nameStart);
      return null;
    }
    if (spec.values?.includes(value)) return { lit: value };
    if (spec.literal && literalOk(spec, value)) return { lit: value };
    this.error("TEMPLATE_ATTRIBUTE_VALUE", `${name}="${value}" is not valid on <${piece}>; use ${describeAccepted(spec)}.`, at);
    return null;
  }

  private closing(raw: RawElement) {
    if (raw.selfClosing) {
      this.error(
        "TEMPLATE_SELF_CLOSING",
        `Close <${raw.name}> with </${raw.name}> instead of />: custom elements never self-close in HTML.`,
        raw.start,
      );
    } else if (!raw.closed) {
      this.error("TEMPLATE_UNCLOSED_ELEMENT", `<${raw.name}> is never closed; add </${raw.name}> where its content ends.`, raw.start);
    }
  }

  private unknownElement(name: string, at: number) {
    let message: string;
    if ((PAGE_TAGS as readonly string[]).includes(name)) {
      message = `<${name}> is a page tag; a widget template uses only pieces such as <ravi-card> and <ravi-field>.`;
    } else if (name.startsWith("ravi-")) {
      message = `Unknown piece <${name}>; pieces: ${PIECE_NAMES.join(", ")}.`;
    } else {
      const suggestion = Object.hasOwn(HTML_SUGGESTIONS, name) ? HTML_SUGGESTIONS[name] : undefined;
      message = `Only ravi-* pieces are allowed, not <${name}>${suggestion ? `; use ${suggestion}` : `; pieces: ${PIECE_NAMES.join(", ")}`}.`;
    }
    this.error("TEMPLATE_UNKNOWN_ELEMENT", message, at);
  }

  private outsideVariant(at: number) {
    this.error(
      "TEMPLATE_OUTSIDE_VARIANT",
      "Move this into a <ravi-variant> block: when widget.html has variant blocks, all content belongs to one.",
      at,
    );
  }

  private declaration(at: number) {
    this.error("TEMPLATE_UNKNOWN_ELEMENT", "Remove this declaration: widget.html holds only ravi-* pieces, text and blocks.", at);
  }

  // -- diagnostics -----------------------------------------------------------

  private pos(offset: number): SourcePosition {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - (this.lineStarts[low] ?? 0) + 1 };
  }

  private error(code: string, message: string, offset: number) {
    this.diagnostics.push({ severity: "error", code, message, file: WIDGET_TEMPLATE_FILE, ...this.pos(offset) });
  }

  private sorted() {
    return sortDiagnostics(this.diagnostics);
  }
}

export function sortDiagnostics(diagnostics: Diagnostic[]) {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort(
      (a, b) =>
        (a.diagnostic.line ?? 0) - (b.diagnostic.line ?? 0) ||
        (a.diagnostic.column ?? 0) - (b.diagnostic.column ?? 0) ||
        a.index - b.index,
    )
    .map(({ diagnostic }) => diagnostic);
}

function hasContent(node: RawNode) {
  if (node.type === "comment") return false;
  if (node.type === "text") return !ONLY_HTML_SPACE.test(node.data);
  return true;
}

function forbiddenMessage(name: string, piece: string) {
  if (name.startsWith("on")) {
    return `Remove ${name} from <${piece}>: the template runs no code; use <ravi-button action=…>, or draw in a <ravi-canvas> from widget.js.`;
  }
  if (name.startsWith("aria-") || name === "role") {
    return `Remove ${name} from <${piece}>: the renderer sets roles and ARIA from the piece.`;
  }
  if (name.startsWith("data-")) return `Remove ${name} from <${piece}>: the renderer owns data-* attributes.`;
  if (name === "id" || name === "tabindex") return `Remove ${name} from <${piece}>: the renderer sets ids and focus order per record.`;
  return `Remove ${name} from <${piece}>: the theme and the pieces own styling; use the piece's attributes (tone, size, gap…).`;
}

function describeAccepted(spec: AttrSpec) {
  const parts: string[] = [];
  if (spec.values) parts.push(`one of ${spec.values.join(", ")}`);
  switch (spec.literal) {
    case "https-url":
      parts.push("an https:// URL");
      break;
    case "link-url":
      parts.push("an https:, mailto: or tel: URL");
      break;
    case "number":
      parts.push("a positive number");
      break;
    case "text":
      parts.push(`text up to ${spec.maxLength ?? 80} characters`);
      break;
    case "field-key":
      parts.push("a widget field key");
      break;
    case "display":
      parts.push("a display for the field's type");
      break;
    case "set":
      parts.push("field=value pairs separated by ;");
      break;
    case "css-length":
      parts.push("a length such as 20rem, 320px or 40vh");
      break;
    default:
      break;
  }
  if (spec.fields) parts.push(`a ${spec.fields.join(", ")} field as {field}`);
  return parts.join(", or ");
}

function literalOk(spec: AttrSpec, value: string) {
  switch (spec.literal) {
    case "https-url":
      return urlWithProtocol(value, ["https:"]);
    case "link-url":
      return urlWithProtocol(value, ["https:", "mailto:", "tel:"]);
    case "number":
      return /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0;
    case "text": {
      const text = value.trim();
      return text.length > 0 && text.length <= (spec.maxLength ?? 80) && !/[\u0000-\u001f\u007f]/.test(text);
    }
    case "field-key":
      return WIDGET_FIELD_KEY_PATTERN.test(value);
    case "display":
      return /^[a-z][a-z-]*$/.test(value);
    case "set":
      return value.trim().length > 0;
    case "css-length":
      return CSS_LENGTH_PATTERN.test(value) && Number.parseFloat(value) > 0;
    default:
      return false;
  }
}

function urlWithProtocol(value: string, protocols: readonly string[]) {
  if (/\s/.test(value)) return false;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Whitespace is formatting. Between pieces in layout content (cards, rows,
 * stacks, grids, the file itself) whitespace-only text is dropped: the layout
 * owns spacing. In text content (text, titles, badges, links, buttons) it is
 * a word space, so `{cliente}⏎{prazo}` keeps one. Runs collapse to one space
 * and an element's content is trimmed at its edges; block branches are not
 * trimmed, so `{#if a} ({a}){/if}` keeps its space.
 */
function normalizeWhitespace(list: AstNode[], trimEdges: boolean, phrasing: boolean) {
  const out: AstNode[] = [];
  for (const node of list) {
    if (node.k === "if") {
      normalizeWhitespace(node.then, false, phrasing);
      normalizeWhitespace(node.else, false, phrasing);
    } else if (node.k === "each") {
      normalizeWhitespace(node.children, false, phrasing);
    }
    if (node.k !== "text") {
      out.push(node);
      continue;
    }
    if (!phrasing && ONLY_HTML_SPACE.test(node.v)) continue;
    const previous = out[out.length - 1];
    if (previous?.k === "text") previous.v += node.v;
    else out.push({ ...node });
  }
  for (const node of out) if (node.k === "text") node.v = node.v.replace(HTML_SPACE, " ");
  if (trimEdges) {
    const first = out[0];
    if (first?.k === "text") first.v = first.v.replace(/^ /, "");
    const last = out[out.length - 1];
    if (last?.k === "text") last.v = last.v.replace(/ $/, "");
  }
  list.splice(0, list.length, ...out.filter((node) => node.k !== "text" || node.v.length > 0));
}
