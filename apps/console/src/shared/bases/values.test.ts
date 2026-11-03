import { describe, expect, test } from "bun:test";

import type { BaseProperty, BasePropertyConfig, BasePropertyType, BaseSelectOption } from "./types";
import {
  BASE_AGENT_READONLY_ERROR,
  BASE_NUL_ERROR,
  baseAgentState,
  baseApprovalState,
  baseHasNul,
  basePropertyKeyFromName,
  baseValueToApi,
  convertBaseValue,
  defaultStatusOptions,
  describeBaseApproval,
  displayBaseValue,
  findBaseOption,
  normalizeBaseAgentOutput,
  normalizeBaseValueInput,
  normalizeSelectOptions,
} from "./values";

const USER_A = "8e0e034f-6cce-4f10-82da-3ebf2c8b49f4";
const USER_B = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

function prop(type: BasePropertyType, config: BasePropertyConfig = {}, key: string = type): BaseProperty {
  return {
    id: `00000000-0000-4000-8000-${String(key.length).padStart(12, "0")}`,
    key,
    name: key,
    description: null,
    type,
    config,
    position: 0,
    required: false,
    deletedAt: null,
  };
}

const selectOptions: BaseSelectOption[] = [
  { id: "opt00001", name: "Lead", color: "gray" },
  { id: "opt00002", name: "Qualified", color: "blue" },
  { id: "opt00003", name: "Old", color: "red", archived: true },
];
const statusOptions: BaseSelectOption[] = [
  { id: "st000001", name: "Not started", color: "gray", group: "todo" },
  { id: "st000002", name: "Doing", color: "blue", group: "in_progress" },
  { id: "st000003", name: "Done", color: "green", group: "done" },
  { id: "st000004", name: "Qualified", color: "green", group: "done" },
];

const ok = (value: unknown) => ({ ok: true as const, value });
const normalize = (property: BaseProperty, input: unknown, timezone?: string) =>
  normalizeBaseValueInput(property, input, timezone ? { timezone } : {});

