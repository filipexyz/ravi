import { describe, expect, test } from "bun:test";

import { escapeAttr, escapeHtml, h, mailtoUrl, safeStyle, safeUrl, sanitizeAttrs, telUrl, textContent, toHtml } from "./vnode";

describe("h", () => {
  test("builds plain data: drops empty attributes, stringifies numbers, flattens and merges text", () => {
    const node = h("div", { class: "a", hidden: true, title: null, tabindex: 0, "aria-hidden": false }, "a", ["b", null, ["c"]], false, 3);
    expect(node).toEqual({ tag: "div", attrs: { class: "a", hidden: true, tabindex: "0" }, children: ["abc3"] });
    expect(JSON.parse(JSON.stringify(node))).toEqual(node);
  });
});

describe("toHtml escaping", () => {
  test("escapes text and attribute values", () => {
    const html = toHtml(h("p", { title: `"><script>alert(1)</script>` }, "<b>&</b> 'x'"));
    expect(html).toBe(`<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&lt;b&gt;&amp;&lt;/b&gt; 'x'</p>`);
    expect(html).not.toContain("<script");
  });

  test("escape helpers", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(`&lt;a href="x"&gt;&amp;&lt;/a&gt;`);
    expect(escapeAttr(`a"b'c<d>&`)).toBe("a&quot;b&#39;c&lt;d&gt;&amp;");
  });

  test("drops tags outside the allowlist but keeps their children as escaped text", () => {
    expect(toHtml(h("script", null, "alert(1)"))).toBe("alert(1)");
    expect(toHtml(h("iframe", { src: "https://example.test" }, h("span", null, "x")))).toBe("<span>x</span>");
    expect(toHtml(h("style", null, "body{}"))).toBe("body{}");
  });

  test("drops event handlers and attributes outside the allowlist", () => {
    const html = toHtml(h("div", { onclick: "x()", OnMouseOver: "y()", formaction: "z", "data-other": "1", "data-ravi-row": "r1", "aria-label": "ok" }, "t"));
    expect(html).toBe('<div data-ravi-row="r1" aria-label="ok">t</div>');
  });

  test("void elements have no closing tag; boolean attributes are bare", () => {
    expect(toHtml(h("input", { type: "checkbox", checked: true, disabled: false }))).toBe('<input type="checkbox" checked>');
    expect(toHtml(h("hr", { class: "ravi-divider" }))).toBe('<hr class="ravi-divider">');
  });

  test("unknown input and button types are dropped; buttons default to type=button", () => {
    expect(toHtml(h("input", { type: "image", src: "https://example.test/a.png" }))).toBe("<input>");
    expect(toHtml(h("button", { type: "evil" }, "x"))).toBe('<button type="button">x</button>');
  });
});

describe("safeUrl", () => {
  const web = ["https", "http"] as const;
  const link = ["https", "http", "mailto", "tel"] as const;

  test("accepts absolute URLs with allowed schemes and returns the final value", () => {
    expect(safeUrl("https://example.test/a b", web)).toBe("https://example.test/a%20b");
    expect(safeUrl("  HTTPS://Example.test  ", web)).toBe("https://example.test/");
    expect(safeUrl("http://example.test/x", web)).toBe("http://example.test/x");
    expect(safeUrl("mailto:pessoa@example.test", link)).toBe("mailto:pessoa@example.test");
    expect(safeUrl("tel:+550000000000", link)).toBe("tel:+550000000000");
  });

  test("refuses javascript:, data:, vbscript:, file: and obfuscated schemes", () => {
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "java\nscript:alert(1)",
      "java\tscript:alert(1)",
      "\u0001javascript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(safeUrl(value, link)).toBeNull();
    }
  });

  test("refuses protocol-relative, relative and malformed URLs", () => {
    for (const value of ["//evil.example/x", "/path", "path/to", "?q=1", "#frag", "https://", "", "   "]) {
      expect(safeUrl(value, link)).toBeNull();
    }
  });

  test("checks the scheme against the allowed list and refuses credentials", () => {
    expect(safeUrl("mailto:a@example.test", web)).toBeNull();
    expect(safeUrl("http://example.test", ["https"])).toBeNull();
    expect(safeUrl("https://user:pass@example.test/", web)).toBeNull();
    expect(safeUrl(42, web)).toBeNull();
    expect(safeUrl(`https://example.test/${"a".repeat(3000)}`, web)).toBeNull();
  });

  test("mailto and tel builders", () => {
    expect(mailtoUrl("pessoa@example.test")).toBe("mailto:pessoa@example.test");
    expect(mailtoUrl("not an email")).toBeNull();
    expect(mailtoUrl("a@b.test?subject=x")).toBeNull();
    expect(telUrl("+55 (00) 0000-0000")).toBe("tel:+550000000000");
    expect(telUrl("call me")).toBeNull();
  });
});

