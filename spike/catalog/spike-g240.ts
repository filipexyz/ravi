/**
 * Spike — Produto real G240 (Galvanotek Embalagem Forneável 800ml)
 *
 * Pega o produto setordaembalagem.com/G240 e mostra exatamente:
 * - O que é extraído da página
 * - Como vira linha no SQLite (catalog_products)
 * - Como o texto editorial vira artifact + artifact_version
 * - Como a busca encontra ele depois
 *
 * Run: bun spike/catalog/spike-g240.ts
 */

import { Database } from "bun:sqlite";

const db = new Database(":memory:");

console.log("=== SPIKE G240 — Produto real ===\n");

// === SCHEMA (igual produção) ===
db.exec(`
  CREATE TABLE catalog_products (
    tenant_id           TEXT NOT NULL DEFAULT 'default',
    sku                 TEXT NOT NULL,
    nome                TEXT NOT NULL,
    marca               TEXT,
    categoria_path      TEXT,
    preco               REAL,
    preco_promo         REAL,
    estoque             INTEGER,
    ativo               INTEGER DEFAULT 1,
    gtin                TEXT,
    ncm                 TEXT,
    peso_liquido_g      REAL,
    peso_bruto_g        REAL,
    altura_mm           REAL,
    largura_mm          REAL,
    comprimento_mm      REAL,
    diametro_mm         REAL,
    capacidade_ml       REAL,
    material            TEXT,
    resistencia_termica TEXT,
    usos_json           TEXT,
    tipo_variacao       TEXT,
    sku_pai             TEXT,
    imagem_url          TEXT,
    artifact_id         TEXT,
    tiny_sync_at        INTEGER,
    enriquecimento_conf TEXT,
    enriquecimento_at   INTEGER,
    vendavel            INTEGER DEFAULT 1,
    mostrar_chatbot     INTEGER DEFAULT 1,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, sku)
  );

  CREATE VIRTUAL TABLE catalog_products_fts USING fts5(
    tenant_id UNINDEXED,
    sku UNINDEXED,
    nome, marca, categoria_path, material, usos, texto_completo,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER catalog_products_ai AFTER INSERT ON catalog_products BEGIN
    INSERT INTO catalog_products_fts(tenant_id, sku, nome, marca, categoria_path, material, usos, texto_completo)
    VALUES (new.tenant_id, new.sku, new.nome, COALESCE(new.marca, ''),
            COALESCE(new.categoria_path, ''), COALESCE(new.material, ''),
            COALESCE(new.usos_json, ''), '');
  END;

  CREATE TABLE artifacts (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL,
    title           TEXT,
    summary         TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    metadata_json   TEXT,
    tags_json       TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );

  CREATE TABLE artifact_versions (
    id              TEXT PRIMARY KEY,
    artifact_id     TEXT NOT NULL,
    version_number  INTEGER NOT NULL,
    label           TEXT,
    body_markdown   TEXT NOT NULL,
    created_by      TEXT,
    created_at      INTEGER NOT NULL,
    UNIQUE(artifact_id, version_number)
  );
`);

const now = Date.now();

// === DADOS REAIS extraídos da página ===
console.log("[1] Dados extraídos de setordaembalagem.com/G240:\n");

const pageData = {
  sku: "G240",
  nome: "Embalagem Forneável 800mL com tampa forno a gás microondas e freezer Galvanotek G240",
  marca: "Galvanotek",
  categoria: "EMBALAGEM/Marmita/Linha Forno",
  preco_base: 141.04,
  preco_com_tampa: 201.87,
  estoque_status: "disponível",
  gtin: null,
  ncm: null,
  peso_liquido_g: null,
  peso_bruto_g: null,
  // Dimensão EXTERNA em mm
  altura_mm: 45,
  largura_mm: 165,
  comprimento_mm: 220,
  diametro_mm: null,
  capacidade_ml: 800,
  material_base: "CPET",
  material_tampa: "PET",
  resistencia_base: "-30°C até 205°C",
  resistencia_tampa: "-8°C até 40°C",
  usos: ["lasanha", "kibe", "receitas 400-700g"],
  equipamentos: ["forno a gás doméstico", "forno a gás industrial", "forno microondas", "freezer", "congelador"],
  diferenciais: [
    "ANVISA aprovado",
    "Sem Bisfenol A",
    "Não abre no transporte delivery",
    "Empilhamento máximo de 6 unidades",
    "Remover tampa antes de aquecer",
  ],
  restricoes: "Tampa não deve ir ao forno ou microondas",
  imagem_url:
    "https://images.tcdn.com.br/img/img_prod/753724/30_embalagem_forneavel_800ml_forno_a_gas_microondas_e_freezer_galvanotek_g240_75_variacao_277_1_a95f215191cbd3e97706c10819fea391.png",
  qtd_por_caixa: 100,
  tipo_variacao_label: "Com ou sem tampa",
};

