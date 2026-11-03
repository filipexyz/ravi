import { describe, expect, test } from "bun:test";

import type { FieldRole, RenderColumn, RenderContext } from "../types";
import { renderField, resolveDisplay } from "./fields";
import { DEFAULT_RULES, makeCtx, norm, ORDER_COLUMNS } from "./test-fixtures";
import { textContent, toHtml } from "./vnode";

const col = (type: RenderColumn["type"], config: RenderColumn["config"] = {}, name = "Campo"): RenderColumn => ({ key: "campo", name, type, config });
const STATUS = ORDER_COLUMNS.status as RenderColumn;

function field(
  column: RenderColumn,
  value: unknown,
  options: { display?: string; role?: FieldRole; label?: "hidden" | "visible"; editable?: boolean; ctx?: Partial<RenderContext> } = {},
) {
  const ctx = makeCtx(options.ctx);
  const node = renderField(
    {
      key: column.key,
      column,
      value,
      role: options.role,
      display: options.display,
      label: options.label ?? "hidden",
      editable: options.editable ?? true,
    },
    ctx,
  );
  return { node, html: norm(toHtml(node)), text: norm(textContent(node, true)).replace(/\s+/g, " ").trim() };
}

const EN = { ctx: { locale: "en" } };

describe("resolveDisplay", () => {
  const rules = { ...DEFAULT_RULES, types: { ...DEFAULT_RULES.types, status: "steps" as const, currency: "compact" as const, date: "relative" as const } };

  test("override attribute, then role from rules, then type from rules", () => {
    expect(resolveDisplay({ column: STATUS, rules })).toBe("steps");
    expect(resolveDisplay({ column: STATUS, override: "text", rules })).toBe("text");
    expect(resolveDisplay({ column: STATUS, override: "stars", rules })).toBe("steps");
    expect(resolveDisplay({ column: col("number"), role: "progress", rules })).toBe("bar");
    expect(resolveDisplay({ column: col("number"), role: "progress", override: "ring", rules })).toBe("ring");
    expect(resolveDisplay({ column: col("number"), role: "rating", rules: { ...rules, roles: { ...rules.roles, rating: "number" } } })).toBe("number");
    expect(resolveDisplay({ column: col("date"), rules })).toBe("relative");
  });

  test("currency and percent by number format; any number display may be forced", () => {
    expect(resolveDisplay({ column: col("number", { format: "currency" }), rules })).toBe("compact");
    expect(resolveDisplay({ column: col("number", { format: "percent" }), rules })).toBe("percent");
    expect(resolveDisplay({ column: col("number"), rules })).toBe("number");
    expect(resolveDisplay({ column: col("number"), override: "currency", rules })).toBe("currency");
    expect(resolveDisplay({ column: col("number"), override: "bar", rules })).toBe("bar");
  });

  test("a role that does not fit the type is ignored; types without displays", () => {
    expect(resolveDisplay({ column: col("text"), role: "image", rules })).toBe("text");
    expect(resolveDisplay({ column: col("email"), rules })).toBe("email");
    expect(resolveDisplay({ column: col("ref"), rules })).toBe("ref");
    expect(resolveDisplay({ column: col("created_by"), rules })).toBe("avatar-name");
    expect(resolveDisplay({ column: col("person"), role: "avatar", rules })).toBe("circle");
  });
});

describe("field root", () => {
  test("carries data-ravi-field, data-ravi-value and a hidden label by default", () => {
    const { node, html } = field(STATUS, "k5d6e7f8");
    expect(node.attrs["data-ravi-field"]).toBe("status");
    expect(node.attrs["data-ravi-value"]).toBe("Em produção");
    expect(html).toContain('<span class="ravi-sr-only">Status: </span>');
  });

  test("visible labels", () => {
    const { html, text } = field(col("text", {}, "Cliente"), "Cliente Exemplo", { label: "visible" });
    expect(html).toContain('<span class="ravi-field-label">Cliente</span>');
    expect(html).toContain("ravi-field-labeled");
    expect(text).toBe("Cliente Cliente Exemplo");
  });

  test("empty values say so in text", () => {
    expect(field(col("text"), null).text).toBe("Campo: Sem valor");
    expect(field(col("date"), undefined, EN).text).toBe("Campo: No value");
    expect(field(col("text"), "").html).toContain('<span aria-hidden="true">—</span>');
  });
});

