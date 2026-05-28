# Catalog Gateway — PRD técnico v0.3

**Status:** Schema atualizado com base em pesquisa empírica · **Owner:** dev-do-ravi · **Data:** 2026-05-27 · **Cliente piloto:** setordaembalagem.com (823 SKUs Tiny) · **Spike empírico:** ✅ passou (`spike/catalog/spike.ts`)

## Histórico

- **v0.1** (2026-05-27 16:25) — primeira versão, 5 decisões pendentes
- **v0.2** (2026-05-27 16:40) — spike passou (11/11 checks, latência 0.110ms estruturada / 0.939ms FTS5), decisões D1-D5 resolvidas (ver §11)
- **v0.3** (2026-05-27 19:10) — schema reajustado com base em pesquisa empírica do researcher (task-f9997eef, 734 conversas WhatsApp reais analisadas). Veredito 80/20 hot/cold/markdown aplicado. Detalhes em §13.

## §13. Ajustes do schema com base em pesquisa empírica (researcher task-f9997eef)

**Fonte:** 734 conversas WhatsApp reais do setordaembalagem analisadas em `vault-ravi/knowledge/catalog-gateway/arvore-decisao-cliente-sde-2026-05-27.md`.

### Campos ADICIONADOS (justificativa empírica)

| Campo | Justificativa | Frequência |
|---|---|---|
| `weight_grams_approx` | Equipe SEMPRE clarifica ml ≠ gramas. Confusão em 33% das conversas. | 33% qualitativo |
| `shape` (enum) | Equipe pergunta "redonda/quadrada/garrafa/bowl" em use-case-first | 20% qualitativo |
| `compartments` (int) | Equipe pergunta "com/sem divisória" proativamente | 11% quant, 33% qual |
| `microwave_safe` (bool) | Substitui `resistencia_termica` enum por flag específico | 5.5% quant |
| `oven_safe` (bool) | Idem | 5.5% quant |
| `freezer_safe` (bool) | Idem | 5.5% quant |
| `airfryer_safe` (bool) | Nicho crescente (mencionado junto a forno) | sample qualitativo |
| `leak_resistant` (bool) | Substitui `seal_type`. "Não vaza?" é a pergunta real. | 7% qualitativo |
| `lid_included` (bool) | Tampa é decisor binário | 21.5% quant |
| `lid_compatible` (bool) | Variações com/sem tampa do mesmo SKU pai | 21.5% quant |
| `customization_min_qty` (int) | Personalização aparece em 18.4% (B2B) | 18.4% quant |
| `cor` (text) | Aparece em 10% das conversas | 10.2% quant |
| `tiny_id` (text) | Chave forte cross-system Ravi ↔ Tiny ERP | infra |

### Campos REBAIXADOS (mantidos no schema, removidos de filtros hot)

| Campo | Razão | Frequência |
|---|---|---|
| `material` | Cliente nunca diz "PP" — sempre "Galvanotek" (marca). Manter como info técnica. | 6.9% quant, **0% qualitativo** |
| `resistencia_termica` | Substituído por booleans específicos (`*_safe`). Coluna preservada pra back-compat. | rebrand |
| `diametro_mm` | Cliente nunca menciona em mm. Manter pra ficha técnica. | <1% |

### Campos NUNCA ADICIONADOS (atributos com baixa relevância)

- `stackable` — 0.3% quant, 0% qualitativo
- `anvisa_compliant` — 1.9% quant, só relevante B2B regulado (tag em vez de coluna)
- `seal_type` — substituído por `leak_resistant` boolean

### Os 4 arquétipos de cliente (define UX do chatbot Sprint 2)

🔹 **SKU-first (~30%)** — recorrente. Tool-call simples: `validateSku → ficha → estoque`
🔹 **Capacity-first (~25%)** — sabe volume. **Equipe clarifica ml/g** (`weight_grams_approx`)
🔹 **Use-case-first (~25%)** — empreendedor. **Chatbot deve fazer perguntas de qualificação proativas** (divisória? quente/frio? porções?)
🔹 **B2B-list (~10%)** — listas + cotação + frete + CNPJ. Frete é objeção #1 (33% perdem por frete caro)

### Limitações declaradas pelo researcher

- Sample qualitativo de 15 (universe 734) — robusto pra HOT/WARM, pode subestimar COLD
- **Recompra mascara processo** — SKU-first oculta decisão real (já feita em primeira compra)
- 25-30% das conversas têm <3 msgs (excluídas)
- Áudio não transcrito

## §14. Matriz origem-justificativa por coluna

**Regra de inclusão:** toda coluna deve ter ao menos 1 das 3 fontes legítimas:
- **🔬 Cliente** — researcher confirmou em conversa real (freq % ou qual)
- **📋 Negócio** — exigência fiscal/regulatório/operacional do domínio
- **🔧 Infra Ravi** — padrão de subsistema (PK, tenant, audit, integração)

### Tabela completa (45 colunas)

