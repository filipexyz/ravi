import { describe, expect, test } from "bun:test";

import { applySplices, escapeKitJson, rewriteKitDocument, scanKitDocument, scriptBlock, styleBlock } from "./html";

const HEAD = "<b>HEAD</b>";

function rewrite(source: string, plan: Partial<Parameters<typeof rewriteKitDocument>[1]> = {}) {
  const scanned = scanKitDocument(source);
  return rewriteKitDocument(scanned, { head: HEAD, lang: null, tags: [], ...plan });
}

describe("scanKitDocument", () => {
  test("finds kit tags with attributes, source line and column, and inner ranges", () => {
    const source = [
      "<!doctype html>",
      "<html><body>",
      '  <ravi-view view="v1" layout=board create>old <b>x</b></ravi-view>',
      "<RAVI-WIDGET use='org/card' data='{\"a\":1}'></RAVI-WIDGET><ravi-form view=\"v2\"></ravi-form>",
      "</body></html>",
    ].join("\n");
    const scanned = scanKitDocument(source);
    expect(scanned.tags.map((tag) => [tag.tag, tag.line, tag.column])).toEqual([
      ["ravi-view", 3, 3],
      ["ravi-widget", 4, 1],
      ["ravi-form", 4, 58],
    ]);
    const [view, widget] = scanned.tags;
    expect(view?.attrs).toEqual({ view: "v1", layout: "board", create: "" });
    expect(view?.attributes.map((attribute) => source.slice(attribute.start, attribute.end))).toEqual(['view="v1"', "layout=board", "create"]);
    expect(source.slice(view!.openEnd, view!.closeStart!)).toBe("old <b>x</b>");
    expect(widget?.attrs.data).toBe('{"a":1}');
    expect(source.slice(widget!.openEnd, widget!.closeStart!)).toBe("");
  });

  test("a tag closed with /> or not at all has no close, and nested tags name their parent", () => {
    const scanned = scanKitDocument('<div><ravi-view view="a"/></div><ravi-view view="b"><ravi-widget use="x"></ravi-widget></ravi-view>');
    expect(scanned.tags.map((tag) => [tag.tag, tag.closeStart === null, tag.parent])).toEqual([
      ["ravi-view", true, null],
      ["ravi-view", false, null],
      ["ravi-widget", false, 1],
    ]);
  });

  test("tags inside scripts, styles and comments are not tags", () => {
    const scanned = scanKitDocument('<script>"<ravi-view view=a></ravi-view>"</script><!-- <ravi-widget use=x></ravi-widget> --><style>ravi-view{}</style>');
    expect(scanned.tags).toEqual([]);
  });

  test("finds previously injected blocks wherever they are", () => {
    const source =
      '<head><meta charset="utf-8"><style id="ravi-theme" data-ravi-theme="h">a</style><style id="ravi-pieces">b</style>' +
      '<script type="application/json" id="ravi-kit">{"v":1}</script><script id="ravi-runtime" data-version="1.0.0">x()</script>' +
      '<style id="mine">c</style></head><body><script id="ravi-runtime">y()</script></body>';
    const scanned = scanKitDocument(source);
    expect(scanned.injected.map((block) => [block.id, source.slice(block.start, block.end)])).toEqual([
      ["ravi-theme", '<style id="ravi-theme" data-ravi-theme="h">a</style>'],
      ["ravi-pieces", '<style id="ravi-pieces">b</style>'],
      ["ravi-kit", '<script type="application/json" id="ravi-kit">{"v":1}</script>'],
      ["ravi-runtime", '<script id="ravi-runtime" data-version="1.0.0">x()</script>'],
      ["ravi-runtime", '<script id="ravi-runtime">y()</script>'],
    ]);
  });
});

