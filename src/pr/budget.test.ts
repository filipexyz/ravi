import { describe, expect, it } from "bun:test";
import {
  createPublicationDeadline,
  publicationBudgetMs,
  publicationRequestTimeoutMs,
  PUBLICATION_TIMEOUT_CEILING_MS,
  PUBLICATION_TIMEOUT_ENV,
  PUBLICATION_TIMEOUT_MS,
} from "./budget.js";
import { LIMITS } from "./contracts.js";
import { carriedBytes } from "./github.js";

const MIB = 1024 * 1024;

describe("pr publish time budget", () => {
  it("budget_scales_with_upload_size", () => {
    expect(publicationBudgetMs(0, {})).toBe(PUBLICATION_TIMEOUT_MS);
    expect(publicationBudgetMs(1, {})).toBe(181_000);
    expect(publicationBudgetMs(250 * 1024, {})).toBe(181_000);
    // The publication that motivated this: 24 MiB of generated SDKs did not fit in 180s.
    expect(publicationBudgetMs(24 * MIB, {})).toBe(279_000);
    expect(publicationBudgetMs(LIMITS.bytes, {})).toBe(385_000);
    // Never unbounded, whatever the measured size.
    expect(publicationBudgetMs(10_000 * MIB, {})).toBe(PUBLICATION_TIMEOUT_CEILING_MS);

    // One request gets the time its own bytes need: an 8 MiB blob no longer has to fit in 20s.
    expect(publicationRequestTimeoutMs(0)).toBe(20_000);
    expect(publicationRequestTimeoutMs(carriedBytes("repos/o/r/git/blobs", "POST", "x".repeat(6 * MIB)))).toBe(45_000);
    expect(carriedBytes(`repos/o/r/git/blobs/${"a".repeat(40)}`, "GET")).toBeGreaterThan(LIMITS.blobBytes);
    expect(carriedBytes(`repos/o/r/git/trees/${"a".repeat(40)}`, "GET")).toBe(0);
  });

  it("budget_env_override_respects_ceiling", () => {
    const env = (value: string) => ({ [PUBLICATION_TIMEOUT_ENV]: value });
    expect(publicationBudgetMs(0, env("600000"))).toBe(600_000);
    // The override replaces the adaptive value, in both directions.
    expect(publicationBudgetMs(24 * MIB, env("60000"))).toBe(60_000);
    expect(publicationBudgetMs(0, env("3600000"))).toBe(PUBLICATION_TIMEOUT_CEILING_MS);
    expect(publicationBudgetMs(0, env("999999999999"))).toBe(PUBLICATION_TIMEOUT_CEILING_MS);
    expect(publicationBudgetMs(0, env("  "))).toBe(PUBLICATION_TIMEOUT_MS);
    for (const invalid of ["0", "-1", "15m", "1e6", "180.5", "Infinity"])
      expect(() => publicationBudgetMs(0, env(invalid))).toThrow(
        expect.objectContaining({ code: "USAGE_ERROR", exitCode: 2 }),
      );
  });

  it("extends one deadline from the start of the publication instead of restarting it", async () => {
    const deadline = createPublicationDeadline(10);
    deadline.setBudget(60);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deadline.signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(deadline.signal.aborted).toBe(true);

    const spent = createPublicationDeadline(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    spent.setBudget(60_000);
    expect(spent.signal.aborted).toBe(true);
    spent.dispose();
  });
});
