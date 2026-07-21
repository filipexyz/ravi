import { afterEach, describe, expect, it } from "bun:test";
import { runWithContext } from "../context.js";
import { determineMaxAcuLimit, resolveResumable } from "./devin.js";

const originalDefaultMaxAcuLimit = process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT;

afterEach(() => {
  if (originalDefaultMaxAcuLimit === undefined) delete process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT;
  else process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT = originalDefaultMaxAcuLimit;
});

describe("Devin negated options", () => {
  it("resolves resumable from validated command arguments", () => {
    expect(resolveResumable()).toEqual({ value: undefined, source: "omitted" });
    expect(resolveResumable(true, false)).toEqual({ value: true, source: "explicit" });
    expect(resolveResumable(undefined, true)).toEqual({ value: false, source: "explicit" });
  });

  it("rejects contradictory resumable arguments from remote callers", () => {
    expect(() => runWithContext({}, () => resolveResumable(true, true))).toThrow(
      "Use either --resumable or --no-resumable",
    );
  });

  it("uses the validated noMaxAcuLimit argument instead of process.argv", () => {
    process.env.DEVIN_DEFAULT_MAX_ACU_LIMIT = "25";

    expect(determineMaxAcuLimit(undefined, false)).toEqual({ maxAcuLimit: 25, source: "env" });
    expect(determineMaxAcuLimit(undefined, true)).toEqual({ source: "omitted" });
    expect(determineMaxAcuLimit("12", false)).toEqual({ maxAcuLimit: 12, source: "explicit" });
  });

  it("rejects max ACU together with its negated flag", () => {
    expect(() => runWithContext({}, () => determineMaxAcuLimit("12", true))).toThrow(
      "Use either --max-acu or --no-max-acu-limit",
    );
  });
});
