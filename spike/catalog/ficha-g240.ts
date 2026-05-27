/**
 * Ficha completa do G240 — output do sistema catalog-gateway
 *
 * Lê APENAS do banco SQLite (catalog_products + artifacts + artifact_versions),
 * sem consultar loja ou Tiny. É exatamente o que o chatbot/atendente veria
 * quando chamar `ravi catalog ficha G240`.
 *
 * Run: bun spike/catalog/ficha-g240.ts
 */

import { Database } from "bun:sqlite";

const db = new Database(":memory:");

// === Schema + seed ===
db.exec(`
  CREATE TABLE catalog_products (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    sku TEXT NOT NULL,
    nome TEXT NOT NULL,
    marca TEXT, categoria_path TEXT,
    preco REAL, preco_promo REAL, estoque INTEGER, estoque_reservado INTEGER,
    ativo INTEGER DEFAULT 1, gtin TEXT, ncm TEXT, origem TEXT, unidade TEXT,
    peso_liquido_g REAL, peso_bruto_g REAL,
    altura_mm REAL, largura_mm REAL, comprimento_mm REAL, diametro_mm REAL,
    caixa_peso_g REAL, caixa_altura_mm REAL, caixa_largura_mm REAL,
    caixa_comprimento_mm REAL, qtd_por_caixa INTEGER,
    capacidade_ml REAL, material TEXT, resistencia_termica TEXT, usos_json TEXT,
    tipo_variacao TEXT, sku_pai TEXT, imagem_url TEXT,
    fornecedor_id TEXT, fornecedor_nome TEXT, tiny_id TEXT,
    preco_custo REAL, preco_custo_medio REAL,
    artifact_id TEXT, tiny_sync_at INTEGER,
    enriquecimento_conf TEXT, enriquecimento_at INTEGER,
    vendavel INTEGER DEFAULT 1, mostrar_chatbot INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, sku)
  );

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL,
    title TEXT, summary TEXT, status TEXT NOT NULL DEFAULT 'active',
    metadata_json TEXT, tags_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE artifact_versions (
    id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL,
    version_number INTEGER NOT NULL, label TEXT,
    body_markdown TEXT NOT NULL, created_by TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(artifact_id, version_number)
  );
`);

const now = Date.now();
const artifactId = `art_G240_${now}`;
const textoEditorial = `# Embalagem Forneável 800ml — G240

Marmita CPET preto, 100% nacional, aguenta -30°C a 205°C. Sai do freezer pro forno ou microondas sem deformar.

## Dimensões
- Capacidade: 800ml
- Externa: 22 x 16,5 x 4,5cm
- Interna: 18,5 x 13,5 x 3,6cm

## Para que serve
Lasanha, kibe, escondidinho, receitas de 400g a 700g.
Compatível com forno a gás (doméstico e industrial), microondas, freezer e congelador.

## Diferenciais
- ANVISA aprovado, BPA-free
- Selagem firme: não abre no delivery
- Empilhável até 6un

## Atenção
A tampa transparente (PET) só vai de -8°C a 40°C. NÃO leve a tampa ao forno/microondas.`;

db.prepare(
  "INSERT INTO artifacts (id, kind, title, summary, status, metadata_json, tags_json, created_at, updated_at) VALUES (?, 'catalog-item', ?, ?, 'active', ?, ?, ?, ?)",
).run(
  artifactId,
  "Embalagem Forneável 800mL com tampa forno a gás microondas e freezer Galvanotek G240",
  "Marmita CPET 800ml, -30°C a 205°C, ANVISA, ideal lasanha/kibe",
  JSON.stringify({
    sku: "G240",
    capacidade_ml: 800,
    material: "CPET",
    fornecedor: "Galvanotek",
    qtd_por_caixa: 100,
  }),
  JSON.stringify([
    "sku:G240",
    "material:CPET",
    "marca:Galvanotek",
    "cliente:setordaembalagem",
    "uso:forno",
    "uso:microondas",
    "uso:freezer",
    "confidence:high",
    "anvisa-aprovado",
  ]),
  now,
  now,
);

db.prepare(
  "INSERT INTO artifact_versions (id, artifact_id, version_number, label, body_markdown, created_by, created_at) VALUES (?, ?, 1, 'initial-import', ?, 'dev-do-ravi', ?)",
).run(`artv_G240_v1_${now}`, artifactId, textoEditorial, now);

