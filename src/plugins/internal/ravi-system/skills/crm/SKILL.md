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

Use esta skill para transformar contexto em estado CRM util, auditavel e seguro.

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

## Primeiro Leia

Antes de escrever, colete a visao atual:

```bash
ravi crm contact <contact-or-identity> --json
ravi contacts profile <contact-or-identity> --json
ravi contacts timeline <contact-or-identity> --limit 20 --json
ravi contacts messages <contact-or-identity> --limit 20 --json
ravi contacts activity <contact-or-identity> --limit 20 --json
ravi crm fact list --contact <contact-or-identity> --json
ravi crm next --contact <contact-or-identity> --json
```

Use `--json` quando for tomar decisao programatica.

Se estiver no repo `ravi.bot`, prefira o wrapper local:

```bash
bin/ravi crm contact <contact-or-identity> --json
```

## Resolva O Alvo

Antes de qualquer write, garanta que o alvo e o contato canonico certo.

```bash
ravi contacts info <contact-or-identity> --json
ravi contacts duplicates --json
```

Regras:

- Nao use display name como prova de identidade.
- Se o contato nao resolver, pare e reporte que o alvo nao foi encontrado.
- Se houver duplicata ou ambiguidade relevante, nao escreva CRM ate a identidade
  ser confirmada ou os contatos serem mergeados.
- Nunca escreva CRM em grupo/chat/thread como se fosse pessoa ou conta.

## Regra de Escrita

Escolha entre campo forte e fact:

- Escreva campo forte quando o operador pediu explicitamente, quando a informacao
  vem de fonte confiavel, ou quando o proprio workflow acabou de produzir o dado.
- Proponha `crm fact` quando a informacao foi inferida, resumida, ambigua,
  incompleta, sensivel, ou ainda precisa de revisao humana.
- Nao sobrescreva campo forte apenas porque uma mensagem recente sugeriu algo.
- Nao derive identidade por display name. Use contato canonico ou identity resolvida.
- Nao modele grupo/chat como contato, conta ou pessoa.

Campos fortes atuais de contato:

```text
lifecycle
relationship-health
priority
score
health-score
owner
primary-account
primary-opportunity
lead-source
persona
buying-role
last-meaningful-interaction-at
next-action-at
next-action-summary
next-task
metadata
```

Exemplos:

```bash
ravi crm contact set <contact> priority high --source agent:crm --json
ravi crm contact set <contact> persona founder --source agent:crm --json
ravi crm contact set <contact> buying-role decision_maker --source agent:crm --json
ravi crm contact set <contact> metadata '{"interests":["crm","agents"]}' --source agent:crm --json
```

## Facts

Use facts para memoria revisavel e evidenciada.

```bash
ravi crm fact propose contact <contact> profile.buying_role '{"role":"decision_maker"}' \
  --contact <contact> \
  --confidence 0.7 \
  --idempotency-key <stable-key> \
  --json

ravi crm fact propose contact <contact> profile.buying_role '{"role":"decision_maker"}' \
  --contact <contact> \
  --status confirmed \
  --confidence 1 \
  --idempotency-key <stable-key> \
  --json

ravi crm fact list --contact <contact> --status proposed --json
ravi crm fact confirm <fact-id> --json
ravi crm fact reject <fact-id> --json
```

Boas chaves de fact:

- `profile.persona`
- `profile.buying_role`
- `profile.preference`
- `relationship.context`
- `opportunity.need`
- `account.context`
- `risk.objection`
- `followup.commitment`

Use `status=confirmed` so quando a confirmacao ja estiver clara no pedido ou na
fonte. Caso contrario, deixe `proposed`.

## Idempotencia

Toda criacao repetivel deve usar `--idempotency-key`.

Formato recomendado:

```text
<agent>:<entity>:<operation>:<source-id-or-date>
```

Exemplos:

```bash
ravi crm task create "Follow up sobre proposta" \
  --contact <contact> \
  --priority high \
  --due <due-at-iso-with-timezone> \
  --owner agent:main \
  --idempotency-key crm-agent:<contact>:followup:<stable-date-or-source-id> \
  --json
```

```bash
ravi crm opportunity create "Piloto CRM" \
  --account <account-id> \
  --contact <contact> \
  --stage qualified \
  --value 500000 \
  --currency BRL \
  --owner agent:main \
  --idempotency-key crm-agent:<contact>:opportunity:piloto-crm \
  --json
```

## Contas e Oportunidades

Criar conta:

```bash
ravi crm account create "Acme" \
  --domain acme.com \
  --owner team:sales \
  --idempotency-key crm-agent:account:acme.com \
  --json
```

Vincular contato a conta:

```bash
ravi crm account link-contact <account-id> <contact> --role sponsor --primary --json
```

Criar oportunidade:

```bash
ravi crm opportunity create "Piloto Ravi" \
  --account <account-id> \
  --contact <contact> \
  --stage qualified \
  --value 250000 \
  --currency BRL \
  --owner agent:main \
  --idempotency-key crm-agent:<contact>:opp:piloto-ravi \
  --json
```

Vincular stakeholders:

```bash
ravi crm opportunity link-contact <opportunity-id> <contact> --role champion --primary --json
ravi crm opportunity contacts <opportunity-id> --json
```

Mover oportunidade:

```bash
ravi crm opportunity move <opportunity-id> proposal --json
```

## Next Actions

