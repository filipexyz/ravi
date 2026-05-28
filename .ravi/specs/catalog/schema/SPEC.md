---
id: catalog/schema
title: "Catalog Schema Empírico v0.3 (45 colunas)"
kind: capability
domain: catalog
capabilities:
  - schema
tags:
  - empirical
  - tenant-isolation
  - hot-cold-markdown
applies_to:
  - src/catalog/db.ts
  - src/catalog/types.ts
  - src/catalog/store.ts
owners:
  - dev-do-ravi
status: active
normative: true
---

# Catalog Schema Empírico v0.3 (45 colunas)

**See:** `docs/proposals/catalog-gateway-prd.md` (PRD v0.3 humano-legível, com matriz origem-justificativa em §14)

## Intent

Schema do subsistema `catalog-gateway` (PR #79) ajustado a partir de pesquisa empírica de 734 conversas WhatsApp reais do setordaembalagem.com (researcher task-f9997eef). Toda coluna deve declarar 1 das 3 origens legítimas: 🔬 cliente (validado pelo researcher), 📋 negócio (regulação/fiscal/operação), 🔧 infra Ravi.

## Invariants

- **PK composto `(tenant_id, sku)`** — multi-tenant ready desde dia 1. `tenant_id TEXT NOT NULL DEFAULT 'default'` em todas tabelas catalog.
- **Schema versionado inline** em `src/catalog/db.ts` via lazy `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` para campos novos (padrão Ravi, sem migration files).
- **Coluna nova exige justificativa**: ou frequência ≥5% nas conversas, ou exigência clara de negócio (NF-e/regulação/Tiny), ou padrão infra Ravi. Nunca chute do dev.
- **Material e resistencia_termica são COLD** (info técnica, não filtro hot). Cliente diz "Galvanotek" (marca), nunca "PP" (researcher: 0% qualitativo pra material).
- **Tampa é decisor binário** — `lid_included` + `lid_compatible` separados (21.5% das conversas).
- **ml ≠ gramas** — `weight_grams_approx` SEMPRE preenchido quando `capacidade_ml` existe (equipe clarifica em 33% das conversas).
- **Temperaturas são booleans específicos** — `microwave_safe`, `oven_safe`, `freezer_safe`, `airfryer_safe`. Substitui enum `resistencia_termica` (legacy preservado pra back-compat).
- **FTS5 obrigatório** — `catalog_products_fts` virtual table + triggers `ai/ad/au` mantêm índice sincronizado.

## Validation

```bash
bun test src/catalog/                      # 28/28 pass / 79 expect
bun run typecheck                          # clean
bunx biome check src/catalog/              # clean
bun spike/catalog/seed-real-api.ts         # populate 3 SKUs via real API
bun spike/catalog/ficha-g240.ts            # full ficha rendered from DB
```

Toda mudança no schema:
1. ALTER TABLE via `CATALOG_PRODUCT_COLUMNS` em `db.ts` (lazy migration)
2. Update `CatalogProduct`/`UpsertCatalogProductInput`/`CatalogSearchFilter` em `types.ts`
3. Update `rowToProduct`/`upsertProduct`/`searchProducts` em `store.ts`
4. Adicionar teste cobrindo round-trip do campo novo
5. Atualizar §14 do PRD com origem-justificativa

## Known Failure Modes

- **Ambiguidade unidade vs caixa** em `peso_*` e `*_mm`: Tiny entrega dimensão da CAIXA (100un), não da unidade. Hoje schema não distingue. PRD §14 documenta como caveat. Roadmap: adicionar colunas `caixa_*` separadas.
- **Recompra mascara processo**: SKU-first conversas (~30%) não capturam decisão real (já tomada em compra anterior). Schema não tem como detectar isso; sinal vem do CRM.
- **Material como filtro hot** (regressão se voltar): cliente nunca pergunta por PP/PET. Manter em info técnica apenas.
- **`resetCatalogSchemaFlag` no barrel público** (M1 do code review original): vazou no `index.ts`. Fixado v0.3 — testes importam direto de `./db.js`. Não regredir.
- **Inventar SKU** (alucinação chatbot): sempre `validateSku` antes de mencionar código.
