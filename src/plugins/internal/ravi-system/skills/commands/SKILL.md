---
name: commands
description: |
  Gerencia Ravi Commands. Use quando precisar:
  - Criar, listar, mostrar, validar ou previewar comandos `#nome`
  - Editar arquivos Markdown em `.ravi/commands` ou `$RAVI_HOME/commands`
  - Entender como `#command` vira prompt composto antes do runtime
  - Debugar por que um comando foi expandido, falhou ou passou como chat normal
  - Usar o CLI `ravi commands`
---

# Ravi Commands

Ravi Commands sao atalhos de prompt invocados pelo usuario com `#nome`.
Eles nao sao slash commands, nao sao shell commands e nao concedem permissao extra ao agent.

## Modelo Mental

Um Ravi Command e um arquivo Markdown que vira prompt composto.

Fluxo de mensagem de canal:

1. Omni recebe o texto cru do usuario.
2. Ravi resolve rota, sessao e agent.
3. Se o texto cru comeca com `#command`, Ravi tenta expandir o command.
4. Ravi monta o envelope do canal, por exemplo `[WhatsApp ...] Luis: ...`.
5. O prompt composto entra no `SESSION_PROMPTS` via NATS.
6. O runtime despacha normalmente, com as mesmas regras de fila, debounce, interrupcao, barriers e provider.

`ravi commands run` e diferente: ele so renderiza e retorna o prompt composto para preview. Ele nao publica em sessao e nao executa runtime.

## Locais

Commands sao arquivos Markdown em:

```text
<agent.cwd>/.ravi/commands/<name>.md
$RAVI_HOME/commands/<name>.md
```

`$RAVI_HOME` normalmente e `~/.ravi`.

Ordem de resolucao:

1. Agent command em `<agent.cwd>/.ravi/commands`.
2. Global user command em `$RAVI_HOME/commands`.

Um command do agent sobrescreve um global com o mesmo nome canonico.

## Sintaxe de Invocacao

```text
#review-pr 123 high
#restart "ativar commands"
#daily-summary
```

Regras:

- O token precisa estar no primeiro caractere nao-espaco da mensagem.
- O nome aceita letras, numeros e `-`: `#[A-Za-z0-9][A-Za-z0-9-]{0,63}`.
- Lookup e deteccao de conflito usam lowercase.
- `#word` no meio de uma frase e texto normal.
- Um `#command` valido mas inexistente passa como chat normal.
- Um token invalido que comeca com `#` deve falhar com erro claro.

## CLI

```bash
ravi commands list --agent <agent> --json
ravi commands show <name> --agent <agent> --json
ravi commands validate --agent <agent> --json
ravi commands run <name> --agent <agent> --json -- <arguments>
```

Use `--agent` quando precisar resolver commands do workspace daquele agent.

## Formato do Arquivo

```markdown
---
title: Restart Ravi daemon
description: Restart the Ravi daemon with a contextual reason.
argument-hint: "<reason>"
arguments:
  - reason
---

Restart the Ravi daemon now.

Use this reason: $reason
```

Frontmatter suportado:

- `title`
- `description`
- `argument-hint`
- `arguments`
- `disabled`

Frontmatter como `allowed-tools`, `model`, `effort`, `shell`, `hooks`, `context` ou `agent`
nao concede capabilities nem altera runtime. Trate como aviso de validacao, nao como regra efetiva.

## Argumentos

Placeholders suportados:

- `$ARGUMENTS`: string crua apos o token do command.
- `$ARGUMENTS[N]`: argumento posicional, zero-based.
- `$N`: atalho zero-based.
- `$name`: argumento posicional nomeado em `arguments`.

Argumentos posicionais usam parsing shell-like. Para passar texto com espaco como um argumento:

```text
#restart "ativar Ravi Commands"
```

Se argumentos forem fornecidos e o corpo nao usar nenhum placeholder, o renderer adiciona
`ARGUMENTS: <raw arguments>` para nao descartar input do usuario silenciosamente.

## Edicao Segura

- Editar um arquivo de command nao requer restart do daemon.
- Criar ou alterar a implementacao de Ravi Commands no codigo requer build e restart para o daemon vivo usar o patch.
- Nao execute snippets de shell contidos no Markdown durante render.
- Nao transforme Ravi Command em mecanismo de permissao. Permissoes continuam no runtime, context keys e skill gates.

## Debug

Para inspecionar commands:

```bash
ravi commands validate --agent dev --json
ravi commands show restart --agent dev --json
ravi commands run restart --agent dev --json -- "ativar Ravi Commands"
```

Para ver se um command foi expandido em uma mensagem real:

```bash
ravi sessions trace <session> --message <message_id> --explain --json
```

Eventos e metadata relevantes:

- `command.invoked`: command expandido antes do runtime.
- `command.failed`: command invalido, duplicado, disabled ou com erro de validacao.
- `prompt.published`: prompt ja publicado para `SESSION_PROMPTS`.
- `adapter.request.commands`: metadata dos commands que produziram o prompt.

