---
name: slack
description: |
  Opera o canal Slack nativo do Ravi. Use quando o usuario quiser:
  - Criar, listar, inspecionar, renomear ou convidar pessoas para canais Slack
  - Enviar, ler, inspecionar ou dar replay em mensagens Slack
  - Criar, validar, enviar ou atualizar mensagens Slack Block Kit
  - Trabalhar com botoes, selects e eventos interativos do Slack nativo
  - Validar, publicar, unfurl e apresentar Work Objects nativos do Slack
  - Criar, publicar, editar ou gerenciar Slack Canvas
  - Publicar artifacts Markdown como Slack Canvas
  - Entender rotas, sessoes, threads, presenca/status ou topology do Slack nativo
  - Ver scopes/permissoes Slack e diagnosticar capacidades da integracao nativa
---

# Slack Nativo

Slack e um canal nativo do Ravi. Para Slack, use `ravi slack ...` e as specs
`channels/slack/*` como fonte operacional.

## Principios

- Ravi e dono de `chat`, `thread`, `session`, `message`, `delivery`,
  `presence`, `route`, `artifact` e `policy`.
- Slack e adapter/plataforma: workspace, channel, DM, thread, files, Canvas e
  assistant status sao projetados para o modelo Ravi.
- Mutacoes Slack devem ser dry-run por padrao e executar somente com
  `--execute` (contrato agent-first: dry-run sai com exit 3 — veja
  "Contrato Do CLI" abaixo).
- Use `--json` quando outro agent ou workflow for consumir a resposta.
- Nunca exponha tokens Slack, scopes sensiveis brutos ou secrets. Use o broker
  de credenciais/connections.
- Antes de uma mutacao incerta, verifique scopes com:

```bash
ravi slack permissions-list --json
```

## Contrato Do CLI

O dominio `ravi slack` segue o contrato agent-first (Manual v2), igual aos
demais dominios migrados:

- Exit codes: `0` sucesso · `1` erro/not-found · `2` erro de uso · `3` freio
  de escrita (dry-run). **Exit 3 NAO e erro** — e o sistema funcionando.
- Toda mutacao visivel a humanos e dry-run por padrao. Sem `--execute`, o
  comando sai com exit 3 e o envelope `WRITE_REQUIRES_EXECUTE`, SEM fazer
  nenhuma chamada a Web API do Slack (nem leituras — `messages-replay` freia
  antes do fetch do historico). O `plan` do envelope mostra o metodo Slack e o
  request exato que `--execute` faria.
- `--execute` e sempre a ULTIMA flag do comando. Validacao local (arquivos
  JSON, access level, artifact) roda ANTES do freio.
- Not-found sai com exit 1 e envelope com codigo: `CHANNEL_NOT_FOUND` (config
  de canal Ravi, com suggestions do config store local),
  `CREDENTIALS_NOT_CONFIGURED`, `MESSAGE_NOT_FOUND` (replay),
  `CANVAS_NOT_FOUND`, `ARTIFACT_NOT_FOUND` (com suggestions do ledger local de
  artifacts). Suggestions vem SOMENTE de fontes locais baratas.
- Listagens principais aceitam `--fields a,b,c` (modo compacto: reduz os
  `items` do JSON): `channels-list`, `channels-history`, `files-list`,
  `canvas-sections-lookup`. `members-list` retorna strings de user id, entao
  `--fields` nao se aplica.

### Exemplos freados

```bash
# Dry-run (exit 3, nada enviado — mostra o plano):
ravi slack messages-send C0123456789 "olá time" --json
ravi slack canvas-delete F0123456789 --json

# Escrita real (apos conferir o plano):
ravi slack messages-send C0123456789 "olá time" --json --execute
ravi slack blocks-send C0123456789 ./message.json --json --execute
ravi slack channels-invite C0123456789 U111,U222 --json --execute
ravi slack canvas-edit F0123456789 replace --artifact art_abc_123 --json --execute
```

### Comandos freados (exigem `--execute`)

`messages-send`, `blocks-send`, `blocks-update`, `blocks-showcase`,
`interactions-respond`, `modals-open`, `modals-update`, `modals-push`,
`work-objects-send`, `work-objects-unfurl`, `work-objects-present-details`,
`messages-replay`, `channels-create`, `channels-rename`, `channels-invite`,
`canvas-create`, `canvas-channel-create`, `canvas-showcase`,
`canvas-channel-showcase`, `canvas-artifact-publish`, `canvas-edit`,
`canvas-access-set`, `canvas-access-delete`, `canvas-delete`.

### Comandos sem freio (leitura/local)

`permissions-list`, `channels-list`, `channels-info`, `channels-history`,
`messages-inspect`, `members-list`, `files-list`, `topology`,
`blocks-validate` (chamada de validacao, nada visivel), `work-objects-validate`
(local puro), `canvas-sections-lookup`, `canvas-artifact-status` (local puro).

