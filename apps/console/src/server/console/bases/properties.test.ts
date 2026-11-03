import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";

import { deriveBaseSlug } from "./bases";
import { buildPropertyConfig, preparePropertyDefinitions } from "./properties";

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConsoleApiError) return error;
    throw error;
  }
  throw new Error("expected a ConsoleApiError");
}

describe("property config", () => {
  test("status properties default to Not started / In progress / Done", () => {
    const errors: Record<string, string> = {};
    const config = buildPropertyConfig("status", undefined, null, "config", errors);
    expect(errors).toEqual({});
    expect(config.options?.map((option) => [option.name, option.group])).toEqual([
      ["Not started", "todo"],
      ["In progress", "in_progress"],
      ["Done", "done"],
    ]);
  });

  test("keys that do not apply to the type are field errors", () => {
    const errors: Record<string, string> = {};
    buildPropertyConfig("text", { options: [{ name: "A" }], precision: 2, includeTime: true }, null, "config", errors);
    expect(Object.keys(errors).sort()).toEqual(["config.includeTime", "config.options", "config.precision"]);
  });

  test("currency format defaults to USD; a currency without the format is rejected", () => {
    const errors: Record<string, string> = {};
    expect(buildPropertyConfig("number", { format: "currency", precision: 0 }, null, "config", errors)).toEqual({
      format: "currency",
      currency: "USD",
      precision: 0,
    });
    buildPropertyConfig("number", { currency: "EUR" }, null, "config", errors);
    expect(errors["config.currency"]).toBeString();
  });

  test("option ids are kept and missing options are archived", () => {
    const errors: Record<string, string> = {};
    const existing = { options: [{ id: "a", name: "A", color: "gray" as const }, { id: "b", name: "B", color: "blue" as const }] };
    const config = buildPropertyConfig("select", { options: [{ id: "a", name: "Alpha" }, { name: "C" }] }, existing, "config", errors);
    expect(errors).toEqual({});
    expect(config.options?.find((option) => option.id === "a")?.name).toBe("Alpha");
    expect(config.options?.find((option) => option.id === "b")?.archived).toBe(true);
    expect(config.options?.some((option) => option.name === "C" && option.id !== "a" && option.id !== "b")).toBe(true);
  });

  test("options re-sent by name keep their ids, also across an option type change", () => {
    const errors: Record<string, string> = {};
    const existing = { options: [{ id: "a", name: "A", color: "gray" as const }, { id: "b", name: "B", color: "blue" as const }] };
    const config = buildPropertyConfig("status", { options: [{ name: "A" }, { name: "B", group: "done" }] }, existing, "config", errors);
    expect(errors).toEqual({});
    expect(config.options).toEqual([
      { id: "a", name: "A", color: "gray", group: "todo" },
      { id: "b", name: "B", color: "blue", group: "done" },
    ]);
  });

  test("dates always store includeTime", () => {
    const errors: Record<string, string> = {};
    expect(buildPropertyConfig("date", undefined, null, "config", errors)).toEqual({ includeTime: false });
    expect(buildPropertyConfig("date", { includeTime: true }, null, "config", errors)).toEqual({ includeTime: true });
  });
});

describe("property definitions", () => {
  test("derive keys from names, avoiding taken and reserved keys", () => {
    const prepared = preparePropertyDefinitions(
      [
        { name: "Deal name", type: "text" },
        { name: "Deal name", type: "text" },
        { name: "Body", type: "text" },
        { key: "amount", name: "Valor", type: "number" },
      ],
      new Set(["deal_name"]),
      5,
      (index) => `properties.${index}.`,
    );
    expect(prepared.map((property) => property.key)).toEqual(["deal_name_2", "deal_name_3", "body_2", "amount"]);
    expect(prepared.map((property) => property.position)).toEqual([5, 6, 7, 8]);
  });

  test("reserved explicit keys are validation errors", () => {
    const error = errorOf(() => preparePropertyDefinitions([{ key: "row_id", name: "Row", type: "text" }], new Set(), 0, () => ""));
    expect(error.status).toBe(400);
    expect(error.payload.fieldErrors).toEqual({ key: '"row_id" is reserved.' });
  });

  test("taken explicit keys are key_taken", () => {
    const error = errorOf(() =>
      preparePropertyDefinitions(
        [
          { key: "stage", name: "Stage", type: "text" },
          { key: "stage", name: "Stage 2", type: "text" },
        ],
        new Set(),
        0,
        (index) => `properties.${index}.`,
      ),
    );
    expect(error.status).toBe(409);
    expect(error.payload.error).toBe("key_taken");
    expect(error.payload.fieldErrors).toEqual({ "properties.1.key": "This key is already used by another property." });
  });
});

describe("base slugs", () => {
  test("derive DNS-label slugs and avoid collisions and reserved words", () => {
    expect(deriveBaseSlug("Ação & Vendas", new Set())).toBe("acao-vendas");
    expect(deriveBaseSlug("My CRM", new Set(["my-crm"]))).toBe("my-crm-2");
    expect(deriveBaseSlug("123", new Set())).toBe("base-123");
    expect(deriveBaseSlug("", new Set(["base"]))).toBe("base-2");
    expect(deriveBaseSlug("admin", new Set())).toBe("base");
  });
});
