---
name: crm-manager
description: |
  Opera o CRM nativo do Ravi sobre contatos. Use quando precisar:
  - Ler ou atualizar card CRM de um contato
  - Criar contas, oportunidades, stakeholders e follow-ups
  - Propor, confirmar ou rejeitar facts de CRM com evidencia
  - Ensinar agentes a trabalhar com relacionamento, pipeline e next actions
  - Decidir quando escrever campo forte versus proposta revisavel
---

# CRM Manager

Voce opera o CRM nativo do Ravi. O CRM e a camada de relacionamento acima de
`contacts`; ele nao substitui identidade, policy, chats, sessoes ou mensagens.

A sintaxe voce descobre no proprio CLI (`ravi crm --help`, `ravi crm <grupo> --help`,
`ravi crm <grupo> <op> --help`). Esta skill cobre o que o `--help` nao ensina: quando
usar cada operacao, as regras do funil e as armadilhas do dominio.

## Modelo Mental

- `contact`: pessoa ou organizacao canonica.
- `contact_policy.status`: permissao operacional (`allowed`, `pending`, `blocked`, `discovered`).
- `crm_contact_profile.lifecycle`: estado de relacionamento (`lead`, `qualified`, `active`, etc.).
- `account`: wrapper CRM para uma organizacao, idealmente ancorado em um contact `kind=org`.
- `opportunity`: oportunidade de trabalho/venda/projeto ligada a conta e/ou contato.
- `task`: proxima acao rastreavel.
- `fact`: afirmacao proposta ou confirmada sobre contato, conta ou oportunidade.
- `crm_events`: ledger append-only que explica por que o estado mudou.

Nunca confunda policy status com lifecycle CRM.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em
envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.

Taxonomia de saida:

- `0` sucesso.
- `1` erro de execucao ou not-found. O envelope traz `suggestions` com entidades reais
  parecidas — consulte antes de concluir "nao existe".
- `2` erro de uso (flag/arg invalido). O envelope traz `acceptedFlags`: corrija a
  chamada, nao insista na mesma sintaxe.
- `3` **freio de escrita — nao e erro.** Nada foi gravado; o envelope traz `dryRun:true`
  e `plan` com exatamente o que seria escrito. Revise o plano e repita com `--execute`.

**Onde o freio existe hoje:** somente `crm pipeline create`, `crm opportunity create` e
`crm opportunity move`. **Todas as demais escritas gravam na hora**, sem dry-run:
`crm contact set`, `crm account create`, `crm account link-contact`,
`crm opportunity link-contact`, `crm pipeline set`, `crm task create|done|cancel|snooze`,
`crm fact propose|confirm|reject`. Nessas o freio e voce: confira o alvo antes de rodar.

**Compact mode:** `crm next`, `crm contacts`, `crm board` e `crm pipeline list` aceitam
`--fields a,b,c`. Use em varredura para nao arrastar o card inteiro.

**Help por operacao:** `ravi crm pipeline help <op>` (idem `task` e `fact`). Nos grupos
`contact` e `opportunity` o `help <op>` falha porque o grupo tem argumento posicional
proprio — nesses use `ravi crm contact set --help`, `ravi crm opportunity create --help`.

## Primeiro Leia

Antes de escrever, colete a visao atual do alvo: `crm contact`, `contacts profile`,
`contacts timeline`, `contacts messages`, `contacts activity`, `crm fact list --contact`
e `crm next --contact`. No repo `ravi.bot`, prefira o wrapper local `bin/ravi`: o CLI so
e confiavel apontando para o mesmo runtime/DB do daemon vivo.

## Resolva O Alvo

Antes de qualquer write, garanta que o alvo e o contato canonico certo
(`contacts info`, `contacts duplicates`).

- Nao use display name como prova de identidade.
- Se o contato nao resolver, pare e reporte que o alvo nao foi encontrado.
- Se houver duplicata ou ambiguidade relevante, nao escreva CRM ate a identidade
  ser confirmada ou os contatos serem mergeados.
- Nunca escreva CRM em grupo/chat/thread como se fosse pessoa ou conta.

## Regra De Escrita

Escolha entre campo forte e fact:

- Escreva campo forte quando o operador pediu explicitamente, quando a informacao
  vem de fonte confiavel, ou quando o proprio workflow acabou de produzir o dado.
- Proponha `crm fact` quando a informacao foi inferida, resumida, ambigua,
  incompleta, sensivel, ou ainda precisa de revisao humana.
- Nao sobrescreva campo forte apenas porque uma mensagem recente sugeriu algo.
- Nao derive identidade por display name. Use contato canonico ou identity resolvida.
- Nao modele grupo/chat como contato, conta ou pessoa.

Campos fortes aceitos por `crm contact set <contact> <campo> <valor>`: `lifecycle`,
`relationship-health`, `priority`, `score`, `health-score`, `owner`, `primary-account`,
`primary-opportunity`, `lead-source`, `persona`, `buying-role`,
`last-meaningful-interaction-at`, `next-action-at`, `next-action-summary`, `next-task`,
`metadata`. Valor `-` limpa campo anulavel.

## Facts

Use facts para memoria revisavel e evidenciada. Chaves boas:

`profile.persona` · `profile.buying_role` · `profile.preference` · `relationship.context` ·
`opportunity.need` · `account.context` · `risk.objection` · `followup.commitment`

Use `--status confirmed` so quando a confirmacao ja estiver clara no pedido ou na fonte;
caso contrario deixe `proposed`. Fact confirmado NAO propaga para campo forte — aplique o
campo forte separadamente quando essa for a decisao correta.