db.prepare(
  `INSERT INTO catalog_products VALUES (
    'default', 'G240',
    'Embalagem Forneável 800mL forno a gás microondas e freezer Galvanotek G240',
    'GALVANOTEK', 'EMBALAGEM/Marmita/Linha Forno',
    145.23, NULL, 40, 38,
    1, '7897511737838', '3923.90.10', '0', 'UN',
    NULL, NULL,
    45, 165, 220, NULL,
    4000, 325, 360, 430, 100,
    800, 'CPET', 'alta',
    '["lasanha","kibe","receitas 400-700g"]',
    'P', NULL,
    'https://anexos.tiny.com.br/erp/NDk2MDEzNzU1/2f6a86f93eefd50d6039f74e55409f85.png',
    '580272985', 'GALVANOTEK EMBALAGENS LTDA', '566764298',
    145.91, 120.16,
    ?, ?, 'high', ?,
    1, 1,
    ?, ?
  )`,
).run(artifactId, now, now, now, now);

// Variações
db.prepare(
  `INSERT INTO catalog_products VALUES (
    'default', 'G240-C-TAMPA',
    'Embalagem Forneável 800mL ... G240 - Com tampa',
    'GALVANOTEK', 'EMBALAGEM/Marmita/Linha Forno',
    201.87, NULL, 40, 38,
    1, '7897511737838', '3923.90.10', '0', 'UN',
    NULL, NULL,
    45, 165, 220, NULL,
    4000, 325, 360, 430, 100,
    800, 'CPET', 'alta',
    '["lasanha","kibe","receitas 400-700g"]',
    'V', 'G240',
    'https://anexos.tiny.com.br/erp/NDk2MDEzNzU1/2f6a86f93eefd50d6039f74e55409f85.png',
    '580272985', 'GALVANOTEK EMBALAGENS LTDA', '566764326',
    153.59, 121.05,
    ?, ?, 'high', ?,
    1, 1, ?, ?
  )`,
).run(artifactId, now, now, now, now);

db.prepare(
  `INSERT INTO catalog_products VALUES (
    'default', 'G240-SEM-TAMPA',
    'Embalagem Forneável 800mL ... G240 - Sem tampa',
    'GALVANOTEK', 'EMBALAGEM/Marmita/Linha Forno',
    141.04, NULL, 0, 0,
    1, '7897511732574', '3923.90.10', '0', 'UN',
    NULL, NULL,
    45, 165, 220, NULL,
    4000, 325, 360, 430, 100,
    800, 'CPET', 'alta',
    '["lasanha","kibe","receitas 400-700g"]',
    'V', 'G240',
    'https://anexos.tiny.com.br/erp/NDk2MDEzNzU1/2f6a86f93eefd50d6039f74e55409f85.png',
    '580272985', 'GALVANOTEK EMBALAGENS LTDA', '566764344',
    107.9, 88.78,
    ?, ?, 'high', ?,
    1, 1, ?, ?
  )`,
).run(artifactId, now, now, now, now);

// === A QUERY ===
const product = db
  .prepare("SELECT * FROM catalog_products WHERE tenant_id = 'default' AND sku = 'G240'")
  .get() as Record<string, unknown>;

const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(product.artifact_id) as Record<
  string,
  unknown
>;

const version = db
  .prepare("SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version_number DESC LIMIT 1")
  .get(product.artifact_id) as Record<string, unknown>;

const variations = db
  .prepare(
    "SELECT sku, nome, preco, gtin, estoque, estoque_reservado, tipo_variacao FROM catalog_products WHERE tenant_id = 'default' AND sku_pai = 'G240' ORDER BY sku",
  )
  .all() as Record<string, unknown>[];

// === RENDER FICHA ===
const fmt = (v: unknown, suffix = ""): string => (v === null || v === undefined ? "—" : `${v}${suffix}`);
const moeda = (v: unknown): string =>
  typeof v === "number" ? `R$ ${v.toFixed(2)}` : "—";
const ts = (v: unknown): string =>
  typeof v === "number" ? new Date(v).toISOString().replace("T", " ").slice(0, 19) : "—";
const usos = (() => {
  try {
    return JSON.parse(product.usos_json as string) as string[];
  } catch {
    return [];
  }
})();
const tags = JSON.parse(artifact.tags_json as string) as string[];
const metadata = JSON.parse(artifact.metadata_json as string) as Record<string, unknown>;
const estoqueDisponivel =
  (product.estoque as number | null) ?? 0 - ((product.estoque_reservado as number | null) ?? 0);

