# Observers: CLI, saídas e inspeção

Referência do `ravi observers`. O caso comum (vigiar uma sessão) está na SKILL.md, com `ravi sessions observe`.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `OBSERVER_NOT_FOUND` para binding/rule/profile, `SESSION_NOT_FOUND` para sessão fonte). O envelope de `OBSERVER_NOT_FOUND` traz `suggestions` com ids reais parecidos — consulte antes de concluir "não existe". `SESSION_NOT_FOUND` NÃO traz `suggestions` de propósito: o isolamento de escopo mascara sessão não-autorizada como not-found, e sugerir nomes reais vazaria sessões de outros escopos.
- `2` erro de uso (flag/argumento inválido). Corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: só `observers rules rm` (deletar rule é destrutivo — o único reverso é recriar na mão) é dry-run por default e exige `--execute`:

```bash
ravi observers rules rm <rule-id> --json            # dry-run: mostra o plan e sai com exit 3
ravi observers rules rm <rule-id> --json --execute  # apaga de verdade
```

Todas as demais escritas gravam na hora, sem dry-run: `refresh`, `rules set`, `rules enable|disable`, `profiles init`. Nessas o freio é você: confira o alvo antes de rodar (`rules set` sobrescreve a rule inteira com o mesmo id; `disable` é o reverso barato de `enable`).

Compact mode: `observers list`, `observers rules list` e `observers profiles list` aceitam `--fields a,b,c` (ex.: `--fields id,enabled`) — use em varredura para não arrastar o objeto inteiro.

Checklist antes de responder sobre observers:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?
- Rodei o `rm` de novo com `--execute` só depois de confirmar que a rule certa está no plano?

## Comandos

```bash
ravi observers list
ravi observers show <binding-id>
ravi observers refresh <session>
ravi observers refresh <session> --reconcile full-reconcile

ravi observers rules list
ravi observers rules show <rule-id>
ravi observers rules set <rule-id> <observer-agent> [--scope profile] [--source-profile observed-task] [--profile tasks] [--selector <expression>]
ravi observers rules enable <rule-id>
ravi observers rules disable <rule-id>
ravi observers rules rm <rule-id> --execute   # sem --execute é dry-run (exit 3)
ravi observers rules validate
ravi observers rules explain --session <session>

ravi observers profiles list
ravi observers profiles show <profile-id>
ravi observers profiles preview <profile-id> --event message.assistant
ravi observers profiles validate [profile-id]
ravi observers profiles init <profile-id>
```

## Inspeção Cruzada

Observers vivem em cima do resto do CRM. Antes de criar ou debugar, inspecione o ecossistema todo:

```bash
ravi observers rules list --json                 # quais regras observam o quê
ravi observers list --json                       # bindings ativos
ravi tag-rules list --json                       # quem produz as tags que observers consomem
ravi contacts list --json                        # base sob observação
ravi chats lists list --json                     # filas de leitura (se observers usam reading lists)
```

⚠️ **Observer rule sem source matching** = dorme pra sempre. Use `ravi observers rules explain --session <session>` pra ver porque uma rule específica não disparou.

⚠️ **Observer rule por tag de contato** depende de `session_participants` ter o contato linkado. Confirme via `ravi observers rules explain` que `source.contactIds` está preenchido.