describe("status and select", () => {
  test("pill: color plus the name, in both locales", () => {
    for (const ctx of [{}, EN.ctx]) {
      const { html, text } = field(STATUS, "k9g0h1i2", { ctx });
      expect(html).toContain('<span class="ravi-pill ravi-option-green"><span class="ravi-dot" aria-hidden="true"></span>Entregue</span>');
      expect(text).toBe("Status: Entregue");
    }
  });

  test("steps: the three groups, the current one by name and aria-current", () => {
    const pt = field(STATUS, "k5d6e7f8", { display: "steps" });
    expect(pt.html).toContain('<ol class="ravi-steps">');
    expect(pt.html).toContain('<li class="ravi-step ravi-step-done">A fazer</li>');
    expect(pt.html).toContain('<li class="ravi-step ravi-step-current ravi-option-blue" aria-current="step">Em produção</li>');
    expect(pt.html).toContain('<li class="ravi-step">Feito</li>');
    const en = field(STATUS, "k1a2b3c4", { display: "steps", ...EN });
    expect(en.html).toContain('aria-current="step">A fazer</li>');
    expect(en.text).toBe("Status: A fazer In progress Done");
  });

  test("text display and select pills", () => {
    expect(field(STATUS, "k5d6e7f8", { display: "text" }).html).toContain('<span class="ravi-text-value">Em produção</span>');
    const select = { ...STATUS, type: "select" as const };
    expect(field(select, "k1a2b3c4").html).toContain("ravi-pill ravi-option-gray");
    expect(field(select, "k1a2b3c4", { display: "steps" }).html).toContain("ravi-pill");
  });

  test("multi_select: a list of pills, or text", () => {
    const multi = { ...STATUS, type: "multi_select" as const };
    const pills = field(multi, ["k1a2b3c4", "k9g0h1i2"]);
    expect(pills.html).toContain('<ul class="ravi-pills" role="list"><li><span class="ravi-pill ravi-option-gray">');
    expect(pills.text).toBe("Status: A fazer Entregue");
    expect(field(multi, ["k1a2b3c4", "k9g0h1i2"], { display: "text", ...EN }).text).toBe("Status: A fazer, Entregue");
  });
});

describe("numbers", () => {
  test("number and compact", () => {
    expect(field(col("number", { precision: 2 }), 1234.5).text).toBe("Campo: 1.234,50");
    expect(field(col("number", { precision: 2 }), 1234.5, EN).text).toBe("Campo: 1,234.50");
    expect(field(col("number"), 1200000, { display: "compact" }).text).toBe("Campo: 1,2 mi");
    expect(field(col("number"), 1200000, { display: "compact", ...EN }).text).toBe("Campo: 1.2M");
  });

  test("currency and compact currency", () => {
    const money = col("number", { format: "currency", currency: "BRL" });
    expect(field(money, 12400).text).toBe("Campo: R$ 12.400,00");
    expect(field(money, 12400, EN).text).toBe("Campo: R$12,400.00");
    expect(field(money, 12400, { display: "compact" }).text).toBe("Campo: R$ 12,4 mil");
    expect(field(money, 12400, { display: "compact", ...EN }).text).toBe("Campo: R$12.4K");
  });

  test("percent and percent bar (meter with text)", () => {
    const share = col("number", { format: "percent" });
    expect(field(share, 0.25).text).toBe("Campo: 25%");
    const bar = field(share, 0.25, { display: "bar", ...EN });
    expect(bar.html).toContain('role="meter"');
    expect(bar.html).toContain('aria-label="Campo" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0.25" aria-valuetext="25%"');
    expect(bar.html).toContain('style="--ravi-progress: 25%"');
    expect(bar.html).toContain('<span class="ravi-meter-text">25%</span>');
  });

  test("highlight: a big number in the column format", () => {
    const { html } = field(col("number", { format: "currency" }), 12400, { role: "highlight" });
    expect(html).toContain('<span class="ravi-big">R$ 12.400,00</span>');
  });

  test("progress: bar, ring and percent", () => {
    const bar = field(col("number"), 40, { role: "progress" });
    expect(bar.html).toContain('class="ravi-meter ravi-bar" role="meter"');
    expect(bar.html).toContain('aria-valuemax="100" aria-valuenow="40" aria-valuetext="40%"');
    expect(bar.text).toBe("Campo: 40%");
    const ring = field(col("number"), 140, { role: "progress", display: "ring" });
    expect(ring.html).toContain('class="ravi-meter ravi-ring" role="meter"');
    expect(ring.html).toContain('aria-valuenow="100"');
    expect(field(col("number"), 40, { role: "progress", display: "percent", ...EN }).text).toBe("Campo: 40%");
  });

  test("rating: stars with text, or the text alone", () => {
    const stars = field(col("number"), 4, { role: "rating" });
    expect(stars.html).toContain('<span class="ravi-stars" aria-hidden="true">★★★★☆</span>');
    expect(stars.text).toBe("Campo: 4 de 5");
    expect(field(col("number"), 4, { role: "rating", ...EN }).text).toBe("Campo: 4 of 5");
    expect(field(col("number"), 3.5, { role: "rating", display: "number" }).text).toBe("Campo: 3,5 de 5");
  });
});

