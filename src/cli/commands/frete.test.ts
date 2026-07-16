import "reflect-metadata";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  OLIST_FRETE_API_BASE_URL,
  OLIST_FRETE_CONTRACT_VERIFIED_AT,
  OLIST_FRETE_OFFICIAL_DOC_URL,
  type FreteQuoteInput,
  type FreteQuoteReturn,
} from "../../apps/frete/client.js";
import { buildRegistry } from "../registry-snapshot.js";
import { FreteCommands } from "./frete.js";

const result: FreteQuoteReturn = {
  provider: "olist-tiny",
  contract: {
    documentation: OLIST_FRETE_OFFICIAL_DOC_URL,
    endpointTemplate: `${OLIST_FRETE_API_BASE_URL}/{idEcommerce}/cotar`,
    verifiedAt: OLIST_FRETE_CONTRACT_VERIFIED_AT,
  },
  integrationId: 123,
  originCep: null,
  destinationCep: "01310100",
  settings: {
    grouped: false,
    includePreparationDays: true,
    groupDeliveryTypes: true,
  },
  quotes: [
    {
      sku: "SKU-01",
      options: [
        {
          deliveryType: "normal",
          price: 42.5,
          deadlineDays: 5,
          shippingMethodId: "10",
          shippingMethodName: "Transportadora",
          freightMethodId: "20",
          freightMethodName: "Normal",
        },
      ],
    },
  ],
};

let consoleLog: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  consoleLog?.mockRestore();
  consoleLog = null;
});

describe("FreteCommands", () => {
  it("declares a typed read-only quote operation", () => {
    const command = buildRegistry([FreteCommands]).commands.find((entry) => entry.fullName === "frete.quote");
    expect(command).toBeDefined();
    expect(command?.scope).toBe("open");
    expect(command?.access).toMatchObject({
      kind: "read",
      resource: "frete.quotes",
      action: "quote",
      risk: "low",
    });
    expect(command?.returns).toBeDefined();
    expect(command?.args.map((arg) => ({ name: arg.name, required: arg.required }))).toEqual([
      { name: "integrationId", required: true },
      { name: "destinationCep", required: true },
      { name: "sku", required: true },
    ]);
  });

  it("normalizes CLI input and prints stable JSON", async () => {
    let receivedConnection = "";
    const receivedInputs: FreteQuoteInput[] = [];
    consoleLog = spyOn(console, "log").mockImplementation(() => {});
    const commands = new FreteCommands({
      createClient: (connection) => {
        receivedConnection = connection;
        return {
          quote: async (input) => {
            receivedInputs.push(input);
            return result;
          },
        };
      },
    });

    const output = await commands.quote(
      "123",
      "01310-100",
      "SKU-01",
      "2",
      undefined,
      "1.5",
      "22",
      "25",
      "20",
      false,
      false,
      false,
      "default",
      true,
    );

    expect(receivedConnection).toBe("default");
    expect(receivedInputs).toEqual([
      {
        integrationId: 123,
        destinationCep: "01310100",
        items: [
          {
            sku: "SKU-01",
            quantity: 2,
            weightKg: 1.5,
            heightCm: 22,
            widthCm: 25,
            lengthCm: 20,
          },
        ],
        options: {
          grouped: false,
          includePreparationDays: true,
          groupDeliveryTypes: true,
        },
      },
    ]);
    expect(output).toEqual(result);
    expect(JSON.parse(String(consoleLog.mock.calls[0]?.[0]))).toEqual(result);
  });

  it("prints a concise human quote without exposing provider transport details", async () => {
    consoleLog = spyOn(console, "log").mockImplementation(() => {});
    const commands = new FreteCommands({
      createClient: () => ({ quote: async () => result }),
    });

    await commands.quote("123", "01310100", "SKU-01");

    const lines = consoleLog.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines).toEqual([
      "Freight quote to 01310100: 1 option(s)",
      "SKU SKU-01",
      "- Transportadora / Normal: 42.50, 5 day(s), normal",
    ]);
    expect(lines.join("\n")).not.toContain("placeholder-credential");
  });

  it("rejects invalid input before creating a client", async () => {
    let clientCreations = 0;
    const commands = new FreteCommands({
      createClient: () => {
        clientCreations += 1;
        return { quote: async () => result };
      },
    });

    await expect(commands.quote("0", "01310100", "SKU-01")).rejects.toThrow("integrationId");
    expect(clientCreations).toBe(0);
  });
});