describe("rewriteKitDocument head placement", () => {
  test("right after <meta charset>", () => {
    expect(rewrite('<html><head><title>T</title><meta charset="utf-8"><link rel="x"></head></html>')).toBe(
      `<html><head><title>T</title><meta charset="utf-8">${HEAD}<link rel="x"></head></html>`,
    );
  });

  test("right after <head> without a charset", () => {
    expect(rewrite("<html lang=en><HEAD data-x><title>T</title></HEAD><body></body></html>")).toBe(
      `<html lang=en><HEAD data-x>${HEAD}<title>T</title></HEAD><body></body></html>`,
    );
  });

  test("a new <head> after <html>, after the doctype, or at the start", () => {
    expect(rewrite("<!DOCTYPE html>\n<html class=a><body><p>x</p></body></html>")).toBe(
      `<!DOCTYPE html>\n<html class=a><head>${HEAD}</head><body><p>x</p></body></html>`,
    );
    expect(rewrite("<!doctype html><p>x</p>")).toBe(`<!doctype html><head>${HEAD}</head><p>x</p>`);
    expect(rewrite("<p>x</p>")).toBe(`<head>${HEAD}</head><p>x</p>`);
  });

  test("lang is added to <html> only when it has none", () => {
    expect(rewrite("<html><body></body></html>", { head: "", lang: "pt-BR" })).toBe('<html lang="pt-BR"><body></body></html>');
    expect(rewrite("<HTML class=a><body></body></HTML>", { head: "", lang: "pt-BR" })).toBe('<HTML lang="pt-BR" class=a><body></body></HTML>');
    expect(rewrite("<html lang=en><body></body></html>", { head: "", lang: "pt-BR" })).toBe("<html lang=en><body></body></html>");
    expect(rewrite("<p>no html</p>", { head: "", lang: "pt-BR" })).toBe("<p>no html</p>");
  });
});

describe("rewriteKitDocument blocks and tags", () => {
  test("removes previously injected blocks before inserting, so the result is stable", () => {
    const original = '<html><head><meta charset="utf-8"><title>T</title></head><body><ravi-view view="v"></ravi-view></body></html>';
    const plan = (source: string) => {
      const scanned = scanKitDocument(source);
      return rewriteKitDocument(scanned, {
        head: '<style id="ravi-theme" data-ravi-theme="h">x</style><script id="ravi-runtime" data-version="1.0.0">r()</script>',
        lang: "pt-BR",
        tags: [{ index: 0, id: "r1", inner: "<p>loading</p>" }],
      });
    };
    const once = plan(original);
    expect(once).toBe(
      '<html lang="pt-BR"><head><meta charset="utf-8"><style id="ravi-theme" data-ravi-theme="h">x</style><script id="ravi-runtime" data-version="1.0.0">r()</script><title>T</title></head><body><ravi-view data-ravi-id="r1" view="v"><p>loading</p></ravi-view></body></html>',
    );
    expect(plan(once)).toBe(once);
  });

  test("sets data-ravi-id on each tag, replacing an existing one and dropping duplicates", () => {
    const source = '<ravi-view view="a" data-ravi-id=old data-ravi-id="dup"></ravi-view><ravi-form view="b"></ravi-form>';
    expect(
      rewrite(source, {
        head: "",
        tags: [
          { index: 0, id: "r1", inner: null },
          { index: 1, id: "r2", inner: null },
        ],
      }),
    ).toBe('<ravi-view view="a" data-ravi-id="r1" ></ravi-view><ravi-form data-ravi-id="r2" view="b"></ravi-form>');
  });

  test("replaces inner content only where asked and only for closed tags", () => {
    const source = '<ravi-widget use="x">old</ravi-widget><ravi-view view="v">keep</ravi-view>';
    expect(
      rewrite(source, {
        head: "",
        tags: [
          { index: 0, id: "r1", inner: "<article>new</article>" },
          { index: 1, id: "r2", inner: null },
        ],
      }),
    ).toBe('<ravi-widget data-ravi-id="r1" use="x"><article>new</article></ravi-widget><ravi-view data-ravi-id="r2" view="v">keep</ravi-view>');
  });

  test("overlapping splices are refused", () => {
    expect(() =>
      applySplices("abcdef", [
        { start: 1, end: 4, text: "" },
        { start: 2, end: 3, text: "x" },
      ]),
    ).toThrow("Overlapping");
  });
});

describe("escaping", () => {
  test("kit JSON escapes <, U+2028 and U+2029", () => {
    const separators = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const text = escapeKitJson({ name: "</script><script>alert(1)</script>", separators });
    expect(text).not.toContain("<");
    expect(text).not.toContain(String.fromCharCode(0x2028));
    expect(text).not.toContain(String.fromCharCode(0x2029));
    expect(text).toContain("\\u003c/script>");
    expect(JSON.parse(text)).toEqual({ name: "</script><script>alert(1)</script>", separators });
  });

  test("style and script blocks cannot be closed early by their text", () => {
    expect(styleBlock('id="ravi-theme"', "a{}</style><script>x</script>")).toBe('<style id="ravi-theme">a{}<\\/style><script>x<\\/script></style>');
    expect(scriptBlock('id="ravi-runtime"', 'var s="</SCRIPT>";')).toBe('<script id="ravi-runtime">var s="<\\/SCRIPT>";</script>');
  });
});
