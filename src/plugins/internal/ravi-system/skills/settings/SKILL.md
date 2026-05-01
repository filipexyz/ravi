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
ravi settings delete <key>
```

## Settings Disponíveis

| Key | Descrição | Valores |
|-----|-----------|---------|
| `defaultAgent` | Agent padrão quando nenhuma rota casa | ID do agent |
| `defaultDmScope` | Escopo padrão de DMs | main, per-peer, per-channel-peer, per-account-channel-peer |
| `defaultTimezone` | Fuso horário padrão | America/Sao_Paulo, etc |
| `tasks.sessionTtl` | TTL padrão para sessões de trabalho de tasks | duração como 1d, 12h, ou off |

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
```

Configurar policy por instância (forma correta):
```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```
