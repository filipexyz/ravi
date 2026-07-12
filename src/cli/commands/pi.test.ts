import { describe, expect, it } from "bun:test";
import { parseListModelsTable } from "./pi.js";

describe("parseListModelsTable", () => {
  const sample = [
    "provider            model                                          context  max-out  thinking  images",
    "google              gemini-2.5-flash                               1.0M     65.5K    yes       yes   ",
    "google              gemini-1.5-flash                               1M       8.2K     no        yes   ",
    "groq                llama-3.3-70b                                  128K     32K      no        no    ",
    "",
  ].join("\n");

  it("parses provider/model rows and skips the header", () => {
    const rows = parseListModelsTable(sample);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      context: "1.0M",
      maxOut: "65.5K",
      thinking: true,
      images: true,
    });
  });

  it("maps yes/no columns to booleans", () => {
    const rows = parseListModelsTable(sample);
    const flash15 = rows.find((r) => r.model === "gemini-1.5-flash")!;
    expect(flash15.thinking).toBe(false);
    expect(flash15.images).toBe(true);
    const groq = rows.find((r) => r.provider === "groq")!;
    expect(groq.thinking).toBe(false);
    expect(groq.images).toBe(false);
  });

  it("returns an empty list for empty or malformed output", () => {
    expect(parseListModelsTable("")).toEqual([]);
    expect(parseListModelsTable("some error line")).toEqual([]);
  });
});
