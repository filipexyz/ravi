import { parseDocument } from "htmlparser2";

/**
 * Turns a published Page file into text an agent can read.
 *
 * Static extraction only: the file as uploaded, never executed. Anything
 * hidden by attribute or inline style, scripts, styles and embedded frames is
 * dropped; what remains is rendered as Markdown with absolute links. The
 * result is untrusted data: callers must label it that way, and envelope-like
 * line prefixes are escaped so a page cannot pose as a Ravi system message.
 */

export const PAGE_READ_TEXT_EXTENSIONS = [".html", ".htm", ".md", ".markdown", ".txt"] as const;

export type PageReadExtraction = {
  title: string;
  description: string | null;
  markdown: string;
  links: PageReadLink[];
  signals: {
    scripts: number;
    raviElements: string[];
    staticTextChars: number;
    renderSuggested: boolean;
  };
};

export type PageReadLink = {
  text: string;
  url: string;
};

type DomNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
};

const SKIPPED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "canvas",
  "object",
  "embed",
  "head",
  "meta",
  "link",
  "audio",
  "video",
  "source",
  "track",
  "map",
  "dialog",
]);

const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "body",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "html",
  "main",
  "nav",
  "section",
  "summary",
]);

const MAX_LINKS = 200;
const RENDER_SUGGESTED_BELOW_CHARS = 200;

export function isPageReadTextPath(path: string) {
  const lower = path.toLowerCase();
  return PAGE_READ_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function isPageReadHtmlPath(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

export function extractPageText({
  baseUrl,
  path,
  source,
}: {
  baseUrl: string;
  path: string;
  source: string;
}): PageReadExtraction {
  if (!isPageReadHtmlPath(path)) {
    const markdown = neutralizePageText(source).trim();
    return {
      title: firstMarkdownHeading(markdown) ?? "",
      description: null,
      markdown,
      links: [],
      signals: {
        scripts: 0,
        raviElements: [],
        staticTextChars: countTextChars(markdown),
        renderSuggested: false,
      },
    };
  }
  return extractHtml(source, baseUrl);
}

function extractHtml(source: string, baseUrl: string): PageReadExtraction {
  const document = parseDocument(source, { decodeEntities: true, lowerCaseTags: true }) as unknown as DomNode;
  const state: RenderState = {
    baseUrl,
    links: [],
    linkKeys: new Set(),
    raviElements: new Set(),
    scripts: 0,
  };
  const head = collectHead(document);
  state.scripts = countScripts(document);
  const body = renderBlocks(document.children ?? [], state, 0);
  const markdown = neutralizePageText(normalizeBlankLines(body)).trim();
  const staticTextChars = countTextChars(markdown);
  const raviElements = [...state.raviElements].sort();
  return {
    title: neutralizeInline(head.title || firstMarkdownHeading(markdown) || ""),
    description: head.description ? neutralizeInline(head.description) : null,
    markdown,
    links: state.links,
    signals: {
      scripts: state.scripts,
      raviElements,
      staticTextChars,
      renderSuggested:
        staticTextChars < RENDER_SUGGESTED_BELOW_CHARS && (state.scripts > 0 || raviElements.length > 0),
    },
  };
}

type RenderState = {
  baseUrl: string;
  links: PageReadLink[];
  linkKeys: Set<string>;
  raviElements: Set<string>;
  scripts: number;
};

function collectHead(document: DomNode) {
  let title = "";
  let description = "";
  walk(document, (node) => {
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") return true;
    if (node.name === "title" && !title) title = collapse(textOf(node));
    if (node.name === "meta" && !description) {
      const name = (node.attribs?.name ?? node.attribs?.property ?? "").toLowerCase();
      if (name === "description" || name === "og:description") description = collapse(node.attribs?.content ?? "");
    }
    return node.name !== "body";
  });
  return { title, description };
}

function countScripts(document: DomNode) {
  let count = 0;
  walk(document, (node) => {
    if (node.name === "script") count += 1;
    return true;
  });
  return count;
}

function walk(node: DomNode, visit: (node: DomNode) => boolean) {
  for (const child of node.children ?? []) {
    if (visit(child)) walk(child, visit);
  }
}

function renderBlocks(nodes: DomNode[], state: RenderState, depth: number): string {
  const out: string[] = [];
  let inline = "";
  const flush = () => {
    const text = collapse(inline);
    if (text) out.push(text);
    inline = "";
  };
  for (const node of nodes) {
    if (node.type === "text") {
      inline += node.data ?? "";
      continue;
    }
    if (!isElement(node) || isHidden(node)) continue;
    const name = node.name ?? "";
    if (SKIPPED_ELEMENTS.has(name)) continue;
    if (isBlockLike(name)) {
      flush();
      const block = renderBlock(node, state, depth);
      if (block) out.push(block);
      continue;
    }
    inline += renderInline(node, state);
  }
  flush();
  return out.join("\n\n");
}

function isBlockLike(name: string) {
  return (
    BLOCK_ELEMENTS.has(name) ||
    /^h[1-6]$/.test(name) ||
    name === "p" ||
    name === "ul" ||
    name === "ol" ||
    name === "li" ||
    name === "pre" ||
    name === "blockquote" ||
    name === "table" ||
    name === "hr" ||
    name.startsWith("ravi-")
  );
}

function renderBlock(node: DomNode, state: RenderState, depth: number): string {
  const name = node.name ?? "";
  const children = node.children ?? [];
  if (/^h[1-6]$/.test(name)) {
    const text = collapse(renderInlineChildren(children, state));
    return text ? `${"#".repeat(Number(name.slice(1)))} ${text}` : "";
  }
  if (name === "p") return collapse(renderInlineChildren(children, state));
  if (name === "hr") return "---";
  if (name === "pre") {
    const code = textOf(node).replace(/\n+$/, "");
    return code.trim() ? `\`\`\`\n${code.replace(/```/g, "'''")}\n\`\`\`` : "";
  }
  if (name === "blockquote") {
    const inner = renderBlocks(children, state, depth);
    return inner
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }
  if (name === "ul" || name === "ol") return renderList(node, state, depth);
  if (name === "li") return `- ${renderBlocks(children, state, depth + 1)}`;
  if (name === "table") return renderTable(node, state);
  if (name.startsWith("ravi-")) {
    state.raviElements.add(name);
    const label = ["view", "base", "form", "name"]
      .map((key) => node.attribs?.[key])
      .filter((value): value is string => Boolean(value))
      .join(" ");
    const inner = renderBlocks(children, state, depth);
    return [`[${name}${label ? ` ${collapse(label)}` : ""}]`, inner].filter(Boolean).join("\n\n");
  }
  if (name === "details") return renderBlocks(children, state, depth);
  return renderBlocks(children, state, depth);
}

