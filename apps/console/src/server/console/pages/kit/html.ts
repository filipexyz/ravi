// Page kit HTML surgery: finds the `ravi-view|ravi-widget|ravi-form` tags of
// a page with their source positions (htmlparser2), and rewrites the page by
// splicing strings at those positions. The document is never re-serialized,
// so everything the kit does not touch stays byte-identical.

import { Parser } from "htmlparser2";

import { PAGE_KIT_TAGS, type PageKitTag } from "@/shared/widgets/types";

/** Ids of the blocks the kit injects; a re-ship removes them first. */
export const KIT_BLOCK_IDS = ["ravi-theme", "ravi-pieces", "ravi-kit", "ravi-runtime"] as const;

export type KitAttribute = {
  /** Lowercased. */
  name: string;
  /** Entities decoded. */
  value: string;
  hasValue: boolean;
  /** Source range of the whole attribute (`name="value"`), end exclusive. */
  start: number;
  end: number;
};

export type KitTagSource = {
  tag: PageKitTag;
  /** Offset of `<`. */
  start: number;
  /** Offset right after the opening tag's `>`. */
  openEnd: number;
  /** Offset of `</ravi-…>`, or null when the tag is not closed explicitly. */
  closeStart: number | null;
  attributes: KitAttribute[];
  /** First value of each attribute, by lowercased name. */
  attrs: Record<string, string>;
  line: number;
  column: number;
  /** Index (in `tags`) of the kit tag this one sits inside, or null. */
  parent: number | null;
};

export type KitInsertPoint =
  /** Right after `<meta charset>` or `<head>`. */
  | { kind: "after"; index: number }
  /** No `<head>`: a new one goes here (after `<html>`, else the doctype, else at 0). */
  | { kind: "create"; index: number };

export type ScannedKitDocument = {
  source: string;
  tags: KitTagSource[];
  /** Previously injected blocks (`<style id="ravi-theme">`, ...), end exclusive. */
  injected: Array<{ id: string; start: number; end: number }>;
  insert: KitInsertPoint;
  /** The `<html>` start tag, when present. */
  html: { start: number; hasLang: boolean } | null;
};

const KIT_TAG_SET: ReadonlySet<string> = new Set(PAGE_KIT_TAGS);
const KIT_BLOCK_SET: ReadonlySet<string> = new Set(KIT_BLOCK_IDS);
/** Prefix of the `<script type="text/plain">` blocks that carry widget code (`widgetScriptElementId`). */
export const KIT_WIDGET_SCRIPT_ID_PREFIX = "ravi-widget-js-";

function isKitBlockId(id: string) {
  return KIT_BLOCK_SET.has(id) || /^ravi-widget-js-[0-9a-f]{16}$/.test(id);
}

type OpenElement = { name: string; kitIndex: number | null; blockId: string | null; start: number };

