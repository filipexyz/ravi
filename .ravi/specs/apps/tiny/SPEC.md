---
id: apps/tiny
title: "Tiny"
kind: capability
domain: apps
capability: tiny
capabilities:
  - manifest
  - cli
  - ui
  - operations
tags:
  - apps
  - tiny
applies_to:
  - src/apps/tiny/ravi.app.json
  - src/apps/tiny/config.ts
  - src/apps/tiny/credential.ts
  - src/apps/tiny/client.ts
  - src/apps/tiny/read-contracts.ts
  - src/apps/tiny/read-oracle.ts
  - src/apps/tiny/oracles/read-wave-1.oracle.json
  - src/apps/tiny/read-wave-1.test.ts
  - src/apps/tiny/write-contracts.ts
  - src/apps/tiny/oauth.ts
  - src/apps/tiny/quota.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Tiny

## Intent

Conectar o Tiny/Olist ERP como Ravi App tenant-scoped, com segredo resolvido pelo
broker de credenciais, leitura observável e mutações sempre fail-closed até um
cutover aprovado. O SDE continua sendo baseline e fallback enquanto os gaps
documentais e operacionais abaixo estiverem abertos.

## Invariants

- **R1** — O App MUST manter `ravi.app.json` válido e help estruturado completo por operação.
- **R2** — Toda chamada MUST exigir `--tenant`; não existe tenant default implícito.
  Configuração de tenant MUST conter somente `credentialProvider=tiny` e
  `credentialConnection`; token, client secret, access token e refresh token não
  podem aparecer no manifesto, config, stdout, logs ou artefatos.
- **R3** — Hosts live são fixos: v2 em `https://api.tiny.com.br/api2` e v3 em
  `https://api.tiny.com.br/public-api/v3`.
- **R4** — Leitura live MUST falhar fechado quando a conexão do broker não estiver ativa.
- **R5** — Operações mutating MUST declarar `tiny:write` ou `tiny:destructive`, além de
  `hitlRequired=true`, `confirmationRequired=true` e `idempotent=false`.
- **R6** — Enquanto `executionEnabled=false`, toda escrita MUST exigir `--dry-run`, rejeitar
  `--yes`, não resolver segredo e não abrir rede.
- **R7** — Preview de escrita MUST retornar apenas shape, hash e provenance; valores do
  payload não podem ser ecoados.
- **R8** — Ausência de documentação oficial, divergência legado/oficial ou OAuth lifecycle
  incompleto mantém a operação em NO-GO live.
- **R9** — Nenhuma mutação pode ter retry automático sem idempotência e reconciliação;
  antes do cutover, quota desconhecida exige serialização conservadora e observabilidade.
- **R10** — `read-wave-1` MUST ser um scope explícito de seis operações cujo
  denominador e contrato vêm do oracle sanitizado independente
  `oracles/read-wave-1.oracle.json`, nunca do próprio manifest ou do SDE. O
  comparador MUST verificar command, args, endpoint, input, output, schema e os
  casos nominal, vazio, erro, paginação (ou `not-applicable`) e tenant para 100%
  do wave. As outras dez reads modeladas não podem aparecer no manifesto/CLI até
  wave próprio.

## Acceptance Criteria

| Invariant | Verification Method | Check Ref | Pass Condition |
|-----------|---------------------|-----------|----------------|
| R1 | Test | CHECKS.md#C1 | Manifest válido; 22/25 helps completos e os dois estornos financeiros mais webhook incompletos com gaps oficiais explícitos. |
| R2 | Inspection | CHECKS.md#C2 | Config/output sem segredo e tenant explícito em toda operação. |
| R3 | Test | CHECKS.md#C3 | Host alternativo live é recusado antes de qualquer credencial. |
| R4 | Demonstration | CHECKS.md#C4 | Ausência/inatividade falha fechado; prova broker live gera audit sem exposição. |
| R5 | Test | CHECKS.md#C5 | 17/17 writes têm permissão e gates canônicos de HITL/confirmação. |
| R6 | Test | CHECKS.md#C6 | Writes sem dry-run ou com `--yes` falham; preview registra zero rede/segredo. |
| R7 | Test | CHECKS.md#C7 | Output contém somente schema/campos/hash, nunca valores do payload. |
| R8 | Analysis | CHECKS.md#C8 | Gaps v1, webhook, estornos financeiros e OAuth aparecem no contrato e mantêm NO-GO; URL não verificada não promove provenance, quota, help ou gate. |
| R9 | Inspection | CHECKS.md#C9 | Quotas oficiais v2/v3 são versionadas; retry automático é falso e quota desconhecida permanece NO-GO sem headers inventados. |
| R10 | Test | CHECKS.md#C10 | Oracle independente reporta 6/6 reads e zero mismatch/gate issue; mutações autocertificadas do manifest falham e a saída declara que não prova 171/171 nem paridade completa do conector. |

## Adaptation

Não há decisões abertas sem contrato. Os gaps conhecidos são bloqueadores de
cutover explícitos no RUNBOOK; resolvê-los exige nova validação e autorização,
não uma adaptação implícita deste contrato.

## Interfaces