describe("normalizeBaseValueInput", () => {
  test("null and undefined are absent for every type", () => {
    for (const type of ["text", "number", "checkbox", "date", "select", "multi_select", "status", "url", "email", "phone", "person", "ref"] as const) {
      expect(normalize(prop(type), null)).toEqual(ok(undefined));
      expect(normalize(prop(type), undefined)).toEqual(ok(undefined));
    }
  });

  test("text", () => {
    const text = prop("text");
    expect(normalize(text, "hello")).toEqual(ok("hello"));
    expect(normalize(text, "")).toEqual(ok(undefined));
    expect(normalize(text, 12)).toEqual(ok("12"));
    expect(normalize(text, {}).ok).toBe(false);
    expect(normalize(text, "a".repeat(16 * 1024)).ok).toBe(true);
    expect(normalize(text, "a".repeat(16 * 1024 + 1)).ok).toBe(false);
    // 3-byte characters count as 3 bytes.
    expect(normalize(text, "€".repeat(5462)).ok).toBe(false);
    expect(normalize(text, "€".repeat(5461)).ok).toBe(true);
  });

  test("NUL characters are rejected for every string-bearing type", () => {
    const nul = "a\u0000b";
    for (const property of [prop("text"), prop("url"), prop("email"), prop("phone"), prop("person"), prop("ref")]) {
      const input = property.type === "ref" ? [{ type: "artifact", id: nul }] : property.type === "url" ? `https://x.test/${nul}` : nul;
      expect(normalizeBaseValueInput(property, input)).toEqual({ ok: false, error: BASE_NUL_ERROR });
    }
    expect(baseHasNul({ a: [{ b: nul }] })).toBe(true);
    expect(baseHasNul({ a: ["ok"] })).toBe(false);
    const options = normalizeSelectOptions("select", [], [{ name: nul }]);
    expect(options).toEqual({ ok: false, error: BASE_NUL_ERROR });
  });

  test("number accepts finite numbers and clean numeric strings", () => {
    const number = prop("number");
    expect(normalize(number, 42.5)).toEqual(ok(42.5));
    expect(normalize(number, -0)).toEqual(ok(0));
    expect(normalize(number, " 1e3 ")).toEqual(ok(1000));
    expect(normalize(number, "-12.50")).toEqual(ok(-12.5));
    expect(normalize(number, ".5")).toEqual(ok(0.5));
    expect(normalize(number, "")).toEqual(ok(undefined));
    for (const bad of ["12abc", "1,000", "0x10", "Infinity", "NaN", "1e999", Number.NaN, Number.POSITIVE_INFINITY, true, [1]]) {
      expect(normalize(number, bad).ok).toBe(false);
    }
  });

  test("checkbox stores true or nothing", () => {
    const checkbox = prop("checkbox");
    expect(normalize(checkbox, true)).toEqual(ok(true));
    expect(normalize(checkbox, false)).toEqual(ok(undefined));
    expect(normalize(checkbox, "TRUE")).toEqual(ok(true));
    expect(normalize(checkbox, "false")).toEqual(ok(undefined));
    expect(normalize(checkbox, "yes").ok).toBe(false);
    expect(normalize(checkbox, 1).ok).toBe(false);
  });

  test("date-only properties", () => {
    const date = prop("date");
    expect(normalize(date, "2026-10-06")).toEqual(ok({ start: "2026-10-06", end: null }));
    expect(normalize(date, { start: "2026-10-06", end: "2026-10-08" })).toEqual(ok({ start: "2026-10-06", end: "2026-10-08" }));
    expect(normalize(date, { start: "2026-10-06" })).toEqual(ok({ start: "2026-10-06", end: null }));
    expect(normalize(date, "2026-10-06/2026-10-08")).toEqual(ok({ start: "2026-10-06", end: "2026-10-08" }));
    expect(normalize(date, "")).toEqual(ok(undefined));
    expect(normalize(date, { start: "2026-10-08", end: "2026-10-06" }).ok).toBe(false);
    expect(normalize(date, "2026-02-30").ok).toBe(false);
    expect(normalize(date, "2026-10-06T10:00:00Z").ok).toBe(false);
    expect(normalize(date, { start: "2026-10-06", extra: 1 }).ok).toBe(false);
    expect(normalize(date, 20261006).ok).toBe(false);
  });

  test("date-time properties normalize instants and convert date-only input", () => {
    const dateTime = prop("date", { includeTime: true });
    expect(normalize(dateTime, "2026-10-06T16:51:00-03:00")).toEqual(ok({ start: "2026-10-06T19:51:00.000Z", end: null }));
    expect(normalize(dateTime, "2026-10-06T19:51Z")).toEqual(ok({ start: "2026-10-06T19:51:00.000Z", end: null }));
    expect(normalize(dateTime, "2026-10-06T19:51:00.123Z")).toEqual(ok({ start: "2026-10-06T19:51:00.123Z", end: null }));
    expect(normalize(dateTime, "2026-10-06")).toEqual(ok({ start: "2026-10-06T00:00:00.000Z", end: null }));
    expect(normalize(dateTime, "2026-10-06", "America/Sao_Paulo")).toEqual(ok({ start: "2026-10-06T03:00:00.000Z", end: null }));
    expect(normalize(dateTime, { start: "2026-10-06T10:00:00Z", end: "2026-10-06T09:00:00Z" }).ok).toBe(false);
    expect(normalize(dateTime, "2026-10-06T19:51:00").ok).toBe(false);
    expect(normalize(dateTime, "2026-10-06T25:00:00Z").ok).toBe(false);
    expect(normalize(dateTime, "2026-10-06", "+03:00").ok).toBe(false);
  });

  test("select and status resolve ids and names", () => {
    const select = prop("select", { options: selectOptions });
    expect(normalize(select, "opt00002")).toEqual(ok("opt00002"));
    expect(normalize(select, "qualified")).toEqual(ok("opt00002"));
    expect(normalize(select, " Lead ")).toEqual(ok("opt00001"));
    expect(normalize(select, "")).toEqual(ok(undefined));
    expect(normalize(select, "opt00003")).toEqual({ ok: false, error: 'Option "Old" is archived.' });
    expect(normalize(select, "Old").ok).toBe(false);
    expect(normalize(select, "Nope").ok).toBe(false);
    expect(normalize(select, 1).ok).toBe(false);
    const status = prop("status", { options: statusOptions });
    expect(normalize(status, "done")).toEqual(ok("st000003"));
  });

  test("multi_select dedupes and limits", () => {
    const multi = prop("multi_select", { options: selectOptions });
    expect(normalize(multi, ["Lead", "opt00001", "QUALIFIED"])).toEqual(ok(["opt00001", "opt00002"]));
    expect(normalize(multi, "Lead")).toEqual(ok(["opt00001"]));
    expect(normalize(multi, [])).toEqual(ok(undefined));
    expect(normalize(multi, ["Lead", "Old"]).ok).toBe(false);
    expect(normalize(multi, ["Lead", "Nope"]).ok).toBe(false);
    const many = Array.from({ length: 101 }, (_, i): BaseSelectOption => ({ id: `id${i}`, name: `n${i}`, color: "gray" }));
    const big = prop("multi_select", { options: many });
    expect(normalize(big, many.slice(0, 100).map((o) => o.id)).ok).toBe(true);
    expect(normalize(big, many.map((o) => o.id)).ok).toBe(false);
  });

  test("person accepts uuids only", () => {
    const person = prop("person");
    expect(normalize(person, USER_A)).toEqual(ok([USER_A]));
    expect(normalize(person, [USER_A, USER_A.toUpperCase(), USER_B])).toEqual(ok([USER_A, USER_B]));
    expect(normalize(person, [])).toEqual(ok(undefined));
    expect(normalize(person, ["luis"]).ok).toBe(false);
    expect(normalize(person, [1]).ok).toBe(false);
    const ids = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(normalize(person, ids.slice(0, 50)).ok).toBe(true);
    expect(normalize(person, ids).ok).toBe(false);
  });

  test("ref", () => {
    const ref = prop("ref");
    expect(normalize(ref, { type: "artifact", id: "art_1" })).toEqual(ok([{ type: "artifact", id: "art_1" }]));
    expect(normalize(ref, [{ type: "work.item", id: "1" }, { type: "work.item", id: "1" }])).toEqual(ok([{ type: "work.item", id: "1" }]));
    expect(normalize(ref, [])).toEqual(ok(undefined));
    expect(normalize(ref, { type: "Bad", id: "1" }).ok).toBe(false);
    expect(normalize(ref, { type: "a", id: "" }).ok).toBe(false);
    expect(normalize(ref, { type: "a", id: "x".repeat(201) }).ok).toBe(false);
    expect(normalize(ref, { type: "a", id: "1", extra: true }).ok).toBe(false);
    expect(normalize(ref, "a:1").ok).toBe(false);
  });

  test("url, email, phone", () => {
    expect(normalize(prop("url"), " https://ravi.bot/x ")).toEqual(ok("https://ravi.bot/x"));
    expect(normalize(prop("url"), "javascript:alert(1)").ok).toBe(false);
    expect(normalize(prop("url"), "ftp://example.com").ok).toBe(false);
    expect(normalize(prop("url"), "not a url").ok).toBe(false);
    expect(normalize(prop("url"), `https://x.com/${"a".repeat(2040)}`).ok).toBe(false);
    expect(normalize(prop("email"), " Luis@Example.COM ")).toEqual(ok("luis@example.com"));
    expect(normalize(prop("email"), "luis@localhost").ok).toBe(false);
    expect(normalize(prop("email"), "a b@c.com").ok).toBe(false);
    expect(normalize(prop("email"), `${"a".repeat(320)}@x.com`).ok).toBe(false);
    expect(normalize(prop("phone"), "+55 (11) 99999-9999")).toEqual(ok("+55 (11) 99999-9999"));
    expect(normalize(prop("phone"), "call me").ok).toBe(false);
  });
});

