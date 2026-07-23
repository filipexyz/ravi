import { describe, expect, it } from "bun:test";

describe("verify delivery SHA", () => {
  it("accepts identical stage SHAs and rejects drift", () => {
    const script = new URL("./verify-delivery-sha.ts", import.meta.url).pathname;
    const good = Bun.spawnSync(["bun", script, "abcdef1", "abcdef1", "abcdef1"]);
    expect(good.exitCode).toBe(0);
    expect(good.stdout.toString()).toContain("verified across 3 stages");

    const drift = Bun.spawnSync(["bun", script, "abcdef1", "abcdef2"]);
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr.toString()).toContain("Delivery SHA mismatch");
  });
});
