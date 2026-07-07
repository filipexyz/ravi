---
id: channels/slack/block-kit
title: "Slack Block Kit Native Operations"
kind: feature
domain: channels
capabilities:
  - slack
  - block-kit
  - interactions
tags:
  - slack
  - block-kit
  - interactivity
status: active
normative: true
---

# Slack Block Kit Native Operations

## Tese

Block Kit e a superficie nativa de UI interativa do Slack para mensagens,
modals e app home. No Ravi, Block Kit deve ser tratado como capability nativa do
adapter Slack, nao como chamada bruta de Web API feita por agents.

Canvas continua sendo superficie documental. Block Kit e superficie de mensagem
e interacao.

## Contrato Inicial

O Ravi deve expor:

- validar payload Block Kit com `blocks.validate`;
- enviar mensagem Block Kit com `chat.postMessage`;
- atualizar mensagem Block Kit com `chat.update`;
- publicar um showcase repetivel;
- receber interacoes via Socket Mode e publicar evento canonico
  `ravi.inbound.interaction`.

## Modelo De Payload

Mensagens Block Kit devem aceitar arquivo JSON contendo:

```json
{
  "text": "Fallback acessivel",
  "blocks": []
}
```

O Ravi tambem pode aceitar um array de blocks direto, desde que a chamada forneca
`--text`.

`text` top-level e obrigatorio para mensagem final porque e fallback de
notificacao/acessibilidade. Blocks nao devem ser usados como unico texto
semantico.

## Validacao Local

Antes de chamar Slack, o Ravi deve validar localmente:

- payload possui `blocks` array;
- mensagem possui pelo menos um block;
- mensagem possui no maximo 50 blocks;
- `actions` block possui elementos e no maximo 25 elementos;
- `block_id` e `action_id` tem no maximo 255 caracteres;
- elementos interativos conhecidos possuem `action_id`.

Validacao local nao substitui `blocks.validate`; ela bloqueia erros obvios antes
de mutacao e torna dry-run util.

## Interacoes

Payloads Socket Mode de `block_actions`, `view_submission`, `view_closed`,
`block_suggestion`, `shortcut` e `message_action` devem ser ackados e publicados
como `ravi.inbound.interaction`.

O evento canonico deve incluir, quando existir:

- `provider`;
- `interactionType`;
- `accountId`;
- `instanceId`;
- `teamId`;
- `userId`;
- `channelId`;
- `messageTs`;
- `threadTs`;
- `triggerId`;
- `containerType`;
- `viewId`;
- `viewCallbackId`;
- `actionId`;
- `blockId`;
- `actionType`;
- `value`;
- `selectedOption`;
- `stateValues`;
- `responseUrlId`;
- `responseUrlPresent`.

`response_url` e tokens Slack nao podem ser publicados no evento, logados ou
retornados para agents.

Quando Slack fornecer `response_url`, o runtime deve persistir a URL em broker
local e publicar somente `responseUrlId`. Workflows podem usar esse handle para
responder a interacao, substituir a mensagem original com `replace_original` ou
apagar a mensagem original com `delete_original`, sem receber o segredo bruto.

## Automacoes

Automacoes devem filtrar por `provider`, `interactionType`, `actionId` e
`blockId`. `value` e `stateValues` sao dados fornecidos pelo usuario e devem ser
tratados como input nao confiavel.

Quando a automacao for deterministica, o trigger deve poder executar shell
diretamente, sem acordar agent. Esse modo e apropriado para:

- criar ou atualizar tickets;
- atualizar a propria mensagem Block Kit;
- gravar state local;
- chamar CLIs internos com argumentos derivados do evento;
- notificar agent apenas em erro.

Triggers shell recebem o payload canonico em arquivo:

- `RAVI_TRIGGER_EVENT_FILE` com `{ trigger, event, source }`;
- `RAVI_TRIGGER_DATA_FILE` com `event.data`;
- envs de conveniencia como `RAVI_TRIGGER_ACTION_ID`,
  `RAVI_TRIGGER_BLOCK_ID`, `RAVI_TRIGGER_CHANNEL_ID`,
  `RAVI_TRIGGER_MESSAGE_TS`, `RAVI_TRIGGER_USER_ID` e
  `RAVI_TRIGGER_RESPONSE_URL_ID`.

Fluxos multi-etapa devem ser modelados como maquina de estados duravel, keyed
por `messageTs` ou id de dominio. Cada clique deve ser idempotente.

POC de tickets:

1. mensagem inicial tem botao `ravi_ticket_create`;
2. trigger shell grava ticket local e atualiza a mensagem com select de agent;
3. select `ravi_ticket_assign_agent` grava agent e atualiza para select de
   sessao;
4. select `ravi_ticket_assign_session` grava destino final e marca ticket como
   roteado;
5. criacao real de rota/sessao e capability separada e deve ser adicionada apos
   validacao da UX.

## Permissoes

As mutacoes seguem dry-run por padrao e exigem `--execute`.

Escopos Slack iniciais:

- `chat:write` para enviar e atualizar mensagens;
- interatividade habilitada no app Slack para receber payloads;
- Socket Mode habilitado para entregar interacoes ao runtime;
- `blocks.validate` nao requer escopo extra, mas deve usar credencial Slack
  configurada pelo broker.

Credenciais continuam no broker/connection Slack. Agents nao recebem tokens.

## Fora Do Escopo Inicial

- modal lifecycle completo com `views.open`, `views.update` e `views.publish`;
- App Home;
- menus externos dinâmicos;
- renderer Markdown -> Block Kit;
- DSL de templates Ravi para Block Kit.