describe("baseValueToApi", () => {
  test("checkbox absent is false", () => {
    expect(baseValueToApi(prop("checkbox"), undefined)).toBe(false);
    expect(baseValueToApi(prop("checkbox"), true)).toBe(true);
    expect(baseValueToApi(prop("text"), undefined)).toBeUndefined();
    expect(baseValueToApi(prop("text"), "x")).toBe("x");
  });
});

describe("displayBaseValue", () => {
  test("renders every type", () => {
    expect(displayBaseValue(prop("text"), "hi")).toBe("hi");
    expect(displayBaseValue(prop("text"), undefined)).toBe("");
    expect(displayBaseValue(prop("number"), 12.5)).toBe("12.5");
    expect(displayBaseValue(prop("number", { format: "percent" }), 0.125)).toBe("12.5%");
    expect(displayBaseValue(prop("number", { format: "currency", currency: "BRL" }), 10)).toBe("BRL 10.00");
    expect(displayBaseValue(prop("number", { precision: 1 }), 2)).toBe("2.0");
    expect(displayBaseValue(prop("checkbox"), true)).toBe("true");
    expect(displayBaseValue(prop("checkbox"), false)).toBe("false");
    expect(displayBaseValue(prop("date"), { start: "2026-10-06", end: null })).toBe("2026-10-06");
    expect(displayBaseValue(prop("date"), { start: "2026-10-06", end: "2026-10-07" })).toBe("2026-10-06/2026-10-07");
    expect(displayBaseValue(prop("select", { options: selectOptions }), "opt00002")).toBe("Qualified");
    expect(displayBaseValue(prop("multi_select", { options: selectOptions }), ["opt00001", "opt00002"])).toBe("Lead, Qualified");
    expect(displayBaseValue(prop("person"), [USER_A, USER_B], { [USER_A]: { displayName: "Luis" } })).toBe(`Luis, ${USER_B}`);
    expect(displayBaseValue(prop("ref"), [{ type: "artifact", id: "1" }])).toBe("artifact:1");
  });
});

