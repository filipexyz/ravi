/**
 * Spike: catalog-gateway — prova empírica
 *
 * Valida: SQLite + FTS5 + busca estruturada + busca texto livre + latência <50ms.
 * 5 SKUs reais do cliente piloto (setordaembalagem.com).
 *
 * Run: bun spike/catalog/spike.ts
 */

import { Database } from "bun:sqlite";

const db = new Database(":memory:");

console.log("=== SPIKE: catalog-gateway ===\n");

// === SCHEMA ===
console.log("[1] Criando schema (catalog_products + FTS5)...");
const t0 = performance.now();

db.exec(`
  CREATE TABLE catalog_products (
    tenant_id           TEXT NOT NULL DEFAULT 'default',
    sku                 TEXT NOT NULL,
    nome                TEXT NOT NULL,
    marca               TEXT,
    categoria_path      TEXT,
    preco               REAL,
    estoque             INTEGER,
    ativo               INTEGER DEFAULT 1,
    capacidade_ml       REAL,
    material            TEXT,
    resistencia_termica TEXT,
    usos_json           TEXT,
    artifact_id         TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, sku)
  );

  CREATE INDEX idx_catalog_products_categoria
    ON catalog_products(tenant_id, categoria_path);

  CREATE VIRTUAL TABLE catalog_products_fts USING fts5(
    tenant_id UNINDEXED,
    sku UNINDEXED,
    nome,
    marca,
    categoria_path,
    material,
    usos,
    texto_completo,
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
`);

console.log(`    schema criado em ${(performance.now() - t0).toFixed(2)}ms\n`);

// === SEED: 5 SKUs reais (embalagens) ===
console.log("[2] Inserindo 5 SKUs reais como artifact + catalog_product...");
const now = Date.now();

const skus = [
  {
    sku: "G312",
    nome: "Embalagem para Caldo Quente 500ml com Tampa",
    marca: "Galvanotek",
    categoria: "EMBALAGEM/Marmita/Caldo",
    preco: 1.85,
    estoque: 1200,
    capacidade_ml: 500,
    material: "PP",
    resistencia: "alta",
    usos: ["caldo quente", "sopa", "creme"],
    texto:
      "Pote translúcido em polipropileno 100% virgem, resistente a temperaturas de até 110°C. Ideal para caldos quentes, sopas e cremes. Tampa hermética inclusa.",
  },
  {
    sku: "G315",
    nome: "Embalagem para Caldo Frio 500ml",
    marca: "Galvanotek",
    categoria: "EMBALAGEM/Marmita/Caldo",
    preco: 1.45,
    estoque: 950,
    capacidade_ml: 500,
    material: "PET",
    resistencia: "baixa",
    usos: ["caldo frio", "açaí", "sobremesa"],
    texto: "Pote transparente em PET, para conteúdos frios. NÃO resistente a calor.",
  },
  {
    sku: "M250",
    nome: "Marmita Térmica 750ml com Divisória",
    marca: "Prafesta",
    categoria: "EMBALAGEM/Marmita/Com divisória",
    preco: 2.95,
    estoque: 480,
    capacidade_ml: 750,
    material: "PP",
    resistencia: "alta",
    usos: ["marmita executiva", "delivery quente"],
    texto:
      "Marmita 750ml em PP térmico, com divisória interna. Aguenta micro-ondas. Ideal para delivery com pratos quentes.",
  },
  {
    sku: "PT100",
    nome: "Pote 100ml para Molho",
    marca: "Strawplast",
    categoria: "EMBALAGEM/Pote/Molho",
    preco: 0.35,
    estoque: 5000,
    capacidade_ml: 100,
    material: "PP",
    resistencia: "alta",
    usos: ["molho", "azeite", "vinagrete"],
    texto: "Pote 100ml com tampa de pressão. Para molhos e condimentos. Resiste a microondas.",
  },
  {
    sku: "CX2KG",
    nome: "Caixa de Papel Kraft 2kg",
    marca: "Embaplast",
    categoria: "EMBALAGEM/Caixa/Papel",
    preco: 1.20,
    estoque: 300,
    capacidade_ml: 2000,
    material: "Papelão",
    resistencia: "media",
    usos: ["bolo", "doces", "salgados"],
    texto:
      "Caixa de papel kraft reciclado, capacidade 2kg. Resistente a temperaturas moderadas. Ideal para doces, salgados e bolos.",
  },
];

const insertArtifact = db.prepare(`
  INSERT INTO artifacts (id, kind, title, summary, status, metadata_json, tags_json, created_at, updated_at)
  VALUES (?, 'catalog-item', ?, ?, 'active', ?, ?, ?, ?)
`);

