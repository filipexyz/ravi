# Slack Canvas Runbook

## Criar canvas standalone

```bash
ravi slack canvas-create --title "Ravi Channels" --markdown-file ./canvas.md --execute --json
```

Com artifact como fonte canonica:

```bash
ravi slack canvas-create --title "Ravi Channels" --artifact art_abc_123 --execute --json
```

## Criar channel canvas

```bash
ravi slack canvas-channel-create C123 --title "Ravi Channels" --markdown-file ./canvas.md --ensure --execute --json
```

Com artifact como fonte canonica:

```bash
ravi slack canvas-channel-create C123 --title "Ravi Channels" --artifact art_abc_123 --ensure --execute --json
```

Se o channel canvas ja existir, `--ensure` retorna o canvas existente. Para republicar o artifact em um canvas existente, use `canvas-edit replace --artifact`.

## Publicar showcase em channel canvas

```bash
ravi slack canvas-channel-showcase C123 --execute --json
```

## Publicar showcase em canvas existente

```bash
ravi slack canvas-showcase F123 --channel C123 --execute --json
```

## Publicar artifact Markdown em Canvas existente

Use o comando nativo de edicao com `replace` inteiro:

```bash
ravi slack canvas-edit F123 replace --artifact art_abc_123 --execute --json
```

O publish e `artifact_to_slack`: o artifact local e o source canonico, e o Canvas e uma projecao publicada.

Se a origem ainda e arquivo Markdown local, crie/atualize o artifact no ledger primeiro e depois publique com `--artifact`. O fluxo de publish nao deve criar artifact implicitamente:

```bash
ravi artifacts create --kind slack.canvas.markdown --title "Ravi Channels" --path ./canvas.md --json
```

## Inspecionar status local do artifact publicado

```bash
ravi slack canvas-artifact-status art_abc_123 --json
```

Campos importantes:

- `published.canvasId`: ultimo Canvas publicado;
- `published.markdownSha256`: hash publicado;
- `markdownSha256`: hash local atual;
- `localDiffersFromPublished`: artifact local mudou desde o ultimo publish conhecido;
- `sourceFileChanged`: arquivo fonte mudou em relacao ao blob registrado no artifact;
- `remoteContentReadable=false`: o status nao faz diff contra o conteudo remoto do Slack.

## Localizar secao

```bash
ravi slack canvas-sections-lookup F123 --section-types h1,h2 --contains-text "Status" --json
```

## Editar secao

```bash
ravi slack canvas-edit F123 replace --section-id temp:C:abc --markdown-file ./status.md --execute --json
```

Tambem e possivel usar `--artifact` como entrada Markdown de patch, mas isso nao atualiza `slackCanvas.current` porque nao representa publish inteiro do documento:

```bash
ravi slack canvas-edit F123 replace --section-id temp:C:abc --artifact art_abc_123 --execute --json
```

## Compartilhar standalone canvas

```bash
ravi slack canvas-access-set F123 write --channels C123 --execute --json
```

## Remover acesso

```bash
ravi slack canvas-access-delete F123 --users U123 --json
```

## Deletar canvas

```bash
ravi slack canvas-delete F123 --execute --json
```