function renderList(node: DomNode, state: RenderState, depth: number) {
  const ordered = node.name === "ol";
  const indent = "    ".repeat(depth);
  const items: string[] = [];
  let index = 1;
  for (const child of node.children ?? []) {
    if (!isElement(child) || isHidden(child) || child.name !== "li") continue;
    const marker = ordered ? `${index}.` : "-";
    index += 1;
    const body = renderBlocks(child.children ?? [], state, depth + 1);
    const [first = "", ...rest] = body.split("\n").filter((line) => line.trim() !== "");
    items.push(`${indent}${marker} ${first.trim()}`);
    for (const line of rest) items.push(line.startsWith("    ") ? line : `${indent}    ${line}`);
  }
  return items.join("\n");
}

function renderTable(node: DomNode, state: RenderState) {
  const rows: string[][] = [];
  let headerRow = false;
  walk(node, (child) => {
    if (!isElement(child) || isHidden(child)) return false;
    if (child.name === "table") return false;
    if (child.name !== "tr") return true;
    const cells = (child.children ?? []).filter(
      (cell) => isElement(cell) && !isHidden(cell) && (cell.name === "td" || cell.name === "th"),
    );
    if (rows.length === 0 && cells.length > 0 && cells.every((cell) => cell.name === "th")) headerRow = true;
    rows.push(cells.map((cell) => collapse(renderInlineChildren(cell.children ?? [], state)).replace(/\|/g, "\\|")));
    return false;
  });
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];
  const header = headerRow ? pad(rows[0] ?? []) : Array(width).fill("");
  const body = headerRow ? rows.slice(1) : rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map((row) => `| ${pad(row).join(" | ")} |`),
  ].join("\n");
}

function renderInlineChildren(nodes: DomNode[], state: RenderState): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") out += node.data ?? "";
    else if (isElement(node) && !isHidden(node)) out += renderInline(node, state);
  }
  return out;
}

