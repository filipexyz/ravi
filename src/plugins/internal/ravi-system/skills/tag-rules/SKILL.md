---
name: tag-rules
description: |
  Gerencia o engine de auto-tagging do Ravi. Use quando precisar:
  - Criar, validar, listar ou explicar tag rules
  - Aplicar regras manualmente em um contato ou em todos via tick
  - Entender como rules disparam reativas em mensagens novas
  - Modelar workflows com transições de tags (lifecycle:new → lifecycle:qualified)
---

# Tag Rules

Tag rules classificam contatos e chats de forma determinística. Cada rule lê estado canônico e adiciona/remove tags. Sem IA, sem inferência.

Rules são a base de orquestração: instâncias aplicam tag inicial (`defaultContactTags`), observers reagem a tags (`--scope tag --tag-target contact`), e tag rules movem o contato entre estados conforme o que aparece nas conversas.

## Modelo

- Rule = JSON em `.ravi/tag-rules/<id>.json`
- `scope`: `contact` ou `chat`
- `conditions`: predicados tipados pelo scope (AND implícito)
- `apply`: ações `tag` / `removeTag` no target
- `when`: `matched` (default) ou `not-matched` para inverter

Execução:
- **Reativa**: cada mensagem inbound DM dispara o engine via `queueMicrotask` no consumer
- **Periódica**: `ravi tag-rules tick --apply` percorre todos os contatos (recomendado via cron)
- **Manual**: `ravi tag-rules evaluate <rule-id> --target contact:<id>` (default dry-run)

Audit: cada apply emite `profile.tag_added`/`profile.tag_removed` no timeline do contato e NATS `ravi.tags.rule.applied`.

## Comandos

```bash
ravi tag-rules list
ravi tag-rules show <rule-id>
ravi tag-rules validate
ravi tag-rules explain --target contact:<id>
ravi tag-rules evaluate <rule-id> --target contact:<id> [--apply]
ravi tag-rules tick [--apply] [--limit <n>]
```

`evaluate` e `tick` são dry-run por default. Use `--apply` quando confirmar.

## Inspeção Cruzada

Tag-rules é UM dos 5 planos do CRM. Quando inspecionar, sempre combine com os outros pra ter contexto:

```bash
ravi tag-rules list --json                      # regras carregadas
ravi instances list --json                      # default tags por instância
ravi contacts list --json                       # base de contatos onde as regras vão rodar
ravi chats list --limit 5 --json                # conversas onde os sinais aparecem
ravi observers rules list --json                # quem consome as tags produzidas
```

⚠️ **Regras sem contatos** = inerte. Antes de criar regra, confirme que há intake ativo e contatos sendo criados.

⚠️ **Regras sem observer consumindo a tag de saída** = pipeline incompleto. A regra muda a tag, mas ninguém age. Sempre verifique se existe observer rule consumindo cada tag que sua rule produz.

## Conditions Vocabulary

### scope: contact

- `has-tag`, `not-has-tag`, `has-any-tag`, `has-all-tags`
- `status`: `allowed | pending | blocked | discovered`
- `last-inbound-age`: operadores `>`/`<`/`>=`/`<=`/`=` e duração (`7d`, `24h`, `30m`)
- `has-chat-with`: sub-conditions avaliadas em chats relacionados

### scope: chat (e sub-conditions de has-chat-with)

- `chat-type`: `dm | group | channel | thread`
- `message-count`: operadores numéricos
- `any-message-text-matches`: regex case-insensitive, `lastN` e `from` (`any|contact|agent`)
- `last-inbound-age`: idade da última mensagem inbound
- `has-tag`, `not-has-tag`: tags atachadas ao chat asset

## Apply Semantics

```yaml
apply:
  - target: contact         # ou chat
    tag: lifecycle:qualified
    removeTag: lifecycle:new
    when: matched           # ou not-matched
    targetMode: all         # ou matched (futuro, ainda não em uso)
```

Transições explícitas via `removeTag`. Tag families são deferred — quando manualmente listar removes ficar repetitivo, promover pra family.

## Playbook: Pipeline de Lead

### 1. Instância marca tag inicial
```bash
ravi instances set main contactIntakeMode discovered
ravi instances set main defaultContactTags lifecycle:new
```