describe("dates", () => {
  const date = col("date");
  test("date, relative and datetime in both locales", () => {
    expect(field(date, { start: "2026-10-18", end: null }).text).toBe("Campo: 18 de out.");
    expect(field(date, { start: "2026-10-18", end: null }, EN).text).toBe("Campo: Oct 18");
    expect(field(date, { start: "2026-10-18", end: null }, { display: "relative" }).text).toBe("Campo: em 2 dias");
    expect(field(date, { start: "2026-10-18", end: null }, { display: "relative", ...EN }).text).toBe("Campo: in 2 days");
    expect(field(date, { start: "2026-10-16T02:30:00Z", end: null }, { display: "datetime" }).text).toBe("Campo: 15 de out., 23:30");
    expect(field(date, { start: "2026-10-16T02:30:00Z", end: null }, { display: "datetime", ...EN }).text).toBe("Campo: Oct 15, 11:30 PM");
    expect(field(date, { start: "2026-10-18", end: null }).node.attrs["data-ravi-value"]).toBe("2026-10-18");
  });
});

describe("people", () => {
  const person = col("person", {}, "Responsável");
  test("avatar and name: decorative initials or image next to the name", () => {
    const ana = field(person, ["user_ana"]);
    expect(ana.html).toContain('<span class="ravi-person"><span class="ravi-avatar ravi-avatar-sm" aria-hidden="true">AS</span><span class="ravi-person-name">Ana Souza</span></span>');
    expect(ana.text).toBe("Responsável: Ana Souza");
    const bia = field(person, ["user_bia"], EN);
    expect(bia.html).toContain('<img class="ravi-avatar ravi-avatar-sm" src="https://example.test/bia.png" alt="" referrerpolicy="no-referrer" loading="lazy">');
    const both = field(person, ["user_ana", "user_bia"]);
    expect(both.html).toContain('<ul class="ravi-people" role="list">');
    expect(both.node.attrs["data-ravi-value"]).toBe("user_ana,user_bia");
  });

  test("initials keep the full name for assistive technology", () => {
    const { html, text } = field(person, ["user_ana"], { display: "initials" });
    expect(html).toContain('<span aria-hidden="true">AS</span><span class="ravi-sr-only">Ana Souza</span>');
    expect(text).toBe("Responsável: Ana Souza");
  });

  test("name only, and unknown people", () => {
    expect(field(person, ["user_ana", "user_bia"], { display: "name" }).text).toBe("Responsável: Ana Souza Bia Lima");
    expect(field(person, ["user_zz"], { display: "name" }).text).toBe("Responsável: Pessoa desconhecida");
    expect(field(person, ["user_zz"], { display: "name", ...EN }).text).toBe("Responsável: Unknown person");
  });

  test("avatar role: circle or square, named by the person", () => {
    const circle = field(person, ["user_bia"], { role: "avatar" });
    expect(circle.html).toContain('<img class="ravi-avatar" src="https://example.test/bia.png" alt="Bia Lima"');
    const square = field(person, ["user_ana"], { role: "avatar", display: "square" });
    expect(square.html).toContain('<span class="ravi-avatar ravi-avatar-square"><span aria-hidden="true">AS</span><span class="ravi-sr-only">Ana Souza</span></span>');
  });
});

