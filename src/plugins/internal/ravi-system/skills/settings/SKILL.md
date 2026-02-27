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

## ⚠️ Settings Depreciadas (use `ravi instances`)

As settings `account.*` foram migradas para a tabela `instances`. **Não use mais estas keys:**

| Key depreciada | Substituta |
|----------------|-----------|
| `account.<name>.agent` | `ravi instances set <name> agent <agent>` |
| `account.<name>.instanceId` | `ravi instances set <name> instanceId <id>` |
| `account.<name>.dmPolicy` | `ravi instances set <name> dmPolicy <policy>` |
| `account.<name>.groupPolicy` | `ravi instances set <name> groupPolicy <policy>` |

A migração acontece automaticamente na primeira inicialização do daemon.

## Exemplos

Definir agent default:
```bash
ravi settings set defaultAgent main
```

Configurar timezone:
```bash
ravi settings set defaultTimezone America/Sao_Paulo
```

Configurar policy por instância (forma correta):
```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```