## Idempotencia

Toda criacao repetivel deve usar `--idempotency-key` (`crm task create`,
`crm opportunity create`, `crm account create`, `crm fact propose`). Formato:

```text
<agent>:<entity>:<operation>:<source-id-or-date>
```

Ex.: `crm-agent:<contact>:followup:2026-05-22`. Sem chave estavel, reprocessamento
duplica registro — o CRM nao faz dedupe semantico de conta/oportunidade.

## Next Actions

Proxima acao boa e concreta: tem dono (`--owner agent:main`), alvo (`--contact` e/ou
`--opportunity`), prioridade e, quando possivel, `--due` em ISO com timezone. Toda task
exige pelo menos um alvo (contact, account, opportunity, chat ou session). Feche com
`crm task done`; leia a fila com `crm next --owner`.

## Scheduled Commitments + Daily Digest

Quando o cliente promete algo com data ("vou comprar sexta", "te aviso semana que vem"),
o agent que esta conversando cria uma `crm_tasks` com `--task-type commitment` e `--due`
no momento prometido. Todo dia 1 cron varredor lista o que vence e entrega o digest.

### Padrao arquitetural

**1 cron varredor + N rows em `crm_tasks`.** Nunca 1 cron por cliente. O agent que ja tem
o contexto da conversa cria a task direto via CLI. O digest e UM cron de shell, sem task
profile envolvido:

```bash
ravi cron add commitment-digest-morning --cron "0 8 * * *" \
  --shell "ravi crm next --due-today --owner agent:main --json"
```

### Quando o agent cria commitment

- `--due` na timezone do operador, normalizado (sem ambiguidade entre "sexta"
  2026-05-22 ou 2026-05-29). O CLI recusa `commitment` sem `--due`.
- `--evidence` com `[{ message_id, quote, extracted_phrase, extracted_date_iso }]`.
- `--confidence` proporcional a clareza do enunciado.
- `--idempotency-key` = hash de `(contact_id, due_at_normalizado, phrase_fingerprint)`,
  para tolerar reprocessamento sem duplicar.
- `--metadata` com `commitment_kind` opcional: `purchase | follow_up_request | callback | revisit`.

### Quando o cliente muda de ideia

Sempre atualize a row existente (mesma idempotency key), NUNCA crie nova:

- **Cancela**: `crm task cancel <id>` -> status `canceled`.
- **Reagenda**: `crm task snooze <id> --until <novo-due>` -> status `snoozed` e o due_at
  antigo vai para `metadata.history`. Task ja `done`/`canceled` nao aceita snooze.
- **Confirma**: `crm task done <id>` -> status `done`; se houve venda, opcionalmente
  cria/atualiza a oportunidade ganha.

Cada mutacao emite `crm_events` correspondente — a timeline reconstroi o arco da
negociacao. Para evitar dupla notificacao no mesmo dia, o cron MAY filtrar tarefas com
`metadata.last_digested_at` recente.

### Regras de ouro

- Commitment E sempre uma row em `crm_tasks`. Nao e cron, nao e trigger, nao e fact.
- Cancelamento/reschedule MUST atualizar a row existente, nao criar nova.
- Digest E read-only — observa, nao muta status.
- Sem due concreto nao vira commitment. Promessa vaga ("te aviso quando puder") fica
  como `follow_up` (default) sem `--due`, e por isso nunca entra no digest.
- O agent que conversa e quem cria. Sem observer separado.

## Fluxo Recomendado Para Agente

1. Resolva o alvo para contato canonico.
2. Verifique ambiguidade/duplicatas antes de escrever.
3. Leia card CRM, profile, timeline, mensagens recentes, activity e facts.
4. Separe evidencia em tres grupos: confirmado, inferido, acao necessaria.
5. Escreva campos fortes apenas para dados confirmados ou pedidos pelo operador.
6. Proponha facts para inferencias e preferencias.
7. Crie tasks para compromissos, follow-ups e bloqueios acionaveis.
8. Vincule conta/oportunidade quando houver contexto comercial ou projeto claro.
9. Retorne um resumo curto: leituras feitas, writes aplicados, facts pendentes e next actions.

## Limites Atuais

- Nao ha `crm account set`, `crm opportunity set` nem `crm task set` generico: o que nao
  tem comando proprio nao se edita por aqui.
- Nao existe delete de oportunidade — criar a oportunidade errada e irreversivel. Use o
  dry-run (exit 3) para conferir o `plan` antes de `--execute`.
- `crm task create` nao aceita status: toda task nasce `open` com prioridade `normal`.
- Campo desconhecido em `crm contact set` ainda falha em texto puro (exit 1), fora do
  envelope; a mensagem lista os campos aceitos.
- Atividades CRM sao eventos curados; nao despeje toda mensagem bruta como atividade.
- Mutacoes precisam da permissao `write_contacts`. Se receber permission denied, reporte
  a falta de permissao em vez de contornar.

## Checklist Antes De Responder

- Usei contato canonico, nao display name solto?
- Chequei ambiguidade/duplicatas antes de escrever?
- Diferenciei policy status de lifecycle CRM?
- Usei `--json` nas leituras que guiaram writes?
- Tratei exit 3 como freio (revisei o `plan`) e nao como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?
- Usei idempotency key em criacoes/propostas repetiveis?
- Provei ou propus facts conforme a confianca?
- Criei next action somente se ela for acionavel?
