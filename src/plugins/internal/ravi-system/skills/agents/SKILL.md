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
ravi instances routes add <instance> <pattern> <agent>
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
ravi contacts approve <group-id> <agent>                       # Aprovar e associar ao agent
ravi instances routes add main <group-id> <agent>              # Criar rota pro grupo
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

## Permissões (REBAC)

Permissões de tools e executáveis são gerenciadas via REBAC:

```bash
# Ver permissões de um agent
ravi permissions list --subject agent:<id>

# Configurar permissões
ravi permissions init agent:<id> full-access     # Tudo liberado
ravi permissions init agent:<id> sdk-tools       # SDK tools padrão
ravi permissions init agent:<id> safe-executables # Executáveis seguros

# Grants individuais
ravi permissions grant agent:<id> use tool:Bash
ravi permissions grant agent:<id> execute executable:git
```

Ver skill `permissions-manager` para documentação completa.

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

## Receita Completa: Agent Pessoal com Grupo WhatsApp

Agents pessoais são agents dedicados a um aspecto da vida do usuário (comunicação, journaling, estratégia, etc). Cada um tem seu grupo WhatsApp exclusivo.

**Conceito importante:** O agent já nasce dentro do WhatsApp. Ele não precisa de nenhuma tool pra enviar mensagens — toda resposta dele já chega automaticamente no WhatsApp. Ele deve saber disso no CLAUDE.md.

### Passo a passo

#### 1. Criar diretório e CLAUDE.md

```bash
mkdir -p ~/ravi/<agent-id>
```

Escreva o `CLAUDE.md` com a identidade e instruções do agent. Estrutura recomendada:

```markdown
# <Nome do Agent>

## Quem Você É
- Papel, personalidade, tom de voz
- O que você faz e o que NÃO faz

## Contexto
- Você já está conversando pelo WhatsApp com o usuário
- Toda mensagem que você envia chega diretamente no WhatsApp
- Você NÃO precisa de nenhuma tool pra enviar mensagens

## Como Funciona
- Metodologia, frameworks, abordagem
- Exemplos de interação

## Regras
- Limites, boundaries, o que evitar
```

**Dicas pro CLAUDE.md:**
- Dê personalidade — agents genéricos são chatos
- Seja específico sobre o que o agent faz e não faz
- Inclua que ele já está no WhatsApp (não precisa de tool pra mensagem)
- Adapte o tom pro contexto (coach é diferente de diário é diferente de estrategista)

#### 2. Criar o agent no sistema

```bash
ravi agents create <agent-id> ~/ravi/<agent-id>
```

#### 3. Criar grupo WhatsApp dedicado

O usuário cria um grupo no WhatsApp (ex: "Vida - Comunicação") e adiciona o bot. Ao enviar a primeira mensagem no grupo, o contato aparece automaticamente como **pending**.

#### 4. Aprovar e rotear o grupo

**Não peça o ID do grupo pro usuário.** Rode o CLI pra descobrir:

```bash
# Ver grupos/contatos pendentes
ravi contacts pending

# Aprovar o grupo
ravi contacts approve <group-id>

# Criar rota pro agent
ravi instances routes add main <group-id> <agent-id>
```

O `group-id` tem formato `group:120363406060070449`.

#### 5. Pronto!

O agent já está respondendo no grupo. Não precisa reiniciar o daemon.

### Exemplo real: Agent de comunicação

```bash
# 1. Criar diretório
mkdir -p ~/ravi/comm

# 2. Escrever CLAUDE.md (com identidade de coach de comunicação)

# 3. Criar agent
ravi agents create comm ~/ravi/comm

# 4. Usuário cria grupo "Vida - Comunicação" no WhatsApp e manda msg

# 5. Aprovar e rotear
ravi contacts pending                          # Encontra group:120363406060070449
ravi contacts approve group:120363406060070449  # Aprova
ravi instances routes add main group:120363406060070449 comm   # Roteia pro comm
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
ravi instances routes add main group:120363425628305127 atendimento

# 4. Configurar permissões (via REBAC)
ravi permissions init agent:atendimento sdk-tools       # SDK tools padrão
ravi permissions init agent:atendimento safe-executables # Executáveis seguros
ravi permissions grant agent:atendimento use tool:Bash   # Liberar Bash
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
ravi instances routes add main group:123456789 vendas
ravi instances routes set main group:123456789 priority 10

# Rota catch-all (prioridade baixa)
ravi instances routes add main "*" main
```
