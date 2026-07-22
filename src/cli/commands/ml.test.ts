import { describe, expect, it } from "bun:test";
import { buildRegistry } from "../registry-snapshot.js";
import { MlCommands } from "./ml.js";

describe("ml CLI contract", () => {
  it("registers every native command with access metadata and typed returns", () => {
    const registry = buildRegistry([MlCommands]);
    const commands = registry.commands.filter((command) => command.fullName.startsWith("ml."));

    expect(registry.groups.find((group) => group.name === "ml")).toBeDefined();
    expect(commands).toHaveLength(38);
    expect(commands.every((command) => command.access !== undefined)).toBe(true);
    expect(commands.every((command) => command.returns !== undefined)).toBe(true);
  });

  it("requires explicit confirmation on every mutation", () => {
    const registry = buildRegistry([MlCommands]);
    const mutations = registry.commands.filter(
      (command) => command.fullName.startsWith("ml.") && command.access?.kind === "mutate",
    );

    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((command) => command.access?.requiresConfirmation === true)).toBe(true);
    expect(mutations.every((command) => command.options.some((option) => option.name === "confirm"))).toBe(true);
  });

  it("fails before authentication or network access without --confirm", async () => {
    await expect(new MlCommands().itemPause("MLB1234567890")).rejects.toThrow("requires explicit --confirm");
  });

  it("rejects price and lifecycle fields from the generic update command", async () => {
    await expect(new MlCommands().itemUpdate("MLB1234567890", '{"price":99.9}', true)).rejects.toThrow(
      "item-update rejects fields: price",
    );
    await expect(new MlCommands().itemUpdate("MLB1234567890", '{"status":"closed"}', true)).rejects.toThrow(
      "item-update rejects fields: status",
    );
  });

  it("keeps financial reads distinct and exposes no financial mutation command", () => {
    const registry = buildRegistry([MlCommands]);
    const commands = registry.commands.filter((command) => command.fullName.startsWith("ml."));
    const financialReads = commands.filter((command) => command.access?.resource === "ml.financial");

    expect(financialReads.length).toBeGreaterThan(0);
    expect(financialReads.every((command) => command.access?.kind === "read")).toBe(true);
    expect(commands.some((command) => /price-(set|update)|payment|purchase/.test(command.fullName))).toBe(false);
  });
});