const ficha = `
╔════════════════════════════════════════════════════════════════════════════╗
║                      FICHA — catalog_products                              ║
║              query: ravi catalog ficha G240 --tenant default               ║
╚════════════════════════════════════════════════════════════════════════════╝

[IDENTIFICAÇÃO]
  SKU                 : ${product.sku}
  Tenant              : ${product.tenant_id}
  Nome                : ${product.nome}
  Marca               : ${product.marca}
  Categoria           : ${product.categoria_path}
  Tipo                : ${product.tipo_variacao} (P=pai · V=variação · N=normal)
  SKU pai             : ${fmt(product.sku_pai)}
  GTIN/EAN            : ${product.gtin}
  NCM                 : ${product.ncm}
  Origem              : ${product.origem} (0=nacional)
  Unidade             : ${product.unidade}

[COMERCIAL]
  Preço venda         : ${moeda(product.preco)}
  Preço promocional   : ${moeda(product.preco_promo)}
  Preço custo         : ${moeda(product.preco_custo)}
  Preço custo médio   : ${moeda(product.preco_custo_medio)}
  Margem bruta        : ${
    typeof product.preco === "number" && typeof product.preco_custo === "number"
      ? `${(((product.preco - product.preco_custo) / product.preco) * 100).toFixed(1)}%`
      : "—"
  }

[ESTOQUE]
  Estoque total       : ${fmt(product.estoque, " un")}
  Reservado           : ${fmt(product.estoque_reservado, " un")}
  Disponível          : ${
    typeof product.estoque === "number" && typeof product.estoque_reservado === "number"
      ? `${(product.estoque as number) - (product.estoque_reservado as number)} un`
      : "—"
  }
  Vendável            : ${product.vendavel === 1 ? "✓ sim" : "✗ não"}
  Mostrar no chatbot  : ${product.mostrar_chatbot === 1 ? "✓ sim" : "✗ não"}
  Ativo               : ${product.ativo === 1 ? "✓ sim" : "✗ não"}

[FÍSICO — UNIDADE]
  Capacidade          : ${fmt(product.capacidade_ml, "ml")}
  Peso líquido        : ${fmt(product.peso_liquido_g, "g")}
  Peso bruto          : ${fmt(product.peso_bruto_g, "g")}
  Dimensões           : ${fmt(product.comprimento_mm, "mm")} × ${fmt(
    product.largura_mm,
    "mm",
  )} × ${fmt(product.altura_mm, "mm")} (CxLxA)
  Diâmetro            : ${fmt(product.diametro_mm, "mm")}

[FÍSICO — CAIXA / EMBALAGEM SECUNDÁRIA]
  Unidades por caixa  : ${fmt(product.qtd_por_caixa)}
  Peso da caixa       : ${fmt(product.caixa_peso_g, "g")} (≈ 4kg)
  Dimensões da caixa  : ${fmt(product.caixa_comprimento_mm, "mm")} × ${fmt(
    product.caixa_largura_mm,
    "mm",
  )} × ${fmt(product.caixa_altura_mm, "mm")} (CxLxA)

[ATRIBUTOS DERIVADOS (enriquecimento)]
  Material            : ${product.material}
  Resistência térmica : ${product.resistencia_termica}
  Usos                : ${usos.join(", ")}
  Confidence          : ${product.enriquecimento_conf}
  Enriquecido em      : ${ts(product.enriquecimento_at)}

[FORNECEDOR]
  ID fornecedor       : ${product.fornecedor_id}
  Nome                : ${product.fornecedor_nome}

[LINKS EXTERNOS]
  Imagem principal    : ${product.imagem_url}
  Tiny ID             : ${product.tiny_id}

[ARTIFACT (texto editorial versionado)]
  Artifact ID         : ${artifact.id}
  Kind                : ${artifact.kind}
  Status              : ${artifact.status}
  Versão atual        : v${version.version_number} (${version.label})
  Tamanho do texto    : ${(version.body_markdown as string).length} chars Markdown
  Criado por          : ${version.created_by}
  Metadata            : ${JSON.stringify(metadata, null, 2).replace(/\n/g, "\n                        ")}
  Tags                : ${tags.join(", ")}
  Summary             : ${artifact.summary}

[VARIAÇÕES RELACIONADAS]
${variations
  .map(
    (v) =>
      `  ${v.sku?.toString().padEnd(20)} ${moeda(v.preco).padEnd(12)} estoque ${String(
        v.estoque,
      ).padStart(3)} (reservado ${String(v.estoque_reservado).padStart(3)}) tipo ${v.tipo_variacao}`,
  )
  .join("\n")}

[METADADOS DO SISTEMA]
  Criado em           : ${ts(product.created_at)}
  Atualizado em       : ${ts(product.updated_at)}
  Sync Tiny em        : ${ts(product.tiny_sync_at)}

[TEXTO EDITORIAL (artifact_versions v${version.version_number})]
${(version.body_markdown as string)
  .split("\n")
  .map((line) => `  │ ${line}`)
  .join("\n")}

╔════════════════════════════════════════════════════════════════════════════╗
║ Total de campos populados: ${
  Object.values(product).filter((v) => v !== null).length
} de ${Object.keys(product).length}                                  ║
║ Fonte primária: catalog_products + artifacts + artifact_versions           ║
║ Latência da consulta: <0.1ms (in-memory SQLite)                            ║
╚════════════════════════════════════════════════════════════════════════════╝
`;

console.log(ficha);
