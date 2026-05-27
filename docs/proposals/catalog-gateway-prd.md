# Catalog Gateway — PRD técnico v0.2

**Status:** Aprovado pra implementação Sprint 1 · **Owner:** dev-do-ravi · **Data:** 2026-05-27 · **Cliente piloto:** setordaembalagem.com (823 SKUs Tiny) · **Spike empírico:** ✅ passou (`spike/catalog/spike.ts`)

## Histórico

- **v0.1** (2026-05-27 16:25) — primeira versão, 5 decisões pendentes
- **v0.2** (2026-05-27 16:40) — spike passou (11/11 checks, latência 0.110ms estruturada / 0.939ms FTS5), decisões D1-D5 resolvidas (ver §11)

---

## 1. Resumo executivo

Subsistema `src/catalog/` dentro do daemon Ravi que espelha catálogo de produtos de ERPs externos (Tiny no piloto), enriquece com atributos derivados, e expõe interface estruturada para LLMs (chatbot, content gen, atendente humano, ads).

**Reusa 70%** da infra existente do Ravi (artifacts, tags, cron, triggers, gateway HTTP auto-gen, SDK TypeScript). **Novo (~30%)**: domain folder catalog, adapter Tiny, enriquecimento, FTS5 dedicado, validador anti-alucinação.

**Paradigma de referência:** `src/prox/calls/` (subsistema de domínio com DB próprio, adapter externo, sync, rules, tool-bridge).

---

## 2. Capability multi-tenant

**Decisão arquitetural bloqueante** antes do primeiro commit em prod.

| Modelo | Trade-off | Recomendação |
|---|---|---|
| 1 daemon = 1 cliente | Isolamento absoluto. Cada cliente tem seu `ravi.db`. Operação multiplica por N (deploys, monitoria, sync, backup). | Pra MVP piloto (1 cliente) |
| 1 daemon multi-tenant | `tenant_id` em toda tabela catalog. Operação 1x. REBAC por tenant. Risco vazamento cross-tenant. | Pra escala (≥3 clientes) |

**MVP**: deploy isolado por cliente. Schema **já prepara** `tenant_id TEXT NOT NULL DEFAULT 'default'` em todas as tabelas catalog desde dia 1 (custo zero, evita migração futura). Promoção pra multi-tenant exige apenas adicionar guard no gateway + REBAC scoping.

---

## 3. Schema SKU (catalog tables)

Tabelas novas no `~/.ravi/ravi.db` (mesmo arquivo, namespace `catalog_*`):

```sql
CREATE TABLE IF NOT EXISTS catalog_products (
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  sku                TEXT NOT NULL,
  -- comerciais (SoT: ERP externo)
  nome               TEXT NOT NULL,
  marca              TEXT,
  categoria_path     TEXT,
  preco              REAL,
  preco_promo        REAL,
  estoque            INTEGER,
  ativo              INTEGER DEFAULT 1,
  gtin               TEXT,
  ncm                TEXT,
  -- físicos
  peso_liquido_g     REAL,
  peso_bruto_g       REAL,
  altura_mm          REAL,
  largura_mm         REAL,
  comprimento_mm     REAL,
  diametro_mm        REAL,
  -- derivados (enriquecimento)
  capacidade_ml      REAL,
  material           TEXT,
  resistencia_termica TEXT,
  usos_json          TEXT,
  -- variação
  tipo_variacao      TEXT,
  sku_pai            TEXT,
  -- mídia
  imagem_url         TEXT,
  -- artifact link (texto rico vive em artifacts/artifact_versions)
  artifact_id        TEXT,
  -- qualidade
  tiny_sync_at       INTEGER,
  enriquecimento_conf TEXT,
  enriquecimento_at  INTEGER,
  vendavel           INTEGER DEFAULT 1,
  mostrar_chatbot    INTEGER DEFAULT 1,
  -- timestamps
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_catalog_products_categoria
  ON catalog_products(tenant_id, categoria_path);
CREATE INDEX IF NOT EXISTS idx_catalog_products_artifact
  ON catalog_products(artifact_id);

CREATE VIRTUAL TABLE IF NOT EXISTS catalog_products_fts USING fts5(
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

CREATE TABLE IF NOT EXISTS catalog_sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL,
  provider    TEXT NOT NULL,           -- 'tiny', 'bling', ...
  modified_since INTEGER,
  fetched     INTEGER NOT NULL DEFAULT 0,
  upserted    INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  payload_json TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
```