### 2. Rule promove `new → qualified` quando o contato menciona compra
```bash
cat > ~/.ravi/tag-rules/qualify-buy-intent.json <<'EOF'
{
  "id": "qualify-buy-intent",
  "description": "Move lead pra qualified quando demonstra interesse de compra",
  "scope": "contact",
  "enabled": true,
  "priority": 10,
  "conditions": [
    { "kind": "has-tag", "tag": "lifecycle:new" },
    {
      "kind": "has-chat-with",
      "conditions": [
        { "kind": "any-message-text-matches", "pattern": "(preço|comprar|orçamento)", "from": "contact" }
      ]
    }
  ],
  "apply": [
    {
      "target": "contact",
      "tag": "lifecycle:qualified",
      "removeTag": "lifecycle:new",
      "when": "matched"
    }
  ]
}
EOF

ravi tag-rules validate
ravi tag-rules explain --target contact:<id>
```

### 3. Observer entra quando tag muda
```bash
ravi observers rules set qualified-nurture <observer-agent> \
  --scope tag \
  --tag lifecycle:qualified \
  --tag-target contact \
  --observer-role qualified-nurture
```

### 4. Rule esfria lead inativo (cron)
```bash
cat > ~/.ravi/tag-rules/cold-lead.json <<'EOF'
{
  "id": "cold-lead",
  "scope": "contact",
  "enabled": true,
  "priority": 50,
  "conditions": [
    { "kind": "has-tag", "tag": "lifecycle:qualified" },
    { "kind": "last-inbound-age", "operator": ">", "duration": "7d" }
  ],
  "apply": [
    { "target": "contact", "tag": "temperature:cold", "when": "matched" }
  ]
}
EOF
```

Rode via cron:
```bash
0 */6 * * * cd /path/to/ravi && bin/ravi tag-rules tick --apply --json
```

## Regras de Ouro

- Rules são determinísticas: mesmo estado, mesmo resultado.
- Sempre dry-run antes de apply.
- Não usar rules pra mudar `contact_policies.status` ou `crm_contact_profiles.lifecycle` — só tags.
- Transições de estado entre tags = `removeTag` explícito no apply.
- Cascade guard previne loop entre rules; max-depth é telemetria por enquanto.
- `tick` é idempotente: rodar 2x não duplica eventos (no-op detectado).

## Debugging

`ravi tag-rules explain --target contact:<id>` mostra:
- Quais rules deram MATCH e quais miss
- O trace de cada condition
- Que tags seriam adicionadas/removidas no apply

`ravi contacts events <phone>` mostra timeline incluindo `profile.tag_added`/`profile.tag_removed`.

NATS: assine `ravi.tags.rule.applied` para reagir em outros sistemas.

## Integração com Reading Lists

Tag rules são a entrada reativa do motor de membership dinâmico. Cada vez que uma rule aplica (`ravi.tags.rule.applied`), o motor de reading lists:

1. Consulta o índice reverso (tag_slug → Set<list_id>) para descobrir quais listas usam essa tag como condição.
2. Agenda reavaliação debounced (500 ms) para o contato ou chat afetado.
3. Aplica a máquina de estado: MATCHED + fora → adiciona; NOT_MATCHED + dentro → soft-delete.

Consequência prática: **toda mudança de tag via rule é propagada automaticamente para as listas dinâmicas relevantes — sem polling manual**.

Para forçar reavaliação imediata:

```bash
ravi chats lists tick --list <nome-ou-id> --apply
ravi chats lists explain <lista> --target contact:<id>
```

Para criar uma lista que filtra contatos com `lifecycle:qualified`:

```bash
ravi chats lists create "Leads Qualificados" --mode dynamic \
  --selector '{"scope":"contact","match":"all","conditions":[{"kind":"has-tag","tag":"lifecycle:qualified"}]}'
```

Ao aplicar a rule que adiciona `lifecycle:qualified`, o contato entra automaticamente na lista. Ao reverter (rule remove a tag), o contato sai — com o cursor preservado (leitura independente de membership).

## Spec

Spec normativa: `tags/auto-tagging` em `.ravi/specs`. Cobre invariants, performance, audit, e convergência futura com observer rules compostas.

Spec do motor de membership: `.ravi/specs/channels/chats/reading-lists/DYNAMIC-MEMBERSHIP.md`.
