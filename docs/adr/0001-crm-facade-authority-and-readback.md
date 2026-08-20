# ADR 0001: autoridade e readback da facade CRM

**Data:** 2026-08-20
**Status:** accepted

## Contexto

A facade CRM persistia planos sob um comando classificado como leitura, fazia
readback por agregados amplos, convertia `primary` ausente em `false` e nao
propagava integralmente identidade e idempotencia aos eventos. O RAVI SDK e
consumidores remotos derivam seus contratos do registry da CLI, portanto a
correcao nao pode introduzir flags de identidade controladas pelo chamador nem
quebrar assinaturas existentes.

## Decisao

O registry da CLI continua sendo a fonte do SDK, mas `crm.facade.plan` passa a
ser uma mutacao `writeContacts`. Identidade de apply vem do contexto confiavel
do runtime. Flags opcionais preservam tri-state. Autorizacao de linha ocorre
antes da resolucao e usa todos os contatos vinculados. Readback usa sensores
exatos e projecoes minimas por operacao.

Planos expirados, nao aprovados e sem journal sao removidos oportunisticamente
por identificadores exatos. Planos com aprovacao ou efeito permanecem como
evidencia operacional.

## Alternativas consideradas

- **Manter `plan` como leitura e persistir em `approve`** - rejeitada porque
  quebraria o fluxo e a referencia `planId` usada pelos SDKs e consumidores.
- **Receber `actorId` como argumento do SDK** - rejeitada porque permitiria
  spoofing de identidade e divergiria do modelo de contexto do gateway.
- **Filtrar agregados amplos depois do readback** - rejeitada porque dados
  ocultos ainda seriam lidos antes da autorizacao e novos campos poderiam vazar.
- **Converter ausencia de `primary` em `false`** - rejeitada porque transforma
  omissao em efeito destrutivo e viola o contrato de flags opcionais.

## Consequencias

- **Positivas:** assinaturas do SDK permanecem compativeis; autorizacao,
  dispatch, readback e eventos compartilham a mesma intencao; readbacks nao
  carregam relacionamentos alheios ao predicado.
- **Negativas/custos:** consumidores de `plan` precisam de `writeContacts`; uma
  conta ou oportunidade ligada a qualquer contato oculto falha fechada; novos
  sensores exatos e uma matriz por operacao passam a ser obrigatorios.

## Notas

A matriz automatizada cobre as nove operacoes em
`src/crm/facade.test.ts`. A persistencia real dos campos de evento e validada em
`src/contacts.identity-model.test.ts`.
