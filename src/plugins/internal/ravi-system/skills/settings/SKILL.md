---
name: settings-manager
description: |
  Gerencia configurações globais do Ravi. Use quando o usuário quiser:
  - Ver ou alterar configurações do sistema
  - Definir agent default
  - Configurar DM scope padrão
  - Ver todas as settings disponíveis
---

# Settings Manager

Configurações globais do sistema Ravi.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `SETTING_NOT_FOUND`). O envelope traz `suggestions` com keys reais parecidas (conhecidas + setadas) — consulte antes de concluir "não existe". Key conhecida-mas-não-setada e key legacy `account.*` NÃO são not-found: continuam leitura informativa (exit 0).
- `2` erro de uso (flag\argumento inválido).
- `3` freio de escrita — não é erro. Nada foi apagado; o envelope traz `dryRun:true` e `plan` com `key`, `currentValue`, `legacy`, `known`. Revise o valor que seria perdido e repita com `--execute`.

Onde o freio existe hoje: só `settings delete` (destrutivo — apaga config global sem undo) é dry-run por default e exige `--execute`. O not-found dispara ANTES do freio: deletar key não setada é exit 1, nunca 3. `settings set` grava na hora, sem freio (reversível; validado antes de gravar) — nessa o freio é você: confira key e valor antes de rodar.

Compact mode: `settings list` aceita `--fields a,b,c` (ex.: `--fields key,value`) — use em varredura para não arrastar descrição/hint/default de cada item.

Checklist antes de responder sobre settings:

- Tratei exit 3 como freio (revisei `currentValue` no `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar que a key não existe?
- Diferenciei "não setada" (default vale) de "não existe" (envelope)?

## Comandos

### Listar todas
```bash
ravi settings list
ravi settings list --legacy
```

### Ver valor
```bash
ravi settings get <key>
```

### Definir valor
```bash
ravi settings set <key> <value>
```

### Remover
```bash
ravi settings delete <key>            # dry-run: mostra o plano e sai com 3
ravi settings delete <key> --execute  # apaga de verdade
```

## Settings Disponíveis

| Key | Descrição | Valores |
|-----|-----------|---------|
| `defaultAgent` | Agent padrão quando nenhuma rota casa | ID do agent |
| `defaultDmScope` | Escopo padrão de DMs | main, per-peer, per-channel-peer, per-account-channel-peer |
| `defaultTimezone` | Fuso horário padrão | America/Sao_Paulo, etc |
| `runtime.defaultProvider` | Provider runtime global (próximo turno sem override) | `codex`, `claude`, `pi` |
| `runtime.defaultModel` | Model runtime global. `RAVI_MODEL` só é fallback se esta key estiver unset | seletor de model |
| `runtime.defaultEffort` | Effort runtime global | `none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra` |
| `tasks.sessionTtl` | TTL padrão para sessões de trabalho de tasks | duração como 1d, 12h, ou off |
| `tasks.sessionTtl.knowledgeEngineer` | TTL para sessões de task de `knowledge-engineer-*` | duração como 5m, 1h, ou off |

## ⚠️ Settings Depreciadas (use `ravi instances`)

As settings `account.*` foram migradas para a tabela `instances`. **Não use mais estas keys:**

| Key depreciada | Substituta |
|----------------|-----------|
| `account.<name>.agent` | `ravi instances set <name> agent <agent>` |
| `account.<name>.instanceId` | `ravi instances set <name> instanceId <id>` |
| `account.<name>.dmPolicy` | `ravi instances set <name> dmPolicy <policy>` |
| `account.<name>.groupPolicy` | `ravi instances set <name> groupPolicy <policy>` |

A migração acontece automaticamente na primeira inicialização do daemon.
Por default, `ravi settings list` esconde essas keys; use `--legacy` só para inspecionar ou limpar restos antigos.

## Exemplos

Definir defaults runtime (provider/model/effort do próximo turno sem override):
```bash
ravi settings set runtime.defaultProvider claude
ravi settings set runtime.defaultModel opus
ravi settings set runtime.defaultEffort high
ravi settings get runtime.defaultModel
ravi sessions info <session> --json   # source de cada eixo
```

`RAVI_MODEL` no `~/.ravi/.env` é só fallback quando `runtime.defaultModel` não está setada.

Definir agent default:
```bash
ravi settings set defaultAgent main
```

Configurar timezone:
```bash
ravi settings set defaultTimezone America/Sao_Paulo
```

Configurar retenção de sessões de tasks:
```bash
ravi settings get tasks.sessionTtl
ravi settings set tasks.sessionTtl 1d
ravi settings set tasks.sessionTtl off
ravi settings get tasks.sessionTtl.knowledgeEngineer
ravi settings set tasks.sessionTtl.knowledgeEngineer 5m
```

Configurar policy por instância (forma correta):
```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```
