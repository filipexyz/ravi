import { describe, expect, it } from "bun:test";
import { FreteClient, OLIST_FRETE_API_BASE_URL, OLIST_FRETE_OFFICIAL_DOC_URL, type FreteQuoteInput } from "./client.js";

const input: FreteQuoteInput = {
  integrationId: 123,
  destinationCep: "01310100",
  originCep: "05633000",
  items: [
    {
      sku: "SKU-01",
      quantity: 2,
      weightKg: 1,
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
};

describe("FreteClient", () => {
  it("uses the verified official quote contract and normalizes its response", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const client = new FreteClient({
      credential: { token: "placeholder-credential" },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            cep_origem: "05633000",
            cep_destino: "01310100",
            cotacoes: [
              {
                sku: "SKU-01",
                opcoes: [
                  {
                    tipo_entrega: "normal",
                    preco: 63.83,
                    prazo: 5,
                    id_forma_envio: "443903880",
                    nome_forma_envio: "Jadlog",
                    id_forma_frete: 443903891,
                    nome_forma_frete: ".PACKAGE",
                  },
                ],
              },
            ],
            opcoes: {
              cotar_agrupado: false,
              considerar_dias_preparacao: true,
              agrupar_tipo_entrega: true,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    const result = await client.quote(input);

    expect(requestedUrl).toBe(`${OLIST_FRETE_API_BASE_URL}/123/cotar`);
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toEqual({
      "content-type": "application/json",
      Token: "placeholder-credential",
    });
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      cep_origem: "05633000",
      cep_destino: "01310100",
      itens: [
        {
          sku: "SKU-01",
          quantidade: 2,
          peso: 1,
          altura: 22,
          largura: 25,
          comprimento: 20,
        },
      ],
      opcoes: {
        cotar_agrupado: false,
        considerar_dias_preparacao: true,
        agrupar_tipo_entrega: true,
      },
    });
    expect(result.contract.documentation).toBe(OLIST_FRETE_OFFICIAL_DOC_URL);
    expect(result.quotes).toEqual([
      {
        sku: "SKU-01",
        options: [
          {
            deliveryType: "normal",
            price: 63.83,
            deadlineDays: 5,
            shippingMethodId: "443903880",
            shippingMethodName: "Jadlog",
            freightMethodId: "443903891",
            freightMethodName: ".PACKAGE",
          },
        ],
      },
    ]);
  });

  it("fails closed before fetch when the Ravi credential is unavailable", async () => {
    let fetchCalls = 0;
    const client = new FreteClient({
      resolveCredential: async () => {
        throw new Error("missing");
      },
      fetch: (async () => {
        fetchCalls += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });

    await expect(client.quote(input)).rejects.toThrow("credential unavailable");
    expect(fetchCalls).toBe(0);
  });

  it("redacts provider error bodies before surfacing them", async () => {
    const client = new FreteClient({
      credential: { token: "placeholder-credential" },
      fetch: (async () =>
        new Response(
          JSON.stringify({ token: "placeholder-credential", access_token: "provider-secret", error: "denied" }),
          { status: 401 },
        )) as unknown as typeof fetch,
    });

    let message = "";
    try {
      await client.quote(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("401");
    expect(message).toContain("[redacted]");
    expect(message).not.toContain("placeholder-credential");
    expect(message).not.toContain("provider-secret");
  });

  it("rejects response drift instead of guessing a provider shape", async () => {
    const client = new FreteClient({
      credential: { token: "placeholder-credential" },
      fetch: (async () =>
        Response.json({
          cep_destino: "01310100",
          opcoes: {
            cotar_agrupado: false,
            considerar_dias_preparacao: true,
            agrupar_tipo_entrega: true,
          },
        })) as unknown as typeof fetch,
    });

    await expect(client.quote(input)).rejects.toThrow("official contract at cotacoes");
  });
});
