---
name: routes-manager
description: |
  Gerencia rotas de mensagens do Ravi. Use quando o usuário quiser:
  - Criar, listar ou remover rotas
  - Direcionar contatos/grupos para agents específicos
  - Configurar prioridade de rotas
  - Ver qual agent atende qual padrão
---

# Routes Manager

Rotas direcionam mensagens para agents baseado em padrões. Um contato ou grupo pode ser roteado para um agent específico.

## Comandos

### Listar rotas
```bash
ravi routes list
```

### Ver detalhes
```bash
ravi routes show <pattern>
```

### Adicionar rota
```bash
ravi routes add <pattern> <agent>
```

Exemplos de padrões:
- `5511*` - Todos com DDD 11
- `*999*` - Números contendo 999
- `group:123456` - Grupo específico do WhatsApp
- `*` - Catch-all (fallback)

### Remover rota
```bash
ravi routes remove <pattern>
```

### Configurar propriedades
```bash
ravi routes set <pattern> <key> <value>
```

Keys:
- `priority` - Prioridade (maior = mais prioritário)
- `dmScope` - Escopo de DM (main, per-peer, etc)

## Prioridade de Resolução

1. Contato com agent atribuído diretamente
2. Rota que casa com o padrão (por prioridade)
3. AccountId = AgentId
4. Agent default

## Exemplos

Rotear grupo para agent especializado:
```bash
ravi routes add "group:120363123456789@g.us" projeto-x
```

Rotear todos de SP para agent:
```bash
ravi routes add "5511*" vendas
```

Definir fallback:
```bash
ravi routes add "*" main
```
