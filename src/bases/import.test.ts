import { describe, expect, it } from "bun:test";
import { neutralizeCsvFormula, parseCsv, restoreCsvFormula, toCsv } from "./csv.js";
import { descriptorsFromProperties, rowsToCsv } from "./format.js";
import {
  batchImportRecords,
  coerceCsvCell,
  importBatchKey,
  importIdempotencyPrefix,
  parseColumnMap,
  planCsvImport,
} from "./import.js";
import {
  buildRowValues,
  parseAggregateOption,
  parseGroupByOption,
  parseOptionsShorthand,
  parseSetAssignments,
  parseSortOption,
  requireConcurrencyChoice,
} from "./input.js";
import type { BaseProperty } from "./schemas.js";

describe("CSV codec", () => {
  it("parses quotes, escaped quotes, CRLF, embedded newlines, and a BOM", () => {
    const text = '﻿name,notes\r\n"Acme, Inc.","line 1\nline ""2"""\r\nBeta,\r\n';
    expect(parseCsv(text)).toEqual([
      ["name", "notes"],
      ["Acme, Inc.", 'line 1\nline "2"'],
      ["Beta", ""],
    ]);
    expect(() => parseCsv('a\n"open')).toThrow("unterminated");
  });

  it("round-trips through toCsv", () => {
    const rows = [
      ["a", "b"],
      ["x,y", " padded "],
      ['q"uote', "multi\nline"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("neutralizes spreadsheet formulas on export and restores them on import", () => {
    expect(neutralizeCsvFormula("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(neutralizeCsvFormula("-5 apples")).toBe("'-5 apples");
    expect(neutralizeCsvFormula("plain")).toBe("plain");
    expect(restoreCsvFormula("'=SUM(A1)")).toBe("=SUM(A1)");
    expect(restoreCsvFormula("'quoted")).toBe("'quoted");
  });

  it("exports option names, person ids, and neutralized free text", () => {
    const properties = [
      prop("title", "text"),
      prop("stage", "select", { options: [{ id: "opt_1", name: "Won", color: "green" }] }),
      prop("owner", "person"),
      prop("amount", "number"),
    ];
    const csv = rowsToCsv(
      ["title", "stage", "owner", "amount"],
      [{ rowId: "row_1", version: 3, values: { title: "=cmd", stage: "opt_1", owner: ["usr_1"], amount: -5 } }],
      descriptorsFromProperties(properties),
      { usr_1: { id: "usr_1", displayName: "Ana", avatarUrl: null } },
    );
    expect(parseCsv(csv)).toEqual([
      ["row_id", "version", "title", "stage", "owner", "amount"],
      ["row_1", "3", "'=cmd", "Won", "usr_1", "-5"],
    ]);
  });
});

describe("CSV export neutralization", () => {
  it("neutralizes every cell type except numbers and checkboxes", () => {
    const properties = [
      prop("phone", "phone"),
      prop("due", "date"),
      prop("link", "ref"),
      prop("n", "number"),
      prop("ok", "checkbox"),
    ];
    const csv = rowsToCsv(
      ["phone", "due", "link", "n", "ok", "extra"],
      [
        {
          rowId: "row_1",
          version: 1,
          values: {
            phone: "+5511999",
            due: { start: "-0001" },
            link: [{ type: "=x", id: "1" }],
            n: -5,
            ok: true,
            extra: "@cmd",
          },
        },
      ],
      descriptorsFromProperties(properties),
      {},
    );
    expect(parseCsv(csv)[1]).toEqual(["row_1", "1", "'+5511999", "'-0001", "'=x:1", "-5", "true", "'@cmd"]);
  });
});

describe("flag parsing", () => {
  it("merges --values with --set text and JSON assignments", () => {
    expect(parseSetAssignments(["title=Acme = Co", "amount:=1200", 'tags:=["a"]', "url=https://x.y/?a=b"])).toEqual({
      title: "Acme = Co",
      amount: 1200,
      tags: ["a"],
      url: "https://x.y/?a=b",
    });
    expect(buildRowValues('{"title":"A","stage":"lead"}', ["stage=won"])).toEqual({ title: "A", stage: "won" });
    expect(() => parseSetAssignments(["=x"])).toThrow();
    expect(() => parseSetAssignments(["n:=not-json"])).toThrow();
  });

  it("parses sort, group-by, aggregates, and options shorthand", () => {
    expect(parseSortOption("amount:desc, created_time")).toEqual([
      { prop: "amount", dir: "desc" },
      { prop: "created_time", dir: "asc" },
    ]);
    expect(() => parseSortOption("a,b,c,d")).toThrow("at most 3");
    expect(parseGroupByOption(["stage", "created_time:month"])).toEqual([
      { prop: "stage" },
      { prop: "created_time", timeUnit: "month" },
    ]);
    expect(() => parseGroupByOption(["a:fortnight"])).toThrow();
    expect(parseAggregateOption(undefined)).toEqual([{ op: "count", as: "count" }]);
    expect(parseAggregateOption(["count::deals", "sum:amount", "avg:amount:avg_deal"])).toEqual([
      { op: "count", as: "deals" },
      { op: "sum", prop: "amount", as: "sum_amount" },
      { op: "avg", prop: "amount", as: "avg_deal" },
    ]);
    expect(() => parseAggregateOption(["sum"])).toThrow("needs a key");
    expect(() => parseAggregateOption(["count", "count"])).toThrow("used twice");
    expect(parseOptionsShorthand("Todo:todo, Doing:in_progress, Maybe")).toEqual([
      { name: "Todo", group: "todo" },
      { name: "Doing", group: "in_progress" },
      { name: "Maybe" },
    ]);
  });

  it("requires exactly one concurrency choice for row writes", () => {
    expect(requireConcurrencyChoice("4", undefined)).toEqual({ expectedVersion: 4 });
    expect(requireConcurrencyChoice(undefined, true)).toEqual({ lastWriteWins: true });
    expect(() => requireConcurrencyChoice(undefined, undefined)).toThrow("--expected-version");
    expect(() => requireConcurrencyChoice("4", true)).toThrow("not both");
  });
});

describe("CSV import planning", () => {
  const properties = [
    prop("name", "text", {}, "Deal Name"),
    prop("amount", "number"),
    prop("won", "checkbox"),
    prop("tags", "multi_select"),
    prop("due", "date"),
    prop("links", "ref"),
  ];

  it("matches columns by key, normalized header, or name and coerces cells", () => {
    const plan = planCsvImport({
      text: 'Deal Name,Amount,won,Tags,due,links,Internal,body\nAcme,"1 200",yes,"a, b",2026-01-01/2026-01-31,contact:c1,x,Notes\n,,,,,,,\n',
      properties,
      columnMap: parseColumnMap(["Internal=-"]),
    });
    expect(plan.columns.map((column) => [column.column, column.key, column.skipped])).toEqual([
      ["Deal Name", "name", false],
      ["Amount", "amount", false],
      ["won", "won", false],
      ["Tags", "tags", false],
      ["due", "due", false],
      ["links", "links", false],
      ["Internal", null, true],
      ["body", "body", false],
    ]);
    expect(plan.records).toEqual([
      {
        line: 2,
        values: {
          name: "Acme",
          amount: 1200,
          won: true,
          tags: ["a", "b"],
          due: { start: "2026-01-01", end: "2026-01-31" },
          links: [{ type: "contact", id: "c1" }],
        },
        body: "Notes",
      },
    ]);
    expect(plan.emptyRows).toBe(1);
    expect(plan.issues).toEqual([]);
  });

  it("reports cells that do not fit their type and rejects ambiguous mappings", () => {
    const plan = planCsvImport({ text: "amount,won\nabc,maybe\n", properties, columnMap: new Map() });
    expect(plan.issues).toEqual([
      { line: 2, column: "amount", key: "amount", message: "not a number" },
      { line: 2, column: "won", key: "won", message: "not a boolean" },
    ]);
    expect(() => planCsvImport({ text: "name,Deal Name\na,b\n", properties, columnMap: new Map() })).toThrow(
      "Two CSV columns",
    );
    expect(() => planCsvImport({ text: "a\n1\n", properties, columnMap: parseColumnMap(["missing=name"]) })).toThrow(
      "not in the CSV header",
    );
    expect(coerceCsvCell("ref", "nocolon")).toEqual({ error: "refs must be type:id" });
  });

  it("batches by count and bytes with keys that ignore the batch size", () => {
    const records = Array.from({ length: 5 }, (_, index) => ({ line: index + 2, values: { name: `r${index}` } }));
    expect(batchImportRecords(records, 2).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batchImportRecords(records, 500, 60).map((batch) => batch.length)).toEqual([2, 2, 1]);

    const columns = [{ column: "name", key: "name", type: "text", skipped: false }];
    const prefix = importIdempotencyPrefix({ fileBytes: "name\nA\n", projectRef: "p", baseRef: "b", columns });
    expect(prefix).toMatch(/^ravi-import:[0-9a-f]{40}$/);
    expect(importIdempotencyPrefix({ fileBytes: "name\nA\n", projectRef: "p", baseRef: "b", columns })).toBe(prefix);
    expect(importIdempotencyPrefix({ fileBytes: "name\nB\n", projectRef: "p", baseRef: "b", columns })).not.toBe(
      prefix,
    );
    expect(importBatchKey(prefix, 3)).toBe(`${prefix}:3`);
  });
});

function prop(key: string, type: string, config: BaseProperty["config"] = {}, name = key): BaseProperty {
  return {
    id: `prop_${key}`,
    key,
    name,
    description: null,
    type,
    config,
    position: 0,
    required: false,
    deletedAt: null,
  };
}