**Texto editorial (.md humano)** vive como `artifact_versions` do Ravi — versionamento + lineage de graça. `catalog_products.artifact_id` aponta pra `artifacts.id` com `kind='catalog-item'`. Reusa store existente em `src/artifacts/store.ts`.

---

## 4. Sync cron Tiny

`ravi cron create` agenda execução periódica de `ravi catalog sync --provider tiny --tenant <id>`:

```
*/30 * * * *  ravi catalog sync --provider tiny --tenant default
```

Adapter pattern (mesmo padrão `prox/calls/provider.ts`):
- `src/catalog/providers/tiny.ts` — implementa `ProductProviderAdapter`
- `fetchModifiedSince(timestamp): Product[]`
- UPSERT atômico em `catalog_products` + sync log em `catalog_sync_log`

Reconciliation diária full sync (1x/dia 03:00) pra detectar drift.

Enriquecimento via **trigger** (`ravi triggers`) que dispara em UPSERT: parser regex local + fallback LLM batch.

---

## 5. FTS5 dedicado

SQLite native, virtual table acima. Mantida em sync via trigger SQLite:

```sql
CREATE TRIGGER catalog_products_ai AFTER INSERT ON catalog_products BEGIN
  INSERT INTO catalog_products_fts(tenant_id, sku, nome, marca, categoria_path, material, usos, texto_completo)
  VALUES (new.tenant_id, new.sku, new.nome, COALESCE(new.marca, ''),
          COALESCE(new.categoria_path, ''), COALESCE(new.material, ''),
          COALESCE(new.usos_json, ''), '');
END;

CREATE TRIGGER catalog_products_au AFTER UPDATE ON catalog_products BEGIN
  UPDATE catalog_products_fts
  SET nome=new.nome, marca=COALESCE(new.marca,''), categoria_path=COALESCE(new.categoria_path,''),
      material=COALESCE(new.material,''), usos=COALESCE(new.usos_json,'')
  WHERE tenant_id=new.tenant_id AND sku=new.sku;
END;
```

`texto_completo` populado por sync separado quando `artifact_id` muda (texto editorial atualizado).

Busca híbrida: filtro estruturado (`capacidade_ml`, `material`, `resistencia_termica`) + ranking FTS5 quando texto livre presente.

---

## 6. Exposição via CLI + SDK + HTTP

Cria comandos no `src/cli/commands/catalog.ts` — registry-driven, **HTTP + SDK saem de graça**.

| CLI | HTTP auto-gen | Uso |
|---|---|---|
| `ravi catalog search --capacidade-min 450 --capacidade-max 550 --material PP --resistencia alta` | `POST /api/v1/catalog/search` | Tool-call do chatbot |
| `ravi catalog ficha G312` | `POST /api/v1/catalog/ficha` | Retorna SQL + texto editorial |
| `ravi catalog sync --provider tiny --tenant default` | `POST /api/v1/catalog/sync` | Cron job |
| `ravi catalog enrich --sku G312` | `POST /api/v1/catalog/enrich` | Enriquecimento manual / trigger |
| `ravi catalog list --categoria embalagem` | `POST /api/v1/catalog/list` | Listagem |

**SDK TypeScript** (auto-gen do registry):
```ts
import { RaviClient, createHttpTransport } from "@ravi-os/sdk";
const ravi = new RaviClient(createHttpTransport({ baseUrl: "http://127.0.0.1:7777", contextKey: process.env.RAVI_CONTEXT_KEY! }));
const result = await ravi.catalog.search({ capacidadeMin: 450, capacidadeMax: 550, material: "PP" });
```

