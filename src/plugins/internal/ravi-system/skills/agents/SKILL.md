---
name: agents-manager
description: |
  Gerencia agents do sistema Ravi. Use quando o usuário quiser:
  - Criar, configurar ou deletar agents
  - Gerenciar permissões de tools (whitelist/bypass)
  - Configurar permissões de Bash (allowlist/denylist)
  - Ver ou resetar sessões de agents
  - Configurar debounce de mensagens
---

# Agents Manager

Você gerencia os agents do Ravi. Agents são instâncias do Claude com configurações específicas (diretório, tools, permissões).

## Comandos Disponíveis

### Listar agents
```bash
ravi agents list
```

### Ver detalhes
```bash
ravi agents show <id>
```

### Criar agent
```bash
ravi agents create <id> <cwd>
```

### Deletar agent
```bash
ravi agents delete <id>
```

### Configurar propriedades
```bash
ravi agents set <id> <key> <value>
```

Keys:
- `name` - Nome do agent
- `cwd` - Diretório de trabalho
- `model` - Modelo (claude-sonnet, etc)
- `dmScope` - Escopo de DM (main, per-peer, etc)
- `systemPromptAppend` - Texto adicional no prompt
- `matrixAccount` - Conta Matrix associada

## Gerenciamento de Tools

### Ver tools
```bash
ravi agents tools <id>
```

### Permitir tool
```bash
ravi agents tools <id> allow <tool>
```

### Bloquear tool
```bash
ravi agents tools <id> deny <tool>
```

### Inicializar whitelist
```bash
ravi agents tools <id> init       # SDK tools
ravi agents tools <id> init all   # Todas as tools
ravi agents tools <id> init cli   # Apenas CLI tools
```

### Modo bypass (todas permitidas)
```bash
ravi agents tools <id> clear
```

## Permissões de Bash

### Ver configuração
```bash
ravi agents bash <id>
```

### Definir modo
```bash
ravi agents bash <id> mode <bypass|allowlist|denylist>
```

### Adicionar à allowlist
```bash
ravi agents bash <id> allow <cli>
```

### Adicionar à denylist
```bash
ravi agents bash <id> deny <cli>
```

### Remover das listas
```bash
ravi agents bash <id> remove <cli>
```

### Inicializar com defaults
```bash
ravi agents bash <id> init         # Denylist com CLIs perigosos
ravi agents bash <id> init strict  # Allowlist com CLIs seguros
```

### Resetar para bypass
```bash
ravi agents bash <id> clear
```

## Debounce de Mensagens

Agrupa mensagens rápidas antes de processar:

```bash
ravi agents debounce <id> <ms>   # Definir (ex: 2000 = 2s)
ravi agents debounce <id> 0      # Desabilitar
ravi agents debounce <id>        # Ver atual
```

## Sessões

### Ver sessões
```bash
ravi agents session <id>
```

### Resetar sessão
```bash
ravi agents reset <id>              # Sessão principal
ravi agents reset <id> <sessionKey> # Sessão específica
ravi agents reset <id> all          # Todas as sessões
```

## Interação

### Enviar prompt
```bash
ravi agents run <id> "prompt"
```

### Chat interativo
```bash
ravi agents chat <id>
```

## Exemplos

Criar agent para projeto específico:
```bash
ravi agents create meu-projeto ~/projetos/meu-projeto
```

Configurar tools restritivas:
```bash
ravi agents tools meu-projeto init
ravi agents tools meu-projeto allow mcp__ravi-cli__contacts_list
```

Configurar bash seguro:
```bash
ravi agents bash meu-projeto init strict
ravi agents bash meu-projeto allow npm
ravi agents bash meu-projeto allow bun
```