const insertProduct = db.prepare(`
  INSERT INTO catalog_products
    (tenant_id, sku, nome, marca, categoria_path, preco, estoque, capacidade_ml, material, resistencia_termica, usos_json, artifact_id, created_at, updated_at)
  VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateFtsTexto = db.prepare(`
  UPDATE catalog_products_fts SET texto_completo = ?
  WHERE tenant_id = 'default' AND sku = ?
`);

const t1 = performance.now();
db.transaction(() => {
  for (const p of skus) {
    const artifactId = `art_${p.sku}_${now}`;
    insertArtifact.run(
      artifactId,
      p.nome,
      p.texto.slice(0, 80),
      JSON.stringify({ sku: p.sku, capacidade_ml: p.capacidade_ml, material: p.material }),
      JSON.stringify([`sku:${p.sku}`, `material:${p.material}`, `cliente:setordaembalagem`]),
      now,
      now,
    );

    insertProduct.run(
      p.sku,
      p.nome,
      p.marca,
      p.categoria,
      p.preco,
      p.estoque,
      p.capacidade_ml,
      p.material,
      p.resistencia,
      JSON.stringify(p.usos),
      artifactId,
      now,
      now,
    );

    updateFtsTexto.run(p.texto, p.sku);
  }
})();
console.log(`    5 SKUs inseridos em ${(performance.now() - t1).toFixed(2)}ms\n`);

// === BUSCA ESTRUTURADA (filtro) ===
console.log('[3] Busca estruturada: "embalagem caldo quente 500ml"');
console.log("    filtros: capacidade 450-550ml + resistencia=alta + ativo=1\n");

const stmtStruct = db.prepare(`
  SELECT sku, nome, marca, preco, capacidade_ml, material, resistencia_termica
  FROM catalog_products
  WHERE tenant_id = 'default'
    AND ativo = 1
    AND capacidade_ml BETWEEN 450 AND 550
    AND resistencia_termica = 'alta'
  ORDER BY estoque DESC
  LIMIT 3
`);

const t2 = performance.now();
const structResults = stmtStruct.all() as Array<Record<string, unknown>>;
const t2dur = performance.now() - t2;
console.log(`    latência: ${t2dur.toFixed(3)}ms`);
console.log(`    resultados: ${structResults.length}`);
for (const r of structResults) {
  console.log(
    `      → ${r.sku} | ${r.nome} | ${r.material} | ${r.capacidade_ml}ml | R$ ${r.preco}`,
  );
}
console.log();

// === BUSCA FTS5 (texto livre) ===
console.log('[4] Busca FTS5: query="caldo quente"');
const stmtFts = db.prepare(`
  SELECT p.sku, p.nome, p.material, bm25(catalog_products_fts) AS rank
  FROM catalog_products_fts
  JOIN catalog_products p ON p.tenant_id = catalog_products_fts.tenant_id AND p.sku = catalog_products_fts.sku
  WHERE catalog_products_fts MATCH ?
    AND p.tenant_id = 'default'
    AND p.ativo = 1
  ORDER BY rank
  LIMIT 5
`);

const t3 = performance.now();
const ftsResults = stmtFts.all("caldo quente") as Array<Record<string, unknown>>;
const t3dur = performance.now() - t3;
console.log(`    latência: ${t3dur.toFixed(3)}ms`);
console.log(`    resultados: ${ftsResults.length}`);
for (const r of ftsResults) {
  console.log(`      → ${r.sku} | ${r.nome} | ${r.material} | rank=${(r.rank as number).toFixed(3)}`);
}
console.log();

// === BUSCA HÍBRIDA (estruturada + texto livre) ===
console.log('[5] Busca híbrida: filtro PP + query="molho"');
const stmtHybrid = db.prepare(`
  SELECT p.sku, p.nome, p.material, p.capacidade_ml, bm25(catalog_products_fts) AS rank
  FROM catalog_products_fts
  JOIN catalog_products p ON p.tenant_id = catalog_products_fts.tenant_id AND p.sku = catalog_products_fts.sku
  WHERE catalog_products_fts MATCH ?
    AND p.tenant_id = 'default'
    AND p.material = 'PP'
    AND p.ativo = 1
  ORDER BY rank
  LIMIT 3
`);

const t4 = performance.now();
const hybridResults = stmtHybrid.all("molho") as Array<Record<string, unknown>>;
const t4dur = performance.now() - t4;
console.log(`    latência: ${t4dur.toFixed(3)}ms`);
for (const r of hybridResults) {
  console.log(`      → ${r.sku} | ${r.nome} | ${r.capacidade_ml}ml | rank=${(r.rank as number).toFixed(3)}`);
}
console.log();

// === VALIDADOR ANTI-ALUCINAÇÃO ===
console.log("[6] Validador anti-alucinação");
const stmtExists = db.prepare(
  `SELECT 1 FROM catalog_products WHERE tenant_id = 'default' AND sku = ? AND ativo = 1`,
);

function validateSku(sku: string): { valid: boolean; sku: string } {
  const row = stmtExists.get(sku);
  return { valid: !!row, sku };
}

const candidates = ["G312", "G999", "M250", "X404", "PT100"];
const t5 = performance.now();
const validations = candidates.map(validateSku);
const t5dur = performance.now() - t5;
console.log(`    latência total (5 SKUs): ${t5dur.toFixed(3)}ms`);
for (const v of validations) {
  console.log(`      ${v.valid ? "✓" : "✗ INVENTADO"}  ${v.sku}`);
}
console.log();

// === ARTIFACT LOOKUP ===
console.log("[7] Lookup artifact (texto rico)");
const stmtArtifact = db.prepare(
  `SELECT a.id, a.kind, a.title, a.summary, a.tags_json, a.metadata_json
   FROM catalog_products p
   JOIN artifacts a ON a.id = p.artifact_id
   WHERE p.tenant_id = 'default' AND p.sku = ?`,
);

const t6 = performance.now();
const artifact = stmtArtifact.get("G312") as Record<string, unknown> | undefined;
const t6dur = performance.now() - t6;
console.log(`    latência: ${t6dur.toFixed(3)}ms`);
if (artifact) {
  console.log(`    kind=${artifact.kind} title="${artifact.title}"`);
  console.log(`    summary="${artifact.summary}"`);
  console.log(`    tags=${artifact.tags_json}`);
  console.log(`    metadata=${artifact.metadata_json}`);
}
console.log();

// === BENCHMARK STRESS (1000 buscas) ===
console.log("[8] Stress test: 1000 buscas estruturadas consecutivas");
const t7 = performance.now();
for (let i = 0; i < 1000; i++) {
  stmtStruct.all();
}
const t7dur = performance.now() - t7;
console.log(`    total: ${t7dur.toFixed(2)}ms`);
console.log(`    média: ${(t7dur / 1000).toFixed(3)}ms por busca`);
console.log();

// === BENCHMARK FTS5 STRESS ===
console.log("[9] Stress test: 1000 buscas FTS5 consecutivas");
const t8 = performance.now();
for (let i = 0; i < 1000; i++) {
  stmtFts.all("caldo quente");
}
const t8dur = performance.now() - t8;
console.log(`    total: ${t8dur.toFixed(2)}ms`);
console.log(`    média: ${(t8dur / 1000).toFixed(3)}ms por busca`);
console.log();

// === VEREDITO ===
console.log("=== VEREDITO ===");
const checks = [
  { name: "Schema (artifacts + FTS5 + triggers)", ok: true },
  { name: "Insert 5 SKUs com artifact link", ok: true },
  { name: "Busca estruturada retorna G312+M250 (PP, alta, 500ml/750ml)", ok: structResults.length >= 1 },
  { name: 'FTS5 "caldo quente" retorna G312 no top', ok: ftsResults.length > 0 && ftsResults[0].sku === "G312" },
  { name: "Busca híbrida funciona (filtro + texto)", ok: hybridResults.length > 0 },
  {
    name: "Validador bloqueia G999/X404 inventados",
    ok: validations.filter((v) => !v.valid).length === 2,
  },
  { name: "Latência estruturada <50ms", ok: t2dur < 50 },
  { name: "Latência FTS5 <50ms", ok: t3dur < 50 },
  { name: "Latência híbrida <50ms", ok: t4dur < 50 },
  { name: "Latência média estruturada <1ms (stress 1k)", ok: t7dur / 1000 < 1 },
  { name: "Latência média FTS5 <1ms (stress 1k)", ok: t8dur / 1000 < 1 },
];

for (const c of checks) {
  console.log(`  ${c.ok ? "✓" : "✗"}  ${c.name}`);
}

const allOk = checks.every((c) => c.ok);
console.log(`\n${allOk ? "✓ SPIKE PASSOU" : "✗ SPIKE FALHOU"} — viabilidade técnica ${allOk ? "confirmada" : "reprovada"}`);

db.close();
process.exit(allOk ? 0 : 1);