**Tool-bridge in-process** (latência <50ms) pra chatbot que vive dentro do daemon:
```ts
import { searchProducts } from "@/catalog";  // import direto, sem rede
const result = searchProducts({ capacidadeMin: 450, ... });
```

---

## 7. Validador anti-alucinação

Pós-processador da resposta do LLM:
- Regex extrai códigos (`[A-Z][0-9]{2,4}`)
- Lookup em `catalog_products` por tenant
- Bloqueia se SKU não existe ou `ativo=0`
- Loga em `artifact_events` (audit nativo)

---

## 8. Métricas de aceite

| Métrica | Alvo |
|---|---|
| Busca estruturada (in-process) | <50ms p99 |
| Busca FTS5 com 1000 SKUs | <100ms p99 |
| Sync delta 20 SKUs | <5s |
| Enriquecimento batch 50 SKUs | <60s |
| End-to-end chatbot | <3s |
| SKUs inventados bloqueados | 100% |

---

## 9. Riscos

| Risco | Mitigação |
|---|---|
| Schema sem migrations | Versionar inline (padrão Ravi) + ADR formal por mudança breaking |
| Lock contention SQLite | WAL mode (já default no Ravi) + benchmark com sync concorrente |
| FTS5 sem padrão prévio | Spike empírico (este doc) + isolado em `catalog/fts.ts` |
| Multi-tenant futuro | `tenant_id` desde dia 1 (custo zero hoje, refactor caro depois) |
| Enriquecimento erra | `enriquecimento_conf` por atributo + auditoria amostral via tags |
| Tiny rate limit | Adapter respeita backoff + sync delta + reconciliation diária |

---

## 10. Plano de implementação

| Sprint | Entrega |
|---|---|
| **Spike** (este PR) | Prova SQLite + FTS5 + latência <50ms |
| **Sprint 1** (1 sem) | `src/catalog/` + schema + provider Tiny + sync básico |
| **Sprint 2** (1 sem) | CLI commands + tool-bridge + validador anti-alucinação |
| **Sprint 3** (3 dias) | Enriquecimento + telemetria + dashboard |
| **Pilot** (30 dias) | Cliente setordaembalagem.com em prod |

---

## 11. Decisões tomadas (2026-05-27)

- **D1. ✅** Single-tenant deploy isolado pra MVP. Schema preparado com `tenant_id TEXT NOT NULL DEFAULT 'default'` em todas as tabelas catalog desde dia 1 — refactor pra multi-tenant futuro custa apenas guard no gateway + REBAC scoping.
- **D2. ✅** `artifact_versions` (Ravi nativo) como SoT do texto editorial. Versionamento + lineage + audit grátis. Backup vira `~/.ravi/ravi.db` + blobs.
- **D3. ✅** Cron 30min (`*/30 * * * *`) + reconciliation full diária às 03:00. Webhook Tiny avaliado em sprint futura.
- **D4. ✅** Top 100 incremental (priorizar SKUs mais vendidos). Cobertura full em 4 semanas (200/sem).
- **D5. ✅** Sonnet 4.6 pra enriquecimento (custo) + Opus 4.7 só em fallback quando confidence "low".

## 12. Status do spike empírico

Branch: `spike/catalog-prototype` · Script: `spike/catalog/spike.ts` · Resultado: **11/11 checks ✓**

| Check | Latência medida | Alvo |
|---|---|---|
| Busca estruturada | 0.110ms | <50ms |
| Busca FTS5 | 0.939ms | <50ms |
| Busca híbrida | 0.057ms | <50ms |
| Validador anti-alucinação (5 SKUs) | 0.173ms | — |
| Lookup artifact texto rico | 0.033ms | — |
| Stress 1k buscas estruturadas (média) | 0.008ms | — |
| Stress 1k buscas FTS5 (média) | 0.070ms | — |

Conclusão: viabilidade técnica confirmada. Margem de **50-450x** vs orçamento de latência.
