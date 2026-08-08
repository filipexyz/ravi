---
name: heartbeat-manager
description: |
  Gerencia heartbeat dos agents. Use quando o usuário quiser:
  - Configurar check-ins periódicos para agents
  - Ativar/desativar heartbeat
  - Definir intervalo e horários ativos
  - Disparar heartbeat manualmente
---

# Heartbeat Manager

Heartbeat são check-ins periódicos que um agent faz. O agent lê o arquivo HEARTBEAT.md do seu workspace e executa as instruções.

## Como Funciona

1. Agent tem heartbeat habilitado com intervalo (ex: 30min)
2. A cada intervalo, o daemon envia prompt pro agent
3. Agent lê HEARTBEAT.md e executa (ex: verificar pendências, enviar resumo)

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `AGENT_NOT_FOUND`). O envelope traz `suggestions` com agents reais parecidos — consulte antes de concluir "não existe".
- `2` erro de uso (flag\argumento inválido). O envelope traz `acceptedFlags`: corrija a chamada, não insista na mesma sintaxe.
- `3` NÃO acontece neste domínio: heartbeat não tem nenhum freio de escrita (nenhum comando aceita `--execute`). O valor do contrato aqui é envelope + exits + `--fields`.

Por que sem freio (decisão declarada, não omissão): `trigger` dispara o heartbeat do PRÓPRIO agente — ação benigna e frequente na operação, que só processa o `HEARTBEAT.md` e é suprimida quando o agente responde `HEARTBEAT_OK`; `enable`/`disable` são um par reversível; e todo `set` (interval, model, account, active-hours) tem inverso óbvio. Se algum comando de heartbeat um dia sair com exit 3, isso é regressão de contrato — não "conserte" adicionando `--execute` na chamada.

Compact mode: `heartbeat status` aceita `--fields a,b,c` (ex.: `--fields agent,heartbeat`) — use em varredura para não arrastar o objeto inteiro de cada agent.

Help por operação: `ravi heartbeat <op> --help` é enxuto; prefira-o ao help do domínio inteiro.

Checklist antes de responder sobre heartbeat:

- Consultei `suggestions` do envelope antes de declarar que o agent não existe?
- Tratei `status: "skipped"` do `trigger` como sucesso (falta/vazio o HEARTBEAT.md), e não como erro?
- Lembrei que aqui NÃO existe `--execute` — nenhum comando é dry-run?

## Comandos

### Ver status de todos
```bash
ravi heartbeat status
```

### Ver config de um agent
```bash
ravi heartbeat show <agent>
```

### Habilitar heartbeat
```bash
ravi heartbeat enable <agent>
ravi heartbeat enable <agent> 30m    # Com intervalo
```

### Desabilitar heartbeat
```bash
ravi heartbeat disable <agent>
```

### Configurar propriedades
```bash
ravi heartbeat set <agent> interval 1h          # Intervalo
ravi heartbeat set <agent> model haiku          # Modelo (economia)
ravi heartbeat set <agent> active-hours 09:00-22:00  # Horário ativo
ravi heartbeat set <agent> active-hours always  # Sempre ativo
```

### Disparar manualmente
```bash
ravi heartbeat trigger <agent> --execute
```

## Arquivo HEARTBEAT.md

Cada agent precisa ter um `HEARTBEAT.md` no seu workspace com instruções do que fazer no check-in.

Exemplo:
```markdown
# Heartbeat - Check-in Periódico

## O Que Verificar
- Tarefas pendentes
- Erros recentes nos logs
- Mensagens não respondidas

## Quando Notificar
- Se algo importante ficou pendente
- Se um processo crashou
- Se há muito tempo sem interação

## Como Notificar
Use sessions inform para enviar mensagem:
ravi sessions inform <session-name> "mensagem"
```

## Exemplos

Configurar heartbeat básico:
```bash
ravi heartbeat enable main 30m
```

Heartbeat só em horário comercial:
```bash
ravi heartbeat enable main 1h
ravi heartbeat set main active-hours 09:00-18:00
```

Usar modelo mais barato:
```bash
ravi heartbeat set main model haiku
```

Testar configuração:
```bash
ravi heartbeat trigger main --execute
ravi daemon logs -f
```
