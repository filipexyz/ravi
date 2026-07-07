# Slack Block Kit Workflows

Use esta referencia quando o usuario quiser montar automacoes deterministicas
com Slack Block Kit, triggers shell e primitives nativas do Ravi, sem colocar a
regra de negocio dentro do core do canal.

## Tese

O core do Ravi deve fornecer primitives genericas:

- enviar e atualizar Block Kit;
- receber `ravi.inbound.interaction`;
- resolver credenciais Slack via broker;
- executar triggers shell;
- criar rotas, canais, sessoes e artifacts por CLI/API local.

O workflow de negocio deve ficar fora do core, por exemplo em
`.ravi/workflows/<nome>/handler.ts`, com state local e idempotencia.

## Padrao Base

1. Publicar uma mensagem Block Kit fixa.
2. Receber clique/select como `ravi.inbound.interaction`.
3. Filtrar trigger por `provider`, `interactionType`, `channelId`, `blockId` e
   `actionId`.
4. Executar handler shell versionado no workspace.
5. Ler `RAVI_TRIGGER_EVENT_FILE`.
6. Resolver state local por chave de dominio.
7. Executar mutacoes nativas: Slack, routes, artifacts, tasks ou bash externo.
8. Atualizar a mensagem de origem ou publicar follow-up.
9. Marcar state como processado antes de aceitar novo clique equivalente.
10. Notificar uma sessao apenas em erro operacional.

## Fronteira Core vs Workflow

Fica no core:

- `ravi slack blocks-send`;
- `ravi slack blocks-update`;
- `ravi slack interactions-respond`;
- evento `ravi.inbound.interaction`;
- envs de trigger como `RAVI_TRIGGER_ACTION_ID`,
  `RAVI_TRIGGER_CHANNEL_ID`, `RAVI_TRIGGER_MESSAGE_TS` e
  `RAVI_TRIGGER_RESPONSE_URL_ID`;
- credenciais Slack via connection/broker;
- APIs genericas de routes, sessions, artifacts, cron e triggers.

Fica no workflow:

- nomes e textos dos botoes;
- maquina de estados;
- arquivo SQLite/JSON de state;
- mapping `messageTs -> domain id`;
- regra de negocio;
- scripts de bash deterministico;
- decisoes de quando chamar ou nao um agent.

## Response URL E Ephemeral

Nunca exponha `response_url` bruto em prompt, logs ou payloads de trigger.

Quando o payload Slack trouxer `response_url`, o runtime publica apenas
`responseUrlId`. Use:

```bash
ravi slack interactions-respond <responseUrlId> ./response.json --execute --json
```

Payload de exemplo para substituir a mensagem interativa:

```json
{
  "replace_original": true,
  "text": "Pedido recebido",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Pedido recebido.*"
      }
    }
  ]
}
```

Payload de exemplo para apagar a mensagem interativa:

```json
{
  "delete_original": true
}
```

Limite observado: `chat.update` nao edita ephemeral interativa comum; Slack pode
retornar `message_not_found`. Se `responseUrlId` nao existir, use fallback:

- publicar nova ephemeral;
- abrir modal com `views.open`;
- responder no ACK do Socket Mode quando a acao puder ser resolvida
  imediatamente.

## Trigger Split

Nao coloque todas as etapas em um unico trigger com cooldown alto. Um clique em
`Abrir` e um select seguinte podem acontecer em menos de cinco segundos.

Padrao recomendado:

```bash
ravi triggers add "workflow open" \
  --topic "ravi.inbound.interaction" \
  --filter 'data.provider == "slack" && data.interactionType == "block_actions" && data.channelId == "C123" && data.actionId == "workflow_open"' \
  --shell 'bun .ravi/workflows/demo/handler.ts' \
  --timeout 30 \
  --cooldown 1s \
  --on-error notify-session:ops

ravi triggers add "workflow actions" \
  --topic "ravi.inbound.interaction" \
  --filter '(data.provider == "slack" && data.interactionType == "block_actions" && data.channelId == "C123" && data.blockId startsWith "workflow_") || (data.provider == "slack" && data.interactionType == "block_actions" && data.blockId == "workflow_channel_actions")' \
  --shell 'bun .ravi/workflows/demo/handler.ts' \
  --timeout 30 \
  --cooldown 1s \
  --on-error notify-session:ops
```

Use filtros explicitos para evitar que um workflow de teste capture cliques de
outro canal.

## Idempotencia

Cada action precisa de uma chave idempotente. Exemplos:

- `sourceChannelId + sourceMessageTs + userId`;
- `targetMessageTs`;
- `ticketId`;
- `artifactId + version`;
- `domainObjectId + transition`.

O handler deve:

