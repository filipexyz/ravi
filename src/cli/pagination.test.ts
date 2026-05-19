import { describe, expect, it } from "bun:test";
import { buildCliOffsetPagination, paginateCliItems, parseCliListLimit, parseCliListOffset } from "./pagination.js";

describe("CLI pagination helpers", () => {
  it("parses standard list limit and offset options", () => {
    expect(parseCliListLimit(undefined)).toBe(50);
    expect(parseCliListLimit("999", { maxLimit: 100 })).toBe(100);
    expect(parseCliListOffset(undefined)).toBe(0);
    expect(parseCliListOffset("25")).toBe(25);
  });

  it("paginates finite command lists", () => {
    const page = paginateCliItems(["a", "b", "c"], { limit: "2", offset: "1" });
    expect(page).toEqual({
      items: ["b", "c"],
      total: 3,
      limit: 2,
      offset: 1,
    });
  });

  it("builds a standard next command", () => {
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "agents", "list"],
      limit: 2,
      offset: 0,
      returned: 2,
      total: 3,
      options: ["--tag", "core"],
    });

    expect(pagination.nextCommand).toBe("ravi agents list --json --limit 2 --offset 2 --tag core");
  });
});
