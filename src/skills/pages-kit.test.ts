import { describe, expect, it } from "bun:test";
import { listCatalogSkills, listSkillFilePaths, readSkillFile } from "./manager.js";

// The rk kit of the pages skill has one source (references/kit/) and each
// skeleton carries a copy inline between exact markers, so a page shipped as a
// single index.html needs nothing else. The files are read through the skill
// loader, the same way `ravi skills show pages --file ...` serves them.

const KIT_CSS = "references/kit/kit.css.txt";
const KIT_JS = "references/kit/kit.js.txt";
const CLIENT = "references/esqueletos/_client.js.txt";
const DECISOES = "references/esqueletos/decisoes.html.txt";
const RELATORIO = "references/esqueletos/relatorio.html.txt";
const SKELETONS = [DECISOES, RELATORIO];

const KB = 1000;
// The JS grew past its first 12 KB guess once the decision flow handled refreshes, errors and
// keyboard guards; the decisions skeleton carries kit, client and example data in one file.
const BUDGETS: [path: string, maxBytes: number][] = [
  [KIT_CSS, 24 * KB],
  [KIT_JS, 20 * KB],
  [DECISOES, 66 * KB],
  [RELATORIO, 60 * KB],
];

interface InlineBlock {
  begin: string;
  end: string;
  source: string;
  open: string;
  close: string;
}

const CSS_BLOCK: InlineBlock = {
  begin: "/* rk-kit:css v1 begin */",
  end: "/* rk-kit:css v1 end */",
  source: KIT_CSS,
  open: '<style id="rk-kit">',
  close: "</style>",
};
const JS_BLOCK: InlineBlock = {
  begin: "/* rk-kit:js v1 begin */",
  end: "/* rk-kit:js v1 end */",
  source: KIT_JS,
  open: '<script id="rk-kit-js">',
  close: "</script>",
};
const CLIENT_BLOCK: InlineBlock = {
  begin: "/* rk-client v1 begin */",
  end: "/* rk-client v1 end */",
  source: CLIENT,
  open: '<script id="rk-client">',
  close: "</script>",
};

const INLINED: Record<string, InlineBlock[]> = {
  [DECISOES]: [CSS_BLOCK, JS_BLOCK, CLIENT_BLOCK],
  [RELATORIO]: [CSS_BLOCK, JS_BLOCK],
};

