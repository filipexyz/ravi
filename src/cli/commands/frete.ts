import "reflect-metadata";
import { z } from "zod";
import {
  FreteClient,
  freteQuoteReturnSchema,
  OLIST_FRETE_OFFICIAL_DOC_URL,
  type FreteQuoteInput,
  type FreteQuoteReturn,
} from "../../apps/frete/client.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const requiredStringSchema = z.string().trim().min(1);
const positiveIntegerStringSchema = z.string().regex(/^[1-9]\d*$/, "must be a positive integer");
const optionalPositiveNumberStringSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/, "must be a positive number")
  .optional();

const FRETE_QUOTE_HELP = `
CUSTO / SEGURANCA
  READ-ONLY: consulta opcoes de frete configuradas na conta Olist.
  Nao contrata, compra, paga, despacha, emite etiqueta nem cancela transporte.
  O transporte HTTP oficial e POST, mas a operacao de negocio e somente leitura.

USE
  Cotar um SKU conhecido para um CEP, com quantidade e dimensoes opcionais.
  Use --grouped para uma cotacao combinada e --all-delivery-options para nao agrupar por tipo.

NAO USE
  Contratar/enviar/cancelar frete -> fora da Fase 1; requer contrato oficial e HITL.
  Aplicar markup ou lista de preco -> regras do SDE legado, nao confirmadas neste contrato.
  Comparar FM/GF/J3 diretamente -> use os dominios dedicados depois de suas migracoes.

REGRAS HARD
  integrationId: argumento posicional inteiro positivo da integracao Olist.
  CEPs: exatamente 8 digitos depois de remover pontuacao.
  quantidade e dimensoes: maiores que zero.
  Credencial nunca entra em flag, stdout ou manifesto; o App usa conexao Ravi.

EXAMPLES
  ravi frete quote 123 01310100 SKU-01 --json
  ravi frete quote 123 01310-100 SKU-01 --quantity 2 --weight 1 --height 22 --width 25 --length 20 --json
  ravi frete quote 123 01310100 SKU-01 --grouped --all-delivery-options --json

ON ERROR
  credential unavailable -> concluir onboarding da conexao tiny:<id>; o SDE nao e lido.
  invalid input -> corrigir o argumento ou a flag indicada e repetir.
  provider HTTP error -> revisar status/mensagem redigida; nenhum segredo e retornado.
  contract violation -> interromper e rever a documentacao oficial antes de mudar parser/endpoint.

PIPELINE
  SKU + CEP -> ravi frete quote -> escolher opcao -> HITL/fluxo futuro de contratacao (fora da Fase 1).

SEE ALSO
  ravi apps show frete --json
  ravi apps check frete --json
  ravi specs get apps/frete --mode rules --json

FORMATO
  Valores monetarios: numero decimal na moeda configurada pela conta Olist.
  Prazos: dias inteiros. IDs de formas de envio/frete: strings semanticas estaveis no JSON Ravi.
  --json: FreteQuoteReturn tipado no SDK; exit 0 sucesso, exit 1 erro.

FONTES
  Contrato oficial verificado em 2026-07-13: ${OLIST_FRETE_OFFICIAL_DOC_URL}
  Implementacao: src/apps/frete/client.ts e src/cli/commands/frete.ts
`;

export interface FreteQuoteClient {
  quote(input: FreteQuoteInput): Promise<FreteQuoteReturn>;
}

export interface FreteCommandDependencies {
  createClient?: (connection: string) => FreteQuoteClient;
}

@Group({
  name: "frete",
  description: "Quote freight through the verified official Olist contract without contracting transport",
  scope: "open",
})
export class FreteCommands {
  readonly #createClient: (connection: string) => FreteQuoteClient;

  constructor(dependencies: FreteCommandDependencies = {}) {
    this.#createClient = dependencies.createClient ?? ((connection) => new FreteClient({ connection }));
  }

