---
name: artifacts
description: |
  Gerencia o ledger genérico de artifacts do Ravi. Use quando precisar:
  - Registrar outputs reutilizáveis de qualquer parte do Ravi
  - Encontrar de onde um artifact veio e quais metadados e métricas ele carregou
  - Editar metadata, anexar artifacts a tasks/sessões/projetos ou arquivar artifacts
  - Auditar lineage de imagens, reports, traces, documentos, tool outputs e mensagens
---

# Ravi Artifacts

`ravi artifacts` é o ledger genérico de artefatos do Ravi.

Ele registra o arquivo bruto, metadata, métricas, lineage e relações com sessão/task/canal para que um artifact possa ser auditado, encontrado e reutilizado depois.

## Criar Artifact

```bash
ravi artifacts create image \
  --title "Diagrama Ravi Artifacts" \
  --path /tmp/diagram.png \
  --provider openai \
  --model gpt-image-2 \
  --duration-ms 32000 \
  --total-tokens 1722 \
  --metadata '{"quality":"auto","format":"png"}' \
  --lineage '{"source":"ravi image generate"}'
```

## Listar

```bash
ravi artifacts list
ravi artifacts list --kind image
ravi artifacts list --session dev --limit 20
ravi artifacts list --task task-123 --json
```

## Ver Detalhes

```bash
ravi artifacts show art_xxx --json
```

Mostra:
- artifact principal
- links com tasks/sessões/mensagens/projetos
- eventos de criação/edição/anexo/archive

## Timeline / Lifecycle

Artifacts também podem representar geração assíncrona em andamento.

Estados principais:
- `pending`
- `running`
- `completed`
- `failed`
- `archived`

Ver timeline ordenada:

```bash
ravi artifacts events art_xxx --json
```

Acompanhar até status terminal:

```bash
ravi artifacts watch art_xxx
```

Adicionar evento manual/recovery:

```bash
ravi artifacts event art_xxx failed \
  --status failed \
  --message "provider timeout" \
  --source "manual-recovery" \
  --payload '{"reason":"timeout"}'
```

## Editar Metadata

```bash
ravi artifacts update art_xxx \
  --summary "Versão aprovada pelo Luís" \
  --metadata '{"approved":true,"reviewedBy":"luis"}'
```

`--metadata`, `--metrics` e `--lineage` fazem merge com os dados existentes.

## Anexar a Outro Objeto

```bash
ravi artifacts attach art_xxx task task-123 --relation evidence
ravi artifacts attach art_xxx session dev --relation generated-in
```

## Arquivar

```bash
ravi artifacts archive art_xxx
```

Archive é soft-delete: o artifact sai da listagem padrão, mas continua consultável com `--include-deleted`.

## Integração Atual

`ravi image generate` registra automaticamente artifacts `kind=image` usando lifecycle.

O registro inclui:
- path original e cópia no blob store local
- sha256 e tamanho
- provider, model, prompt e comando
- sessão, agent e canal quando houver contexto Ravi
- duração da geração
- tokens/usage quando o provider retorna
- input/output estruturados
- metadata e lineage básicos

Para geração longa, prefira:

```bash
ravi image generate "prompt" --provider openai --model gpt-image-2 --json
```

Isso retorna imediatamente `artifact_id`, `status` e comando `watch`. O worker
atualiza eventos até `completed` ou `failed`. Quando existe contexto de chat,
a mídia gerada é enviada automaticamente para o chat de origem; não faça polling
por padrão, use `watch/events` só para inspeção manual/debug.

## Regra de Provider

Artifacts não fazem fallback de provider.

Se uma geração falha, ela falha. Para tentar outro provider, rode explicitamente outro comando com `--provider`.