describe("sanitizeAttrs and URL attributes", () => {
  test("links always get rel=noopener noreferrer; unsafe href is dropped", () => {
    expect(toHtml(h("a", { href: "https://example.test", rel: "opener" }, "x"))).toBe('<a href="https://example.test/" rel="noopener noreferrer">x</a>');
    expect(toHtml(h("a", { href: "javascript:alert(1)" }, "x"))).toBe('<a rel="noopener noreferrer">x</a>');
    expect(toHtml(h("a", { href: "//evil.example" }, "x"))).toBe('<a rel="noopener noreferrer">x</a>');
  });

  test("images get referrerpolicy=no-referrer, loading=lazy and an alt; only http(s) src", () => {
    expect(toHtml(h("img", { src: "https://example.test/a.png", alt: "Capa" }))).toBe(
      '<img src="https://example.test/a.png" alt="Capa" referrerpolicy="no-referrer" loading="lazy">',
    );
    expect(toHtml(h("img", { src: "data:image/png;base64,AAAA", referrerpolicy: "unsafe-url" }))).toBe(
      '<img referrerpolicy="no-referrer" loading="lazy" alt="">',
    );
    expect(toHtml(h("img", { src: "mailto:a@example.test" }))).not.toContain("src=");
  });

  test("styles keep custom properties only, without url() or breakouts", () => {
    expect(safeStyle("--ravi-progress: 40%")).toBe("--ravi-progress: 40%");
    expect(safeStyle("--font-sans: \"Segoe UI\", sans-serif; color-scheme: dark")).toBe('--font-sans: "Segoe UI", sans-serif; color-scheme: dark');
    expect(safeStyle("background: red")).toBeNull();
    expect(safeStyle("--x: url(https://evil.example/a.png)")).toBeNull();
    expect(safeStyle("--x: 1px} body{")).toBeNull();
    expect(safeStyle("--x: \\75 rl(x)")).toBeNull();
    expect(toHtml(h("div", { style: "--x: url(x)" }))).toBe("<div></div>");
    expect(toHtml(h("div", { style: '--x: "a"' }))).toBe('<div style="--x: &quot;a&quot;"></div>');
  });

  test("returns null for tags outside the allowlist", () => {
    expect(sanitizeAttrs("script", {})).toBeNull();
    expect(sanitizeAttrs("object", {})).toBeNull();
    for (const tag of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(sanitizeAttrs(tag, { class: "x" })).toBeNull();
      expect(toHtml(h(tag, null, "t"))).toBe("t");
    }
  });

  test("aria attributes pass by shape; malformed ones are dropped", () => {
    expect(toHtml(h("span", { "aria-describedby": "d1", "aria-": "x", "aria-x1": "y" }, "t"))).toBe('<span aria-describedby="d1">t</span>');
  });
});

describe("textContent", () => {
  test("joins text, optionally skipping aria-hidden subtrees", () => {
    const node = h("span", null, h("span", { "aria-hidden": "true" }, "AS"), h("span", { class: "ravi-sr-only" }, "Ana Souza"));
    expect(textContent(node)).toBe("ASAna Souza");
    expect(textContent(node, true)).toBe("Ana Souza");
  });

  test("accessible text counts an image as its alt", () => {
    const node = h("button", null, h("img", { src: "https://example.test/a.png", alt: "Arquivar pedido" }), h("img", { src: "https://example.test/b.png", alt: "" }));
    expect(textContent(node)).toBe("");
    expect(textContent(node, true)).toBe("Arquivar pedido");
  });
});
