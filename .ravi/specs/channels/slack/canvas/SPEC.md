---
id: channels/slack/canvas
title: "Slack Canvas Native Operations"
kind: feature
domain: channels
capabilities:
  - slack
  - canvas
  - artifacts
tags:
  - slack
  - canvas
  - artifacts
  - markdown
status: active
normative: true
---

# Slack Canvas Native Operations

## Tese

Slack Canvas deve ser tratado pelo Ravi como uma superficie documental nativa do Slack, usada para publicar e manter artifacts vivos, runbooks, specs, checklists e estado de sessoes.

Canvas nao e mensagem, thread nem sessao. Canvas e um documento de canal ou standalone que pode ser sincronizado a partir do estado canonico do Ravi.

## Contrato

O Ravi deve expor operacoes nativas para:

- criar canvas standalone via `canvases.create`;
- criar ou garantir channel canvas via `conversations.canvases.create` + `conversations.info`;
- publicar showcase/gap list repetivel em canvas existente ou em channel canvas;
- editar canvas via `canvases.edit`;
- localizar secoes via `canvases.sections.lookup`;
- conceder/remover acesso via `canvases.access.set` e `canvases.access.delete`;
- deletar canvas standalone via `canvases.delete`;
- usar um artifact Markdown do Ravi como fonte em `canvas-create`, `canvas-channel-create` e `canvas-edit`;
- inspecionar o status local de publish via `canvas-artifact-status`.

## Conteudo

O formato canonico aceito nesta fase e markdown:

```json
{ "type": "markdown", "markdown": "..." }
```

O renderer do Ravi deve gerar markdown compatível com Canvas. Block Kit nao deve ser usado dentro de Canvas.

## Edicao

`canvases.edit` aceita uma operacao por chamada. O Ravi deve modelar cada chamada como mutacao pequena e auditavel:

- `insert_before`
- `insert_after`
- `insert_at_start`
- `insert_at_end`
- `replace`
- `delete`
- `rename`

Operacoes relativas devem usar `section_id` obtido por `canvases.sections.lookup`, nao por ID persistido indefinidamente.

## Leitura

A Web API publica `canvases.sections.lookup`, mas nao deve ser assumida como export completo do documento. O Ravi deve manter o estado canonico local para canvases que ele cria/sincroniza e usar lookup apenas para localizar pontos de patch no documento Slack.

## Artifact canonico

Para conteudo que precisa ser mantido ao longo do tempo, o source of truth MUST ser um Ravi artifact Markdown, nao o documento remoto do Slack.

O publish Canvas a partir de artifact MUST:

- usar comandos nativos de Canvas (`canvas-create`, `canvas-channel-create`, `canvas-edit`) com `--artifact`;
- aceitar apenas artifact existente como fonte canônica no caminho `--artifact`;
- manter `--markdown` e `--markdown-file` como entradas nativas diretas, sem criar artifact implicitamente;
- rejeitar combinacoes simultaneas de `--markdown`, `--markdown-file` e `--artifact`;
- refrescar o artifact a partir do arquivo fonte apenas no `--execute`, salvo `--skip-refresh`;
- publicar no Slack com `document_content` na criacao, ou `replace` inteiro quando atualizar Canvas existente;
- registrar snapshot/version do artifact no momento do publish;
- gravar metadata `slackCanvas.current` com `canvasId`, `channelId`, `connection`, `title`, `artifactVersionNumber`, hash do Markdown e timestamp;
- gravar evento `slack.canvas.published`;
- linkar o artifact ao `slack_canvas` e ao `slack_channel` quando houver canal;
- declarar `syncDirection=artifact_to_slack` e `remoteContentExportSupported=false`.

O metadata `slackCanvas.current` MUST ser atualizado somente quando o artifact for publicado como documento inteiro. Patches por secao podem usar `--artifact` como fonte Markdown, mas nao devem sobrescrever o estado `current` do artifact ate existir um modelo de diff/patch local confiavel.

O Ravi MUST NOT vender sync bidirecional automatico para Canvas enquanto a API disponivel nao fornecer export Markdown completo ou eventos de edicao manual suficientes para reconciliacao segura.

Edicoes manuais feitas diretamente no Slack Canvas sao out-of-band nesta fase. Um novo publish do Ravi MAY sobrescrever essas edicoes, porque o artifact local e o source canônico. A reconciliacao Slack -> Ravi deve ser um fluxo futuro explicito, nao comportamento implicito.

## Showcase

O Ravi deve manter um showcase nativo de Canvas para testar a integracao end-to-end e comunicar claramente o status da feature.

O showcase deve cobrir:

- markdown rico: headings, listas, checklist, tabelas, quote, code block, links e mentions;
- matriz de metodos implementados;
- matriz de lacunas ainda abertas;
- IDs de canal/canvas usados no teste;
- links para docs oficiais relevantes.

O showcase deve ser gerado por comando, nao por montagem manual ad hoc.

Ao publicar showcase em um canal, o Ravi deve consultar `conversations.info` primeiro e procurar uma aba Canvas existente em `channel.properties.tabs` ou `channel.properties.tabz` com o mesmo titulo. Slack pode manter multiplas abas Canvas no mesmo canal; portanto `canvas-channel-showcase` nao deve assumir unicidade de channel canvas nem criar duplicatas quando uma aba equivalente ja existir.

## Permissoes

Canvas requer escopos Slack:

- `canvases:write` para create/edit/delete/access;
- `canvases:read` para sections lookup.

Credenciais continuam no broker/connection Slack. Agents nao recebem tokens.

## Invariantes

- Channel canvas pertence ao canal; acesso segue acesso do canal.
- Standalone canvas precisa de compartilhamento/acesso explicito.
- `owner` so pode ser definido para usuarios.
- `channel_ids` e `user_ids` nao podem ser enviados juntos em operacoes de acesso.
- Mutacoes destrutivas permanecem dry-run por padrao no CLI; remocao de acesso
  e contencao imediata porque reduz compartilhamento.

## Lacunas ate 100%

Ver `BACKLOG.md`. Ate essas lacunas fecharem, Canvas esta completo apenas no nucleo Web API, nao como produto semantico final do Ravi.
