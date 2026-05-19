import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildCommand,
  buildOffsetPagination,
  countRows,
  normalizeLimitOffsetPage,
  normalizePageLimit,
  normalizePageOffset,
  paginateItems,
} from "./pagination.js";

describe("generic pagination utilities", () => {
  it("normalizes limit and offset consistently", () => {
    expect(normalizePageLimit(undefined, { defaultLimit: 20, maxLimit: 100 })).toBe(20);
    expect(normalizePageLimit("500", { defaultLimit: 20, maxLimit: 100 })).toBe(100);
    expect(normalizePageOffset("-3")).toBe(0);
    expect(normalizeLimitOffsetPage({ limit: "10", offset: "30" })).toEqual({ limit: 10, offset: 30 });
  });

  it("builds standard offset pagination with a reusable next command", () => {
    const pagination = buildOffsetPagination({
      limit: 2,
      offset: 4,
      returned: 2,
      total: 9,
      nextCommand: (nextOffset) => buildCommand(["ravi", "things", "list", "--limit", 2, "--offset", nextOffset]),
    });

    expect(pagination).toEqual({
      limit: 2,
      offset: 4,
      returned: 2,
      total: 9,
      hasMore: true,
      nextOffset: 6,
      nextCommand: "ravi things list --limit 2 --offset 6",
    });
  });

  it("drops option flags whose value is absent while keeping boolean flags", () => {
    expect(buildCommand(["ravi", "agents", "list", "--json", "--tag", null, "--all"])).toBe(
      "ravi agents list --json --all",
    );
  });

  it("paginates finite arrays with the same list page shape", () => {
    expect(paginateItems(["a", "b", "c", "d"], { limit: 2, offset: 1 })).toEqual({
      items: ["b", "c"],
      total: 4,
      limit: 2,
      offset: 1,
    });
  });

  it("counts rows for any trusted table and where clause", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE things (id TEXT PRIMARY KEY, kind TEXT NOT NULL)");
    db.prepare("INSERT INTO things (id, kind) VALUES (?, ?)").run("one", "image");
    db.prepare("INSERT INTO things (id, kind) VALUES (?, ?)").run("two", "image");
    db.prepare("INSERT INTO things (id, kind) VALUES (?, ?)").run("three", "report");

    expect(countRows({ db, table: "things", where: ["kind = ?"], params: ["image"] })).toBe(2);
  });
});
