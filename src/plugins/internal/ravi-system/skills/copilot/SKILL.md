---
name: copilot
description: |
  Gerencia a ponte bidirecional entre Ravi e sessões do Claude Code. Use quando o usuário quiser:
  - Enviar mensagens pra sessões do Claude Code via mailbox
  - Listar times ativos do Claude Code
  - Configurar hooks e triggers pro copilot
  - Entender como a integração CC ↔ Ravi funciona
---

# Copilot — Claude Code Bridge

Você gerencia a ponte bidirecional entre Ravi e sessões do Claude Code (CC).

## Como Funciona

```
CC → Ravi:  Hooks globais (~/.claude/settings.json) → ravi-copilot.sh → nats pub ravi.copilot.*
Ravi → CC:  ravi copilot send <team> "msg" → ~/.claude/teams/{team}/inboxes/team-lead.json
```

1. **Global hooks** em `~/.claude/settings.json` disparam em cada evento do CC
2. **Hook script** `~/.claude/hooks/ravi-copilot.sh` lê o JSON, wrapa num envelope e publica no NATS
3. **Ravi triggers** assinam os tópicos `ravi.copilot.*` e reagem
4. **Mailbox injection** — Ravi escreve no inbox JSON do CC pra comunicar de volta (CC precisa estar em team mode)

## Comandos

### Enviar mensagem pra sessão CC
```bash
ravi copilot send <teamName> "mensagem"
ravi copilot send <teamName> "mensagem" --from jarvis
ravi copilot send <teamName> "mensagem" --summary "Alerta" --color red
```

### Listar times do CC
```bash
ravi copilot teams
```

### Descobrir teams no disco
```bash
ls ~/.claude/teams/
cat ~/.claude/teams/{name}/config.json
```

## NATS Topics

| Topic | Evento CC | Descrição |
|---|---|---|
| `ravi.copilot.session.start` | SessionStart | Sessão CC aberta |
| `ravi.copilot.session.end` | SessionEnd | Sessão CC fechada |
| `ravi.copilot.prompt` | UserPromptSubmit | Usuário enviou prompt |
| `ravi.copilot.tool.pre` | PreToolUse | Tool prestes a executar |
| `ravi.copilot.tool.post` | PostToolUse | Tool executou com sucesso |
| `ravi.copilot.tool.fail` | PostToolUseFailure | Tool falhou |
| `ravi.copilot.stop` | Stop | Claude terminou de gerar |
| `ravi.copilot.subagent.start` | SubagentStart | Subagente criado |
| `ravi.copilot.subagent.stop` | SubagentStop | Subagente terminou |
| `ravi.copilot.notification` | Notification | Notificação do CC |
| `ravi.copilot.teammate.idle` | TeammateIdle | Teammate ficou idle |
| `ravi.copilot.config.change` | ConfigChange | Config do CC mudou |
| `ravi.copilot.compact.pre` | PreCompact | Compactação de contexto |
| `ravi.copilot.task.completed` | TaskCompleted | Task delegada concluída |

### Envelope do payload

```json
{
  "session_id": "abc-123",
  "session_type": "main",
  "cwd": "/path/to/project",
  "event": "PostToolUse",
  "timestamp": "2026-02-25T17:30:00Z",
  "data": { ...payload original do CC... }
}
```

## Exemplos de Triggers

### Alertar em falha de tool
```bash
ravi triggers add "CC Tool Failure" \
  --topic "ravi.copilot.tool.fail" \
  --message "Uma ferramenta falhou no Claude Code. Analise o erro e avise o Luis se for crítico." \
  --agent main --cooldown 30s --session isolated
```

### Monitorar sessões novas
```bash
ravi triggers add "CC Session Start" \
  --topic "ravi.copilot.session.start" \
  --message "Nova sessão do Claude Code iniciada. Registre o CWD e session_id." \
  --agent main --cooldown 10s --session isolated
```

### Monitorar comandos Bash perigosos
```bash
ravi triggers add "CC Bash Monitor" \
  --topic "ravi.copilot.tool.post" \
  --message "Tool executada no CC. Se for Bash com comando perigoso (rm -rf, push --force, DROP TABLE), alerte imediatamente. Senão @@SILENT@@." \
  --agent main --cooldown 5s --session isolated
```

### Notificar fim de sessão
```bash
ravi triggers add "CC Session End" \
  --topic "ravi.copilot.session.end" \
  --message "Sessão do Claude Code terminou. Atualize TASKS.md se relevante. @@SILENT@@ se nada a fazer." \
  --agent main --cooldown 10s --session isolated
```

## Setup

1. Verificar `nats` CLI: `nats --version` (senão: `brew install nats-io/nats-tools/nats`)
2. Daemon rodando: `ravi daemon status`
3. Hook executável: `ls -la ~/.claude/hooks/ravi-copilot.sh`
4. Hooks registrados: `cat ~/.claude/settings.json | grep -c "ravi-copilot.sh"` (deve mostrar 14)
5. Testar: `nats sub "ravi.copilot.>" --server nats://127.0.0.1:4222`
6. Abrir sessão CC → eventos devem aparecer no subscriber

## Arquivos Chave

| Arquivo | Função |
|---|---|
| `~/.claude/settings.json` | Hooks globais do CC |
| `~/.claude/hooks/ravi-copilot.sh` | Script que publica no NATS |
| `~/.claude/teams/{name}/config.json` | Config do team CC |
| `~/.claude/teams/{name}/inboxes/*.json` | Mailbox dos membros |

## Notas

- CC precisa estar em **team mode** pra receber mensagens do Ravi (inbox poller só roda com team ativo)
- NATS port: `4222` (default), override via `RAVI_NATS_URL` env var
- Hook script requer `jq` e `nats` no PATH — falha silenciosa se ausentes
- Publishes em background (`&`) — nunca bloqueia o CC
- Triggers têm anti-loop: eventos de sessões trigger são ignorados
