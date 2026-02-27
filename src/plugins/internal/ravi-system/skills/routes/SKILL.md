---
name: routes-manager
description: |
  Gerencia rotas de mensagens do Ravi. Use quando o usuário quiser:
  - Criar, listar ou remover rotas
  - Direcionar contatos/grupos/threads para agents específicos
  - Configurar prioridade, policy e dmScope de rotas
  - Ver qual agent atende qual padrão
---

# Routes Manager

Rotas direcionam mensagens para agents baseado em padrões. Podem ser gerenciadas via `ravi routes` (standalone) ou via `ravi instances routes` (agrupadas por instância).

## Comandos

### Listar rotas
```bash
ravi routes list
ravi routes list --account vendas    # filtrar por instância
```

### Ver detalhes
```bash
ravi routes show <pattern>
ravi routes show <pattern> --account vendas
```

### Adicionar rota
```bash
ravi routes add <pattern> <agent>
ravi routes add <pattern> <agent> --account vendas
```

Exemplos de padrões:
- `5511*` - Todos com DDD 11
- `*999*` - Números contendo 999
- `group:123456` - Grupo específico do WhatsApp
- `thread:abc123` - Thread específica dentro de um grupo
- `*` - Catch-all (fallback)

### Remover rota
```bash
ravi routes remove <pattern>
```

### Configurar propriedades
```bash
ravi routes set <pattern> <key> <value>
```

Keys disponíveis:
- `agent` - Agent ID alvo
- `priority` - Prioridade (maior = mais prioritário)
- `dmScope` - Escopo de DM (main, per-peer, per-channel-peer, per-account-channel-peer)
- `session` - Nome fixo de sessão (bypassa auto-geração)
- `policy` - Policy override para esta rota (open, pairing, closed, allowlist)

## Prioridade de Resolução

1. Rota `thread:ID` (mais específica — thread dentro de grupo)
2. Rota `group:ID` ou padrão de grupo
3. Rota por telefone/padrão
4. Mapeamento agent da instância (`ravi instances set <name> agent <agent>`)
5. Agent default

## Herança de Policy

A `policy` de uma rota sobrescreve a policy da instância:
```
route.policy → instance.dmPolicy/groupPolicy → legacy settings → "open"
```

## Exemplos

Rotear grupo para agent especializado:
```bash
ravi routes add "group:120363123456789" projeto-x
```

Rotear thread específica dentro de um grupo:
```bash
ravi routes add "thread:msg-abc123" suporte-vip
```

Rotear todos de SP para agent:
```bash
ravi routes add "5511*" vendas
```

Definir política restrita em rota específica:
```bash
ravi routes set "group:123456" policy closed
```

Definir fallback:
```bash
ravi routes add "*" main
```

## Relação com Instances

Rotas pertencem sempre a uma instância (account). Para gerenciar rotas de uma instância específica de forma semântica, use `ravi instances routes`:
```bash
ravi instances routes list vendas
ravi instances routes add vendas "5511*" vendas-agent
```

Para gerenciar contacts: use a skill `ravi-system:contacts`
