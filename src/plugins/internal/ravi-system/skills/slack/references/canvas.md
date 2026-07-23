# Slack Canvas

Use esta referencia quando a tarefa envolver Slack Canvas, showcase, artifacts
Markdown, publish, patch de secao, acesso ou remocao de Canvas.

## Regra Central

O Ravi artifact Markdown e a fonte canonica. O Slack Canvas e a projecao
publicada.

Nao prometa sync bidirecional automatico. A API atual usada pelo Ravi permite
criar, editar, procurar secoes e gerenciar acesso, mas nao oferece export
Markdown completo confiavel para reconciliacao Slack -> Ravi.

## Comandos

```bash
ravi slack canvas-create --title "Titulo" --artifact <artifactId> --execute --json
ravi slack canvas-create --title "Titulo" --markdown-file ./canvas.md --execute --json

ravi slack canvas-channel-create <channel> --title "Titulo" --artifact <artifactId> --ensure --execute --json
ravi slack canvas-channel-showcase <channel> --execute --json

ravi slack canvas-edit <canvas> replace --artifact <artifactId> --execute --json
ravi slack canvas-sections-lookup <canvas> --section-types h1,h2 --contains-text "Status" --json
ravi slack canvas-edit <canvas> replace --section-id <sectionId> --markdown-file ./status.md --execute --json

ravi slack canvas-access-set <canvas> write --channels <channelIds> --execute --json
ravi slack canvas-access-delete <canvas> --users <userIds> --execute --json
ravi slack canvas-delete <canvas> --execute --json
ravi slack canvas-artifact-status <artifactId> --json
```

## Dry-run

Mutacoes de Canvas sao dry-run por padrao. Adicione `--execute` somente quando a
acao estiver correta.

## Artifact Metadata

Quando o publish usa `--artifact` e publica o documento inteiro, o Ravi deve
registrar:

- `slackCanvas.current`
- evento `slack.canvas.published`
- link do artifact para `slack_canvas`
- link do artifact para `slack_channel` quando houver canal

Patch por secao com `--artifact` nao deve sobrescrever `slackCanvas.current`.

## Specs

```bash
ravi specs get channels/slack/canvas --mode full --json
```
