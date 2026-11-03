import { describe, expect, test } from "bun:test";

import type { RenderColumn } from "../types";
import { applyFilter, applyFilters, formatNumber, formatValue, initials, intlLocale, rawValueText, type FormatContext } from "./format";
import { NOW, norm, ORDER_COLUMNS, USERS } from "./test-fixtures";

const col = (type: RenderColumn["type"], config: RenderColumn["config"] = {}): RenderColumn => ({ key: "k", name: "K", type, config });
const pt: FormatContext = { locale: "pt-BR", timeZone: "America/Sao_Paulo", now: NOW, users: USERS };
const en: FormatContext = { ...pt, locale: "en" };
const fmt = (column: RenderColumn, value: unknown, ctx: FormatContext = pt, display?: string) => norm(formatValue(column, value, ctx, display));

describe("locales", () => {
  test("pt-BR for Portuguese, en-US for everything else", () => {
    expect(intlLocale("pt-BR")).toBe("pt-BR");
    expect(intlLocale("pt")).toBe("pt-BR");
    expect(intlLocale("pt-PT")).toBe("pt-BR");
    expect(intlLocale("en")).toBe("en-US");
    expect(intlLocale("es-AR")).toBe("en-US");
    expect(intlLocale("")).toBe("en-US");
  });
});

describe("numbers", () => {
  test("plain numbers with the column precision", () => {
    expect(fmt(col("number"), 1234.5)).toBe("1.234,5");
    expect(fmt(col("number", { precision: 2 }), 1234.5)).toBe("1.234,50");
    expect(fmt(col("number", { precision: 0 }), 1234.5)).toBe("1.235");
    expect(fmt(col("number", { precision: 2 }), 1234.5, en)).toBe("1,234.50");
    expect(fmt(col("number"), 0.1 + 0.2)).toBe("0,3");
    expect(fmt(col("number"), 0)).toBe("0");
  });

  test("currency with the column's ISO currency, BRL by default", () => {
    expect(fmt(col("number", { format: "currency" }), 1234.5)).toBe("R$ 1.234,50");
    expect(fmt(col("number", { format: "currency", currency: "usd" }), 10)).toBe("US$ 10,00");
    expect(fmt(col("number", { format: "currency" }), 1234.5, en)).toBe("R$1,234.50");
    expect(fmt(col("number", { format: "currency", currency: "USD" }), 10, en)).toBe("$10.00");
    expect(fmt(col("number", { format: "currency", currency: "not-a-code" }), 10)).toBe("R$ 10,00");
    expect(fmt(col("number", { format: "currency", precision: 0 }), 12.4)).toBe("R$ 12");
  });

  test("percent: 0.25 is 25%", () => {
    expect(fmt(col("number", { format: "percent" }), 0.25)).toBe("25%");
    expect(fmt(col("number", { format: "percent", precision: 1 }), 0.2534)).toBe("25,3%");
    expect(fmt(col("number", { format: "percent", precision: 1 }), 0.2534, en)).toBe("25.3%");
  });

  test("compact keeps the currency", () => {
    expect(fmt(col("number", { format: "currency" }), 12400, pt, "compact")).toBe("R$ 12,4 mil");
    expect(fmt(col("number"), 1200000, pt, "compact")).toBe("1,2 mi");
    expect(fmt(col("number", { format: "currency" }), 12400, en, "compact")).toBe("R$12.4K");
    expect(fmt(col("number"), 1200000, en, "compact")).toBe("1.2M");
    expect(norm(formatNumber(999, col("number"), "pt-BR", "compact"))).toBe("999");
  });

  test("progress displays read a plain number out of 100", () => {
    expect(fmt(col("number"), 40, pt, "bar")).toBe("40%");
    expect(fmt(col("number", { format: "percent" }), 0.4, pt, "ring")).toBe("40%");
  });
});

