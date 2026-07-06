---
name: slack
description: |
  Opera o canal Slack nativo do Ravi. Use quando o usuario quiser:
  - Criar, listar, inspecionar, renomear ou convidar pessoas para canais Slack
  - Enviar, ler, inspecionar ou dar replay em mensagens Slack
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
  `--execute`.
- Use `--json` quando outro agent ou workflow for consumir a resposta.
- Nunca exponha tokens Slack, scopes sensiveis brutos ou secrets. Use o broker
  de credenciais/connections.
- Antes de uma mutacao incerta, verifique scopes com:

```bash
ravi slack permissions-list --json
```

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
ravi slack messages-inspect <channel> <ts> --json
ravi slack messages-replay <channel> <ts> --execute --json
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
ravi specs get channels/slack/canvas --mode rules --json
ravi specs get channels/slack/operations --mode rules --json
ravi specs get channels/slack/threads --mode rules --json
ravi specs get channels/slack/presence --mode rules --json
ravi specs get channels/slack/topology --mode rules --json
ravi specs get channels/slack/message-replay --mode rules --json
```
