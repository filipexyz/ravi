---
name: cross-manager
description: |
  DEPRECADO — use os comandos de sessions:
  - ravi sessions send <session> "mensagem"
  - ravi sessions ask <session> "pergunta" "sender"
  - ravi sessions answer <session> "resposta" "sender"
  - ravi sessions execute <session> "tarefa"
  - ravi sessions inform <session> "info"
---

# Cross Manager (DEPRECADO)

Os comandos `ravi cross send` e `ravi cross list` foram migrados para `ravi sessions`.

## Migração

| Antes | Agora |
|-------|-------|
| `ravi cross send <target> relay "msg"` | `ravi sessions send <session> "msg"` |
| `ravi cross send <target> inform "msg"` | `ravi sessions inform <session> "msg"` |
| `ravi cross send <target> execute "msg"` | `ravi sessions execute <session> "msg"` |
| `ravi cross send <target> ask "msg" "sender"` | `ravi sessions ask <session> "msg" "sender"` |
| `ravi cross send <target> answer "msg" "sender"` | `ravi sessions answer <session> "msg" "sender"` |
| `ravi cross list` | `ravi sessions list` |

## Notas

- Targets agora usam **session names** (ex: `main`, `e2-filipe-e2`) em vez de session keys
- Source/context são resolvidos automaticamente da sessão
- Use `--channel` e `--to` para override explícito de routing
