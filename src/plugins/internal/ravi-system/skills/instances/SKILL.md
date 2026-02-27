---
name: instances-manager
description: |
  Gerencia instâncias de canais do Ravi. Use quando o usuário quiser:
  - Criar, listar ou configurar instâncias (contas omni)
  - Conectar/desconectar contas WhatsApp, Matrix, etc
  - Definir policies de DM e grupo por instância
  - Gerenciar rotas de uma instância específica
  - Aprovar ou rejeitar pendências de acesso
---

# Instances Manager

Instâncias são a entidade central de configuração do Ravi. Cada instância representa uma conta conectada (WhatsApp, Matrix, etc) com seu próprio agent, policies e rotas.

## Comandos Principais

### Listar instâncias
```bash
ravi instances list
```

### Ver detalhes
```bash
ravi instances show <name>
```

### Criar instância
```bash
ravi instances create <name>
ravi instances create vendas --agent vendas-agent --channel whatsapp
```

### Configurar propriedades
```bash
ravi instances set <name> <key> <value>
```

Keys disponíveis:
- `agent` - Agent ID padrão desta instância
- `dmPolicy` - Política para DMs: `open` | `pairing` | `closed`
- `groupPolicy` - Política para grupos: `open` | `allowlist` | `closed`
- `dmScope` - Escopo de sessões DM: `main` | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
- `instanceId` - UUID omni (normalmente auto-preenchido no connect)
- `channel` - Canal: `whatsapp` | `matrix` | etc

### Remover instância
```bash
ravi instances delete <name>
```

## Conexão de Canal

### Conectar WhatsApp
```bash
ravi instances connect <name>
ravi instances connect vendas --agent vendas-agent
```

### Ver status omni
```bash
ravi instances status <name>
```

### Desconectar
```bash
ravi instances disconnect <name>
```

## Policies

Policies controlam quem pode iniciar conversa com o bot desta instância:

| Policy | Contexto | Comportamento |
|--------|----------|---------------|
| `dmPolicy=open` | DMs | Aceita qualquer DM |
| `dmPolicy=pairing` | DMs | Só aceita contatos previamente aprovados |
| `dmPolicy=closed` | DMs | Rejeita todos os DMs |
| `groupPolicy=open` | Grupos | Aceita qualquer grupo |
| `groupPolicy=allowlist` | Grupos | Só grupos com rota explícita (`ravi instances routes add`) |
| `groupPolicy=closed` | Grupos | Rejeita todos os grupos |

```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```

## Rotas por Instância

```bash
ravi instances routes list <name>
ravi instances routes show <name> <pattern>
ravi instances routes add <name> <pattern> <agent>
ravi instances routes remove <name> <pattern>
ravi instances routes set <name> <pattern> <key> <value>
```

Padrões suportados:
- `5511*` - Prefixo de telefone
- `group:123456` - Grupo específico
- `thread:abc123` - Thread dentro de grupo (maior prioridade)
- `*` - Catch-all

## Pendências

Quando `dmPolicy=pairing` ou `groupPolicy=allowlist`, contatos/grupos desconhecidos ficam pendentes:

```bash
ravi instances pending list <name>
ravi instances pending approve <name> <id>    # aprova + cria rota
ravi instances pending reject <name> <id>     # rejeita
```

## Exemplos de Setup

### Bot público (responde tudo)
```bash
ravi instances create main --agent main --channel whatsapp
ravi instances set main dmPolicy open
ravi instances set main groupPolicy open
ravi instances connect main
```

### Bot controlado (só contatos aprovados)
```bash
ravi instances create suporte --agent suporte-agent
ravi instances set suporte dmPolicy pairing
ravi instances set suporte groupPolicy allowlist
ravi instances connect suporte
# Quando alguém envia mensagem → aparece em `pending list`
ravi instances pending list suporte
ravi instances pending approve suporte 5511999999999
```

### Multi-instância
```bash
ravi instances create vendas --agent vendas-agent
ravi instances create suporte --agent suporte-agent
ravi instances set vendas dmPolicy open
ravi instances set suporte dmPolicy pairing
ravi instances connect vendas
ravi instances connect suporte
```
