---
name: agents-manager
description: |
  Gerencia agents do sistema Ravi. Use quando o usuário quiser:
  - Criar, configurar ou deletar agents
  - Gerenciar permissões de tools (whitelist/bypass)
  - Configurar permissões de Bash (allowlist/denylist)
  - Ver ou resetar sessões de agents
  - Configurar debounce de mensagens
  - Entender como rotear mensagens pra um agent
---

# Agents Manager

Agents são instâncias do Claude com configurações específicas (diretório, tools, permissões). Cada agent tem seu workspace, sessões independentes e pode atender canais/contatos diferentes.

**Importante:** Criar ou modificar agents **não requer restart** do daemon. Tudo atualiza em tempo real.

## Fluxo Completo: Criar um Agent e Colocar pra Funcionar

### 1. Criar o agent

```bash
ravi agents create <id> <cwd>
```

O `cwd` é o diretório onde fica o `CLAUDE.md` do agent (suas instruções). Crie o diretório e o `CLAUDE.md` antes.

### 2. Rotear mensagens pro agent

Existem duas formas de rotear:

**Por rota (padrão de grupo/contato):**
```bash
ravi routes add <pattern> <agent>
```

Patterns suportados:
- `group:120363425628305127` — grupo específico
- `lid:178035101794451` — contato específico (por lid)
- `5511*` — todos com DDD 11
- `*` — catch-all

**Por contato (assignment direto):**
```bash
ravi contacts approve <phone> <agent>
# ou
ravi contacts set <phone> agent <agent>
```

### 3. Ativar em grupo WhatsApp

Grupos novos precisam ser **aprovados** antes de funcionar.

**Instrua o usuário a:**
1. Criar um grupo no WhatsApp e adicionar o bot
2. Mandar uma mensagem qualquer no grupo (isso faz o grupo aparecer como **pending**)

**Depois, VOCÊ (o agent) deve executar:**
```bash
ravi contacts pending                            # Checar pendentes — o grupo aparece aqui
ravi contacts approve <group-id> <agent>         # Aprovar e associar ao agent
ravi routes add <group-id> <agent>               # Criar rota pro grupo
```

**IMPORTANTE:** Não peça o ID do grupo pro usuário. Rode `ravi contacts pending` pra descobrir o ID automaticamente. O usuário já mandou a mensagem — o grupo já está lá.

Tudo atualiza em tempo real. **Não precisa reiniciar o daemon.**

### Como novos contatos/grupos aparecem?

Quando alguém novo manda mensagem (ou o bot é adicionado a um grupo novo), o contato/grupo aparece como **pending** automaticamente. Nenhuma mensagem é processada até ser aprovado.

```bash
ravi contacts pending     # Ver contatos/grupos pendentes
```

Pra aprovar e rotear:
```bash
ravi contacts approve <phone> <agent>   # Aprova e associa ao agent
ravi contacts approve <phone>           # Aprova sem associar (usa rota ou default)
ravi contacts block <phone>             # Bloqueia
```

### Prioridade de roteamento

Quando uma mensagem chega, o sistema resolve o agent nesta ordem:

1. **Contato tem agent?** → usa o agent do contato
2. **Tem rota que casa?** → usa o agent da rota (prioridade maior primeiro)
3. **Account ID casa com agent?** → usa (Matrix multi-account)
4. **Nenhum match** → usa o agent default (geralmente `main`)

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
- `name` — Nome do agent
- `cwd` — Diretório de trabalho
- `model` — Modelo (claude-opus-4-6, claude-sonnet-4-5-20250929, etc)
- `dmScope` — Escopo de sessão DM:
  - `main` — Todas as DMs numa sessão só
  - `per-peer` — Uma sessão por contato (default)
  - `per-channel-peer` — Por canal + contato
  - `per-account-channel-peer` — Isolamento total
- `systemPromptAppend` — Texto adicional no system prompt
- `matrixAccount` — Conta Matrix associada

## Gerenciamento de Tools (CLI)

Controla quais comandos `ravi` o agent pode executar via Bash. Quando configurado, o agent só pode rodar os subcomandos permitidos.

### Ver tools
```bash
ravi agents tools <id>
```

### Permitir tool
```bash
ravi agents tools <id> allow <tool>
# Ex: ravi agents tools marina allow cross_send
# Ex: ravi agents tools marina allow contacts_list
```

### Bloquear tool
```bash
ravi agents tools <id> deny <tool>
```

### Inicializar whitelist
```bash
ravi agents tools <id> init       # SDK tools apenas
ravi agents tools <id> init all   # SDK + CLI tools
ravi agents tools <id> init cli   # Apenas CLI tools
```

### Modo bypass (todas permitidas)
```bash
ravi agents tools <id> clear
```

### Nomes dos tools

Os nomes seguem o padrão `grupo_comando`. Pra ver todos disponíveis:
```bash
ravi tools list
```

Exemplos: `cross_send`, `media_send`, `contacts_list`, `contacts_approve`, `agents_list`, `daemon_restart`, `outbound_send`, etc.

## Permissões de Bash

Controla quais executáveis o agent pode rodar no terminal (git, node, etc). Separado do controle de tools CLI.

### Ver configuração
```bash
ravi agents bash <id>
```

### Definir modo
```bash
ravi agents bash <id> mode <bypass|allowlist|denylist>
```

- `bypass` — tudo permitido
- `allowlist` — só os listados
- `denylist` — tudo exceto os listados

### Gerenciar listas
```bash
ravi agents bash <id> allow <cli>     # Adicionar à allowlist
ravi agents bash <id> deny <cli>      # Adicionar à denylist
ravi agents bash <id> remove <cli>    # Remover das listas
```

### Inicializar com defaults
```bash
ravi agents bash <id> init         # Denylist com CLIs perigosos (rm, sudo, curl, etc)
ravi agents bash <id> init strict  # Allowlist com CLIs seguros (git, node, etc)
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

## Exemplos Práticos

### Criar agent pra atendimento

```bash
# 1. Criar diretório e CLAUDE.md
mkdir -p ~/ravi/atendimento
# (crie o CLAUDE.md com as instruções do agent)

# 2. Criar agent
ravi agents create atendimento ~/ravi/atendimento

# 3. Rotear grupo pro agent
ravi routes add group:120363425628305127 atendimento

# 4. Configurar permissões (opcional)
ravi agents bash atendimento init          # Denylist básica
ravi agents tools atendimento init         # Whitelist de SDK tools
ravi agents tools atendimento allow cross_send    # Liberar envio cross
ravi agents tools atendimento allow contacts_list # Liberar listagem
```

### Aprovar contato e associar a agent

```bash
# Ver pendentes
ravi contacts pending

# Aprovar e associar
ravi contacts approve 5511999999999 atendimento

# Ou aprovar com modo "mention" (só responde quando mencionado)
ravi contacts approve 5511999999999 atendimento mention
```

### Configurar rota com prioridade

```bash
# Rota específica (prioridade alta)
ravi routes add group:123456789 vendas
ravi routes set group:123456789 priority 10

# Rota catch-all (prioridade baixa)
ravi routes add "*" main
```
