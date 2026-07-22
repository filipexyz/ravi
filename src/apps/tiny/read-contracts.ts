import { TINY_V2_QUOTA, publicTinyQuota } from "./quota.js";

export const TINY_READ_OPERATIONS = [
  "info",
  "pedidos",
  "pedido",
  "contatos",
  "contato",
  "produtos",
  "produto",
  "estoque",
  "notas",
  "nota",
  "nota-xml",
  "contas-receber",
  "conta-receber",
  "contas-pagar",
  "conta-pagar",
  "listas-precos",
] as const;

export type TinyReadOperation = (typeof TINY_READ_OPERATIONS)[number];

export const TINY_READ_WAVE_1_OPERATIONS = ["info", "contatos", "contato", "produtos", "produto", "estoque"] as const;

export type TinyReadWaveOneOperation = (typeof TINY_READ_WAVE_1_OPERATIONS)[number];

export const TINY_READ_PARITY_CASES = ["nominal", "empty", "error", "pagination", "tenant"] as const;

export interface TinyReadParityContract {
  version: "ravi-app-read-parity/v1";
  responseKind: "single" | "collection";
  collectionKey: string | null;
  emptyState: "empty-success" | "empty-collection" | "not-found-error";
  pagination: "not-applicable" | "pagina+numero_paginas";
  tenantIsolation: "explicit-tenant+broker-connection";
  errorPolicy: "redacted-code-only";
  cases: readonly (typeof TINY_READ_PARITY_CASES)[number][];
}

export interface TinyReadContract {
  path: string;
  officialDoc: string;
  positional: string[];
  options: Record<string, string>;
  defaults?: Record<string, string>;
  requiredOptions?: string[];
  requireAny?: string[];
  textResponse?: "xml_nfe";
  parity?: TinyReadParityContract;
}