- CLI: `ravi tiny`
- Manifest: `src/apps/tiny/ravi.app.json`
- Tenant config: `$RAVI_STATE_DIR/apps/tiny/tenants/<tenant>.json`
- Credential broker: `provider=tiny`, `connection=<tenant-or-explicit-connection>`

## Operations

- Read-only local: `config-check`, `v3-auth-check`.
- Read-only wave 1 v2: `info`, `contatos`, `contato`, `produtos`, `produto`,
  `estoque`. Os outros dez contratos v2 já modelados permanecem fora do
  manifesto/CLI público até wave próprio e continuam no SDE.
- Write preview v2: `contato-incluir`, `contato-alterar`, `produto-incluir`,
  `produto-alterar`, `pedido-incluir`, `pedido-alterar`, `pedido-situacao`,
  `estoque-atualizar`, `nota-emitir`, `conta-receber-incluir`,
  `conta-receber-baixar`, `conta-receber-estornar`, `conta-pagar-incluir`,
  `conta-pagar-baixar`, `conta-pagar-estornar`, `webhook-incluir`.
- Write preview v3: `oc-criar`.

Para cada operação, `ravi tiny <operation> --help` é a fonte operacional. Os
contratos de escrita são apenas preview: não existe transporte live habilitado.

## Quota Policy

- V2 é account-scoped e publica 0/30/60/120 requests/minuto por plano (20 para
  planos descontinuados), batch 5, até 20 registros/request, 100 registros/response,
  concorrência recomendada de 1/4 e header `x-limit-api`. A lista upstream oficial
  completa dos serviços que sempre contam como lote é `contato-incluir`,
  `contato-alterar`, `produto-incluir`, `produto-alterar`, `grupo-tag-incluir`,
  `grupo-tag-alterar`, `tag-incluir` e `tag-alterar`, independentemente do número de
  registros. O subset atualmente migrado pelo App contém os quatro primeiros; os
  quatro serviços de grupos/tags permanecem fora do subset migrado, sem apagar a
  regra upstream publicada.
- V3 é account-scoped, compartilhada entre aplicativos, e publica buckets
  total/write de 60/30, 120/60 e 240/100 requests/minuto por faixa de plano,
  observáveis em `X-RateLimit-Limit`, `X-RateLimit-Remaining` e
  `X-RateLimit-Reset`.
- Quando endpoint/quota não têm contrato oficial localizado, os limites e
  headers permanecem `null`/vazios, com owner e gate NO-GO; nunca herdam a
  hipótese legada de 100/min.
- Uma string em `officialDoc` não constitui evidência por si só. Sem fonte
  oficial imutável verificada, `officialDoc` MUST ser `null`, provenance MUST
  permanecer `low`/`gap`, quota MUST permanecer `unknown`, um owner MUST ser
  explícito, `liveGate` MUST ser `no-go`, `complete` MUST ser `false` e os itens
  materiais ausentes MUST permanecer em `missing`. Essa regra vale para toda
  operação, não apenas para gaps conhecidos hoje.
- Antes do cutover: `maxInFlight=1`, `minIntervalMs=3000`, `maxAttempts=1` e
  retry automático desabilitado.
- Produção exige métricas de consumo, erro de quota observado, latência e reconciliação.

## Known Gaps

- Não há conexão `tiny/sde` persistida no broker neste host: keychain e Vault não
  estão disponíveis/configurados. A leitura real de validação usou banco de
  credenciais e backend Vault compatível temporários, resolveu `auth.check` e
  gerou audit sem expor o token; todo estado temporário foi removido ao fim.
- O lifecycle OAuth v3 (bundle no broker, access/refresh expiry, rotação,
  persistência no mesmo secretRef, auditoria e falha fechada) existe e tem testes
  offline. Consentimento, conexão persistente, grants, revogação real e prova live
  ainda não foram materializados e mantêm v3 live em NO-GO.
- `conta-receber-estornar` e `conta-pagar-estornar` não possuem evidência
  oficial imutável localizada. Os comandos legados observados não substituem
  essa evidência; ambos permanecem com `officialDoc=null`, provenance
  `low`/`gap`, quota `unknown`, owner explícito, `liveGate=no-go`,
  `complete=false` e `missing` material.
- `webhook-incluir` não possui contrato oficial v2 público localizado e
  permanece sob a mesma política fail-closed de provenance, quota e live gate.
- `conta-receber-baixar` diverge entre campos observados no SDE e documentação.
- Não foi localizada documentação oficial v1 independente; comandos chamados
  de v1 no SDE usam o transporte `/api2` e devem ser tratados como legado até
  prova documental.
- O binário instalado pode estar atrás do source; deploy/restart é uma etapa HITL
  separada e não faz parte desta validação.

## Validation

- `ravi apps check tiny --json`
- `ravi apps show tiny --json`
- `ravi tiny check --json`
- `bun test src/apps/tiny/read-contracts.test.ts src/apps/tiny/read-wave-1.test.ts src/apps/tiny/client.test.ts src/apps/tiny/write-contracts.test.ts src/apps/tiny/manifest.test.ts src/apps/tiny/oauth.test.ts src/apps/tiny/credential.test.ts src/credentials/broker.authorization.test.ts`
- `bun test src/apps/router.test.ts`
- `bun src/cli/index.ts tiny <operation> --help --json`
- `bun test src/apps/tiny/read-wave-1.test.ts`
