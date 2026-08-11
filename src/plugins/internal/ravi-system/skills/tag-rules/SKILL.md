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
ravi tag-rules list [--fields id,scope]
ravi tag-rules show <rule-id>
ravi tag-rules validate
ravi tag-rules explain --target contact:<id>
ravi tag-rules evaluate <rule-id> --target contact:<id> [--apply]
ravi tag-rules tick [--apply] [--limit <n>]
```

`evaluate` e `tick` são dry-run por default. Use `--apply` quando confirmar.

## Contrato Do CLI

Contrato agent-first (Manual v2). Exit codes: `0` sucesso · `1` erro
(not-found/provider) · `2` erro de uso · `3` freio de escrita (não usado neste
domínio — veja abaixo). Com `--json`, falhas retornam o envelope
`{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.

**Freadas vs sem-freio:**

- Nenhuma op deste domínio usa `--execute`. As duas escritas do domínio —
  `tick` (em massa, TODOS os contatos) e `evaluate` (alvo único) — já nascem
  dry-run: **sem `--apply` são preview puro e não escrevem nada** (exit 0).
  `--apply` é o equivalente documentado do freio e NÃO será renomeado.
- Reads (`list`, `show`, `validate`, `explain`) são sem-freio, declaradas.

**Códigos de erro:**

| caso | code | exit |
|---|---|---|
| rule desconhecida (`show`, `evaluate`) | `TAG_RULE_NOT_FOUND` + `suggestions` de ids reais | 1 |
| contato desconhecido (`explain`, `evaluate`) | `CONTACT_NOT_FOUND` sem suggestions (visibilidade de contatos é escopada; use `ravi contacts list`) | 1 |

**Compact mode:** `ravi tag-rules list --json --fields id,scope` retorna só os
campos pedidos em cada rule.

**Autorização:** `tick` e `evaluate` declaram `@CommandAccess kind:"mutate"`
porque podem escrever tags com `--apply`. Isso não adiciona `--execute`:
autorização e confirmação são controles separados, e o preview sem `--apply`
continua sem efeitos.

**Checklist antes de aplicar em massa:**

1. `ravi tag-rules validate` — regras carregam sem erro?
2. `ravi tag-rules explain --target contact:<id>` — o match é o esperado?
3. `ravi tag-rules evaluate <rule> --target contact:<id>` — preview do alvo único.
4. `ravi tag-rules tick --json` — preview em massa; conferir `matched`/`appliedActions`.
5. Só então `ravi tag-rules tick --apply --json`.

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

## Spec

Specs normativas em `.ravi/specs`:

- `tags/auto-tagging` — invariants do engine, performance, audit, e convergência futura com observer rules compostas.
- `cli/tag-rules` — contrato agent-first do CLI (envelopes, exit taxonomy, equivalência do `--apply`, autorização mutate).