Proxima acao boa e concreta: tem dono, alvo, prioridade e quando possivel data.

```bash
ravi crm task create "Enviar resumo e proximos passos" \
  --contact <contact> \
  --opportunity <opportunity-id> \
  --priority urgent \
  --due <due-at-iso-with-timezone> \
  --owner agent:main \
  --idempotency-key crm-agent:<contact>:next-action:summary:<stable-date-or-source-id> \
  --json

ravi crm next --owner agent:main --json
ravi crm task done <task-id> --json
```

## Scheduled Commitments + Daily Digest

Quando o cliente promete algo com data ("vou comprar sexta", "te aviso semana que vem"), o agent que esta conversando cria uma `crm_tasks` com `task_type=commitment` e `due_at` no momento prometido. Todo dia 1 cron varredor lista o que vence e entrega o digest.

### Padrao arquitetural

**1 cron varredor + N rows em `crm_tasks`**. Nunca 1 cron por cliente. O agent que ja tem o contexto da conversa cria a task direto via CLI. O cron diario chama `ravi crm next --due-today` (ou equivalente) e ja entrega o resultado.

### Quando o agent cria commitment

Use `task_type=commitment` com:

- `due_at` na timezone do operador, normalizado (sem ambiguidade entre "sexta" 2026-05-22 ou 2026-05-29)
- `evidence_json` com `[{ message_id, quote, extracted_phrase, extracted_date_iso }]`
- `confidence` proporcional a clareza do enunciado
- `idempotency_key` = hash de `(contact_id, due_at_normalizado, phrase_fingerprint)` para tolerar reprocessamento sem duplicar
- `metadata_json.commitment_kind` opcional: `purchase | follow_up_request | callback | revisit`

```bash
ravi crm task create "Compra prometida — kraft 60g" \
  --contact 5511987340036 \
  --task-type commitment \
  --priority high \
  --due 2026-05-22T09:00-03:00 \
  --owner agent:main \
  --confidence 0.9 \
  --evidence '[{"message_id":"cm_...","quote":"vou comprar sexta","extracted_date_iso":"2026-05-22"}]' \
  --metadata '{"commitment_kind":"purchase"}' \
  --idempotency-key commitment:<contact_id>:2026-05-22:kraft-60g \
  --json
```

### Quando o cliente muda de ideia

Sempre atualize a row existente via `idempotency_key`, NUNCA cria nova:

- **Cancela**: `ravi crm task cancel <id>` -> status=canceled.
- **Reagenda**: `ravi crm task snooze <id> --until <novo-due-at>` -> push do due_at antigo pra metadata.history.
- **Confirma**: `ravi crm task done <id>` -> status=done; se houve venda, opcionalmente cria/atualiza `crm_opportunities` ganha.

Cada mutacao emite `crm_events` correspondente — a timeline reconstroi o arco da negociacao.

### Daily digest

Cron unico chama o comando CLI que ja consulta o estado:

```bash
ravi cron add commitment-digest-morning "0 8 * * *" \
  --command "ravi crm next --due-today --owner agent:main --json" \
  --account main
```

Saida do `ravi crm next --due-today` ja agrupa por owner e expoe as tarefas que vencem hoje. O cron entrega isso via o canal configurado (default: WhatsApp DM pro operador).

Para evitar dupla notificacao no mesmo dia, o cron MAY filtrar tarefas com `metadata_json.last_digested_at` recente.

### Inspecao e debug

```bash
ravi crm next --owner agent:main --task-type commitment --due-before 2026-05-23 --json
ravi crm task list --status scheduled --task-type commitment --json
ravi crm task show <task-id> --json
```

### Regras de ouro

- Commitment E sempre uma row em `crm_tasks`. Nao e cron, nao e trigger, nao e fact.
- Cancelamento/reschedule MUST atualizar a row existente, nao criar nova.
- Digest E read-only — observa, nao muta status.
- Sem due_at concreto, nao vira commitment. Promessa vaga ("te aviso quando puder") e `task_type=follow_up` com status=waiting, sem digest.
- O agent que conversa e quem cria. Sem observer separado.
- O cron e UM comando CLI, sem task profile envolvido.

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

- A sintaxe CLI e aninhada: use `ravi crm fact list`, nao `ravi crm.fact list`.
- Ja existem `crm contact set`, create/link/move/done e facts.
- Ainda nao ha `crm account set`, `crm opportunity set` ou `crm task set` generico.
- Facts confirmados nao atualizam automaticamente todos os campos fortes; aplique o campo forte separadamente quando essa for a decisao correta.
- O CRM nao faz dedupe semantico perfeito de conta/oportunidade. Use idempotency key e pesquise antes de criar.
- Atividades CRM sao eventos curados; nao despeje toda mensagem bruta como atividade.
- Mutacoes precisam de permissao `write_contacts`. Se receber permission denied, reporte a falta de permissao em vez de contornar.

## Checklist Antes De Responder

- Usei contato canonico, nao display name solto?
- Chequei ambiguidade/duplicatas antes de escrever?
- Diferenciei policy status de lifecycle CRM?
- Usei `--json` nas leituras que guiaram writes?
- Usei idempotency key em criacoes/propostas repetiveis?
- Provei ou propus facts conforme a confianca?
- Criei next action somente se ela for acionavel?
- Evitei escrever em conta/oportunidade/task campos que ainda nao tem comando `set`?