function renderInline(node: DomNode, state: RenderState): string {
  const name = node.name ?? "";
  if (SKIPPED_ELEMENTS.has(name)) return "";
  if (isBlockLike(name)) return ` ${collapse(renderBlock(node, state, 0))} `;
  const children = node.children ?? [];
  switch (name) {
    case "br":
      return "\n";
    case "a": {
      const text = collapse(renderInlineChildren(children, state));
      const url = absoluteUrl(node.attribs?.href, state.baseUrl);
      if (!url) return text;
      rememberLink(state, text || url, url);
      if (!text) return `<${url}>`;
      // Parentheses or spaces would end a bare destination early.
      const destination = /[\s()<>]/.test(url) ? `<${url}>` : url;
      return `[${text.replace(/([[\]])/g, "\\$1")}](${destination})`;
    }
    case "img": {
      const alt = collapse(node.attribs?.alt ?? "");
      return alt ? `[image: ${alt}]` : "";
    }
    case "strong":
    case "b": {
      const text = collapse(renderInlineChildren(children, state));
      return text ? `**${text}**` : "";
    }
    case "em":
    case "i": {
      const text = collapse(renderInlineChildren(children, state));
      return text ? `*${text}*` : "";
    }
    case "time": {
      // The machine-readable date is what a reader may need when the text is relative ("ontem").
      const text = collapse(renderInlineChildren(children, state));
      const datetime = collapse(node.attribs?.datetime ?? "");
      if (!datetime || datetime === text) return text;
      return text ? `${text} (${datetime})` : datetime;
    }
    case "code": {
      const text = collapse(textOf(node));
      return text ? `\`${text.replace(/`/g, "'")}\`` : "";
    }
    case "button": {
      const text = collapse(renderInlineChildren(children, state)) || collapse(node.attribs?.["aria-label"] ?? "");
      return text ? ` [button: ${text}] ` : "";
    }
    case "input": {
      const type = (node.attribs?.type ?? "text").toLowerCase();
      if (type === "hidden" || type === "password") return "";
      if (type === "submit" || type === "button") {
        const value = collapse(node.attribs?.value ?? "");
        return value ? ` [button: ${value}] ` : "";
      }
      const label = fieldLabel(node);
      return label ? ` [input: ${label}] ` : "";
    }
    case "textarea":
    case "select": {
      const label = fieldLabel(node);
      return label ? ` [${name}: ${label}] ` : "";
    }
    default:
      return renderInlineChildren(children, state);
  }
}

function fieldLabel(node: DomNode) {
  return collapse(
    node.attribs?.["aria-label"] ?? node.attribs?.placeholder ?? node.attribs?.title ?? node.attribs?.name ?? "",
  );
}

function rememberLink(state: RenderState, text: string, url: string) {
  if (state.links.length >= MAX_LINKS || state.linkKeys.has(url)) return;
  state.linkKeys.add(url);
  state.links.push({ text: text.slice(0, 200), url });
}

function absoluteUrl(href: string | undefined, baseUrl: string) {
  const value = href?.trim();
  if (!value || value.startsWith("#")) return null;
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:") return null;
    // mailto: keeps <, > and spaces, which would break a Markdown destination.
    return url.toString().replace(/[<>\s]/g, (character) => encodeURIComponent(character));
  } catch {
    return null;
  }
}

function isElement(node: DomNode) {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

function isHidden(node: DomNode) {
  const attribs = node.attribs ?? {};
  if ("hidden" in attribs) return true;
  if ((attribs["aria-hidden"] ?? "").toLowerCase() === "true") return true;
  const style = (attribs.style ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

function textOf(node: DomNode): string {
  if (node.type === "text") return node.data ?? "";
  if (node.name && SKIPPED_ELEMENTS.has(node.name) && node.name !== "title") return "";
  return (node.children ?? []).map(textOf).join("");
}

function collapse(text: string) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\r\u00a0]+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}

function normalizeBlankLines(text: string) {
  return text.replace(/\n{3,}/g, "\n\n");
}

function firstMarkdownHeading(markdown: string) {
  const match = markdown.match(/^#{1,6}\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function countTextChars(markdown: string) {
  return markdown.replace(/\s+/g, "").length;
}

// Ravi envelope prefixes the OSS prompt treats as system or routing lines.
const ENVELOPE_PREFIX = /^(\s*)(\[|\uff3b)(?=\s*(system|trigger|replying to|from:|\+\d))/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** Strips control and zero-width characters and escapes envelope-like line starts. */
export function neutralizePageText(text: string) {
  return text
    .normalize("NFKC")
    .replace(CONTROL_CHARS, "")
    .split("\n")
    .map((line) => line.replace(ENVELOPE_PREFIX, "$1\\["))
    .join("\n");
}

function neutralizeInline(text: string) {
  return neutralizePageText(text).replace(/\s+/g, " ").trim();
}
