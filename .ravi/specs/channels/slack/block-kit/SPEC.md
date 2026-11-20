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
  `ravi.inbound.interaction`;
- publicar a App Home padrao de cada usuario com `views.publish`.

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

Exceção obrigatória: interações reservadas ao intake de credenciais são
interceptadas antes deste fluxo, inclusive inválidas ou expiradas. O payload é
consumido e apagado na entrada; nenhum segredo ou `response_url` passa por evento,
trigger, trace ou persistência genérica. Ver `credentials/slack-intake`.

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

O handle so aceita `https://hooks.slack.com/actions/` (interacoes) e
`https://hooks.slack.com/commands/` (slash commands, ver `channels/slack/commands`);
qualquer outro host ou caminho e recusado. Cada handle aceita no maximo cinco
respostas (limite do Slack): a sexta e recusada antes de qualquer requisicao, e
cada resposta tem prazo. O uso e reservado antes da requisicao, numa unica
instrucao que tambem confere o limite, e so volta quando o Slack responde e
recusa.

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

## App Home Padrao

O Slack mostra a aba Home vazia ate o app publicar uma view para aquele usuario
com `views.publish`. Um app com a Home Tab ligada que nunca publica deixa a aba
vazia. Por isso o runner Socket Mode responde a `app_home_opened`:

- evento com `tab: "home"` MUST publicar uma view `type: "home"` valida para o
  `user` do evento; `tab: "messages"` MUST ser ignorado;
- a view padrao MUST funcionar para qualquer agent sem configuracao: nome do
  agent, descricao, como falar com ele (aba Mensagens; mencao num canal em que o
  app esteja) e um estado vazio que diz que nada foi configurado ali;
- o agent da Home MUST ser o que responde a DM daquele usuario (`matchRoute` da
  DM) ou, sem rota, o agent da instancia; sem nenhum, a Home MUST dizer que o
  app nao esta ligado a um agente;
- a descricao MUST vir so do diretorio da org (`ravi agents set <id>
  description`, ate 300 caracteres) e MUST aparecer so quando o agent esta
  listado nele (`ravi agents listing <id> on --execute`): o diretorio nao
  mostra agent nao listado, e a Home desse agent mostra so o nome. A descricao
  MUST ser escapada; a Home MUST NOT mostrar instrucoes, arquivos ou contexto
  do agent, porque qualquer pessoa do workspace abre a aba;
- todo texto MUST caber nos limites do Block Kit (header ate 150 caracteres,
  texto ate 3000, no maximo 100 blocks por view);
- `private_metadata` MUST carregar uma impressao do conteudo; se a view que o
  usuario ja tem traz a mesma impressao, o runner MUST NOT publicar de novo;
- falha de `views.publish` MUST ser registrada no log com o erro do Slack
  (`not_enabled` nomeia a Home Tab desligada) e MUST NOT derrubar o envelope
  nem o runner: o proximo `app_home_opened` tenta de novo;
- cada `views.publish` MUST ter prazo (4 s) e MUST ser abortado ao estourar:
  somado ao `auth.test` (5 s), o envelope fecha dentro do prazo de 10 s do
  drain, e um Slack que nao responde nunca trava o restart do runner.

O app Slack precisa assinar o evento `app_home_opened` e ligar a Home Tab.
`views.publish` nao exige escopo.

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

- modal lifecycle completo com `views.open` e `views.update`;
- App Home customizada por agent ou por usuario (a padrao esta em
  "App Home Padrao");
- menus externos dinâmicos;
- renderer Markdown -> Block Kit;
- DSL de templates Ravi para Block Kit.