const THEME_DECLARATION = /(?:^|[;{\s"'`])--(?:color|ravi|font|border|shadow)-[\w-]*\s*:/gm;
const CSS_COLOR_LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|navy|teal|maroon|olive|lime|aqua|fuchsia)(?![\w-])/gi;
const JS_COLOR_LITERAL = /["'`]#[0-9a-f]{3,8}["'`]|\b(?:rgba?|hsla?|hwb|oklab|oklch)\(/gi;
/** String literals of a script; colour checks read the CSS-like ones (`"color:#fff"`, `"background:black"`). */
const JS_STRING = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
/** Values written to a style: `el.style.background = "black"`, `style.setProperty("--x", "red")`. */
const JS_STYLE_VALUE = /(?:\.style\.[\w$]+\s*=|setProperty\([^,]+,)\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
const ATTRIBUTE_COLOR_LITERAL =
  /\b(?:fill|stroke|stop-color|flood-color|color|bgcolor)\s*=\s*["']\s*(?:#|(?:rgba?|hsla?|oklch|oklab)\()/gi;
const BRANDS = /\b(?:slack|github|aws|openai|anthropic|salesforce|stripe|pagerduty)\b/gi;

const pages = listCatalogSkills().find((skill) => skill.name === "pages");

function read(path: string): string {
  if (!pages) throw new Error("catalog skill pages not found");
  const file = readSkillFile(pages, path);
  if (!file) throw new Error(`pages skill does not ship ${path}`);
  return file.content;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Null when equal, otherwise where the two strings first differ. */
function firstDifference(actual: string, expected: string): string | null {
  if (actual === expected) return null;
  let index = 0;
  while (index < actual.length && actual[index] === expected[index]) index++;
  const around = (text: string) => JSON.stringify(text.slice(Math.max(0, index - 40), index + 40));
  return `differs at char ${index} (length ${actual.length} vs ${expected.length}): got ${around(actual)}, want ${around(expected)}`;
}

/** The text with every `var(...)` call, fallback included, reduced to `var()`. */
function withoutVarCalls(css: string): string {
  let out = "";
  let index = 0;
  while (index < css.length) {
    const start = css.indexOf("var(", index);
    if (start < 0) return out + css.slice(index);
    out += `${css.slice(index, start)}var()`;
    let depth = 0;
    let cursor = start + "var".length;
    for (; cursor < css.length; cursor++) {
      if (css[cursor] === "(") depth++;
      else if (css[cursor] === ")" && --depth === 0) break;
    }
    index = cursor + 1;
  }
  return out;
}

function withoutCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Markup comments go first: the skeleton headers mention tags such as <script src>. */
function withoutHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** CSS a skeleton adds besides the inlined kit: its own `<style>` blocks and `style` attributes. */
function pageCss(html: string): string[] {
  html = withoutHtmlComments(html);
  const blocks = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)]
    .filter((match) => !/\bid\s*=\s*["']rk-kit["']/.test(match[1] ?? ""))
    .map((match) => match[2] ?? "");
  const attributes = [...html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  return [...blocks, ...attributes];
}

/** Inline classic scripts of a skeleton, without the kit and client blocks (checked from their sources). */
function pageScripts(html: string): string[] {
  return [...withoutHtmlComments(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => {
      const attributes = match[1] ?? "";
      if (/\bid\s*=\s*["']rk-(?:kit-js|client)["']/.test(attributes)) return false;
      const type = /\btype\s*=\s*["']([^"']*)["']/.exec(attributes)?.[1]?.toLowerCase();
      return !type || type === "text/javascript" || type === "application/javascript";
    })
    .map((match) => match[2] ?? "");
}

/** Colour literals in a script: whole hex strings, colour functions, and colours inside CSS-like strings. */
function jsColors(code: string): string[] {
  const cssLike = [...code.matchAll(JS_STRING)]
    .map((match) => match[2] ?? "")
    .filter((text) => text.includes(":") || text.includes("#"));
  const styleValues = [...code.matchAll(JS_STYLE_VALUE)].map((match) => match[2] ?? "");
  return [
    ...matches(code, JS_COLOR_LITERAL),
    ...[...cssLike, ...styleValues].flatMap((text) => matches(text, CSS_COLOR_LITERAL)),
  ];
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

function contexts(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) =>
    text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30),
  );
}

describe("pages kit (rk)", () => {
  it("ships the kit, the skeletons and the client through the skill loader", () => {
    expect(pages).toBeDefined();
    const paths = listSkillFilePaths(pages!);
    for (const path of [KIT_CSS, KIT_JS, CLIENT, ...SKELETONS]) {
      expect(paths).toContain(path);
    }
  });

  for (const skeleton of SKELETONS) {
    it(`inlines the kit byte for byte in ${skeleton}`, () => {
      const html = read(skeleton);
      for (const block of INLINED[skeleton] ?? []) {
        expect(`${skeleton} ${block.begin} x${count(html, block.begin)}`).toBe(`${skeleton} ${block.begin} x1`);
        expect(`${skeleton} ${block.end} x${count(html, block.end)}`).toBe(`${skeleton} ${block.end} x1`);
        const opened = new RegExp(`${escapeRegExp(block.open)}\\s*${escapeRegExp(block.begin)}`).test(html);
        const closed = new RegExp(`${escapeRegExp(block.end)}\\s*${escapeRegExp(block.close)}`).test(html);
        expect({ block: block.begin, opened, closed }).toEqual({ block: block.begin, opened: true, closed: true });

        const start = html.indexOf(block.begin) + block.begin.length;
        const inlined = html.slice(start, html.indexOf(block.end));
        expect({
          block: block.begin,
          source: block.source,
          diff: firstDifference(inlined, `\n${read(block.source)}`),
        }).toEqual({ block: block.begin, source: block.source, diff: null });
      }
    });
  }

  it("keeps the inlined sources free of text that would end the inline element early", () => {
    const offenders = [KIT_CSS, KIT_JS, CLIENT].flatMap((path) =>
      contexts(read(path), /<\/style|<\/script|<!--/gi).map((context) => `${path}: ${context}`),
    );
    expect(offenders).toEqual([]);
  });

  it("names nothing ravi-: the theme is only read through var(--ravi-…)", () => {
    const offenders = [KIT_CSS, KIT_JS, ...SKELETONS].flatMap((path) =>
      contexts(read(path).replace(/var\(\s*--ravi-/g, "var(--"), /ravi-/gi).map((context) => `${path}: ${context}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never declares the theme's own variables", () => {
    const sources = [KIT_CSS, KIT_JS, CLIENT, ...SKELETONS];
    const offenders = sources.flatMap((path) => {
      const text = read(path);
      return [
        ...contexts(text, THEME_DECLARATION),
        ...contexts(text, /setProperty\(\s*["'`]--(?:color|ravi|font|border|shadow)-/g),
      ].map((context) => `${path}: ${context}`);
    });
    expect(offenders).toEqual([]);
  });

  it("writes literal colours only in the kit's --rk-fb-* fallback block", () => {
    const kitCss = withoutVarCalls(withoutCssComments(read(KIT_CSS)).replace(/--rk-fb-[\w-]+\s*:[^;}]*/g, ""));
    const offenders = matches(kitCss, CSS_COLOR_LITERAL).map((literal) => `${KIT_CSS}: ${literal}`);
    for (const skeleton of SKELETONS) {
      const html = read(skeleton);
      for (const css of pageCss(html)) {
        offenders.push(
          ...matches(withoutVarCalls(withoutCssComments(css)), CSS_COLOR_LITERAL).map(
            (literal) => `${skeleton}: ${literal}`,
          ),
        );
      }
      for (const script of pageScripts(html)) {
        offenders.push(...jsColors(script).map((literal) => `${skeleton}: ${literal}`));
      }
      offenders.push(...matches(html, ATTRIBUTE_COLOR_LITERAL).map((literal) => `${skeleton}: ${literal}`));
    }
    for (const path of [KIT_JS, CLIENT]) {
      offenders.push(...jsColors(read(path)).map((literal) => `${path}: ${literal}`));
    }
    expect(offenders).toEqual([]);
  });

  it("stays within the size budgets", () => {
    const overBudget = BUDGETS.map(([path, maxBytes]) => ({ path, maxBytes, bytes: Buffer.byteLength(read(path)) }))
      .filter(({ bytes, maxBytes }) => bytes > maxBytes)
      .map(({ path, bytes, maxBytes }) => `${path}: ${bytes} bytes > ${maxBytes}`);
    expect(overBudget).toEqual([]);
  });

  it("parses: kit JS, client, page scripts and the example data", () => {
    const failures: string[] = [];
    const parse = (label: string, code: string) => {
      try {
        new Function(code);
      } catch (error) {
        failures.push(`${label}: ${(error as Error).message}`);
      }
    };
    parse(KIT_JS, read(KIT_JS));
    parse(CLIENT, read(CLIENT));
    for (const skeleton of SKELETONS) {
      for (const [index, script] of pageScripts(read(skeleton)).entries()) {
        parse(`${skeleton} script ${index + 1}`, script);
      }
    }
    expect(failures).toEqual([]);

    const data = /<script type="application\/json" id="rk-data">([\s\S]*?)<\/script>/.exec(read(DECISOES))?.[1];
    expect(data).toBeDefined();
    const parsed = JSON.parse(data!) as { decisoes?: unknown };
    expect(Array.isArray(parsed.decisoes) && parsed.decisoes.length > 0).toBe(true);
    // The example teaches the escaping rule: nothing in the data may end the script element.
    expect(contexts(data!, /<\/|<!--/g)).toEqual([]);
  });

  it("names no third-party brand in the skeletons", () => {
    const offenders = SKELETONS.flatMap((path) => contexts(read(path), BRANDS).map((context) => `${path}: ${context}`));
    expect(offenders).toEqual([]);
  });
});
