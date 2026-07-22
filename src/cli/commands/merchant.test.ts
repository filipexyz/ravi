import "reflect-metadata";
import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getGroupMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { MerchantCommands } from "./merchant.js";

describe("MerchantCommands contract", () => {
  it("registers every finite command with JSON, typed returns and access metadata", () => {
    const instance = new MerchantCommands();
    const commands = getCommandsMetadata(MerchantCommands);
    const returns = getReturnsMetadata(MerchantCommands);
    const access = getCommandAccessMetadata(MerchantCommands);

    expect(getGroupMetadata(MerchantCommands)).toMatchObject({ name: "merchant", scope: "open" });
    expect(commands).toHaveLength(20);
    expect(returns.size).toBe(commands.length);
    expect(access.size).toBe(commands.length);

    for (const command of commands) {
      const options = getOptionsMetadata(instance, command.method);
      expect(options.some((option) => option.flags.includes("--json"))).toBe(true);
      expect(returns.has(command.method)).toBe(true);
      expect(access.has(command.method)).toBe(true);
    }
  });

  it("keeps Merchant writes promotion-blocked while allowing dry-run previews", async () => {
    const commands = new MerchantCommands();
    const log = spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.productInsert("123", "456", '{"offerId":"sku-1"}', true, false);

    expect(result).toEqual({
      result: {
        dryRun: true,
        liveRequestBlocked: true,
        operation: "product-insert",
        input: { account: "123", dataSource: "456", body: { offerId: "sku-1" } },
        nextAction: expect.stringContaining("Merchant credentials"),
      },
    });
    expect(log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
  });

  it("previews promotion inserts with the required data source argument", async () => {
    const commands = new MerchantCommands();
    spyOn(console, "log").mockImplementation(() => {});

    await expect(commands.promotionInsert("123", "456", '{"promotionId":"promo-1"}', true, false)).resolves.toEqual({
      result: expect.objectContaining({
        dryRun: true,
        liveRequestBlocked: true,
        operation: "promotion-insert",
        input: {
          account: "123",
          dataSource: "456",
          promotion: { promotionId: "promo-1" },
        },
      }),
    });
  });

  it("blocks confirmed Merchant writes without calling a provider in this task phase", async () => {
    const commands = new MerchantCommands();
    spyOn(console, "error").mockImplementation(() => {});
    mock.module("../../credentials/broker.js", () => ({
      resolveCredentialSecret: mock(() => {
        throw new Error("provider should not be called");
      }),
    }));

    await expect(commands.productInsert("123", "456", '{"offerId":"sku-1"}', false, true, "default")).rejects.toThrow(
      "promotion-blocked",
    );
  });
});
