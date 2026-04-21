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
  - Inspecionar trace SQLite de uma sessão para incidentes de runtime/canal
---

# Sessions Manager

Sessões são conversas persistentes entre agents e usuários. Cada sessão tem um nome único, um agent associado, e pode ter canal de saída (WhatsApp, Matrix, etc).

Sessões são a superfície de comunicação do Ravi. Não são o task runtime. Se o trabalho precisa de dono, progresso e estado terminal, use `ravi tasks ...`. Se a pergunta é medir regressão ou comparar comportamento, use `ravi eval ...`.

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

# Ler histórico durável da sessão (normalizado, sem tool calls; atravessa restarts/resets de provider)
ravi sessions read <name> [-n count]

# Inspecionar timeline operacional persistida em SQLite
ravi sessions trace <name> --since 2h --explain
```

### Gerenciamento

```bash
# Renomear o nome canonico da sessao (sessions.name)
ravi sessions rename <name> <novo-nome-canonico>

# Definir label humano/display-only
ravi sessions set-display <name> "Novo Nome Humano"

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
# Enviar prompt/contexto
ravi sessions send <name> "mensagem" [-w] [-a agent] [-i]
# -w: espera e streama a resposta
# -a: cria sessão com esse agent se não existir
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

### Session Trace

Use `ravi sessions trace` quando precisar entender uma sessão real ponta a ponta:
inbound de canal, routing, prompt publish, decisões de dispatch, request final
do adapter, tools, resposta, delivery e falhas.

SQLite (`ravi.db`) é a fonte canônica do trace. NATS/logs são apoio para debug
ao vivo, não a fonte primária para reconstruir incidente.

```bash
# Golden path de incidente
ravi sessions trace <name> --since 2h --explain

# Filtros úteis
ravi sessions trace <name> --turn <turn_id> --explain
ravi sessions trace <name> --run <run_id>
ravi sessions trace <name> --message <source_message_id> --explain
ravi sessions trace <name> --correlation <correlation_id> --raw --explain

# Cortes de leitura
ravi sessions trace <name> --only adapter
ravi sessions trace <name> --only tools
ravi sessions trace <name> --only delivery
ravi sessions trace <name> --only dispatch
ravi sessions trace <name> --only turn
ravi sessions trace <name> --since 30m --limit 40
ravi sessions trace <name> --json

# Payloads grandes só quando necessário
ravi sessions trace <name> --show-system-prompt
ravi sessions trace <name> --turn <turn_id> --show-user-prompt
ravi sessions trace <name> --turn <turn_id> --raw
```

`--show-system-prompt` resolve o system prompt mais recente da sessão e não
depende do `turn` estar visível no recorte/limit. User prompt e raw request
continuam escopados a turn/request.

Leitura rápida:

- `channel.message.received` = inbound chegou no Ravi.
- `route.resolved` = rota escolheu sessão e agent.
- `prompt.published` = prompt entrou no stream da sessão.
- `dispatch.*` = cold start, push em sessão viva, queue, interrupt, restart ou task barrier.
- `runtime.start` = runtime começou ou falhou antes do provider.
- `adapter.request` = Ravi montou a request final para o provider. Se existe, chegou no handoff.
- `tool.start` / `tool.end` = atividade de tool do provider.
- `assistant.message` = texto do assistant recebido do provider.
- `response.emitted` = Ravi emitiu resposta para o gateway.
- `delivery.*` = gateway observou delivered, failed, dropped ou outro status.
- `turn.complete` / `turn.failed` / `turn.interrupted` = estado terminal do turno.

Achados comuns do `--explain`:

- `prompt-without-adapter-request`: prompt nao chegou no handoff do provider; olhar dispatch, debounce, task barrier ou runtime startup.
- `adapter-request-without-terminal-turn`: request foi criada, mas nao houve terminal turn; olhar provider/runtime apos handoff.
- `response-without-delivery`: resposta saiu do runtime mas nao teve delivery observado.
- `delivery-failed` / `delivery-dropped`: falha ou drop no outbound; olhar payload de delivery e target.
- `interruption-or-abort`: houve interrupt/abort; ler `abortReason`, `session.abort` e `dispatch.interrupt_requested`.
- `timeout`: watchdog/timeout interrompeu a sessao/turno.
- `resume-disabled-with-provider-session`: havia provider session id mas `resume=false`; investigar reset/delete/fork/troca de provider ou modelo.
- `tool-start-without-end`: tool iniciou e nao completou no trace.
- `system-prompt-changed`: hashes de system prompt mudaram entre turns.

Golden path SDE para "agent viu a mensagem mas nao respondeu":

1. `ravi sessions trace <name> --since 2h --explain`
2. `ravi sessions trace <name> --message <source_message_id> --explain`
3. `ravi sessions trace <name> --turn <turn_id> --explain`

Classifique pela ultima linha confiavel:

- sem `channel.message.received`: inbound nao chegou ou janela/sessao errada.
- `channel.message.received` sem `route.resolved`: routing/contact resolution.
- `route.resolved` sem `prompt.published`: publish no stream da sessao.
- `prompt.published` sem `adapter.request`: dispatch, task barrier, debounce, concorrencia ou runtime startup.
- `adapter.request` sem terminal turn: provider/runtime apos handoff.
- `assistant.message` sem `response.emitted`: resposta silenciosa, suppressao ou interrupcao.
- `response.emitted` sem `delivery.*`: gateway/outbound observation.
- `delivery.failed` / `delivery.dropped`: entrega final no canal.

Para abort/context loss, procure `session.abort`, `session.timeout`,
`turn.interrupted`, `provider_session_id_before`, `provider_session_id_after` e
hash de system prompt. `resume=false` com provider session id existente e
suspeito, exceto se reset/delete/fork/troca de provider/modelo/capability
explicar.

Use placeholders em runbooks e issues (`<name>`, `<turn_id>`, `<message_id>`).
Nao cole telefones reais, ids de grupo/chat, prompts de cliente, context keys,
tokens ou provider session ids em documentacao compartilhada.

## Notas

- **Reset vs Delete**: `reset` limpa a conversa mas mantém nome/routing/config. `delete` remove a sessão inteira.
- **Session names**: nomes canonicos unicos usados em routing, historico e topicos NATS. Use um token sem espacos, pontos (`.`), `*` ou `>`. `sessions rename` muda esse nome canonico e atualiza rotas que apontavam para o nome antigo.
- **Display labels**: labels humanos vivem em `display_name`. Use `sessions set-display` para nomes com espaco, acentos ou contexto visual; isso nao altera routing nem historico.
- **Source automático**: Todos os comandos de comunicação incluem source (channel/chatId) automaticamente — o agent sabe onde responder.
- **`send` vs `inform`**: `send` é a opção mais geral e pode esperar resposta com `-w`; `inform` é fogo-e-esqueça explícito para contexto.
- **Isolamento de contexto**: `sessions read` deve recuperar apenas a sessão atual. Nunca use histórico de outro grupo/DM como fallback para responder uma sessão fria.
