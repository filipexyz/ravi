---
name: cross-manager
description: |
  Gerencia mensagens entre sessões do Ravi. Use quando o usuário quiser:
  - Enviar mensagens de uma sessão para outra
  - Fazer perguntas para outro agent
  - Notificar usuário em outro canal
  - Ver sessões ativas
---

# Cross Manager

Cross-session messaging permite que um agent envie mensagens para outra sessão do Ravi.

## Conceitos

- **Session Key**: Identificador único de uma conversa (ex: `agent:main:main`, `agent:main:whatsapp:5511999999999`)
- **Routing**: Canal e destino de entrega (ex: `whatsapp:5511999999999`)
- **Type**: Tipo de mensagem que define como será tratada

## Tipos de Mensagem

| Type | Descrição |
|------|-----------|
| `send` | Envia mensagem que dispara prompt (resposta) |
| `contextualize` | Adiciona contexto para próxima mensagem |
| `execute` | Pede execução de ação |
| `ask` | Faz pergunta atribuída ao sender |
| `answer` | Responde a uma pergunta anterior |

## Comandos

### Enviar mensagem
```bash
ravi cross send <target> <type> "<message>"
```

Com routing explícito:
```bash
ravi cross send <target> <type> "<message>" --channel whatsapp --to 5511999999999
```

Com atribuição (pra ask/answer):
```bash
ravi cross send <target> ask "<pergunta>" "Nome do Sender"
```

### Listar sessões
```bash
ravi cross list
```

## Exemplos

Notificar usuário no WhatsApp:
```bash
ravi cross send "agent:main:whatsapp:lid:12345" send "Tarefa concluída!"
```

Fazer pergunta para outro agent:
```bash
ravi cross send "agent:sde:main" ask "Como implementar X?" "Usuário"
```

Adicionar contexto antes de mandar mensagem:
```bash
ravi cross send "agent:main:main" contextualize "Projeto: MoltTalent, Stack: React+Node"
```

Ver todas as sessões ativas:
```bash
ravi cross list
```

## Session Keys

Formato: `agent:<agentId>:<scope>[:<details>]`

Exemplos:
- `agent:main:main` - Sessão principal do agent main
- `agent:main:whatsapp:5511999999999` - DM do WhatsApp
- `agent:main:whatsapp:group:123456@g.us` - Grupo do WhatsApp
- `agent:main:matrix:!room:server` - Sala do Matrix

## Routing

A resposta vai pro canal correto baseado em:
1. Parâmetros `--channel` e `--to` (se fornecidos)
2. Último canal/destino da sessão
3. Derivado da session key

Se não houver routing, a resposta não é entregue em nenhum canal (fica só no contexto).