const contracts: Record<TinyReadOperation, TinyReadContract> = {
  info: {
    path: "/info.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-info",
    positional: [],
    options: {},
    parity: parityContract("single", null, "empty-success", "not-applicable"),
  },
  pedidos: {
    path: "/pedidos.pesquisa.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-pedidos-pesquisar",
    positional: [],
    options: {
      "--data-inicial": "dataInicial",
      "--data-final": "dataFinal",
      "--situacao": "situacao",
      "--numero": "numero",
      "--cliente": "cliente",
      "--cpf-cnpj": "cpf_cnpj",
      "--data-atualizacao": "dataAtualizacao",
      "--numero-ecommerce": "numeroEcommerce",
      "--id-vendedor": "idVendedor",
      "--nome-vendedor": "nomeVendedor",
      "--marcador": "marcador",
      "--data-inicial-ocorrencia": "dataInicialOcorrencia",
      "--data-final-ocorrencia": "dataFinalOcorrencia",
      "--situacao-ocorrencia": "situacaoOcorrencia",
      "--pagina": "pagina",
      "--sort": "sort",
    },
    defaults: { pagina: "1" },
    requireAny: [
      "dataInicial",
      "dataFinal",
      "dataAtualizacao",
      "situacao",
      "numero",
      "numeroEcommerce",
      "cliente",
      "cpf_cnpj",
      "idVendedor",
      "nomeVendedor",
      "marcador",
      "dataInicialOcorrencia",
      "dataFinalOcorrencia",
    ],
  },
  pedido: detail("/pedido.obter.php", "https://tiny.com.br/api-docs/api2-pedidos-obter"),
  contatos: {
    path: "/contatos.pesquisa.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-contatos-pesquisar",
    positional: [],
    options: {
      "--pesquisa": "pesquisa",
      "--cpf-cnpj": "cpf_cnpj",
      "--situacao": "situacao",
      "--id-vendedor": "idVendedor",
      "--nome-vendedor": "nomeVendedor",
      "--data-criacao": "dataCriacao",
      "--data-atualizacao": "dataMinimaAtualizacao",
      "--pagina": "pagina",
    },
    defaults: { pagina: "1" },
    requiredOptions: ["pesquisa"],
    parity: parityContract("collection", "contatos", "empty-collection", "pagina+numero_paginas"),
  },
  contato: detail(
    "/contato.obter.php",
    "https://tiny.com.br/api-docs/api2-contatos-obter",
    parityContract("single", null, "not-found-error", "not-applicable"),
  ),
  produtos: {
    path: "/produtos.pesquisa.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-produtos-pesquisar",
    positional: [],
    options: {
      "--pesquisa": "pesquisa",
      "--situacao": "situacao",
      "--gtin": "gtin",
      "--id-tag": "idTag",
      "--id-lista-preco": "idListaPreco",
      "--data-criacao": "dataCriacao",
      "--pagina": "pagina",
    },
    defaults: { pagina: "1" },
    requiredOptions: ["pesquisa"],
    parity: parityContract("collection", "produtos", "empty-collection", "pagina+numero_paginas"),
  },
  produto: detail(
    "/produto.obter.php",
    "https://tiny.com.br/api-docs/api2-produtos-obter",
    parityContract("single", null, "not-found-error", "not-applicable"),
  ),
  estoque: detail(
    "/produto.obter.estoque.php",
    "https://tiny.com.br/api-docs/api2-produtos-obter-estoque",
    parityContract("single", null, "not-found-error", "not-applicable"),
  ),
  notas: {
    path: "/notas.fiscais.pesquisa.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-notas-fiscais-pesquisar",
    positional: [],
    options: {
      "--tipo-nota": "tipoNota",
      "--numero": "numero",
      "--cliente": "cliente",
      "--cpf-cnpj": "cpf_cnpj",
      "--data-inicial": "dataInicial",
      "--data-final": "dataFinal",
      "--situacao": "situacao",
      "--numero-ecommerce": "numeroEcommerce",
      "--id-vendedor": "idVendedor",
      "--id-forma-envio": "idFormaEnvio",
      "--nome-vendedor": "nomeVendedor",
      "--pagina": "pagina",
    },
    defaults: { pagina: "1" },
    requireAny: ["numero", "cliente", "cpf_cnpj", "dataInicial", "dataFinal", "situacao", "numeroEcommerce"],
  },
  nota: detail("/nota.fiscal.obter.php", "https://tiny.com.br/api-docs/api2-notas-fiscais-obter"),
  "nota-xml": {
    ...detail("/nota.fiscal.obter.xml.php", "https://tiny.com.br/api-docs/api2-notas-fiscais-obter-xml"),
    textResponse: "xml_nfe",
  },
  "contas-receber": {
    path: "/contas.receber.pesquisa.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-contas-receber-pesquisar",
    positional: [],
    options: {
      "--cliente": "nome_cliente",
      "--numero-doc": "numero_doc",
      "--numero-banco": "numero_banco",
      "--data-ini-emissao": "data_ini_emissao",
      "--data-fim-emissao": "data_fim_emissao",
      "--data-ini-vencimento": "data_ini_vencimento",
      "--data-fim-vencimento": "data_fim_vencimento",
      "--situacao": "situacao",
      "--id-origem": "id_origem",
      "--pagina": "pagina",
    },
    defaults: { pagina: "1" },
    requireAny: [
      "nome_cliente",
      "numero_doc",
      "numero_banco",
      "data_ini_emissao",
      "data_fim_emissao",
      "data_ini_vencimento",
      "data_fim_vencimento",
      "situacao",
      "id_origem",
    ],
  },
  "conta-receber": {
    ...detail("/conta.receber.obter.php", "https://tiny.com.br/api-docs/api2-contas-receber-obter"),
    options: { "--boleto": "obter_link_boleto" },
    defaults: { obter_link_boleto: "N" },
  },
  "contas-pagar": {
    path: "/contas.pagar.pesquisa.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-contas-pagar-pesquisar",
    positional: [],
    options: {
      "--cliente": "nome_cliente",
      "--numero-doc": "numero_doc",
      "--data-ini-emissao": "data_ini_emissao",
      "--data-fim-emissao": "data_fim_emissao",
      "--data-ini-vencimento": "data_ini_vencimento",
      "--data-fim-vencimento": "data_fim_vencimento",
      "--situacao": "situacao",
      "--pagina": "pagina",
    },
    defaults: { pagina: "1" },
    requireAny: [
      "nome_cliente",
      "numero_doc",
      "data_ini_emissao",
      "data_fim_emissao",
      "data_ini_vencimento",
      "data_fim_vencimento",
      "situacao",
    ],
  },
  "conta-pagar": detail("/conta.pagar.obter.php", "https://tiny.com.br/api-docs/api2-contas-pagar-obter"),
  "listas-precos": {
    path: "/listas.precos.pesquisa.php",
    officialDoc: "https://tiny.com.br/api-docs/api2-listas-precos-pesquisar",
    positional: [],
    options: { "--pesquisa": "pesquisa", "--pagina": "pagina" },
    defaults: { pagina: "1" },
  },
};

function detail(path: string, officialDoc: string, parity?: TinyReadParityContract): TinyReadContract {
  return { path, officialDoc, positional: ["id"], options: {}, parity };
}

function parityContract(
  responseKind: TinyReadParityContract["responseKind"],
  collectionKey: string | null,
  emptyState: TinyReadParityContract["emptyState"],
  pagination: TinyReadParityContract["pagination"],
): TinyReadParityContract {
  return {
    version: "ravi-app-read-parity/v1",
    responseKind,
    collectionKey,
    emptyState,
    pagination,
    tenantIsolation: "explicit-tenant+broker-connection",
    errorPolicy: "redacted-code-only",
    cases: [...TINY_READ_PARITY_CASES],
  };
}

export interface TinyReadInput {
  operation: TinyReadOperation;
  path: string;
  params: Record<string, string>;
  officialDoc: string;
  textResponse: "xml_nfe" | null;
}

export function isTinyReadOperation(value: string): value is TinyReadOperation {
  return (TINY_READ_OPERATIONS as readonly string[]).includes(value);
}

