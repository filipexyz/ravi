import { describe, expect, it } from "bun:test";
import { evictOldestDiaryRows } from "./evict.js";

const DIARY = [
  "# Auto Memory",
  "",
  "- some index line",
  "",
  "## Diário",
  "",
  "| Data | Tópicos |",
  "|------|---------|",
  "| 2026-07-01 | alpha oldest |",
  "| 2026-07-05 | bravo middle |",
  "| 2026-07-09 | charlie newest |",
].join("\n");

describe("evictOldestDiaryRows (R11 deterministic FIFO fallback)", () => {
  it("returns unchanged when needChars <= 0", () => {
    const r = evictOldestDiaryRows(DIARY, 0);
    expect(r.evictedRows).toBe(0);
    expect(r.content).toBe(DIARY);
  });

  it("returns unchanged when there is no Diário table (nothing safe to evict)", () => {
    const noTable = "# Auto Memory\n\n- just an index, no table\n";
    const r = evictOldestDiaryRows(noTable, 50);
    expect(r.evictedRows).toBe(0);
    expect(r.freedChars).toBe(0);
    expect(r.content).toBe(noTable);
  });

  it("evicts the oldest row first by absolute date, not append order", () => {
    const r = evictOldestDiaryRows(DIARY, 1);
    expect(r.evictedRows).toBe(1);
    expect(r.content).not.toContain("alpha oldest");
    expect(r.content).toContain("bravo middle");
    expect(r.content).toContain("charlie newest");
    // Header, separator, and non-table lines are preserved.
    expect(r.content).toContain("| Data | Tópicos |");
    expect(r.content).toContain("|------|---------|");
    expect(r.content).toContain("- some index line");
  });

  it("frees only as many rows as needed to cover needChars", () => {
    // Each data row is ~30 chars; asking for slightly more than one row's worth
    // should evict exactly two rows (oldest two), never the newest.
    const oneRow = "| 2026-07-01 | alpha oldest |".length + 1;
    const r = evictOldestDiaryRows(DIARY, oneRow + 1);
    expect(r.evictedRows).toBe(2);
    expect(r.content).not.toContain("alpha oldest");
    expect(r.content).not.toContain("bravo middle");
    expect(r.content).toContain("charlie newest");
    expect(r.freedChars).toBeGreaterThanOrEqual(oneRow + 1);
  });

  it("evicts date-parseable order regardless of physical row order", () => {
    const shuffled = [
      "## Diário",
      "",
      "| Data | Tópicos |",
      "|------|---------|",
      "| 2026-07-09 | newest but listed first |",
      "| 2026-07-01 | oldest but listed last |",
    ].join("\n");
    const r = evictOldestDiaryRows(shuffled, 1);
    expect(r.evictedRows).toBe(1);
    expect(r.content).not.toContain("oldest but listed last");
    expect(r.content).toContain("newest but listed first");
  });

  it("treats an undated row as oldest so a malformed row is evicted first", () => {
    const withUndated = [
      "## Diário",
      "",
      "| Data | Tópicos |",
      "|------|---------|",
      "| 2026-07-01 | dated row |",
      "| (no date) | malformed row |",
    ].join("\n");
    const r = evictOldestDiaryRows(withUndated, 1);
    expect(r.evictedRows).toBe(1);
    expect(r.content).not.toContain("malformed row");
    expect(r.content).toContain("dated row");
  });

  it("caps eviction at the available data rows and never removes the header/separator", () => {
    const r = evictOldestDiaryRows(DIARY, 10_000);
    // All three data rows can go, but the table scaffolding stays.
    expect(r.evictedRows).toBe(3);
    expect(r.content).toContain("| Data | Tópicos |");
    expect(r.content).toContain("|------|---------|");
    expect(r.content).not.toContain("alpha oldest");
    expect(r.content).not.toContain("charlie newest");
  });
});
