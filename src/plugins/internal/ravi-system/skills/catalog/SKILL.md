---
name: catalog
description: |
  Subsistema de catálogo de produtos do Ravi (`src/catalog/`). Use quando precisar:
  - Buscar produto por filtros estruturados (capacidade, peso aproximado, formato, divisórias, microondas/forno/freezer)
  - Validar se um SKU mencionado existe (anti-alucinação)
  - Recuperar ficha completa de um SKU
  - Listar produtos por tenant/marca/categoria
  - Sincronizar catálogo com ERP externo (Tiny — Sprint 2)
  - Atender cliente WhatsApp / chatbot com tool-calling in-process (<50ms)

  NÃO é fonte de transação. SKUs são espelhados do ERP. Texto editorial vive em `artifacts` versionado.
---

# Catalog Gateway

Catálogo de produtos para LLM/chatbot consumir via tool-calling. Subsistema dedicado em `src/catalog/`, padrão `prox/calls/`. SQLite + FTS5 com schema empírico (baseado em 734 conversas WhatsApp do setordaembalagem analisadas pelo researcher).

## Quando carregar esta skill

Trigger words: "buscar produto", "ficha SKU", "estoque embalagem", "catálogo", "produtos com capacidade", "marmita com divisória", "vai ao microondas", "vai ao forno", "leak resistant", "G240", "G330", "PP33", outros códigos SKU do setordaembalagem.

## Modelo atual

| Tabela | Função |
|---|---|
| `catalog_products` PK (tenant_id, sku) | Linha principal espelhada do ERP + atributos empíricos |
| `catalog_products_fts` (FTS5 virtual) | Busca texto livre, tokenize unicode61 remove_diacritics |
| `catalog_sync_log` | Telemetria por execução de sync |
| `artifacts` (kind=catalog-item) + `artifact_versions` | Texto editorial Markdown versionado |

**Multi-tenant ready:** todas as tabelas têm `tenant_id TEXT NOT NULL DEFAULT 'default'`. Hoje single-tenant deploy isolado por cliente; promover pra multi-tenant exige apenas guard no gateway + REBAC scoping.

## API in-process (Sprint 1 — disponível agora)

```ts
import {
  searchProducts, validateSku, getProduct, listProducts,
  upsertProduct, deleteProduct, updateFtsTextoCompleto,
  startCatalogSyncLog, finalizeCatalogSyncLog,
} from "src/catalog/index.js";

// Buscar com filtros estruturados (latência <50ms)
const results = searchProducts({
  capacidadeMinMl: 450, capacidadeMaxMl: 550,
  microwaveSafe: true, compartmentsMin: 2,
  shape: "rectangular", lidIncluded: true,
});

// Busca híbrida (estruturada + texto livre FTS5)
const results = searchProducts({
  query: "marmita lasanha",
  ovenSafe: true,
});

// Validar antes de mencionar SKU em resposta (anti-alucinação)
if (!validateSku("default", "G240")) {
  throw new Error("SKU G240 não existe ou inativo");
}

// Ficha completa do produto
const product = getProduct("default", "G240");

// Upsert por sync ou manual
upsertProduct({
  sku: "G240",
  nome: "Embalagem Forneável 800ml",
  capacidadeMl: 800,
  weightGramsApprox: 700,
  shape: "rectangular",
  microwaveSafe: true,
  ovenSafe: true,
  freezerSafe: true,
  airfryerSafe: true,
  lidIncluded: true,
  lidCompatible: true,
  customizationMinQty: 1000,
  tinyId: "566764298",
});
```

## Filtros disponíveis em `searchProducts`

| Filtro | Tipo | Empiricamente justificado |
|---|---|---|
| `capacidadeMinMl`, `capacidadeMaxMl` | range | A — 39.9% das conversas mencionam capacidade |
| `weightGramsMin`, `weightGramsMax` | range | A — equipe clarifica ml ≠ g em 33% |
| `shape` (round/square/rectangular/bottle/bowl/bag/tray) | enum | B — equipe pergunta forma em 20% qualitativo |
| `compartmentsMin` | int | B — equipe pergunta divisória proativamente em 33% qual |
| `microwaveSafe`, `ovenSafe`, `freezerSafe`, `airfryerSafe` | bool | C — nicho forneável 5.5% |
| `leakResistant` | bool | C — "não vaza?" em 7% qualitativo |
| `lidIncluded` | bool | A — tampa é decisor binário 21.5% |
| `material` | string | COLD — manter como info técnica, não filtro hot |
| `categoriaPath` | LIKE prefix | navegação hierárquica |
| `marca`, `cor` | string | warm |
| `query` (FTS5) | string | texto livre, suporta acento |

