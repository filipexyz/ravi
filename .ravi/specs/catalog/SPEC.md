---
id: catalog
title: "Catalog Gateway — Domain"
kind: domain
domain: catalog
capabilities:
  - schema
tags:
  - product-catalog
  - multi-tenant
  - sde-setordaembalagem
applies_to:
  - src/catalog/
  - packages/ravi-os-sdk/ (futuro)
owners:
  - dev-do-ravi
status: active
normative: true
---

# Catalog Gateway — Domain

**See:** `docs/proposals/catalog-gateway-prd.md` (PRD v0.3)

## Intent

Subsistema `src/catalog/` é SSoT de produto pro cliente setordaembalagem.com (823 SKUs Tiny). Serve 4 consumidores: (1) chatbot WhatsApp (atendimento), (2) gerador de conteúdo (Instagram/blog), (3) campanhas Meta Ads, (4) atendente humano. Origem dos dados: pesquisa empírica de 734 conversas WhatsApp reais (researcher task-f9997eef) + ERP Tiny.

## Invariants

- **Multi-tenant by design**: `(tenant_id, sku)` é PK composto. Default `tenant_id='default'` permite single-tenant atual sem quebrar contrato.
- **Capabilities sob este domínio**: [[catalog-schema]] (45 colunas v0.3, hot-filter vs cold-info split).
- **Hot vs cold split**: filtros frequentes (≥5% nas conversas) são colunas indexadas; info técnica (material, resistencia) é COLD em texto/markdown.
- **Empirical-first**: nenhuma coluna nova entra sem 1 de 3 origens: 🔬 cliente (validado), 📋 negócio (regulação/fiscal/operação), 🔧 infra Ravi. Documentado em §14 do PRD.
- **Gateway HTTP auto-gen**: `ravi catalog <cmd>` CLI → `POST /api/v1/catalog/<cmd>` SDK typed automaticamente. Nunca escrever rota HTTP à mão (pattern via `route-table.ts`).

## Validation

```bash
bun test src/catalog/              # 28/28 pass / 79 expect
bun run typecheck                  # clean
bunx biome check src/catalog/      # clean
ravi specs get catalog             # spec carrega
ravi specs get catalog/schema      # capability spec carrega
```

## Known Failure Modes

- **Dev opina sem evidência cliente**: schema cresce com colunas "óbvias" do dev (PP/PET, resistência térmica) que cliente nunca pergunta. Bloqueio: §14 do PRD exige justificativa empírica antes de ALTER TABLE.
- **Unidade vs caixa ambíguo**: Tiny entrega dimensão da CAIXA (100un). Schema hoje não distingue — caveat em [[catalog-schema]] Known Failure Modes.
- **Sunset não-coordenado**: remover coluna sem aviso quebra consumidores downstream (chatbot, ads, conteúdo). Bloqueio: HITL C.15 (mudança em schema DB).