describe("dates", () => {
  const date = col("date");
  const instant = col("date", { includeTime: true });

  test("date-only values: short date, year only when not the current year", () => {
    expect(fmt(date, { start: "2026-10-18", end: null })).toBe("18 de out.");
    expect(fmt(date, "2026-10-18", en)).toBe("Oct 18");
    expect(fmt(date, { start: "2025-03-05", end: null })).toBe("5 de mar. de 2025");
    expect(fmt(date, { start: "2025-03-05", end: null }, en)).toBe("Mar 5, 2025");
  });

  test("date-only values never shift with the time zone", () => {
    for (const timeZone of ["Pacific/Kiritimati", "Etc/GMT+12", "America/Sao_Paulo", "UTC", "Asia/Tokyo"]) {
      expect(fmt(date, { start: "2026-10-18", end: null }, { ...pt, timeZone })).toBe("18 de out.");
      expect(fmt(date, { start: "2026-01-01", end: null }, { ...pt, timeZone, now: new Date("2026-01-01T15:00:00Z") })).toBe("1 de jan.");
    }
  });

  test("instants show in ctx.timeZone, with the time when the column has it", () => {
    const value = { start: "2026-10-16T02:30:00.000Z", end: null };
    expect(fmt(instant, value)).toBe("15 de out., 23:30");
    expect(fmt(instant, value, { ...pt, timeZone: "UTC" })).toBe("16 de out., 02:30");
    expect(fmt(instant, value, en)).toBe("Oct 15, 11:30 PM");
    expect(fmt(col("created_time"), "2026-10-16T02:30:00.000Z")).toBe("15 de out., 23:30");
    // New Year's Eve in São Paulo is already next year in UTC.
    expect(fmt(instant, "2026-01-01T01:00:00Z", { ...pt, now: new Date("2026-06-01T12:00:00Z") })).toBe("31 de dez. de 2025, 22:00");
  });

  test("datetime adds the time to instants; date-only values stay dates", () => {
    expect(fmt(date, "2026-10-16T02:30:00Z", pt, "datetime")).toBe("15 de out., 23:30");
    expect(fmt(date, "2026-10-16T02:30:00Z", pt, "date")).toBe("15 de out.");
    expect(fmt(date, "2026-10-18", pt, "datetime")).toBe("18 de out.");
  });

  test("ranges", () => {
    expect(fmt(date, { start: "2026-10-18", end: "2026-10-20" })).toBe("18 de out. – 20 de out.");
  });

  test("relative within 7 days, else the date (pt-BR)", () => {
    const rel = (value: string, ctx = pt) => fmt(date, { start: value, end: null }, ctx, "relative");
    expect(rel("2026-10-16")).toBe("hoje");
    expect(rel("2026-10-17")).toBe("amanhã");
    expect(rel("2026-10-15")).toBe("ontem");
    expect(rel("2026-10-18")).toBe("em 2 dias");
    expect(rel("2026-10-14")).toBe("há 2 dias");
    expect(rel("2026-10-13")).toBe("há 3 dias");
    expect(rel("2026-10-23")).toBe("em 7 dias");
    expect(rel("2026-10-24")).toBe("24 de out.");
    expect(rel("2026-10-08")).toBe("8 de out.");
  });

  test("relative in en", () => {
    const rel = (value: string) => fmt(date, value, en, "relative");
    expect(rel("2026-10-16")).toBe("today");
    expect(rel("2026-10-17")).toBe("tomorrow");
    expect(rel("2026-10-15")).toBe("yesterday");
    expect(rel("2026-10-18")).toBe("in 2 days");
    expect(rel("2026-10-13")).toBe("3 days ago");
    expect(rel("2026-11-30")).toBe("Nov 30");
  });

  test("relative counts calendar days in ctx.timeZone", () => {
    // 01:00 UTC on the 17th is still the 16th (22:00) in São Paulo.
    const late = new Date("2026-10-17T01:00:00Z");
    expect(fmt(date, "2026-10-17", { ...pt, now: late }, "relative")).toBe("amanhã");
    expect(fmt(date, "2026-10-17", { ...pt, now: late, timeZone: "UTC" }, "relative")).toBe("hoje");
    expect(fmt(date, "2026-10-16", { ...pt, now: late, timeZone: "Asia/Tokyo" }, "relative")).toBe("ontem");
  });

  test("relative instants: now, minutes, hours on the same day, then days", () => {
    const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
    expect(fmt(instant, at(-30_000), pt, "relative")).toBe("agora");
    expect(fmt(instant, at(-5 * 60_000), pt, "relative")).toBe("há 5 minutos");
    expect(fmt(instant, at(2 * 3_600_000), pt, "relative")).toBe("em 2 horas");
    expect(fmt(instant, at(-20 * 3_600_000), pt, "relative")).toBe("ontem");
    expect(fmt(instant, at(-5 * 60_000), en, "relative")).toBe("5 minutes ago");
    expect(fmt(instant, at(-10 * 86_400_000), pt, "relative")).toBe("6 de out., 12:00");
  });

  test("invalid or offset-less instants are shown as written", () => {
    expect(fmt(date, "2026-02-30")).toBe("2026-02-30");
    expect(fmt(date, "2026-10-16T10:00")).toBe("2026-10-16T10:00");
  });
});

