import { z } from "zod";
import { resolveCredentialSecret } from "../../credentials/broker.js";

export const OLIST_FRETE_API_BASE_URL = "https://api.tiny.com.br/webhook/api/v1/parceiro";
export const OLIST_FRETE_OFFICIAL_DOC_URL = "https://tiny.com.br/api-docs/api2-cotacao-fretes";
export const OLIST_FRETE_CONTRACT_VERIFIED_AT = "2026-07-13";
export const FRETE_CREDENTIAL_PROVIDER = "tiny";

const cepSchema = z.string().regex(/^\d{8}$/, "must contain exactly 8 digits");
const positiveNumberSchema = z.number().positive();

export const freteQuoteItemSchema = z
  .object({
    sku: z.string().trim().min(1),
    quantity: z.number().int().positive().default(1),
    weightKg: positiveNumberSchema.optional(),
    heightCm: positiveNumberSchema.optional(),
    widthCm: positiveNumberSchema.optional(),
    lengthCm: positiveNumberSchema.optional(),
  })
  .strict();

export const freteQuoteInputSchema = z
  .object({
    integrationId: z.number().int().positive(),
    destinationCep: cepSchema,
    originCep: cepSchema.optional(),
    items: z.array(freteQuoteItemSchema).min(1),
    options: z
      .object({
        grouped: z.boolean().default(false),
        includePreparationDays: z.boolean().default(true),
        groupDeliveryTypes: z.boolean().default(true),
      })
      .strict()
      .default({ grouped: false, includePreparationDays: true, groupDeliveryTypes: true }),
  })
  .strict();

const providerIdSchema = z.union([z.string(), z.number()]);

const providerQuoteOptionSchema = z
  .object({
    tipo_entrega: z.enum(["normal", "expressa", "economica", "super_expressa", "agendada", "retirada", "nao_definida"]),
    preco: z.number().nonnegative(),
    prazo: z.number().int().nonnegative(),
    id_forma_envio: providerIdSchema,
    nome_forma_envio: z.string(),
    id_forma_frete: providerIdSchema,
    nome_forma_frete: z.string(),
  })
  .passthrough();

const providerItemQuoteSchema = z
  .object({
    sku: z.string(),
    opcoes: z.array(providerQuoteOptionSchema),
  })
  .passthrough();

const providerQuoteResponseSchema = z
  .object({
    cep_origem: z.string().optional(),
    cep_destino: z.string(),
    cotacoes: z.array(z.union([providerItemQuoteSchema, providerQuoteOptionSchema])),
    opcoes: z
      .object({
        cotar_agrupado: z.boolean(),
        considerar_dias_preparacao: z.boolean(),
        agrupar_tipo_entrega: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

export const freteQuoteOptionSchema = z
  .object({
    deliveryType: providerQuoteOptionSchema.shape.tipo_entrega,
    price: z.number().nonnegative(),
    deadlineDays: z.number().int().nonnegative(),
    shippingMethodId: z.string(),
    shippingMethodName: z.string(),
    freightMethodId: z.string(),
    freightMethodName: z.string(),
  })
  .strict();

export const freteQuoteReturnSchema = z
  .object({
    provider: z.literal("olist-tiny"),
    contract: z
      .object({
        documentation: z.literal(OLIST_FRETE_OFFICIAL_DOC_URL),
        endpointTemplate: z.literal(`${OLIST_FRETE_API_BASE_URL}/{idEcommerce}/cotar`),
        verifiedAt: z.literal(OLIST_FRETE_CONTRACT_VERIFIED_AT),
      })
      .strict(),
    integrationId: z.number().int().positive(),
    originCep: cepSchema.nullable(),
    destinationCep: cepSchema,
    settings: z
      .object({
        grouped: z.boolean(),
        includePreparationDays: z.boolean(),
        groupDeliveryTypes: z.boolean(),
      })
      .strict(),
    quotes: z.array(
      z
        .object({
          sku: z.string().nullable(),
          options: z.array(freteQuoteOptionSchema),
        })
        .strict(),
    ),
  })
  .strict();

export type FreteQuoteInput = z.infer<typeof freteQuoteInputSchema>;
export type FreteQuoteReturn = z.infer<typeof freteQuoteReturnSchema>;

export interface FreteCredential {
  token: string;
}

export type FreteCredentialResolver = (connection: string) => Promise<FreteCredential>;

export interface FreteClientOptions {
  connection?: string;
  fetch?: typeof globalThis.fetch;
  credential?: FreteCredential;
  resolveCredential?: FreteCredentialResolver;
}

export class FreteClient {
  readonly #connection: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credential?: FreteCredential;
  readonly #resolveCredential: FreteCredentialResolver;

  constructor(options: FreteClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credential = options.credential;
    this.#resolveCredential = options.resolveCredential ?? resolveFreteCredential;
  }

  async quote(input: FreteQuoteInput): Promise<FreteQuoteReturn> {
    const parsed = freteQuoteInputSchema.parse(input);
    const credential = await this.credential();
    const endpoint = `${OLIST_FRETE_API_BASE_URL}/${parsed.integrationId}/cotar`;
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Token: credential.token,
      },
      body: JSON.stringify(toProviderRequest(parsed)),
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Olist freight quote failed (${response.status}): ${redactProviderText(text, credential.token)}`);
    }

    let raw: unknown;
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Olist freight quote returned invalid JSON.");
    }

    const provider = providerQuoteResponseSchema.safeParse(raw);
    if (!provider.success) {
      const issue = provider.error.issues[0];
      const path = issue?.path.length ? issue.path.join(".") : "response";
      throw new Error(`Olist freight quote response violates the official contract at ${path}.`);
    }

    return freteQuoteReturnSchema.parse(normalizeProviderResponse(parsed, provider.data));
  }

  private async credential(): Promise<FreteCredential> {
    if (this.#credential) return validateCredential(this.#credential);
    try {
      return validateCredential(await this.#resolveCredential(this.#connection));
    } catch {
      throw new Error(
        `Frete credential unavailable for Ravi connection ${FRETE_CREDENTIAL_PROVIDER}:${this.#connection}. ` +
          "Complete credential onboarding before running frete.quote; legacy credential files are not used.",
      );
    }
  }
}

export function parseFreteCredential(value: string): FreteCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Frete credential must be JSON with shape {"token":"..."}.');
  }
  return validateCredential(parsed);
}

