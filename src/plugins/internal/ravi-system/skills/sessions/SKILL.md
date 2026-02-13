---
name: sessions
description: |
  Gerencia sessões do sistema Ravi. Use quando o usuário quiser:
  - Listar, ver detalhes ou renomear sessões
  - Resetar ou deletar sessões
  - Configurar modelo ou thinking level por sessão
  - Criar sessões efêmeras com TTL
  - Estender, manter ou excluir sessões efêmeras
  - Enviar prompts, perguntas ou comandos entre sessões
  - Ler histórico de mensagens de uma sessão
---

# Sessions Manager

Sessões são conversas persistentes entre agents e usuários. Cada sessão tem um nome único, um agent associado, e pode ter canal de saída (WhatsApp, Matrix, etc).

## Tipos de Sessão

- **Permanent** (padrão): Sessão normal, sem expiração.
- **Ephemeral**: Sessão com TTL (time-to-live). Expira automaticamente após o tempo definido. 10 minutos antes de expirar, o agent recebe um aviso com comandos CLI para estender, manter ou excluir.

## Comandos

### Listagem e Info

```bash
# Listar todas as sessões (mostra tipo e data de expiração)
ravi sessions list

# Filtrar por agent
ravi sessions list --agent <id>

# Listar só efêmeras
ravi sessions list --ephemeral

# Ver detalhes de uma sessão
ravi sessions info <name>

# Ler histórico de mensagens (normalizado, sem tool calls)
ravi sessions read <name> [-n count]
```

### Gerenciamento

```bash
# Renomear display name
ravi sessions rename <name> "Novo Nome"

# Definir modelo override
ravi sessions set-model <name> <model>

# Definir thinking level
ravi sessions set-thinking <name> <level>

# Resetar sessão (limpa conversa, mantém config)
ravi sessions reset <name>

# Deletar sessão permanentemente (abort + delete)
ravi sessions delete <name>
```

### Sessões Efêmeras

```bash
# Tornar sessão efêmera com TTL (ex: 5h, 30m, 1d)
ravi sessions set-ttl <name> <duration>

# Estender TTL de uma sessão efêmera (+5h default)
ravi sessions extend <name> [duration]

# Tornar sessão efêmera em permanente
ravi sessions keep <name>
```

**Fluxo automático:**
1. Sessão criada com `set-ttl` recebe TTL
2. 10 min antes de expirar, o agent recebe aviso via `[System] Inform:` com os comandos CLI
3. O agent pode executar `extend`, `keep`, ou `delete`
4. Sem ação → sessão é automaticamente deletada pelo runner

### Comunicação Inter-Sessão

```bash
# Enviar prompt e esperar resposta (streaming)
ravi sessions send <name> "mensagem" [-a agent] [-i]
# -a: criar sessão com esse agent se não existir
# -i: modo interativo (loop)

# Perguntar algo (fire-and-forget, agent pergunta no chat se não souber)
ravi sessions ask <name> "pergunta" [sender]

# Responder uma pergunta de outra sessão (agent NUNCA silencia)
ravi sessions answer <name> "resposta" [sender]

# Executar comando (fire-and-forget, agent executa sem responder)
ravi sessions execute <name> "tarefa"

# Informar algo (fire-and-forget, agent pode silenciar se irrelevante)
ravi sessions inform <name> "info"
```

## Notas

- **Reset vs Delete**: `reset` limpa a conversa mas mantém nome/routing/config. `delete` remove a sessão inteira.
- **Session names**: Nomes legíveis, únicos, sem pontos (`.`). Gerados automaticamente ou definidos manualmente.
- **Source automático**: Todos os comandos de comunicação incluem source (channel/chatId) automaticamente — o agent sabe onde responder.
