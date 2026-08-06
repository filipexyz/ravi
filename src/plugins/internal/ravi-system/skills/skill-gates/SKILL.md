---
name: skill-gates
description: |
  Gerencia os skill gates do Ravi. Use quando precisar:
  - Entender por que uma tool carrega uma skill automaticamente
  - Listar regras default e overrides de skill gates
  - Criar novas regras para tools, grupos ou comandos shell
  - Sobrescrever, desativar ou resetar gates existentes
  - Usar o CLI `ravi skill-gates`
---

# Skill Gates

Skill gates fazem uma chamada de tool falhar de forma controlada quando a sessão ainda não carregou a skill necessária. A falha entrega o conteúdo da skill, marca a skill como carregada na sessão e pede retry da tool original.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (`GATE_NOT_FOUND`). O envelope traz `suggestions` com ids reais de regras parecidas — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido).
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que `--execute` faria. Revise e repita com `--execute`.

Onde o freio existe hoje: `skill-gates rm` (deleta regra custom ou desativa default — destrutivo) e `skill-gates reset` (descarta um override configurado) são dry-run por default e exigem `--execute`. Detalhes:

- `rm` valida ANTES do freio: id custom inexistente → exit 1 `GATE_NOT_FOUND`, nunca 3. O `plan.action` diz o que aconteceria: `delete-custom` ou `disable-default`.
- `reset` só freia quando EXISTE override configurado (o `plan.discards` mostra o que seria descartado). Sem override não há o que descartar: resultado legado exit 0 com `deleted:false`.

Sem freio (declarado): `set` (upsert, re-emitível à vontade) e `enable`/`disable` (reversíveis entre si) escrevem na hora.

Compact mode: `skill-gates list` aceita `--fields a,b,c` (ex.: `--fields id,enabled`).

Exemplos freados:

```bash
ravi skill-gates rm linear                 # dry-run: plano delete-custom (exit 3)
ravi skill-gates rm linear --execute       # deleta de verdade
ravi skill-gates rm image --execute        # desativa o default via override
ravi skill-gates reset image               # exit 3 se houver override; senão no-op exit 0
ravi skill-gates reset image --execute     # descarta o override e volta ao default
```

Checklist antes de responder sobre skill gates:

- Tratei exit 3 como freio (revisei `plan.action`/`plan.discards`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar que a regra não existe?
- Lembrei que `rm` de default NÃO deleta — cria override desativado, reversível com `reset --execute`?

## CLI

Use `ravi skill-gates` para gerenciar regras. Não edite JSON em settings.

```bash
ravi skill-gates list
ravi skill-gates show image
ravi skill-gates set image ravi-system-image
ravi skill-gates disable image
ravi skill-gates rm linear --execute
ravi skill-gates reset image --execute
```

## Regras

Existem dois níveis:

- Defaults em código: cobrem grupos Ravi conhecidos, como `image`, `tasks`, `sessions`, `skill-gates`.
- Overrides no DB: tabela `skill_gate_rules`, usada para criar regras novas, sobrescrever defaults ou desativar defaults.

Um override com o mesmo `id` de um default muda esse default. Exemplo:

```bash
ravi skill-gates set image minha-skill-image
```

Para desativar um default:

```bash
ravi skill-gates disable image
```

Para remover o override e voltar ao default (dry-run sem `--execute`):

```bash
ravi skill-gates reset image --execute
```

## Criar Regra Customizada

Regras customizadas precisam de matcher explícito.

```bash
ravi skill-gates set linear linear-skill --pattern '^linear(?:[._]|$)'
ravi skill-gates set lookup lookup-skill --tool external_lookup
ravi skill-gates set github github --command-prefix 'gh issue'
```

Matchers disponíveis:

- `--pattern <regex>`: regex contra grupo/tool normalizado.
- `--group-regex <regex>`: alias semântico de `--pattern`.
- `--tool <name>`: nome exato da runtime tool.
- `--tool-prefix <prefix>`: prefixo de runtime tool.
- `--tool-regex <regex>`: regex contra runtime tool.
- `--command <command>`: comando shell exato.
- `--command-prefix <prefix>`: prefixo de comando shell.
- `--command-regex <regex>`: regex contra comando shell bruto.

## Comportamento no Runtime

O runtime consulta a tabela `skill_gate_rules` a cada resolução de gate e combina com os defaults em código. Ordem prática:

1. Regras configuradas com matcher direto podem forçar ou desativar um gate.
2. Overrides por `id` alteram ou desativam defaults.
3. Se nada configurado casar, os defaults em código continuam valendo.

Comandos de introspecção e carregamento de skills ficam isentos para evitar deadlock, como `ravi skills show`, `ravi tools list` e `ravi sessions visibility`.
