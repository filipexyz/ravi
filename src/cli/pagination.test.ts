import { describe, expect, it } from "bun:test";
import { expectedErrorToContractError } from "./agent-contract.js";
import { CliExpectedError } from "./expected-error.js";
import { buildCliOffsetPagination, paginateCliItems, parseCliListLimit, parseCliListOffset } from "./pagination.js";

describe("CLI pagination helpers", () => {
  it("parses standard list limit and offset options", () => {
    expect(parseCliListLimit(undefined)).toBe(50);
    expect(parseCliListLimit("100", { maxLimit: 100 })).toBe(100);
    expect(parseCliListOffset(undefined)).toBe(0);
    expect(parseCliListOffset("25")).toBe(25);
  });

  it("classifies invalid limit and offset values as public usage errors", () => {
    const cases = [
      () => parseCliListLimit("many"),
      () => parseCliListLimit("0"),
      () => parseCliListLimit("501"),
      () => parseCliListOffset("-1"),
      () => parseCliListOffset("1.5"),
    ];

    for (const attempt of cases) {
      let failure: unknown;
      try {
        attempt();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CliExpectedError);
      const contract = expectedErrorToContractError("agents list", failure);
      expect(contract).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
      expect(contract?.envelope().error).toMatchObject({
        code: "USAGE_ERROR",
        retryable: false,
      });
      expect(contract?.envelope().error.message).not.toBe("Command could not be completed.");
    }
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

  it("preserves a fields projection in the next command", () => {
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "agents", "list"],
      limit: 2,
      offset: 0,
      returned: 2,
      total: 3,
      fields: "id,model",
    });

    expect(pagination.nextCommand).toBe('ravi agents list --json --limit 2 --offset 2 --fields "id,model"');
  });
});