describe("convertBaseValue", () => {
  const tz = { timezone: "America/Sao_Paulo" };
  const select = prop("select", { options: selectOptions });
  const multi = prop("multi_select", { options: selectOptions });
  const status = prop("status", { options: statusOptions });

  test("absent stays absent", () => {
    expect(convertBaseValue(prop("text"), prop("number"), undefined, tz)).toEqual({ value: undefined, cleared: false });
  });

  test("text <-> number", () => {
    expect(convertBaseValue(prop("text"), prop("number"), " 42 ", tz)).toEqual({ value: 42, cleared: false });
    expect(convertBaseValue(prop("text"), prop("number"), "abc", tz)).toEqual({ value: undefined, cleared: true });
    expect(convertBaseValue(prop("number"), prop("text"), 0.1, tz)).toEqual({ value: "0.1", cleared: false });
    expect(convertBaseValue(prop("number", { format: "percent" }), prop("text"), 0.5, tz)).toEqual({ value: "0.5", cleared: false });
  });

  test("option types", () => {
    expect(convertBaseValue(select, multi, "opt00002", tz)).toEqual({ value: ["opt00002"], cleared: false });
    expect(convertBaseValue(multi, select, ["opt00002", "opt00001"], tz)).toEqual({ value: "opt00002", cleared: false, truncated: true });
    expect(convertBaseValue(select, status, "opt00002", tz)).toEqual({ value: "st000004", cleared: false });
    expect(convertBaseValue(select, status, "opt00001", tz)).toEqual({ value: undefined, cleared: true });
    expect(convertBaseValue(prop("text"), select, "qualified", tz)).toEqual({ value: "opt00002", cleared: false });
    expect(convertBaseValue(prop("text"), select, "Old", tz)).toEqual({ value: undefined, cleared: true });
    expect(convertBaseValue(prop("text"), multi, "Lead, nope, Qualified", tz)).toEqual({
      value: ["opt00001", "opt00002"],
      cleared: false,
      truncated: true,
    });
    expect(convertBaseValue(select, prop("text"), "opt00002", tz)).toEqual({ value: "Qualified", cleared: false });
  });

  test("a conversion that keeps fewer values than the source is truncated", () => {
    // multi_select -> select keeps the first option; one option is not a loss.
    expect(convertBaseValue(multi, select, ["opt00002"], tz)).toEqual({ value: "opt00002", cleared: false });
    expect(convertBaseValue(multi, select, ["opt00001", "opt00002"], tz)).toEqual({ value: "opt00001", cleared: false, truncated: true });
    // "Lead" has no status option: it is dropped and "Qualified" is kept.
    expect(convertBaseValue(multi, status, ["opt00001", "opt00002"], tz)).toEqual({ value: "st000004", cleared: false, truncated: true });
    expect(convertBaseValue(select, multi, "opt00001", tz)).toEqual({ value: ["opt00001"], cleared: false });
    expect(convertBaseValue(prop("text"), multi, "Lead, Qualified, lead", tz)).toEqual({ value: ["opt00001", "opt00002"], cleared: false });
    expect(convertBaseValue(multi, prop("text"), ["opt00001", "opt00002"], tz)).toEqual({ value: "Lead, Qualified", cleared: false });
  });

  test("includeTime toggles use the base timezone", () => {
    const dateOnly = prop("date");
    const dateTime = prop("date", { includeTime: true });
    expect(convertBaseValue(dateOnly, dateTime, { start: "2026-10-06", end: "2026-10-07" }, tz)).toEqual({
      value: { start: "2026-10-06T03:00:00.000Z", end: "2026-10-07T03:00:00.000Z" },
      cleared: false,
    });
    expect(convertBaseValue(dateTime, dateOnly, { start: "2026-10-06T02:00:00.000Z", end: null }, tz)).toEqual({
      value: { start: "2026-10-05", end: null },
      cleared: false,
    });
    expect(convertBaseValue(dateOnly, prop("text"), { start: "2026-10-06", end: null }, tz)).toEqual({ value: "2026-10-06", cleared: false });
    expect(convertBaseValue(prop("text"), dateOnly, "2026-10-06", tz)).toEqual({ value: { start: "2026-10-06", end: null }, cleared: false });
    expect(convertBaseValue(prop("text"), dateOnly, "tomorrow", tz)).toEqual({ value: undefined, cleared: true });
  });

  test("url, email, phone, and text", () => {
    expect(convertBaseValue(prop("text"), prop("url"), "https://ravi.bot", tz)).toEqual({ value: "https://ravi.bot", cleared: false });
    expect(convertBaseValue(prop("text"), prop("url"), "ravi", tz)).toEqual({ value: undefined, cleared: true });
    expect(convertBaseValue(prop("text"), prop("email"), "A@B.CO", tz)).toEqual({ value: "a@b.co", cleared: false });
    expect(convertBaseValue(prop("email"), prop("text"), "a@b.co", tz)).toEqual({ value: "a@b.co", cleared: false });
    expect(convertBaseValue(prop("phone"), prop("text"), "+55 11", tz)).toEqual({ value: "+55 11", cleared: false });
    expect(convertBaseValue(prop("checkbox"), prop("text"), true, tz)).toEqual({ value: "true", cleared: false });
    expect(convertBaseValue(prop("person"), prop("text"), [USER_A], tz)).toEqual({ value: USER_A, cleared: false });
    expect(convertBaseValue(prop("number"), prop("checkbox"), 1, tz)).toEqual({ value: undefined, cleared: true });
    expect(convertBaseValue(prop("ref"), prop("person"), [{ type: "a", id: "1" }], tz)).toEqual({ value: undefined, cleared: true });
  });
});