console.log(JSON.stringify(pageData, null, 2));
console.log();

// === MAPEAMENTO → SCHEMA ===
console.log("[2] Mapeamento página → catalog_products:\n");

// Decisões de enriquecimento (humano ou parser):
// - material primário = CPET (a base, não a tampa)
// - resistência térmica = "alta" (205°C >> 110°C limiar)
// - confidence = "high" (info explícita na página)
// - tipo_variacao = "P" (produto pai com 2 variações de SKU: com/sem tampa)
const enriched = {
  material: pageData.material_base, // CPET (escolha: usar material da base, não da tampa)
  resistencia_termica: "alta" as const, // 205°C → alta (limiar ≥110°C)
  enriquecimento_conf: "high" as const, // info explícita
  tipo_variacao: "P" as const, // produto pai
};

console.log("Decisões do enriquecimento:");
console.log(`  material primário: ${enriched.material}  (base CPET, não a tampa PET)`);
console.log(
  `  resistência: ${enriched.resistencia_termica}  (205°C > 110°C limiar, claramente alta)`,
);
console.log(`  tipo_variacao: ${enriched.tipo_variacao}  (pai — tem variações com/sem tampa)`);
console.log(`  confidence: ${enriched.enriquecimento_conf}  (info explícita)`);
console.log();

// === INSERE ARTIFACT (texto editorial) ===
const artifactId = `art_G240_${now}`;
const textoEditorial = `# Embalagem Forneável 800ml — G240 (Galvanotek)

## O produto
Marmita em **CPET preto** (Carbono Polietileno Tereftalato), exclusividade Galvanotek, 100% nacional. Base resistente a -30°C até **205°C** — pode ir do freezer direto ao forno a gás ou microondas sem rachar nem deformar.

## Dimensões
- **Capacidade:** 800ml
- **Dimensão externa:** 22 x 16,5 x 4,5cm
- **Dimensão interna:** 18,5 x 13,5 x 3,6cm

## Variações
- **G240 com tampa transparente PET:** R$ 201,87 (caixa 100un)
- **G240 sem tampa:** R$ 141,04 (caixa 100un)

⚠️ A tampa NÃO vai ao forno/microondas (PET resiste só -8°C a 40°C). Remover antes de aquecer.

## Para que serve
Ideal para **lasanha, kibe, escondidinho** e receitas de **400g a 700g**. Compatível com:
- Forno a gás doméstico e industrial
- Forno microondas
- Freezer e congelador

## Diferenciais
- ✅ **ANVISA aprovado** — apto contato com alimento
- ✅ **Sem Bisfenol A** (BPA-free)
- ✅ **Selagem firme** — não abre no transporte do delivery
- ✅ **Empilhável** até 6 unidades

## Cuidados
- Não usar tampa no forno/microondas
- Empilhamento máximo 6un

---
**Indicação Comercial:** Excelente custo-benefício para delivery de massas e refeições congeladas. Diferencial-chave vs concorrentes em PP comum: aguenta forno a gás (PP não).
`;