1. ler state;
2. se ja processou a chave, reutilizar o resultado e sair;
3. gravar state antes ou logo depois da primeira mutacao externa;
4. nao criar segundo canal/ticket/deploy para o mesmo clique.

## Exemplo Paralelo 1: Tickets Slack

Objetivo: botao publico abre um fluxo privado, usuario escolhe tipo, workflow
cria canal dedicado, adiciona solicitante, roteia agent e publica card de
controle.

Card publico:

- `block_id`: `ravi_ticket_open`;
- `action_id`: `ravi_ticket_open`.

Etapa privada:

- `block_id`: `ravi_ticket_problem`;
- `action_id`: `ravi_ticket_problem_type`;
- state key: `userId + channelId + messageTs`.

Canal dedicado:

- nome: `ravi-ticket-<tipo>-<suffix>`;
- card inicial com `ravi_ticket_close` e `ravi_ticket_archive`;
- rota: `group:<channelId> -> agent default`;
- status local: `created | closed | archived`.

Faz sentido quando:

- cada pedido precisa de contexto proprio;
- cada ticket vira conversa roteada;
- fechar/arquivar precisa ser uma acao deterministica.

## Exemplo Paralelo 2: Aprovacao De Deploy

Objetivo: publicar um resumo de deploy com botoes `Aprovar`, `Rejeitar` e
`Ver diff`.

Card:

- campos: servico, ambiente, commit, autor, diff;
- botoes: `deploy_approve`, `deploy_reject`;
- state key: `deploymentId`.

Handler:

- `deploy_approve`: roda `./scripts/deploy.sh <deploymentId>`;
- `deploy_reject`: marca state como rejeitado;
- atualiza card com status final;
- notifica agent somente se o shell falhar.

Faz sentido quando:

- a decisao e humana;
- a execucao e deterministicamente bash;
- sucesso nao precisa acordar LLM.

## Exemplo Paralelo 3: Revisao De Conteudo/CRM

Objetivo: card com lead, nota, tags sugeridas e botoes para atualizar CRM.

Card:

- `crm_accept_tags`;
- `crm_reject`;
- select `crm_owner_select`.

Handler:

- atualiza contato/card CRM;
- salva `reviewMessageTs -> contactId`;
- publica confirmacao curta;
- atualiza o card com `Aprovado por <user>`.

Faz sentido quando:

- um humano valida uma sugestao;
- o estado final vive em sistema estruturado;
- o Slack e apenas superficie de revisao.

## Exemplo Paralelo 4: Canvas/Artifact Publish

Objetivo: revisar um artifact Markdown e publicar em Slack Canvas.

Card:

- link para artifact;
- preview curto;
- botoes `Publicar Canvas`, `Regerar Preview`, `Arquivar`.

Handler:

- `publish`: chama `ravi slack canvas-artifact-publish ... --execute`;
- `regenerate`: roda comando que cria nova versao do artifact;
- atualiza card com canvas id e versao publicada.

Faz sentido quando:

- artifact e fonte de verdade;
- Canvas e projecao publicada;
- cada publish precisa de trilha de auditoria.

## Exemplo Paralelo 5: Roteamento De Sessao/Agent

Objetivo: card com pedido recebido e select para escolher qual agent/sessao
assume.

Card:

- select de agent;
- select de sessao;
- botao `Criar rota`.

Handler:

- grava selecoes parciais no state;
- ao completar, chama `ravi instances routes add ...`;
- atualiza card com rota ativa;
- opcionalmente envia primeira mensagem no canal roteado.

Faz sentido quando:

- a decisao de ownership e humana;
- depois da decisao o runtime deve assumir automaticamente;
- canais e sessoes precisam ficar explicitos.

## Exemplo Paralelo 6: Incident Commander

Objetivo: a partir de um botao `Abrir incidente`, escolher severidade e criar
war room.

Handler:

- cria canal `incident-sev<sev>-<suffix>`;
- convida on-call;
- cria route para agent de incidentes;
- publica checklist Block Kit;
- cria cron/followup para status updates.

Faz sentido quando:

- ha playbook fixo;
- tempo de resposta importa;
- Slack channel vira sala operacional.

## Checklist De Implementacao

- Mensagem Block Kit tem fallback `text`.
- `block_id` e `action_id` sao estaveis.
- Trigger filtra provider, canal e action.
- Fluxo multi-etapa nao depende de um unico trigger com cooldown alto.
- Handler le `RAVI_TRIGGER_EVENT_FILE`.
- State local e idempotente.
- Segredos ficam no broker; payload nao carrega token.
- `responseUrlId` e usado quando existir.
- `chat.update` e usado somente para mensagens normais, nao como unica aposta
  para ephemeral.
- Erro notifica sessao operacional via `--on-error`.
- Sucesso deterministico nao chama agent.