describe("normalizeSelectOptions", () => {
  test("keeps ids, assigns new ids and colors, archives missing options", () => {
    const existing: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "One", color: "red" },
      { id: "bbbbbbbb", name: "Two", color: "blue" },
    ];
    const result = normalizeSelectOptions("select", existing, [{ id: "bbbbbbbb", name: "Deux" }, { name: "Three" }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options[0]).toEqual({ id: "bbbbbbbb", name: "Deux", color: "blue" });
    expect(result.options[1]?.name).toBe("Three");
    expect(result.options[1]?.id).toMatch(/^[0-9a-z]{8}$/);
    expect(result.options[1]?.color).toBe("brown");
    expect(result.options[2]).toEqual({ id: "aaaaaaaa", name: "One", color: "red", archived: true });
  });

  test("status options require a group", () => {
    const result = normalizeSelectOptions("status", [], [{ name: "A" }, { name: "B", group: "done" }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options.map((o) => o.group)).toEqual(["todo", "done"]);
    const select = normalizeSelectOptions("select", [], [{ name: "A", group: "done" }]);
    if (!select.ok) throw new Error(select.error);
    expect(select.options[0]?.group).toBeUndefined();
  });

  test("rejects duplicates, unknown ids, and too many options", () => {
    expect(normalizeSelectOptions("select", [], [{ name: "A" }, { name: " a " }]).ok).toBe(false);
    expect(normalizeSelectOptions("select", [], [{ id: "nope0000", name: "A" }]).ok).toBe(false);
    const existing: BaseSelectOption[] = [{ id: "aaaaaaaa", name: "A", color: "red" }];
    expect(normalizeSelectOptions("select", existing, [{ id: "aaaaaaaa", name: "A" }, { id: "aaaaaaaa", name: "B" }]).ok).toBe(false);
    expect(normalizeSelectOptions("select", [], Array.from({ length: 201 }, (_, i) => ({ name: `o${i}` }))).ok).toBe(false);
    expect(normalizeSelectOptions("select", [], Array.from({ length: 200 }, (_, i) => ({ name: `o${i}` }))).ok).toBe(true);
  });

  test("an archived option may share a name with an active one", () => {
    const existing: BaseSelectOption[] = [{ id: "aaaaaaaa", name: "A", color: "red" }];
    const result = normalizeSelectOptions("select", existing, [{ id: "aaaaaaaa", name: "A", archived: true }, { name: "A" }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options[0]).toEqual({ id: "aaaaaaaa", name: "A", color: "red", archived: true });
    expect(result.options[1]?.name).toBe("A");
    expect(result.options[1]?.id).not.toBe("aaaaaaaa");
    expect(result.options[1]?.archived).toBeUndefined();
  });

  test("re-listing the same names keeps ids and archives nothing", () => {
    const existing: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "Backlog", color: "gray" },
      { id: "bbbbbbbb", name: "Doing", color: "blue" },
      { id: "cccccccc", name: "Done", color: "green" },
    ];
    const result = normalizeSelectOptions("select", existing, [{ name: "Backlog" }, { name: "Doing" }, { name: "Done" }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options).toEqual(existing);
  });

  test("name matching uses the findBaseOption key: trim, NFC, case-insensitive", () => {
    const existing: BaseSelectOption[] = [{ id: "aaaaaaaa", name: "Café", color: "red" }];
    const decomposed = "  CAFÉ ";
    expect(findBaseOption(existing, decomposed)?.id).toBe("aaaaaaaa");
    const result = normalizeSelectOptions("select", existing, [{ name: decomposed }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options).toEqual([{ id: "aaaaaaaa", name: "CAFÉ", color: "red" }]);
    // Accents are not folded, as in findBaseOption: "Cafe" is another option.
    const other = normalizeSelectOptions("select", existing, [{ name: "Cafe" }]);
    if (!other.ok) throw new Error(other.error);
    expect(other.options.map((o) => [o.name, o.id === "aaaaaaaa", o.archived === true])).toEqual([
      ["Cafe", false, false],
      ["Café", true, true],
    ]);
  });

  test("an archived option comes back by name with its id, color, and group", () => {
    const existing: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "Shipped", color: "green", group: "done", archived: true },
      { id: "bbbbbbbb", name: "Doing", color: "blue", group: "in_progress" },
    ];
    const revived = normalizeSelectOptions("status", existing, [{ name: "Doing" }, { name: "shipped" }]);
    if (!revived.ok) throw new Error(revived.error);
    expect(revived.options).toEqual([
      { id: "bbbbbbbb", name: "Doing", color: "blue", group: "in_progress" },
      { id: "aaaaaaaa", name: "shipped", color: "green", group: "done" },
    ]);
    const stillArchived = normalizeSelectOptions("status", existing, [{ name: "Doing" }, { name: "Shipped", archived: true }]);
    if (!stillArchived.ok) throw new Error(stillArchived.error);
    expect(stillArchived.options[1]).toEqual({ id: "aaaaaaaa", name: "Shipped", color: "green", group: "done", archived: true });
  });

  test("an active option wins over an archived one with the same name; ties go to config order", () => {
    const legacy: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "A", color: "red", archived: true },
      { id: "bbbbbbbb", name: "a", color: "blue" },
    ];
    const result = normalizeSelectOptions("select", legacy, [{ name: "A" }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options).toEqual([
      { id: "bbbbbbbb", name: "A", color: "blue" },
      { id: "aaaaaaaa", name: "A", color: "red", archived: true },
    ]);
    const bothArchived: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "A", color: "red", archived: true },
      { id: "bbbbbbbb", name: "a", color: "blue", archived: true },
    ];
    const tie = normalizeSelectOptions("select", bothArchived, [{ name: "a" }]);
    if (!tie.ok) throw new Error(tie.error);
    expect(tie.options).toEqual([
      { id: "aaaaaaaa", name: "a", color: "red" },
      { id: "bbbbbbbb", name: "a", color: "blue", archived: true },
    ]);
  });

  test("an id-less item claims a same-name option in the state it asks for, whatever the item order", () => {
    const legacy: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "A", color: "red", archived: true },
      { id: "bbbbbbbb", name: "A", color: "blue" },
    ];
    const asStored = normalizeSelectOptions("select", legacy, [
      { name: "A", color: "red", archived: true },
      { name: "A", color: "blue" },
    ]);
    const reversed = normalizeSelectOptions("select", legacy, [
      { name: "A", color: "blue" },
      { name: "A", color: "red", archived: true },
    ]);
    if (!asStored.ok) throw new Error(asStored.error);
    if (!reversed.ok) throw new Error(reversed.error);
    const byId = (options: BaseSelectOption[]) => [...options].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(asStored.options)).toEqual(legacy);
    expect(byId(reversed.options)).toEqual(legacy);

    const oneArchived: BaseSelectOption[] = [{ id: "aaaaaaaa", name: "A", color: "red", archived: true }];
    for (const input of [
      [{ name: "A" }, { name: "A", archived: true }],
      [{ name: "A", archived: true }, { name: "A" }],
    ]) {
      const result = normalizeSelectOptions("select", oneArchived, input);
      if (!result.ok) throw new Error(result.error);
      expect(result.options.find((option) => option.id === "aaaaaaaa")?.archived).toBe(true);
      expect(result.options.filter((option) => !option.archived)).toHaveLength(1);
    }
  });

  test("a rename by id frees the old name for a new option, in either input order", () => {
    const existing: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "A", color: "red" },
      { id: "cccccccc", name: "C", color: "green" },
    ];
    for (const input of [
      [{ id: "aaaaaaaa", name: "B" }, { name: "A" }, { name: "C" }],
      [{ name: "A" }, { id: "aaaaaaaa", name: "B" }, { name: "C" }],
    ]) {
      const result = normalizeSelectOptions("select", existing, input);
      if (!result.ok) throw new Error(result.error);
      const byName = new Map(result.options.map((o) => [o.name, o]));
      expect(byName.get("B")).toEqual({ id: "aaaaaaaa", name: "B", color: "red" });
      expect(byName.get("A")?.id).not.toBe("aaaaaaaa");
      expect(byName.get("A")?.id).not.toBe("cccccccc");
      expect(byName.get("C")).toEqual({ id: "cccccccc", name: "C", color: "green" });
      expect(result.options).toHaveLength(3);
    }
  });

  test("two id-less inputs with the same name cannot claim one option", () => {
    const existing: BaseSelectOption[] = [{ id: "aaaaaaaa", name: "A", color: "red" }];
    const twice = normalizeSelectOptions("select", existing, [{ name: "A" }, { name: " a " }]);
    expect(twice.ok ? null : twice.error).toBe('Option names must be unique: "a".');
    const result = normalizeSelectOptions("select", existing, [{ name: "A" }, { name: "A", archived: true }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options[0]).toEqual({ id: "aaaaaaaa", name: "A", color: "red" });
    expect(result.options[1]?.archived).toBe(true);
    expect(result.options[1]?.id).not.toBe("aaaaaaaa");
    expect(result.options).toHaveLength(2);
  });

  test("an option referenced by id is never claimed by name", () => {
    const existing: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "A", color: "red" },
      { id: "bbbbbbbb", name: "A", color: "blue", archived: true },
    ];
    const result = normalizeSelectOptions("select", existing, [{ name: "A" }, { id: "aaaaaaaa", name: "A", archived: true }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options).toEqual([
      { id: "bbbbbbbb", name: "A", color: "blue" },
      { id: "aaaaaaaa", name: "A", color: "red", archived: true },
    ]);
    const clash = normalizeSelectOptions("select", existing.slice(0, 1), [{ id: "aaaaaaaa", name: "A" }, { name: "A" }]);
    expect(clash.ok ? null : clash.error).toBe('Option names must be unique: "A".');
  });

  test("a status option matched by name keeps its group unless one is given", () => {
    const existing: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "Doing", color: "blue", group: "in_progress" },
      { id: "bbbbbbbb", name: "Done", color: "green", group: "done" },
    ];
    const result = normalizeSelectOptions("status", existing, [{ name: "Doing" }, { name: "Done", color: "purple" }, { name: "New" }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options.slice(0, 2)).toEqual([
      { id: "aaaaaaaa", name: "Doing", color: "blue", group: "in_progress" },
      { id: "bbbbbbbb", name: "Done", color: "purple", group: "done" },
    ]);
    expect(result.options[2]?.group).toBe("todo");
    const regrouped = normalizeSelectOptions("status", existing, [{ name: "Doing", group: "todo" }, { name: "Done" }]);
    if (!regrouped.ok) throw new Error(regrouped.error);
    expect(regrouped.options[0]).toEqual({ id: "aaaaaaaa", name: "Doing", color: "blue", group: "todo" });
  });

  test("existing options left out of a by-name list are archived after the listed ones", () => {
    const existing: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "A", color: "red" },
      { id: "bbbbbbbb", name: "B", color: "blue" },
      { id: "cccccccc", name: "C", color: "green" },
    ];
    const result = normalizeSelectOptions("select", existing, [{ name: "C" }, { name: "A" }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.options).toEqual([
      { id: "cccccccc", name: "C", color: "green" },
      { id: "aaaaaaaa", name: "A", color: "red" },
      { id: "bbbbbbbb", name: "B", color: "blue", archived: true },
    ]);
  });

  test("archived flag is preserved unless the input says otherwise", () => {
    const existing: BaseSelectOption[] = [{ id: "aaaaaaaa", name: "A", color: "red", archived: true }];
    const kept = normalizeSelectOptions("select", existing, [{ id: "aaaaaaaa", name: "A" }]);
    expect(kept.ok && kept.options[0]?.archived).toBe(true);
    const restored = normalizeSelectOptions("select", existing, [{ id: "aaaaaaaa", name: "A", archived: false }]);
    expect(restored.ok && restored.options[0]?.archived).toBeUndefined();
  });

  test("defaultStatusOptions", () => {
    const options = defaultStatusOptions();
    expect(options.map((o) => [o.name, o.group, o.color])).toEqual([
      ["Not started", "todo", "gray"],
      ["In progress", "in_progress", "blue"],
      ["Done", "done", "green"],
    ]);
    expect(new Set(options.map((o) => o.id)).size).toBe(3);
  });
});

