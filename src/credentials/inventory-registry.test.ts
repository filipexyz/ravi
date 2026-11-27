import { describe, expect, it } from "bun:test";
import { getRegistry } from "../cli/registry-snapshot.js";

describe("credentials connections inventory over the SDK/gateway", () => {
  it("exposes a positive skipDescribe option bound to the parameter (no inverted --no-* flag)", () => {
    const command = getRegistry().commands.find((entry) => entry.fullName === "credentials.connections.inventory");
    expect(command).toBeDefined();
    const names = command!.options.map((option) => option.name);
    expect(names).toContain("skipDescribe");
    // A `--no-describe` flag reaches the gateway as `noDescribe: true` and lands in a `describe`
    // parameter as true, which turns metadata ON: never expose a negated flag here.
    expect(names.some((name) => /^no[A-Z]/.test(name))).toBe(false);
    const skip = command!.options.find((option) => option.name === "skipDescribe")!;
    expect(skip.propertyKey).toBe("inventory");
  });

  it("documents the 500-item cap in the command description", () => {
    const command = getRegistry().commands.find((entry) => entry.fullName === "credentials.connections.inventory");
    expect(command?.description).toContain("up to 500");
  });
});
