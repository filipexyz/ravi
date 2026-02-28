---
name: channels-manager
description: |
  Gerencia canais de comunicação do Ravi via omni. Use quando o usuário quiser:
  - Ver status das instâncias WhatsApp, Discord, Telegram
  - Conectar ou desconectar contas
  - Configurar policies de DM e grupo por instância
  - Verificar QR code de pareamento
  - Troubleshoot problemas de conexão
---

# Channels Manager

Canais são gerenciados pelo omni API server (processo filho do daemon). Cada conta conectada é uma **instância** — a entidade central de configuração do Ravi.

## Instâncias (central config)

### Listar instâncias
```bash
ravi instances list
ravi instances show <name>
```

### Conectar nova conta (WhatsApp)
```bash
ravi instances connect <name>                         # cria instância + conecta (mostra QR)
ravi instances connect vendas --agent vendas-agent
```

### Configurar instância
```bash
ravi instances set <name> agent <agent-id>
ravi instances set <name> dmPolicy pairing        # open | pairing | closed
ravi instances set <name> groupPolicy allowlist   # open | allowlist | closed
ravi instances set <name> dmScope per-peer
```

### Desconectar
```bash
ravi instances disconnect <name>
```

### Ver status omni
```bash
ravi instances status <name>
```

## Modos de Operação

- `active` - Agent responde automaticamente
- `sentinel` - Agent observa silenciosamente, responde só quando instruído

## Policies por Instância

Cada instância pode ter política independente de acesso:

| Policy | Contexto | Comportamento |
|--------|----------|---------------|
| `dmPolicy=open` | DMs | Aceita qualquer DM |
| `dmPolicy=pairing` | DMs | Só aceita contatos aprovados |
| `dmPolicy=closed` | DMs | Rejeita todos os DMs |
| `groupPolicy=open` | Grupos | Aceita qualquer grupo |
| `groupPolicy=allowlist` | Grupos | Só aceita grupos com rota explícita |
| `groupPolicy=closed` | Grupos | Rejeita todos os grupos |

```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```

## Multi-Instância

```bash
ravi instances connect vendas --agent vendas-agent
ravi instances connect suporte --agent suporte-agent
ravi instances set vendas dmPolicy open
ravi instances set suporte groupPolicy allowlist
```

## Troubleshooting

### WhatsApp não conecta
```bash
ravi instances status main    # Ver estado da instância
ravi instances connect main   # Reconectar (mostra QR se necessário)
ravi daemon logs              # Ver logs do daemon e omni
```

### Daemon não inicia
```bash
ravi daemon logs              # Ver erros de startup
# Verificar OMNI_DIR em ~/.ravi/.env
```