describe("findBaseOption", () => {
  test("id first, then name preferring active options", () => {
    const options: BaseSelectOption[] = [
      { id: "aaaaaaaa", name: "Same", color: "red", archived: true },
      { id: "bbbbbbbb", name: "same", color: "blue" },
    ];
    expect(findBaseOption(options, "aaaaaaaa")?.id).toBe("aaaaaaaa");
    expect(findBaseOption(options, "SAME")?.id).toBe("bbbbbbbb");
    expect(findBaseOption(options, "none")).toBeNull();
  });
});

describe("basePropertyKeyFromName", () => {
  test("transliterates and slugs", () => {
    expect(basePropertyKeyFromName("Situação do Negócio", new Set())).toBe("situacao_do_negocio");
    expect(basePropertyKeyFromName("Preço (R$)", new Set())).toBe("preco_r");
    expect(basePropertyKeyFromName("Straße", new Set())).toBe("strasse");
    expect(basePropertyKeyFromName("2025 revenue", new Set())).toBe("p_2025_revenue");
    expect(basePropertyKeyFromName("!!!", new Set())).toBe("property");
    expect(basePropertyKeyFromName("x".repeat(100), new Set())).toHaveLength(63);
  });

  test("avoids reserved and taken keys", () => {
    expect(basePropertyKeyFromName("ID", new Set())).toBe("id_2");
    expect(basePropertyKeyFromName("Body", new Set())).toBe("body_2");
    expect(basePropertyKeyFromName("Name", new Set(["name", "name_2"]))).toBe("name_3");
    const long = "y".repeat(63);
    const key = basePropertyKeyFromName(long, new Set([long]));
    expect(key).toHaveLength(63);
    expect(key.endsWith("_2")).toBe(true);
  });
});

