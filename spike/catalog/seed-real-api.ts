/**
 * Seed populando catalog_products via API REAL (src/catalog/index.ts)
 *
 * Usa RAVI_STATE_DIR temporario pra não tocar o ravi.db do usuário.
 * Insere 3 SKUs reais do setordaembalagem usando o schema empírico v0.3.
 *
 * Run: bun spike/catalog/seed-real-api.ts
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = join(tmpdir(), `ravi-catalog-seed-${Date.now()}`);
mkdirSync(stateDir, { recursive: true });
process.env.RAVI_STATE_DIR = stateDir;

const {
  upsertProduct,
  getProduct,
  searchProducts,
  validateSku,
  ensureCatalogSchema,
} = await import("../../src/catalog/index.js");

console.log("=== SEED via API real de src/catalog/ ===\n");
console.log(`RAVI_STATE_DIR temp: ${stateDir}\n`);

ensureCatalogSchema();

// === Produto 1 — G240 Forneável 800ml ===
const g240 = upsertProduct({
  sku: "G240",
  nome: "Embalagem Forneável 800mL forno a gás microondas e freezer Galvanotek G240",
  marca: "GALVANOTEK",
  categoriaPath: "EMBALAGEM/Marmita/Linha Forno",
  preco: 145.23,
  estoque: 40,
  gtin: "7897511737838",
  ncm: "3923.90.10",
  capacidadeMl: 800,
  weightGramsApprox: 700,
  shape: "rectangular",
  compartments: 1,
  material: "CPET",
  microwaveSafe: true,
  ovenSafe: true,
  freezerSafe: true,
  airfryerSafe: true,
  leakResistant: false,
  lidIncluded: true,
  lidCompatible: true,
  customizationMinQty: 1000,
  cor: "preto",
  usos: ["lasanha", "kibe", "receitas 400-700g"],
  tipoVariacao: "P",
  imagemUrl:
    "https://anexos.tiny.com.br/erp/NDk2MDEzNzU1/2f6a86f93eefd50d6039f74e55409f85.png",
  tinyId: "566764298",
  tinySyncAt: Date.now(),
  enriquecimentoConf: "high",
  enriquecimentoAt: Date.now(),
});
console.log(`✓ Upserted G240 — ${g240.nome}`);
console.log(`  capacidadeMl=${g240.capacidadeMl}, weightGramsApprox=${g240.weightGramsApprox}`);
console.log(`  microwaveSafe=${g240.microwaveSafe}, ovenSafe=${g240.ovenSafe}, freezerSafe=${g240.freezerSafe}, airfryerSafe=${g240.airfryerSafe}`);
console.log(`  shape=${g240.shape}, compartments=${g240.compartments}, lidIncluded=${g240.lidIncluded}`);

// === Produto 2 — G330 Marmita 3 divisórias ===
const g330 = upsertProduct({
  sku: "G330PR",
  nome: "Embalagem marmita 3 divisórias funda 1150mL Galvanotek G330",
  marca: "GALVANOTEK",
  categoriaPath: "EMBALAGEM/Marmita/Divisorias",
  preco: 253.9,
  estoque: 200,
  capacidadeMl: 1150,
  weightGramsApprox: 900,
  shape: "rectangular",
  compartments: 3,
  material: "PP",
  microwaveSafe: true,
  ovenSafe: false,
  freezerSafe: true,
  lidIncluded: true,
  lidCompatible: true,
  cor: "preto",
  usos: ["marmita executiva", "delivery", "PF"],
  tipoVariacao: "N",
  enriquecimentoConf: "high",
  enriquecimentoAt: Date.now(),
});
console.log(`\n✓ Upserted G330PR — ${g330.nome}`);
console.log(`  compartments=${g330.compartments} (marmita 3 divisórias)`);

// === Produto 3 — PT100 Pote molho ===
const pt100 = upsertProduct({
  sku: "PT100",
  nome: "Pote 100ml para Molho com tampa pressão",
  marca: "STRAWPLAST",
  categoriaPath: "EMBALAGEM/Pote/Molho",
  preco: 0.35,
  estoque: 5000,
  capacidadeMl: 100,
  weightGramsApprox: 80,
  shape: "round",
  material: "PP",
  microwaveSafe: true,
  leakResistant: true,
  lidIncluded: true,
  cor: "transparente",
  usos: ["molho", "azeite", "vinagrete"],
  tipoVariacao: "N",
  enriquecimentoConf: "high",
  enriquecimentoAt: Date.now(),
});
console.log(`\n✓ Upserted PT100 — ${pt100.nome}`);
console.log(`  leakResistant=${pt100.leakResistant} (não vaza)`);

// === Buscas demonstrativas ===
console.log("\n=== BUSCAS demonstrativas ===\n");

console.log("[1] Cliente: 'preciso de marmita pra delivery de lasanha 800ml'");
const r1 = searchProducts({
  capacidadeMinMl: 700,
  capacidadeMaxMl: 900,
  ovenSafe: true,
});
console.log(`  Filtros: capacidade 700-900ml + ovenSafe=true`);
console.log(`  Resultados: ${r1.length}`);
for (const r of r1) {
  console.log(`    → ${r.sku} | ${r.nome.slice(0, 50)}... | ${r.capacidadeMl}ml | forno=${r.ovenSafe}`);
}

console.log("\n[2] Cliente: 'quero marmita com divisória pra refeição executiva'");
const r2 = searchProducts({ compartmentsMin: 2, microwaveSafe: true });
console.log(`  Filtros: compartmentsMin=2 + microwaveSafe=true`);
console.log(`  Resultados: ${r2.length}`);
for (const r of r2) {
  console.log(`    → ${r.sku} | ${r.compartments} divisórias | microondas=${r.microwaveSafe}`);
}

console.log("\n[3] Cliente: 'embalagem pra molho que não vaza'");
const r3 = searchProducts({ leakResistant: true });
console.log(`  Filtros: leakResistant=true`);
console.log(`  Resultados: ${r3.length}`);
for (const r of r3) {
  console.log(`    → ${r.sku} | ${r.nome.slice(0, 40)}... | leak_resistant=true`);
}

console.log("\n[4] Cliente: 'molho transparente' (FTS5 + filtro cor)");
const r4 = searchProducts({ query: "molho", cor: "transparente" });
console.log(`  Filtros: query='molho' + cor=transparente`);
console.log(`  Resultados: ${r4.length}`);
for (const r of r4) {
  console.log(`    → ${r.sku} | ${r.nome} | rank=${r.rank?.toFixed(3) ?? "n/a"}`);
}

console.log("\n[5] Validar SKUs (anti-alucinação)");
const skus = ["G240", "G330PR", "PT100", "G999", "INVENTADO"];
for (const sku of skus) {
  const valid = validateSku("default", sku);
  console.log(`  ${valid ? "✓" : "✗ INVENTADO"}  ${sku}`);
}

console.log("\n[6] Lookup ficha G240");
const ficha = getProduct("default", "G240");
console.log(`  shape: ${ficha?.shape}`);
console.log(`  compartments: ${ficha?.compartments}`);
console.log(`  ml: ${ficha?.capacidadeMl} | g aprox: ${ficha?.weightGramsApprox}`);
console.log(`  forno/microondas/freezer/airfryer: ${ficha?.ovenSafe}/${ficha?.microwaveSafe}/${ficha?.freezerSafe}/${ficha?.airfryerSafe}`);
console.log(`  tampa: ${ficha?.lidIncluded} | compatível: ${ficha?.lidCompatible}`);
console.log(`  custom min qty: ${ficha?.customizationMinQty}`);
console.log(`  Tiny ID: ${ficha?.tinyId}`);

// cleanup
console.log("\n=== CLEANUP ===");
try {
  rmSync(stateDir, { recursive: true, force: true });
  console.log(`✓ Removido ${stateDir}`);
} catch (e) {
  console.log(`⚠️ Falha no cleanup: ${e}`);
}

console.log("\n✓ SEED COMPLETO via API real");
