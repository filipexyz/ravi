import { describe, expect, it } from "bun:test";
import { mergeRrf } from "./merge.js";

type Item = { ref: string; textHash: string; origin: string };

describe("mergeRrf", () => {
  it("ranks a result present in both lists above single-list results", () => {
    const consoleList: Item[] = [
      { ref: "kc:a", textHash: "ha", origin: "console" },
      { ref: "kc:b", textHash: "hb", origin: "console" },
    ];
    const localList: Item[] = [
      { ref: "km:1", textHash: "h1", origin: "local" },
      { ref: "km:2", textHash: "hb", origin: "local" },
    ];
    const merged = mergeRrf([consoleList, localList], 10);
    expect(merged[0]?.textHash).toBe("hb");
    expect(merged.map((item) => item.textHash)).toEqual(["hb", "ha", "h1"]);
  });

  it("keeps one entry per textHash and cuts to the limit", () => {
    const list: Item[] = [
      { ref: "km:1", textHash: "same", origin: "local" },
      { ref: "km:2", textHash: "same", origin: "local" },
      { ref: "km:3", textHash: "other", origin: "local" },
    ];
    const merged = mergeRrf([list, [{ ref: "kc:x", textHash: "same", origin: "console" }]], 1);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.ref).toBe("km:1");
    expect(mergeRrf([list], 10).filter((item) => item.textHash === "same")).toHaveLength(1);
  });
});