## Anti-patterns (regras hard pro chatbot)

🚫 **NUNCA mencione um SKU sem antes chamar `validateSku`.** Inventar código de produto = perder confiança do cliente.

🚫 **NUNCA filtre por `material` como primeira opção.** Cliente diz "Galvanotek" (marca), não "PP". Use marca + capacidade + uso.

🚫 **NUNCA confunda ml com gramas.** 33% das conversas têm essa confusão. Quando cliente fala "500g de comida", lookup `weightGramsApprox`, não `capacidadeMl`.

🚫 **NUNCA retorne produto com `ativo=0` sem flag explícita.** Default da `searchProducts` exclui inativos.

🚫 **NUNCA exponha `resetCatalogSchemaFlag` em produção** — é helper de teste apenas. Importar de `./db.js` direto, nunca do barrel `./index.js`.

## Arquétipos de cliente (define UX do chatbot)

Baseado em 734 conversas WhatsApp do setordaembalagem (researcher task-f9997eef):

🔹 **SKU-first (~30%)** — recorrente, já sabe código. Fluxo:
   `validateSku` → `getProduct` → estoque/prazo/preço → fecha

🔹 **Capacity-first (~25%)** — sabe volume. Equipe SEMPRE clarifica ml/g.
   `searchProducts({ capacidadeMinMl, capacidadeMaxMl })` + **clarificar peso aproximado**

🔹 **Use-case-first (~25%)** — empreendedor iniciando. **Chatbot deve fazer perguntas de qualificação proativas**:
   1. "Com ou sem divisória?" (`compartments`)
   2. "Vai ao forno/microondas?" (`ovenSafe`, `microwaveSafe`)
   3. "Quantas porções?" (informativo)
   4. "Quente ou frio?" (`microwaveSafe` + `freezerSafe`)
   → depois `searchProducts` com filtros derivados

🔹 **B2B-list (~10%)** — listas + cotação. Frete é objeção #1 (33% perdem por frete caro).
   Múltiplos `validateSku` + `searchProducts` por SKU + cotação frete cedo no fluxo

## Sincronização com Tiny ERP (Sprint 2 — em construção)

Adapter Tiny vai usar `sde tiny` CLI:
- `sde tiny produtos --modified-since <ts>` (delta)
- `sde tiny produto <id>` (detalhe com `descricao_complementar` HTML)
- `sde tiny estoque <id>` (estoque + saldoReservado)

Sync orquestrado por `ravi cron`:
```
*/30 * * * *  ravi catalog sync --provider tiny --tenant default
0 3 * * *     ravi catalog sync --provider tiny --tenant default --full
```

Enriquecimento via parser regex no HTML (capacidade, material, peso aproximado) + LLM fallback quando confidence < high.

## Roadmap

| Sprint | Entrega | Status |
|---|---|---|
| **Sprint 1** | Storage + FTS5 + CRUD + sync_log | ✅ Entregue (PR #79) |
| **Sprint 1.5** | Schema empírico (researcher 734 conversas) | ✅ Esta entrega |
| **Sprint 2** | Adapter Tiny + CLI `ravi catalog *` + tool-bridge chatbot | ⏳ Próximo |
| **Sprint 3** | Enriquecimento batch + telemetria + validador anti-alucinação | ⏳ |
| **Pilot** | Cliente setordaembalagem em produção 30 dias | ⏳ |

## Quando NÃO usar esta skill

- Para criar/editar produto fora do flow de sync: usar Tiny direto
- Para inventário/estoque transacional: Tiny é SoT
- Para análise de venda: usar `sde crm cliente-contexto` + Tiny pedidos
- Para texto livre rico de descrição: ler `artifact_versions` do artifact_id linkado

## Referências

- PRD: `docs/proposals/catalog-gateway-prd.md` (v0.3)
- Pesquisa empírica: `vault-ravi/knowledge/catalog-gateway/arvore-decisao-cliente-sde-2026-05-27.md`
- Mapa CLIs: `docs/proposals/catalog-research-cli-map.md`
- Spike: `spike/catalog/spike.ts`, `spike/catalog/spike-g240.ts`, `spike/catalog/ficha-g240.ts`
- PR: https://github.com/filipexyz/ravi/pull/79
