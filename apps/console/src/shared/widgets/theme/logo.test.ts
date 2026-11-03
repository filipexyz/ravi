import { describe, expect, test } from "bun:test";

import { base64FromUtf8, LOGO_MAX_BYTES, sanitizeLogoMarkup, sanitizeLogoSvg } from "./logo";

const decode = (dataUrl: string) => {
  expect(dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
  return Buffer.from(dataUrl.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
};

describe("sanitizeLogoSvg", () => {
  test("keeps an allowed logo and outputs a base64 data URL", () => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Illustrator -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 40" width="120" height="40">
  <title>Acme &amp; Cia</title>
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14635a"/><stop offset="1" stop-color="#17202a"/></linearGradient>
    <clipPath id="c"><rect width="120" height="40" rx="6"/></clipPath>
  </defs>
  <g clip-path="url(#c)"><path d="M0 0h120v40H0z" fill="url(#g1)" style="fill: url('#g1'); opacity: 0.9"/></g>
  <text x="10" y="28" font-family="Inter" font-size="20" fill="#fff">Ação</text>
  <use xlink:href="#c"/>
</svg>`;
    const { dataUrl, diagnostics } = sanitizeLogoSvg(svg);
    expect(diagnostics).toEqual([]);
    const out = decode(dataUrl!);
    expect(out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40">')).toBe(true);
    expect(out).toContain("<title>Acme &amp; Cia</title>");
    expect(out).toContain('<stop offset="0" stop-color="#14635a"/>');
    expect(out).toContain('fill="url(#g1)" style="fill:url(\'#g1\');opacity:0.9"');
    expect(out).toContain(">Ação</text>");
    expect(out).toContain('<use href="#c"/>');
    expect(out).not.toContain("xlink");
    expect(out).not.toContain("<!--");
  });

  test("strips scripts, foreignObject, handlers, external references and style url()", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
  <script>alert(1)</script>
  <script type="text/javascript"><![CDATA[ fetch("https://evil.example") ]]></script>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <style>@import url(https://evil.example/x.css);</style>
  <a href="javascript:alert(1)"><rect width="1" height="1"/></a>
  <image href="https://evil.example/track.png" width="1" height="1"/>
  <rect width="10" height="10" ONCLICK="alert(1)" onmouseover="x()" fill="url(https://evil.example/p.svg#g)"/>
  <use href="https://evil.example/sprite.svg#icon"/>
  <use xlink:href="data:image/svg+xml;base64,AAAA"/>
  <circle r="4" style="fill: red; background: url(https://evil.example/x.png); stroke: url( 'http://x/y' )"/>
  <path d="M0 0" filter="url(#f)" mask="url(#m)" data-x="1" class="c" aria-label="x"/>
</svg>`;
    const { dataUrl, diagnostics } = sanitizeLogoSvg(svg);
    const out = decode(dataUrl!);
    for (const banned of ["script", "alert", "foreignObject", "evil.example", "<a", "<image", "<style", "onload", "onclick", "ONCLICK", "onmouseover", "data:", "javascript", "data-x", "class=", "aria-label", "filter"]) {
      expect(out).not.toContain(banned);
    }
    expect(out).toContain('<circle r="4" style="fill:red"/>');
    expect(out).toContain('<path d="M0 0" mask="url(#m)"/>');
    expect(out).toContain('<rect width="10" height="10"/>');
    expect(diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.code])).toEqual([
      ["warning", "LOGO_SANITIZED"],
      ["warning", "LOGO_SANITIZED"],
      ["warning", "LOGO_SANITIZED"],
    ]);
    const messages = diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    expect(messages).toContain("script, foreignObject, style, a, image");
    expect(messages).toContain("onload, ONCLICK, onmouseover");
    expect(messages).toContain("fill");
    expect(messages).toContain("style stroke");
  });

  test("does not expand entities declared in a DOCTYPE", () => {
    const svg = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg viewBox="0 0 1 1"><text>&x;&lt;b&gt;</text></svg>`;
    const { markup } = sanitizeLogoMarkup(svg);
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;b&gt;");
  });

  test("escapes text and attribute values when rebuilding", () => {
    const { markup } = sanitizeLogoMarkup('<svg viewBox="0 0 1 1"><desc>a &lt;/svg&gt; "b"</desc><rect id="r" width="1&quot;onload=&quot;x"/></svg>');
    expect(markup).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><desc>a &lt;/svg&gt; "b"</desc><rect id="r" width="1&quot;onload=&quot;x"/></svg>');
  });

  test("refuses files that are too large or not SVG", () => {
    const big = `<svg viewBox="0 0 1 1"><desc>${"a".repeat(LOGO_MAX_BYTES)}</desc></svg>`;
    expect(sanitizeLogoSvg(big)).toEqual({
      dataUrl: null,
      diagnostics: [expect.objectContaining({ severity: "error", code: "LOGO_TOO_LARGE", file: "logo.svg" })],
    });
    for (const text of ["", "not svg", "<html><body></body></html>", "<script>alert(1)</script><svg/>"]) {
      const result = sanitizeLogoSvg(text);
      expect(result.dataUrl).toBeNull();
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["LOGO_INVALID"]);
    }
  });
});

describe("base64FromUtf8", () => {
  test.each(["", "a", "ab", "abc", "abcd", "abcde", "Ação ✅ 🎉", "<svg>&</svg>"])("matches Buffer for %j", (text) => {
    expect(base64FromUtf8(text)).toBe(Buffer.from(text, "utf8").toString("base64"));
  });
});
