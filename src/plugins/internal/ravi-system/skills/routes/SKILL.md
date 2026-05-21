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

Rotas direcionam mensagens para agents baseado em padrões. São sempre gerenciadas via `ravi instances routes <name>` — rotas pertencem a uma instância.

## Comandos

### Listar rotas
```bash
ravi instances routes list <name>
```

### Ver detalhes
```bash
ravi instances routes show <name> <pattern>
```

### Adicionar rota
```bash
ravi instances routes add <name> <pattern> <agent>
ravi instances routes add vendas "5511*" vendas-agent --priority 10
ravi instances routes add vendas "group:123456" suporte --policy closed
ravi instances routes add vendas "*" main --channel whatsapp   # só pra um canal
```

Exemplos de padrões:
- `5511*` - Todos com DDD 11
- `*999*` - Números contendo 999
- `group:123456` - Grupo específico do WhatsApp
- `thread:abc123` - Thread específica dentro de um grupo
- `*` - Catch-all (fallback)

### Remover rota (soft-delete, recuperável)
```bash
ravi instances routes remove <name> <pattern>
ravi instances routes restore <name> <pattern>   # recuperar
ravi instances routes deleted [name]             # ver deletadas
```

### Configurar propriedades
```bash
ravi instances routes set <name> <pattern> <key> <value>
```

Keys disponíveis:
- `agent` - Agent ID alvo
- `priority` - Prioridade (maior = mais prioritário)
- `dmScope` - Escopo de DM (main, per-peer, per-channel-peer, per-account-channel-peer)
- `session` - Nome fixo de sessão (bypassa auto-geração)
- `policy` - Policy override (open, pairing, closed, allowlist)
- `channel` - Limitar a canal específico (whatsapp, telegram, etc). `-` pra limpar.

## Prioridade de Resolução

1. Rota `thread:ID` (mais específica — thread dentro de grupo)
2. Rota `group:ID` ou padrão de grupo
3. Rota por telefone/padrão
4. Mapeamento agent da instância (`ravi instances set <name> agent <agent>`)
5. Agent default

Dentro do mesmo nível: rotas com `channel` específico ganham de rotas sem channel, depois desempata por `priority` DESC.

## Herança de Policy

```
route.policy → instance.dmPolicy/groupPolicy → "open"
```

## Exemplos

Rotear grupo para agent especializado:
```bash
ravi instances routes add main "group:120363123456789" projeto-x
```

Rotear thread específica dentro de um grupo:
```bash
ravi instances routes add main "thread:msg-abc123" suporte-vip
```

Rotear todos de SP para agent:
```bash
ravi instances routes add main "5511*" vendas
```

Definir política restrita em rota específica:
```bash
ravi instances routes set main "group:123456" policy closed
```

Definir fallback:
```bash
ravi instances routes add main "*" main
```

## Route vs Attach

Route e attach (`sessions/attach`) operam em camadas diferentes — confundi-las leva a comportamento inesperado.

| Camada | Define | Resultado |
|--------|--------|-----------|
| **Route** | Qual *agent* atende o chat | matchRoute escolhe agent, session_key é derivado de (agent, channel, instance, dmScope, peer). Cada combinação vira sessão própria. |
| **Subscription** (`sessions attach`) | Qual *sessão* recebe a inbound | Override do session_key resolvido. Permite mesma sessão escutar múltiplos chats (histórico compartilhado). |
| **Focus** (`sessions focus`) | Para qual *chat* a sessão emite output | Sobrescreve o inbound-source no output target resolution. |

**Cuidado com a interação:**

- Se um chat tem subscription ativa (atachado a sessão X), o consumer **ignora** o agent escolhido pela route e dispatcha pra sessão X. A route não troca o destino sozinha.
- `routes add` faz cleanup automático de sessões conflitantes (apaga sessão paralela do agent antigo e libera o chat). Quando isso roda, a próxima inbound segue a nova route normalmente.
- `routes add ... --session <name>` (redirect estático) força a sessão alvo e cria subscription automaticamente — funciona ao lado do attach.

**Quando usar cada um:**

- "Quero outro agent atendendo esse chat, com histórico próprio" → `routes add`
- "Quero a MESMA sessão atendendo múltiplos chats" → `sessions attach`
- "Quero responder em chat diferente do source" → `sessions focus`

Ver skill `ravi-system:sessions` (seção Attach + Focus) pras receitas práticas e diagrama de fluxo.

Para gerenciar contacts: use a skill `ravi-system:contacts`
