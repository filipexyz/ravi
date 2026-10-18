# Workflows Canônicos

Estes são os workflows canônicos do Ravi em cima do substrate atual.

Objetivo:

- dar exemplos úteis de uso real
- cobrir os shapes principais do substrate atual
- evitar “demo solta” sem propósito operacional

## 1. Technical Change Flow

Arquivo:

- `docs/reference/workflows/technical-change-flow.json`

Propósito:

- mudança técnica pequena que precisa passar por implementação, revisão e entrega

Shape:

- `implement -> review -> ship`

Uso típico:

- ajuste de código
- refactor localizado
- bugfix simples com handoff de revisão

## 2. Gated Release Flow

Arquivo:

- `docs/reference/workflows/gated-release-flow.json`

Propósito:

- release que precisa de checkpoint e aprovação explícita antes do deploy

Shape:

- `build -> checkpoint -> approval -> deploy`

Uso típico:

- release de feature
- deploy sensível
- mudança que exige go/no-go humano

## 3. Operational Response Flow

Arquivo:

- `docs/reference/workflows/operational-response-flow.json`

Propósito:

- fluxo operacional curto em que alguém precisa triar, executar e comunicar/fechar

Shape:

- `triage -> execute -> communicate`

Uso típico:

- incidente pequeno
- resposta operacional
- ajuste com necessidade de fechamento/comunicação

## Materialização recomendada

Usar a CLI atual para persistir os specs:

```bash
ravi workflows.specs create wf-spec-canonical-technical-change-v1 --file docs/reference/workflows/technical-change-flow.json
ravi workflows.specs create wf-spec-canonical-gated-release-v1 --file docs/reference/workflows/gated-release-flow.json
ravi workflows.specs create wf-spec-canonical-operational-response-v1 --file docs/reference/workflows/operational-response-flow.json
```

Regra operacional:

- pelo menos um run deve ficar visível em estado não-terminal (`ready`, `awaiting_release` ou `running`)
- não fechar todos em `done`, senão a surface vira só happy path morto