### Checklist antes de mutar

1. Confira scopes: `ravi slack permissions-list --json`.
2. Rode o comando SEM `--execute` e inspecione o `plan` do envelope (exit 3 e
   esperado).
3. Valide payloads antes: `blocks-validate` / `work-objects-validate`.
4. So entao repita o comando com `--execute` (ultima flag).
5. Exit 3 = freio (repita com `--execute` se o plano estiver certo); exit 1 =
   erro real (leia `error.code` e `suggestedAction`); exit 0 = escrita feita.

## Descoberta Rapida

```bash
ravi slack --help
ravi slack permissions-list --json
ravi slack channels-list --json
ravi slack topology --json
```

## Mapa De Capabilities

Leia apenas a referencia relevante para a tarefa:

- `references/canvas.md` - Slack Canvas, showcase e artifact -> Canvas.
- `references/operations.md` - criar/renomear/convidar canais, membros, files.
- `references/messages-replay.md` - envio, historico, inspect e replay.
- `references/block-kit.md` - mensagens ricas, botoes/selects e eventos interativos.
- `references/work-objects.md` - Work Objects nativos do Slack via metadata,
  chat.postMessage, chat.unfurl e entity.presentDetails.
- `references/block-kit-workflows.md` - workflows externos com Block Kit,
  triggers shell, state local e exemplos paralelos.
- `references/topology.md` - rotas, sessoes, ownership e diagnostico.
- `references/threads-routing.md` - forks de sessao por Slack thread.
- `references/presence.md` - status nativo/assistant status e delivery boundary.
- `references/credentials.md` - connections, scopes e seguranca de tokens.
- `references/runner-delivery.md` - runner, outbound jobs e idempotencia.

## Comandos Principais

### Read-only

```bash
ravi slack channels-list --json
ravi slack channels-info <channel> --json
ravi slack channels-history <channel> --json
ravi slack members-list <channel> --json
ravi slack files-list --json
ravi slack topology --json
ravi slack permissions-list --json
```

### Mensagens

```bash
ravi slack messages-send <channel> "texto" --execute --json
ravi slack messages-send <channel> "texto" --ephemeral-user <userId> --execute --json
ravi slack messages-inspect <channel> <ts> --json
ravi slack messages-replay <channel> <ts> --execute --json
```

### Block Kit

```bash
ravi slack blocks-validate ./message.json --json
ravi slack blocks-send <channel> ./message.json --execute --json
ravi slack blocks-send <channel> ./message.json --ephemeral-user <userId> --execute --json
ravi slack blocks-update <channel> <ts> ./message.json --execute --json
ravi slack interactions-respond <responseUrlId> ./response.json --execute --json
ravi slack modals-open <triggerId> ./view.json --execute --json
ravi slack modals-update <viewId> ./view.json --hash <hash> --execute --json
ravi slack modals-push <triggerId> ./view.json --execute --json
ravi slack blocks-showcase <channel> --execute --json
```

### Work Objects Nativos Do Slack

```bash
ravi slack work-objects-validate ./metadata.json --json
ravi slack work-objects-send <channel> ./message.json --execute --json
ravi slack work-objects-unfurl <channel> <messageTs> <url> ./metadata.json --execute --json
ravi slack work-objects-present-details <triggerId> ./detail.json --execute --json
```

### Canais

```bash
ravi slack channels-create "nome-canal" --execute --json
ravi slack channels-rename <channel> "novo-nome" --execute --json
ravi slack channels-invite <channel> <userIds> --execute --json
```

### Canvas

```bash
ravi slack canvas-create --title "Titulo" --artifact <artifactId> --execute --json
ravi slack canvas-channel-create <channel> --title "Titulo" --artifact <artifactId> --ensure --execute --json
ravi slack canvas-edit <canvas> replace --artifact <artifactId> --execute --json
ravi slack canvas-artifact-status <artifactId> --json
```

## Fonte De Verdade Para Canvas

Para Canvas, o source canonico deve ser um Ravi artifact Markdown. O Slack Canvas
e a projecao publicada. Nesta fase, edicoes manuais feitas no Slack sao
out-of-band e podem ser sobrescritas em novo publish do Ravi.

## Specs Relacionadas

```bash
ravi specs get channels/slack --mode rules --json
ravi specs get channels/slack/block-kit --mode rules --json
ravi specs get channels/slack/canvas --mode rules --json
ravi specs get channels/slack/operations --mode rules --json
ravi specs get channels/slack/threads --mode rules --json
ravi specs get channels/slack/presence --mode rules --json
ravi specs get channels/slack/topology --mode rules --json
ravi specs get channels/slack/message-replay --mode rules --json
```