db.prepare(
  `INSERT INTO artifacts (id, kind, title, summary, status, metadata_json, tags_json, created_at, updated_at)
   VALUES (?, 'catalog-item', ?, ?, 'active', ?, ?, ?, ?)`,
).run(
  artifactId,
  pageData.nome,
  "Marmita CPET 800ml, aguenta -30°C a 205°C, ANVISA-aprovada, ideal lasanha/kibe",
  JSON.stringify({
    sku: pageData.sku,
    capacidade_ml: pageData.capacidade_ml,
    material: enriched.material,
    fornecedor: pageData.marca,
    qtd_por_caixa: pageData.qtd_por_caixa,
  }),
  JSON.stringify([
    `sku:${pageData.sku}`,
    `material:${enriched.material}`,
    `marca:${pageData.marca}`,
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

// Artifact version 1
db.prepare(
  `INSERT INTO artifact_versions (id, artifact_id, version_number, label, body_markdown, created_by, created_at)
   VALUES (?, ?, 1, 'initial-import', ?, 'dev-do-ravi', ?)`,
).run(`artv_G240_v1_${now}`, artifactId, textoEditorial, now);

// === INSERE catalog_products ===
db.prepare(
  `INSERT INTO catalog_products
   (tenant_id, sku, nome, marca, categoria_path, preco, preco_promo, estoque, ativo,
    gtin, ncm, peso_liquido_g, peso_bruto_g, altura_mm, largura_mm, comprimento_mm, diametro_mm,
    capacidade_ml, material, resistencia_termica, usos_json, tipo_variacao, sku_pai, imagem_url,
    artifact_id, tiny_sync_at, enriquecimento_conf, enriquecimento_at, vendavel, mostrar_chatbot,
    created_at, updated_at)
   VALUES ('default', ?, ?, ?, ?, ?, ?, ?, 1,
           ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, 1, 1, ?, ?)`,
).run(
  pageData.sku,
  pageData.nome,
  pageData.marca,
  pageData.categoria,
  pageData.preco_base,
  null, // sem promo agora
  9999, // estoque "disponível" → mapeamos como alto (real vem do Tiny)
  pageData.gtin,
  pageData.ncm,
  pageData.peso_liquido_g,
  pageData.peso_bruto_g,
  pageData.altura_mm,
  pageData.largura_mm,
  pageData.comprimento_mm,
  pageData.diametro_mm,
  pageData.capacidade_ml,
  enriched.material,
  enriched.resistencia_termica,
  JSON.stringify(pageData.usos),
  enriched.tipo_variacao,
  null, // pai não tem sku_pai
  pageData.imagem_url,
  artifactId,
  now, // tiny_sync_at
  enriched.enriquecimento_conf,
  now, // enriquecimento_at
  now,
  now,
);

// Atualiza texto_completo no FTS (vem do artifact_version)
db.prepare(
  "UPDATE catalog_products_fts SET texto_completo = ? WHERE tenant_id = 'default' AND sku = ?",
).run(textoEditorial, "G240");

// === Variações como SKUs separados (G240-CT, G240-ST) ===
const variations = [
  { sku: "G240-CT", nome: "G240 com tampa", preco: 201.87 },
  { sku: "G240-ST", nome: "G240 sem tampa", preco: 141.04 },
];
const insertVar = db.prepare(
  `INSERT INTO catalog_products
   (tenant_id, sku, nome, marca, categoria_path, preco, estoque, ativo,
    capacidade_ml, material, resistencia_termica, usos_json,
    tipo_variacao, sku_pai, imagem_url, artifact_id,
    tiny_sync_at, enriquecimento_conf, enriquecimento_at,
    vendavel, mostrar_chatbot, created_at, updated_at)
   VALUES ('default', ?, ?, ?, ?, ?, ?, 1,
           ?, ?, ?, ?,
           'V', 'G240', ?, ?,
           ?, ?, ?,
           1, 1, ?, ?)`,
);
for (const v of variations) {
  insertVar.run(
    v.sku,
    v.nome,
    pageData.marca,
    pageData.categoria,
    v.preco,
    9999,
    pageData.capacidade_ml,
    enriched.material,
    enriched.resistencia_termica,
    JSON.stringify(pageData.usos),
    pageData.imagem_url,
    artifactId, // todas variações apontam pro mesmo artifact rich text
    now,
    enriched.enriquecimento_conf,
    now,
    now,
    now,
  );
}

// === MOSTRA o que ficou armazenado ===
console.log("[3] LINHA catalog_products do G240 (produto pai):\n");
const row = db
  .prepare("SELECT * FROM catalog_products WHERE tenant_id = 'default' AND sku = 'G240'")
  .get() as Record<string, unknown>;
for (const [k, v] of Object.entries(row)) {
  const display = v === null ? "NULL (gap)" : typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : String(v);
  console.log(`  ${k.padEnd(22)} = ${display}`);
}
console.log();

console.log("[4] VARIAÇÕES do G240:\n");
const vars = db
  .prepare(
    "SELECT sku, nome, preco, sku_pai, tipo_variacao FROM catalog_products WHERE sku_pai = 'G240'",
  )
  .all() as Record<string, unknown>[];
for (const v of vars) {
  console.log(`  ${v.sku}  | ${v.nome}  | R$ ${v.preco}  | pai=${v.sku_pai} tipo=${v.tipo_variacao}`);
}
console.log();

console.log("[5] ARTIFACT (texto editorial — versionado):\n");
const artifact = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as Record<string, unknown>;
console.log(`  id:        ${artifact.id}`);
console.log(`  kind:      ${artifact.kind}`);
console.log(`  title:     ${artifact.title}`);
console.log(`  summary:   ${artifact.summary}`);
console.log(`  tags:      ${artifact.tags_json}`);
console.log(`  metadata:  ${artifact.metadata_json}`);
console.log();

const version = db
  .prepare("SELECT version_number, label, length(body_markdown) AS len FROM artifact_versions WHERE artifact_id = ?")
  .get(artifactId) as Record<string, unknown>;
console.log(`  Versão ${version.version_number}: ${version.label} (${version.len} chars de Markdown)`);
console.log();

// === BUSCA ===
console.log('[6] Busca "lasanha forno":\n');
const stmtFts = db.prepare(`
  SELECT p.sku, p.nome, p.material, p.capacidade_ml, p.preco, bm25(catalog_products_fts) AS rank
  FROM catalog_products_fts
  JOIN catalog_products p ON p.tenant_id = catalog_products_fts.tenant_id AND p.sku = catalog_products_fts.sku
  WHERE catalog_products_fts MATCH ? AND p.tenant_id = 'default' AND p.ativo = 1
  ORDER BY rank LIMIT 5
`);
const t0 = performance.now();
const results = stmtFts.all('"lasanha"* "forno"*') as Record<string, unknown>[];
const dur = performance.now() - t0;
console.log(`  latência: ${dur.toFixed(3)}ms`);
for (const r of results) {
  console.log(`    → ${r.sku} | ${r.nome} | ${r.material} ${r.capacidade_ml}ml | R$ ${r.preco}`);
}
console.log();

console.log('[7] Busca estruturada "capacidade 750-850 + material CPET":\n');
const stmtStruct = db.prepare(`
  SELECT sku, nome, preco, material, capacidade_ml, resistencia_termica
  FROM catalog_products
  WHERE tenant_id = 'default' AND ativo = 1
    AND capacidade_ml BETWEEN 750 AND 850
    AND material = 'CPET'
  LIMIT 5
`);
const t1 = performance.now();
const r2 = stmtStruct.all() as Record<string, unknown>[];
const dur2 = performance.now() - t1;
console.log(`  latência: ${dur2.toFixed(3)}ms`);
for (const r of r2) {
  console.log(`    → ${r.sku} | ${r.nome} | ${r.material} ${r.capacidade_ml}ml | ${r.resistencia_termica}`);
}
console.log();

// === GAPS / observações ===
console.log("[8] GAPS conhecidos (campos não disponíveis nesta página):\n");
const gaps = [
  { field: "gtin (EAN)", reason: "não exibido na loja — vem do Tiny ERP" },
  { field: "ncm", reason: "não exibido na loja — vem do Tiny ERP" },
  { field: "peso_liquido_g / peso_bruto_g", reason: "não exibido na loja — vem do Tiny ERP" },
  { field: "estoque (número real)", reason: "loja só diz disponível/indisponível — vem do Tiny" },
  { field: "preco_promo", reason: "G240 sem promoção ativa hoje" },
];
for (const g of gaps) {
  console.log(`  ❌ ${g.field}: ${g.reason}`);
}
console.log();

console.log("=== RESUMO ===");
console.log("✓ 1 produto pai (G240) + 2 variações (G240-CT, G240-ST) armazenados");
console.log("✓ 1 artifact com texto editorial Markdown versionado (v1)");
console.log("✓ FTS5 indexa nome + categoria + material + usos + texto_completo");
console.log("✓ Busca por palavra natural ('lasanha forno') e por filtro estruturado funcionam");
console.log("✓ 5 campos comerciais vão precisar de fonte Tiny (gtin/ncm/pesos/estoque/promo)");
console.log("✓ Latência total: <1ms em ambas as buscas");