async function resolveFreteCredential(connection: string): Promise<FreteCredential> {
  const resolved = await resolveCredentialSecret({
    provider: FRETE_CREDENTIAL_PROVIDER,
    connection,
    action: "auth.check",
  });
  return parseFreteCredential(resolved.secret);
}

function validateCredential(value: unknown): FreteCredential {
  return z
    .object({ token: z.string().min(1) })
    .strict()
    .parse(value);
}

function toProviderRequest(input: z.infer<typeof freteQuoteInputSchema>) {
  return {
    ...(input.originCep ? { cep_origem: input.originCep } : {}),
    cep_destino: input.destinationCep,
    itens: input.items.map((item) => ({
      sku: item.sku,
      quantidade: item.quantity,
      ...(item.weightKg !== undefined ? { peso: item.weightKg } : {}),
      ...(item.heightCm !== undefined ? { altura: item.heightCm } : {}),
      ...(item.widthCm !== undefined ? { largura: item.widthCm } : {}),
      ...(item.lengthCm !== undefined ? { comprimento: item.lengthCm } : {}),
    })),
    opcoes: {
      cotar_agrupado: input.options.grouped,
      considerar_dias_preparacao: input.options.includePreparationDays,
      agrupar_tipo_entrega: input.options.groupDeliveryTypes,
    },
  };
}

function normalizeProviderResponse(
  input: z.infer<typeof freteQuoteInputSchema>,
  response: z.infer<typeof providerQuoteResponseSchema>,
) {
  return {
    provider: "olist-tiny" as const,
    contract: {
      documentation: OLIST_FRETE_OFFICIAL_DOC_URL,
      endpointTemplate: `${OLIST_FRETE_API_BASE_URL}/{idEcommerce}/cotar` as const,
      verifiedAt: OLIST_FRETE_CONTRACT_VERIFIED_AT,
    },
    integrationId: input.integrationId,
    originCep: digits(response.cep_origem ?? input.originCep ?? "") || null,
    destinationCep: digits(response.cep_destino),
    settings: {
      grouped: response.opcoes.cotar_agrupado,
      includePreparationDays: response.opcoes.considerar_dias_preparacao,
      groupDeliveryTypes: response.opcoes.agrupar_tipo_entrega,
    },
    quotes: response.cotacoes.map((quote) => {
      const itemQuote = providerItemQuoteSchema.safeParse(quote);
      if (itemQuote.success) {
        const itemOptions = z.array(providerQuoteOptionSchema).parse(itemQuote.data.opcoes);
        return { sku: itemQuote.data.sku, options: itemOptions.map(normalizeProviderOption) };
      }
      return { sku: null, options: [normalizeProviderOption(providerQuoteOptionSchema.parse(quote))] };
    }),
  };
}

function normalizeProviderOption(option: z.infer<typeof providerQuoteOptionSchema>) {
  return {
    deliveryType: option.tipo_entrega,
    price: option.preco,
    deadlineDays: option.prazo,
    shippingMethodId: String(option.id_forma_envio),
    shippingMethodName: option.nome_forma_envio,
    freightMethodId: String(option.id_forma_frete),
    freightMethodName: option.nome_forma_frete,
  };
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function redactProviderText(value: string, credential: string): string {
  const withoutCredential = credential ? value.split(credential).join("[redacted]") : value;
  return withoutCredential
    .replace(/("?(?:token|access_token|refresh_token|client_secret)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]")
    .slice(0, 1000);
}