| Coluna | Origem | Justificativa | Auditável |
|---|---|---|---|
| `tenant_id`, `sku` | 🔧 Infra | PK composto multi-tenant ready | ✅ |
| `nome` | 📋 Negócio | Catálogo precisa de nome legível | ✅ |
| `marca` | 🔬 + 📋 | Researcher: cliente diz "Galvanotek" (>> material); Tiny entrega | ✅ |
| `categoria_path` | 📋 | Navegação hierárquica Tiny | ✅ |
| `preco` | 🔬 + 📋 | Researcher: 77.3% mencionam | ✅ |
| `preco_promo` | 📋 | Variação comercial Tiny | ⚠️ não validado pelo researcher |
| `estoque` | 🔬 + 📋 | Researcher: 41.4% perguntam disponibilidade | ✅ |
| `ativo` | 🔧 + 📋 | Status comercial padrão | ✅ |
| `gtin` | 📋 | NF-e exige EAN. Cliente nunca pergunta. | ✅ (negócio) |
| `ncm` | 📋 | NF-e/regulação fiscal | ✅ (negócio) |
| `peso_liquido_g` | 📋 | Cotação de frete + NF-e | ⚠️ ambiguidade unidade vs caixa |
| `peso_bruto_g` | 📋 | Cotação de frete | ⚠️ ambiguidade unidade vs caixa |
| `altura_mm`, `largura_mm`, `comprimento_mm`, `diametro_mm` | 📋 | Cotação frete. Cliente quase nunca pergunta em mm. | ⚠️ ambiguidade unidade vs caixa |
| `capacidade_ml` | 🔬 + 📋 | Researcher: 39.9% quant, 60% qual — decisor #1 | ✅ |
| `weight_grams_approx` ⭐ | 🔬 | Researcher v0.3: ml≠g em 33% qual | ✅ |
| `shape` ⭐ | 🔬 | Researcher v0.3: equipe pergunta em 20% qual | ✅ |
| `compartments` ⭐ | 🔬 | Researcher v0.3: 11% quant, 33% qual | ✅ |
| `material` | 🔬 (rebaixado) | Researcher: 6.9% quant, **0% qualitativo**. Mantém como info técnica. | ⚠️ COLD |
| `resistencia_termica` | (legacy) | Substituído por `*_safe`. Mantém pra back-compat. | ⚠️ deprecate na próxima major |
| `microwave_safe` ⭐ | 🔬 | Researcher v0.3: substitui enum por flag específico | ✅ |
| `oven_safe` ⭐ | 🔬 | Researcher v0.3 | ✅ |
| `freezer_safe` ⭐ | 🔬 | Researcher v0.3 | ✅ |
| `airfryer_safe` ⭐ | 🔬 | Researcher v0.3: nicho crescente, mencionado junto a forno | ✅ |
| `leak_resistant` ⭐ | 🔬 | Researcher v0.3: "não vaza?" em 7% qual; substitui `seal_type` | ✅ |
| `lid_included` ⭐ | 🔬 | Researcher v0.3: tampa é decisor binário em 21.5% quant | ✅ |
| `lid_compatible` ⭐ | 🔬 | Researcher v0.3: variações com/sem tampa | ✅ |
| `customization_min_qty` ⭐ | 🔬 | Researcher v0.3: 18.4% quant (B2B) | ✅ |
| `cor` ⭐ | 🔬 | Researcher v0.3: 10.2% quant | ✅ |
| `usos_json` | 🔬 + 📋 | Researcher: 13.6% quant, equipe usa pra qualificar | ✅ |
| `tipo_variacao`, `sku_pai` | 📋 + 🔧 | Modelagem produto pai/filho do Tiny | ✅ |
| `imagem_url` | 🔬 + 📋 | Cliente envia imagem em 30% (SKU-first); Tiny entrega | ✅ |
| `artifact_id` | 🔧 | Link pra texto editorial versionado | ✅ |
| `tiny_id` ⭐ | 🔧 | Chave forte cross-system Ravi↔Tiny | ✅ |
| `tiny_sync_at` | 🔧 | Audit do último sync | ✅ |
| `enriquecimento_conf`, `enriquecimento_at` | 🔧 | Confiança do enriquecimento + timestamp | ✅ |
| `vendavel`, `mostrar_chatbot` | 📋 + 🔧 | Flags operacionais (humano edita) | ✅ |
| `created_at`, `updated_at` | 🔧 | Audit padrão Ravi | ✅ |

### Resumo

- ✅ **30 colunas (67%)** validadas por researcher OU por exigência clara de negócio/infra
- ⚠️ **9 colunas (20%)** com caveat:
  - `preco_promo` (não validado pelo researcher)
  - 6 colunas físicas (pesos + dimensões) com ambiguidade unidade vs caixa
  - `material`, `resistencia_termica` (rebaixados / legacy)
- 🟢 **6 colunas (13%)** infra Ravi pura (sem necessidade de validação cliente)

### Próximos passos de auditoria

🔹 **Resolver ambiguidade unidade vs caixa** — adicionar colunas `caixa_peso_g`, `caixa_altura_mm`, etc, OU documentar explicitamente que campos `peso_*`/`*_mm` são da CAIXA (default Tiny)
🔹 **Validar `preco_promo` em sample** — verificar quantos SKUs do setordaembalagem usam promo ativa
🔹 **Sunset `resistencia_termica`** quando todos os SKUs forem migrados pra `*_safe`

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