describe("approval values", () => {
  const approval = prop("approval", { approvers: [{ kind: "project_role", minRole: "project_admin" }] });

  test("inputs are pending, { state, note? } or null; who and when never come from the client", () => {
    expect(normalizeBaseValueInput(approval, "pending")).toEqual({ ok: true, value: { state: "pending", note: null } });
    expect(normalizeBaseValueInput(approval, { state: "approved", note: "  ok  " })).toEqual({ ok: true, value: { state: "approved", note: "ok" } });
    expect(normalizeBaseValueInput(approval, { state: "rejected" })).toEqual({ ok: true, value: { state: "rejected", note: null } });
    expect(normalizeBaseValueInput(approval, null)).toEqual({ ok: true, value: undefined });
    for (const bad of ["approved", { state: "done" }, { state: "approved", decidedBy: USER_A }, { state: "approved", note: 3 }, { state: "approved", note: "x".repeat(1001) }, [], 1]) {
      expect(normalizeBaseValueInput(approval, bad).ok).toBe(false);
    }
  });

  test("states, labels, and the description with who decided", () => {
    const stored = { state: "approved" as const, requestedBy: USER_B, requestedAt: "2026-10-01T00:00:00.000Z", decidedBy: USER_A, decidedAt: "2026-10-02T00:00:00.000Z", note: "ok" };
    expect(baseApprovalState(stored)).toBe("approved");
    expect(baseApprovalState({ state: "maybe" })).toBeNull();
    expect(displayBaseValue(approval, stored)).toBe("Aprovado");
    expect(displayBaseValue(approval, { ...stored, state: "pending" })).toBe("Pendente");
    expect(describeBaseApproval(stored, { [USER_A]: { displayName: "Ana" } })).toBe("Aprovado (Ana)");
    expect(describeBaseApproval({ ...stored, state: "rejected" })).toBe(`Recusado (${USER_A})`);
    expect(describeBaseApproval(null)).toBe("");
  });
});