describe("urls, images, e-mails, phones, refs, text", () => {
  test("link and domain; unsafe URLs are plain text", () => {
    const link = field(col("url"), "https://www.example.test/pedido/1");
    expect(link.html).toContain('<a class="ravi-link" href="https://www.example.test/pedido/1" rel="noopener noreferrer">www.example.test/pedido/1</a>');
    expect(field(col("url"), "https://www.example.test/pedido/1", { display: "domain", ...EN }).html).toContain(">example.test</a>");
    const evil = field(col("url"), "javascript:alert(1)");
    expect(evil.html).not.toContain("<a");
    expect(evil.html).not.toContain("href");
  });

  test("image role: cover or thumb, no referrer, lazy", () => {
    const cover = field(col("url"), "https://example.test/capa.png", { role: "image" });
    expect(cover.html).toContain('<img class="ravi-image ravi-cover" src="https://example.test/capa.png" alt="" referrerpolicy="no-referrer" loading="lazy">');
    expect(field(col("url"), "https://example.test/capa.png", { role: "image", display: "thumb" }).html).toContain("ravi-image ravi-thumb");
    expect(field(col("url"), "data:image/png;base64,AAAA", { role: "image" }).html).not.toContain("<img");
  });

  test("url avatar role", () => {
    expect(field(col("url"), "https://example.test/a.png", { role: "avatar", display: "square" }).html).toContain('<img class="ravi-avatar ravi-avatar-square"');
  });

  test("e-mail and phone links", () => {
    expect(field(col("email"), "pessoa@example.test").html).toContain('<a class="ravi-link" href="mailto:pessoa@example.test" rel="noopener noreferrer">pessoa@example.test</a>');
    expect(field(col("phone"), "(00) 0000-0000").html).toContain('href="tel:0000000000"');
  });

  test("refs and text", () => {
    expect(field(col("ref"), [{ type: "order", id: "42" }]).html).toContain('<span class="ravi-ref">order:42</span>');
    expect(field(col("ref"), [{ type: "order", id: "42" }, { type: "client", id: "7" }]).html).toContain('<ul class="ravi-refs" role="list">');
    expect(field(col("text"), "<b>oi</b>").html).toContain("&lt;b&gt;oi&lt;/b&gt;");
  });
});

describe("checkboxes", () => {
  test("check: a box plus Sim/Não for assistive technology; yes-no as text", () => {
    const on = field(col("checkbox"), true);
    expect(on.html).toContain('<span class="ravi-check ravi-check-on"><span class="ravi-check-box" aria-hidden="true">✓</span><span class="ravi-sr-only">Sim</span></span>');
    expect(field(col("checkbox"), false, EN).text).toBe("Campo: No");
    expect(field(col("checkbox"), true, { display: "yes-no", ...EN }).html).toContain('<span class="ravi-text-value">Yes</span>');
    expect(field(col("checkbox"), undefined, { display: "yes-no" }).text).toBe("Campo: Não");
  });
});

describe("editors", () => {
  const writable = { interactive: true, can: { write: new Set(["campo"]), create: false, archive: false } };

  test("status becomes a native select with a label when editable, interactive and writable", () => {
    const column = { ...STATUS, key: "campo" };
    const { html } = field(column, "k5d6e7f8", { ctx: writable });
    expect(html).toContain('<label for="r1-campo-edit" class="ravi-sr-only">Status</label>');
    expect(html).toContain('<select id="r1-campo-edit" class="ravi-input ravi-select" data-ravi-edit="campo">');
    expect(html).toContain('<option value="k5d6e7f8" selected>Em produção</option>');
    expect(html).not.toContain('<option value="">');
    expect(html).toContain('data-ravi-value="Em produção"');
  });

  test("select offers 'Sem valor' and keeps an archived current option", () => {
    const column: RenderColumn = {
      key: "campo",
      name: "Etapa",
      type: "select",
      config: { options: [{ id: "aaaa0001", name: "Nova", color: "blue" }, { id: "aaaa0002", name: "Velha", color: "red", archived: true }] },
    };
    const empty = field(column, undefined, { ctx: writable, label: "visible" });
    expect(empty.html).toContain('<label for="r1-campo-edit" class="ravi-field-label">Etapa</label>');
    expect(empty.html).toContain('<option value="" selected>Sem valor</option>');
    expect(empty.html).not.toContain("Velha");
    expect(field(column, "aaaa0002", { ctx: writable }).html).toContain('<option value="aaaa0002" selected>Velha</option>');
  });

  test("checkbox editor", () => {
    const { html } = field(col("checkbox", {}, "Pago"), true, { ctx: writable });
    expect(html).toContain('<input type="checkbox" id="r1-campo-edit" class="ravi-checkbox" data-ravi-edit="campo" checked>');
    expect(html).toContain('<label for="r1-campo-edit" class="ravi-sr-only">Pago</label>');
  });

  test("no editor when not editable, not interactive, not writable, or another type", () => {
    const column = { ...STATUS, key: "campo" };
    expect(field(column, "k5d6e7f8", { ctx: writable, editable: false }).html).not.toContain("<select");
    expect(field(column, "k5d6e7f8", { ctx: { ...writable, interactive: false } }).html).not.toContain("<select");
    expect(field(column, "k5d6e7f8", { ctx: { interactive: true } }).html).not.toContain("<select");
    expect(field(col("text"), "x", { ctx: writable }).html).not.toContain("data-ravi-edit");
  });
});
