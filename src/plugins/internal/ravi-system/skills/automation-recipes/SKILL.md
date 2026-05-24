---
name: automation-recipes
description: |
  Receitas operacionais de automacao do Ravi. Use quando precisar:
  - Montar rotinas compostas com cron, triggers, sessions, media e state local
  - Implementar aprovacao por reaction sem perder correlacao de estado
  - Evitar automacoes que disparam LLM ou efeito externo sem necessidade
  - Documentar padroes reutilizaveis de rotina
---

# Automation Recipes

Use esta skill para compor primitives do Ravi em rotinas repetiveis. Uma receita nao substitui specs: quando a rotina vira padrao do produto, registre tambem em `.ravi/specs/routines`.

## Principios

- Separe trigger de contexto: o evento que acorda a rotina raramente contem todo o estado necessario.
- Grave state duravel antes de esperar eventos externos.
- Prefira `ravi cron --shell` para trabalho deterministico e envolva agent apenas em erro ou decisao.
- Defina a politica de fala: default silencioso, falar apenas quando houver acao ou falha relevante.
- Toda acao externa deve ser idempotente ou ter marcador de processamento.

## Receita: Cron Sentinela + Reaction De Aprovacao

Use quando um script periodico encontra candidatos, posta uma previa para revisao humana e publica somente quando alguem reage com aprovacao.

### Componentes

1. Cron shell deterministico
   - roda ETL, scraping, sync ou geracao de cards;
   - nao invoca LLM em sucesso;
   - usa `--on-error notify-session:<session>` para erro operacional.
2. Store local da rotina
   - JSON, SQLite ou outro arquivo sob o workspace do agent;
   - chave principal: external message id da previa enviada;
   - valor: domain id, destino final, payload necessario para publicar, status e timestamps.
3. Trigger de reaction
   - topic canonico: `ravi.inbound.reaction`;
   - filtro somente sobre campos existentes: `data.emoji`, `data.senderId`, `data.targetMessageId`;
   - prompt manda resolver `data.targetMessageId` no store local.
4. Publicador
   - se `targetMessageId` nao existe no store, responda `@@SILENT@@`;
   - se ja foi processado, responda `@@SILENT@@`;
   - se e valido, publica no canal final e marca processed.

### Exemplo de cron shell

```bash
ravi cron add "approval-candidates" \
  --cron "*/15 * * * *" \
  --shell "python3 ./scripts/build_candidates.py" \
  --timeout 10m \
  --on-error notify-session:ops
```

O script deve salvar incrementalmente. Para rotinas que podem sobrepor execucoes, use lock file ou mecanismo equivalente.

### Exemplo de trigger

```bash
ravi triggers add "approval reaction" \
  --topic "ravi.inbound.reaction" \
  --filter 'data.emoji includes "👍"' \
  --message "Reaction {{data.emoji}} on {{data.targetMessageId}} from {{data.senderId}}. Load local approval state by targetMessageId. If no matching item exists or it was already processed, respond @@SILENT@@. If it is pending, publish it once and mark processed."
```

Nao filtre por `data.chatId` nesse topic: reaction events normalizados carregam `targetMessageId`, `emoji` e `senderId`. Se a rotina precisa restringir por chat, grave o chat no state associado ao `targetMessageId` quando enviar a previa.

### State minimo

```json
{
  "external_msg_123": {
    "domainId": "item_123",
    "reviewChatId": "chat_ops",
    "destinationChatId": "chat_public",
    "status": "pending",
    "createdAt": "2026-05-24T12:00:00Z",
    "processedAt": null
  }
}
```

### Checklist

- O cron de sucesso nao chama agent.
- O store sobrevive restart.
- Cada previa enviada grava `targetMessageId -> domain state`.
- O trigger usa `ravi.inbound.reaction`.
- O filtro usa apenas campos do payload real.
- O publicador e idempotente.
- Falhas do cron notificam uma sessao; sucessos ficam silenciosos.
- Dados sensiveis nao entram em prompt, logs ou docs.