  @Command({
    name: "quote",
    description: "Quote one SKU for a destination through the official Olist freight API (read-only)",
    helpAfter: FRETE_QUOTE_HELP,
  })
  @CommandAccess({
    kind: "read",
    resource: "frete.quotes",
    action: "quote",
    risk: "low",
    input: [
      "integrationId",
      "destinationCep",
      "sku",
      "quantity",
      "originCep",
      "weight",
      "height",
      "width",
      "length",
      "grouped",
      "ignorePreparationDays",
      "allDeliveryOptions",
      "connection",
    ],
    notes: "Read-only business operation; official provider transport uses HTTP POST.",
  })
  @Returns(freteQuoteReturnSchema)
  async quote(
    @Arg("integrationId", {
      description: "Positive Olist integration id",
      schema: positiveIntegerStringSchema,
    })
    integrationId: string,
    @Arg("destinationCep", {
      description: "Destination CEP, with or without punctuation",
      schema: requiredStringSchema,
    })
    destinationCep: string,
    @Arg("sku", {
      description: "Olist product/advertisement SKU",
      schema: requiredStringSchema,
    })
    sku: string,
    @Option({
      flags: "--quantity <n>",
      description: "Positive package quantity (default: 1)",
      defaultValue: "1",
      schema: positiveIntegerStringSchema.default("1"),
    })
    quantity?: string,
    @Option({ flags: "--origin-cep <cep>", description: "Optional origin CEP; account CEP is used when omitted" })
    originCep?: string,
    @Option({
      flags: "--weight <kg>",
      description: "Optional package weight in kilograms",
      schema: optionalPositiveNumberStringSchema,
    })
    weight?: string,
    @Option({
      flags: "--height <cm>",
      description: "Optional package height in centimeters",
      schema: optionalPositiveNumberStringSchema,
    })
    height?: string,
    @Option({
      flags: "--width <cm>",
      description: "Optional package width in centimeters",
      schema: optionalPositiveNumberStringSchema,
    })
    width?: string,
    @Option({
      flags: "--length <cm>",
      description: "Optional package length in centimeters",
      schema: optionalPositiveNumberStringSchema,
    })
    length?: string,
    @Option({ flags: "--grouped", description: "Quote all items as one grouped shipment (default: false)" })
    grouped?: boolean,
    @Option({
      flags: "--ignore-preparation-days",
      description: "Do not add product preparation days to the deadline (default: false)",
    })
    ignorePreparationDays?: boolean,
    @Option({
      flags: "--all-delivery-options",
      description: "Return every option instead of grouping by delivery type (default: false)",
    })
    allDeliveryOptions?: boolean,
    @Option({
      flags: "--connection <id>",
      description: "Ravi credential connection (default: default)",
      defaultValue: "default",
      schema: requiredStringSchema.default("default"),
    })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON result" }) asJson?: boolean,
  ): Promise<FreteQuoteReturn> {
    const parsedIntegrationId = positiveInteger(required(integrationId, "integrationId"), "integrationId");
    const parsedDestinationCep = cep(required(destinationCep, "destinationCep"), "destinationCep");
    const parsedSku = required(sku, "sku");
    const parsedQuantity = positiveInteger(quantity ?? "1", "--quantity");
    const parsedConnection = required(connection ?? "default", "--connection");

    const result = await this.#createClient(parsedConnection).quote({
      integrationId: parsedIntegrationId,
      destinationCep: parsedDestinationCep,
      ...(originCep ? { originCep: cep(originCep, "--origin-cep") } : {}),
      items: [
        {
          sku: parsedSku,
          quantity: parsedQuantity,
          ...(weight !== undefined ? { weightKg: positiveNumber(weight, "--weight") } : {}),
          ...(height !== undefined ? { heightCm: positiveNumber(height, "--height") } : {}),
          ...(width !== undefined ? { widthCm: positiveNumber(width, "--width") } : {}),
          ...(length !== undefined ? { lengthCm: positiveNumber(length, "--length") } : {}),
        },
      ],
      options: {
        grouped: grouped === true,
        includePreparationDays: ignorePreparationDays !== true,
        groupDeliveryTypes: allDeliveryOptions !== true,
      },
    });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanQuote(result);
    }
    return result;
  }
}

function required(value: string | undefined, flag: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${flag} is required. Run ravi frete quote --help for a complete example.`);
  return normalized;
}

function positiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function positiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number.`);
  return parsed;
}

function cep(value: string, flag: string): string {
  const normalized = value.replace(/\D/g, "");
  if (!/^\d{8}$/.test(normalized)) throw new Error(`${flag} must contain exactly 8 digits.`);
  return normalized;
}

function printHumanQuote(result: FreteQuoteReturn): void {
  const optionCount = result.quotes.reduce((count, quote) => count + quote.options.length, 0);
  console.log(`Freight quote to ${result.destinationCep}: ${optionCount} option(s)`);
  for (const quote of result.quotes) {
    if (quote.sku) console.log(`SKU ${quote.sku}`);
    for (const option of quote.options) {
      console.log(
        `- ${option.shippingMethodName} / ${option.freightMethodName}: ${option.price.toFixed(2)}, ` +
          `${option.deadlineDays} day(s), ${option.deliveryType}`,
      );
    }
  }
}