describe("agent values", () => {
  const text = prop("agent", { instructions: "Resuma", inputs: ["x"], output: "text" });
  const check = prop("agent", { instructions: "Classifique", inputs: ["x"], output: "checkbox" });
  const pick = prop("agent", { instructions: "Classifique", inputs: ["x"], output: "select", options: selectOptions });

  test("are never written as row values", () => {
    for (const input of ["anything", { state: "done", value: "x" }]) {
      expect(normalizeBaseValueInput(text, input)).toEqual({ ok: false, error: BASE_AGENT_READONLY_ERROR });
    }
  });

  test("fills are validated as the output type; empty is null and checkbox keeps false", () => {
    expect(normalizeBaseAgentOutput(text, "resumo")).toEqual({ ok: true, value: "resumo" });
    expect(normalizeBaseAgentOutput(text, "")).toEqual({ ok: true, value: null });
    expect(normalizeBaseAgentOutput(text, null)).toEqual({ ok: true, value: null });
    expect(normalizeBaseAgentOutput(check, false)).toEqual({ ok: true, value: false });
    expect(normalizeBaseAgentOutput(check, true)).toEqual({ ok: true, value: true });
    expect(normalizeBaseAgentOutput(pick, "Qualified")).toEqual({ ok: true, value: "opt00002" });
    expect(normalizeBaseAgentOutput(pick, "Nope").ok).toBe(false);
    expect(normalizeBaseAgentOutput(prop("agent", { output: "number" }), "abc").ok).toBe(false);
  });

  test("display reads the inner value; states parse", () => {
    const stored = { state: "done", value: "opt00002", error: null, inputsHash: "0123456789abcdef", updatedAt: "2026-10-02T00:00:00.000Z" };
    expect(baseAgentState(stored)).toBe("done");
    expect(baseAgentState({ state: "approved" })).toBeNull();
    expect(displayBaseValue(pick, stored)).toBe("Qualified");
    expect(displayBaseValue(pick, { ...stored, state: "pending", value: null })).toBe("");
  });
});