describe("people, options, refs, checkboxes, urls", () => {
  test("person names from users, initials, unknown people", () => {
    expect(fmt(col("person"), ["user_ana", "user_bia"])).toBe("Ana Souza, Bia Lima");
    expect(fmt(col("person"), ["user_ana", "user_bia"], pt, "initials")).toBe("AS, BL");
    expect(fmt(col("person"), ["user_x"])).toBe("Pessoa desconhecida");
    expect(fmt(col("person"), ["user_x"], en)).toBe("Unknown person");
    expect(fmt(col("created_by"), "user_bia")).toBe("Bia Lima");
    expect(fmt(col("person"), [{ id: "Carla Dias", displayName: "Carla Dias", avatarUrl: null }])).toBe("Carla Dias");
  });

  test("initials", () => {
    expect(initials("Ana Souza")).toBe("AS");
    expect(initials("ana")).toBe("A");
    expect(initials("Érica de Lima")).toBe("ÉL");
    expect(initials("  maria   da  silva ")).toBe("MS");
    expect(initials("")).toBe("?");
  });

  test("option names by id or name; unknown ids say so", () => {
    const status = ORDER_COLUMNS.status as RenderColumn;
    expect(fmt(status, "k5d6e7f8")).toBe("Em produção");
    expect(fmt(status, "Entregue")).toBe("Entregue");
    expect(fmt(status, "zzzzzzzz")).toBe("Opção desconhecida");
    expect(fmt(status, "zzzzzzzz", en)).toBe("Unknown option");
    expect(fmt(col("select"), "Novo")).toBe("Novo");
    expect(fmt({ ...status, type: "multi_select" }, ["k1a2b3c4", "k9g0h1i2"])).toBe("A fazer, Entregue");
  });

  test("refs as type:id", () => {
    expect(fmt(col("ref"), [{ type: "order", id: "42" }, { type: "client", id: "7" }])).toBe("order:42, client:7");
  });

  test("checkboxes always read yes or no", () => {
    expect(fmt(col("checkbox"), true)).toBe("Sim");
    expect(fmt(col("checkbox"), false)).toBe("Não");
    expect(fmt(col("checkbox"), undefined)).toBe("Não");
    expect(fmt(col("checkbox"), true, en)).toBe("Yes");
  });

  test("urls, e-mails, phones and text", () => {
    expect(fmt(col("url"), "https://www.example.test/a/")).toBe("www.example.test/a");
    expect(fmt(col("url"), "https://www.example.test/a/", pt, "domain")).toBe("example.test");
    expect(fmt(col("email"), "pessoa@example.test")).toBe("pessoa@example.test");
    expect(fmt(col("phone"), "(00) 0000-0000")).toBe("(00) 0000-0000");
    expect(fmt(col("text"), "Olá")).toBe("Olá");
    expect(fmt(col("text"), "")).toBe("");
    expect(fmt(col("text"), null)).toBe("");
  });
});

describe("rawValueText", () => {
  test("machine-readable values for data-ravi-value", () => {
    const status = ORDER_COLUMNS.status as RenderColumn;
    expect(rawValueText(col("date"), { start: "2026-10-18", end: null })).toBe("2026-10-18");
    expect(rawValueText(col("date"), { start: "2026-10-18", end: "2026-10-20" })).toBe("2026-10-18/2026-10-20");
    expect(rawValueText(col("date", { includeTime: true }), { start: "2026-10-16T02:30:00Z", end: null })).toBe("2026-10-16T02:30:00.000Z");
    expect(rawValueText(col("number", { format: "currency" }), 1234.5)).toBe("1234.5");
    expect(rawValueText(col("checkbox"), true)).toBe("true");
    expect(rawValueText(col("checkbox"), undefined)).toBe("false");
    expect(rawValueText(status, "k5d6e7f8")).toBe("Em produção");
    expect(rawValueText({ ...status, type: "multi_select" }, ["k1a2b3c4", "k9g0h1i2"])).toBe("A fazer,Entregue");
    expect(rawValueText(col("person"), ["user_ana", "user_bia"])).toBe("user_ana,user_bia");
    expect(rawValueText(col("ref"), [{ type: "order", id: "42" }])).toBe("order:42");
    expect(rawValueText(col("text"), "x")).toBe("x");
    expect(rawValueText(col("text"), undefined)).toBe("");
  });
});

describe("template filters", () => {
  const prazo = ORDER_COLUMNS.prazo as RenderColumn;
  const valor = ORDER_COLUMNS.valor as RenderColumn;
  const plain = col("number");

  test("date and relative", () => {
    expect(norm(applyFilter("date", prazo, { start: "2026-10-18", end: null }, pt))).toBe("18 de out.");
    expect(norm(applyFilter("relative", prazo, { start: "2026-10-18", end: null }, pt))).toBe("em 2 dias");
    expect(norm(applyFilter("relative", prazo, { start: "2026-10-18", end: null }, en))).toBe("in 2 days");
  });

  test("currency, number and compact", () => {
    expect(norm(applyFilter("currency", plain, 1890.5, pt))).toBe("R$ 1.890,50");
    expect(norm(applyFilter("number", valor, 12400, pt))).toBe("12.400");
    expect(norm(applyFilter("compact", valor, 12400, pt))).toBe("R$ 12,4 mil");
    expect(norm(applyFilter("compact", plain, 1200000, en))).toBe("1.2M");
    expect(norm(applyFilters(["currency", "compact"], plain, 12400, pt))).toBe("R$ 12,4 mil");
  });

  test("initials of people and text", () => {
    expect(applyFilter("initials", ORDER_COLUMNS.responsavel as RenderColumn, ["user_ana"], pt)).toBe("AS");
    expect(applyFilter("initials", col("text"), "Cliente Exemplo", pt)).toBe("CE");
    expect(applyFilter("initials", col("text"), "", pt)).toBe("");
  });

  test("a filter that does not fit the value is ignored", () => {
    expect(norm(applyFilter("date", valor, 12400, pt))).toBe("R$ 12.400,00");
    expect(applyFilter("currency", col("text"), "abc", pt)).toBe("abc");
  });
});
