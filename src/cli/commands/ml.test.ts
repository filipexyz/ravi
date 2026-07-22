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

  it("rejects semantically invalid item mutation bodies before dry-run validation", async () => {
    await expect(
      new MlCommands().itemCreate(
        '{"title":false,"category_id":"MLB1051","price":"gratuito","currency_id":[],"available_quantity":-1,"buying_mode":"buy_it_now","listing_type_id":"gold_special"}',
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow("--body item-create is invalid");

    await expect(
      new MlCommands().itemUpdate("MLB1234567890", '{"available_quantity":-999}', undefined, undefined, true),
    ).rejects.toThrow("--body item-update is invalid");
  });

  it("includes proposed non-sensitive values in dry-run HITL plans", async () => {
    const update = await new MlCommands().itemUpdate(
      "MLB1234567890",
      '{"available_quantity":10,"title":"Titulo revisado"}',
      undefined,
      "sandbox",
      true,
    );
    const updatePlan = update.result as Record<string, unknown>;
    const updateInput = updatePlan.input as Record<string, unknown>;

    expect(updateInput.valuesExposed).toBe(true);
    expect(updateInput.target).toBe("MLB1234567890");
    expect(updateInput.proposed).toEqual({ available_quantity: 10, title: "Titulo revisado" });

    const message = await new MlCommands().messageSend(
      "2000000089077943",
      "415458330",
      "3037675074",
      "Mensagem revisada",
      undefined,
      undefined,
      true,
    );
    const messageInput = (message.result as Record<string, unknown>).input as Record<string, unknown>;

    expect(messageInput.proposed).toEqual({
      pack_id: "2000000089077943",
      seller_id: "415458330",
      to_user_id: "3037675074",
      text: "Mensagem revisada",
    });
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