export function scanKitDocument(source: string): ScannedKitDocument {
  const lines = lineStarts(source);
  const tags: KitTagSource[] = [];
  const injected: ScannedKitDocument["injected"] = [];
  const stack: OpenElement[] = [];
  let attributes: KitAttribute[] = [];
  let metaEnd: number | null = null;
  let headEnd: number | null = null;
  let htmlTag: { start: number; end: number; hasLang: boolean } | null = null;
  let doctypeEnd: number | null = null;

  const openKitTag = () => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const kitIndex = stack[index]?.kitIndex;
      if (kitIndex !== null && kitIndex !== undefined) return kitIndex;
    }
    return null;
  };

  const parser = new Parser(
    {
      onattribute(name, value, quote) {
        attributes.push({ name, value, hasValue: quote !== undefined, start: parser.startIndex, end: parser.endIndex });
      },
      onopentag(name, attribs) {
        const start = parser.startIndex;
        const end = parser.endIndex + 1;
        // A start tag the parser drops (a nested <form>) still reports its attributes.
        const own = attributes.filter((attribute) => attribute.start > start);
        attributes = [];
        const element: OpenElement = { name, kitIndex: null, blockId: null, start };
        if (KIT_TAG_SET.has(name)) {
          const position = positionOf(lines, start);
          tags.push({
            tag: name as PageKitTag,
            start,
            openEnd: end,
            closeStart: null,
            attributes: own,
            attrs: { ...attribs },
            line: position.line,
            column: position.column,
            parent: openKitTag(),
          });
          element.kitIndex = tags.length - 1;
        } else if ((name === "style" || name === "script") && isKitBlockId(attribs.id ?? "")) {
          element.blockId = attribs.id ?? null;
        } else if (name === "meta" && metaEnd === null && attribs.charset !== undefined) {
          metaEnd = end;
        } else if (name === "head" && headEnd === null) {
          headEnd = end;
        } else if (name === "html" && htmlTag === null) {
          htmlTag = { start, end, hasLang: attribs.lang !== undefined };
        }
        // Void elements get no close event from the stack.
        if (!VOID_ELEMENTS.has(name)) stack.push(element);
      },
      onclosetag(name, isImplied) {
        if (VOID_ELEMENTS.has(name)) return;
        const element = stack.pop();
        if (!element) return;
        if (element.kitIndex !== null && !isImplied) {
          const tag = tags[element.kitIndex];
          if (tag) tag.closeStart = parser.startIndex;
        }
        if (element.blockId && !isImplied) {
          injected.push({ id: element.blockId, start: element.start, end: parser.endIndex + 1 });
        }
      },
      onprocessinginstruction(name) {
        if (doctypeEnd === null && name.toLowerCase() === "!doctype") doctypeEnd = parser.endIndex + 1;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(source);
  parser.end();

  const resolvedHtml = htmlTag as { start: number; end: number; hasLang: boolean } | null;
  const insert: KitInsertPoint =
    metaEnd !== null
      ? { kind: "after", index: metaEnd }
      : headEnd !== null
        ? { kind: "after", index: headEnd }
        : { kind: "create", index: resolvedHtml?.end ?? doctypeEnd ?? 0 };

  return {
    source,
    tags,
    injected,
    insert,
    html: resolvedHtml ? { start: resolvedHtml.start, hasLang: resolvedHtml.hasLang } : null,
  };
}

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "image",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// ---------------------------------------------------------------------------
// Rewrite

export type KitTagEdit = {
  /** Index into `ScannedKitDocument.tags`. */
  index: number;
  /** `data-ravi-id` value. */
  id: string;
  /** New inner HTML, or null to keep the current content. */
  inner: string | null;
};

export type KitRewritePlan = {
  /** Blocks to insert into `<head>` (already serialized), or "" for none. */
  head: string;
  /** `<html lang>` to add when the start tag has none, or null. */
  lang: string | null;
  tags: KitTagEdit[];
};

type Splice = { start: number; end: number; text: string };

/**
 * Applies the plan: removes every previously injected block, inserts `head`,
 * adds `lang`, sets `data-ravi-id` on each tag (replacing an existing one)
 * and replaces inner content where asked.
 */
export function rewriteKitDocument(scanned: ScannedKitDocument, plan: KitRewritePlan): string {
  const { source } = scanned;
  const splices: Splice[] = scanned.injected.map((block) => ({ start: block.start, end: block.end, text: "" }));

  if (plan.head) {
    const text = scanned.insert.kind === "create" ? `<head>${plan.head}</head>` : plan.head;
    splices.push({ start: scanned.insert.index, end: scanned.insert.index, text });
  }
  if (plan.lang && scanned.html && !scanned.html.hasLang) {
    const at = scanned.html.start + "<html".length;
    splices.push({ start: at, end: at, text: ` lang="${escapeAttribute(plan.lang)}"` });
  }

  for (const edit of plan.tags) {
    const tag = scanned.tags[edit.index];
    if (!tag) continue;
    const idAttribute = `data-ravi-id="${escapeAttribute(edit.id)}"`;
    const existing = tag.attributes.filter((attribute) => attribute.name === "data-ravi-id");
    const [first, ...rest] = existing;
    if (first) {
      splices.push({ start: first.start, end: first.end, text: idAttribute });
      for (const extra of rest) splices.push({ start: extra.start, end: extra.end, text: "" });
    } else {
      const at = tag.start + 1 + tag.tag.length;
      splices.push({ start: at, end: at, text: ` ${idAttribute}` });
    }
    if (edit.inner !== null && tag.closeStart !== null) {
      splices.push({ start: tag.openEnd, end: tag.closeStart, text: edit.inner });
    }
  }

  return applySplices(source, splices);
}

/** Applies non-overlapping splices; an insertion at the start of a removal goes first. */
export function applySplices(source: string, splices: readonly Splice[]): string {
  const ordered = [...splices].sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  let out = "";
  for (const splice of ordered) {
    if (splice.start < cursor) throw new Error(`Overlapping page kit edits at offset ${splice.start}.`);
    out += source.slice(cursor, splice.start) + splice.text;
    cursor = splice.end;
  }
  return out + source.slice(cursor);
}

// ---------------------------------------------------------------------------
// Blocks

/** `<style>` text: `</` cannot close the element early (CSS reads `<\/` as `</`). */
export function styleBlock(attributes: string, css: string) {
  return `<style ${attributes}>${css.replace(/<\//g, "<\\/")}</style>`;
}

/** Inline `<script>` text: `</script` cannot close the element early. */
export function scriptBlock(attributes: string, code: string) {
  return `<script ${attributes}>${code.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
}

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

/** JSON for `<script type="application/json">`: `<`, U+2028 and U+2029 escaped. */
export function escapeKitJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(LINE_SEPARATOR, "\\u2028").replace(PARAGRAPH_SEPARATOR, "\\u2029");
}

export function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Positions

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

/** 1-based line and column of an offset. */
function positionOf(starts: readonly number[], offset: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}