export function isTinyReadWaveOneOperation(value: string): value is TinyReadWaveOneOperation {
  return (TINY_READ_WAVE_1_OPERATIONS as readonly string[]).includes(value);
}

export function getTinyReadContract(operation: TinyReadOperation): TinyReadContract {
  const contract = contracts[operation];
  return {
    ...contract,
    positional: [...contract.positional],
    options: { ...contract.options },
    defaults: contract.defaults ? { ...contract.defaults } : undefined,
    requiredOptions: contract.requiredOptions ? [...contract.requiredOptions] : undefined,
    requireAny: contract.requireAny ? [...contract.requireAny] : undefined,
    parity: contract.parity ? { ...contract.parity, cases: [...contract.parity.cases] } : undefined,
  };
}

export function parseTinyReadInput(operation: TinyReadOperation, argv: string[]): TinyReadInput {
  const contract = contracts[operation];
  const params: Record<string, string> = { ...(contract.defaults ?? {}) };
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const parameter = contract.options[token];
      if (!parameter) throw new Error(`Opcao desconhecida para tiny ${operation}: ${token}.`);
      if (token === "--boleto") {
        params[parameter] = "S";
        continue;
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} exige um valor em tiny ${operation}.`);
      params[parameter] = value;
      index += 1;
      continue;
    }
    positional.push(token);
  }

  if (positional.length !== contract.positional.length) {
    const expected = contract.positional.map((name) => `<${name}>`).join(" ");
    throw new Error(`tiny ${operation} exige argumentos: ${expected || "nenhum"}.`);
  }
  contract.positional.forEach((name, index) => {
    const value = positional[index]!;
    if (name === "id" && !/^\d+$/.test(value))
      throw new Error(`ID Tiny invalido para ${operation}: use numero inteiro.`);
    params[name] = value;
  });
  for (const parameter of contract.requiredOptions ?? []) {
    if (!params[parameter])
      throw new Error(`tiny ${operation} exige --${toKebab(parameter)} conforme contrato oficial.`);
  }
  if (contract.requireAny && !contract.requireAny.some((name) => Boolean(params[name]))) {
    throw new Error(`tiny ${operation} exige ao menos um filtro oficial; consulta irrestrita foi bloqueada.`);
  }
  if (params.pagina && (!/^\d+$/.test(params.pagina) || Number(params.pagina) < 1)) {
    throw new Error("--pagina deve ser inteiro positivo.");
  }
  validateOfficialParameters(operation, params);

  return {
    operation,
    path: contract.path,
    params,
    officialDoc: contract.officialDoc,
    textResponse: contract.textResponse ?? null,
  };
}

function validateOfficialParameters(operation: TinyReadOperation, params: Record<string, string>): void {
  const dateOnlyParameters = [
    "dataInicial",
    "dataFinal",
    "dataInicialOcorrencia",
    "dataFinalOcorrencia",
    "data_ini_emissao",
    "data_fim_emissao",
    "data_ini_vencimento",
    "data_fim_vencimento",
  ];
  for (const name of dateOnlyParameters) {
    const value = params[name];
    if (value && !/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
      throw new Error(`Parametro ${toKebab(name)} invalido em tiny ${operation}: use DD/MM/YYYY.`);
    }
  }

  for (const name of ["dataAtualizacao", "dataCriacao", "dataMinimaAtualizacao"]) {
    const value = params[name];
    if (value && !/^\d{2}\/\d{2}\/\d{4}(?: \d{2}:\d{2}:\d{2})?$/.test(value)) {
      throw new Error(`Parametro ${toKebab(name)} invalido em tiny ${operation}: use DD/MM/YYYY[ HH:MM:SS].`);
    }
  }

  for (const name of ["idVendedor", "idFormaEnvio", "idTag", "idListaPreco"]) {
    const value = params[name];
    if (value && !/^\d+$/.test(value)) {
      throw new Error(`Parametro ${toKebab(name)} invalido em tiny ${operation}: use numero inteiro.`);
    }
  }

  if (params.sort && !["ASC", "DESC"].includes(params.sort.toUpperCase())) {
    throw new Error(`Parametro sort invalido em tiny ${operation}: use ASC ou DESC.`);
  }
  if (params.sort) params.sort = params.sort.toUpperCase();
}

export function buildTinyReadPlan(input: TinyReadInput, tenant: string, connection: string, configured: boolean) {
  return {
    dryRun: true as const,
    networkCalled: false as const,
    secretResolved: false as const,
    tenant,
    operation: input.operation,
    apiVersion: "v2" as const,
    method: "POST" as const,
    endpointPath: input.path,
    parameterNames: Object.keys(input.params).sort(),
    credentialSource: "broker" as const,
    credentialProvider: "tiny" as const,
    credentialConnection: connection,
    credentialConfigured: configured,
    mutating: false,
    quota: publicTinyQuota(TINY_V2_QUOTA),
    provenance: {
      officialDoc: input.officialDoc,
      legacyCommand: `sde tiny ${input.operation}`,
      verifiedAt: "2026-07-14" as const,
    },
  };
}

function toKebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replaceAll("_", "-");
}
