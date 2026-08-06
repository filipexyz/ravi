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

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `ARTIFACT_NOT_FOUND`, `ARTIFACT_VERSION_NOT_FOUND`, `SITE_NOT_FOUND`, `ROUTE_NOT_FOUND`). O envelope traz `suggestions` com artifacts reais parecidos (ids/títulos do ledger local) ou `suggestedAction` apontando a listagem certa — consulte antes de concluir "não existe".
- `2` erro de uso (flag\argumento inválido): corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi enviado/exposto; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje (ops que expõem conteúdo externamente):

- `artifacts publish` e `artifacts release activate` — dry-run por default; nada sobe para o Console sem `--execute`.
- `pages publish` — dry-run por default; o upload/release só acontece com `--execute`.
- `pages password set` e `pages password remove` — dry-run por default; o `set` freado nem pede a senha.
- `pages update`/`pages visibility` PARA `public` — freado (expõe conteúdo já hospedado). Reduzir visibilidade (`private`/`protected_link`) grava na hora, sem freio: lockdown nunca é freado.

Exemplos freados (repita com `--execute` após revisar o `plan`):

```bash
ravi artifacts publish ./site --project proj --site demo --route / --visibility public --json           # exit 3 (plano)
ravi artifacts publish ./site --project proj --site demo --route / --visibility public --json --execute # publica
ravi artifacts release activate art_xxx --release rel_xxx --json --execute
ravi pages publish proj demo ./site --route / --visibility public --entrypoint index.html --execute
ravi pages password set proj demo --route / --execute
ravi pages password remove proj demo --route / --visibility private --execute
ravi pages visibility proj demo public --execute
```

Escritas SEM freio (gravam na hora — o freio é você conferir o alvo antes):

- `artifacts create`, `update`, `attach`, `event`, `snapshot`
- `artifacts archive` e `artifacts restore` (par reversível: archive é soft-delete consultável com `--include-deleted`; restore recupera de versão imutável e registra nova versão)
- `pages create` (só garante o registro do site; nenhum byte fica acessível sem o publish freado), `pages domains`, reduções de visibilidade, `pages password status`

Compact mode: `artifacts list`, `pages list` e `pages published` aceitam `--fields a,b,c` (ex.: `--fields id,kind`) — use em varredura para não arrastar o objeto inteiro.

Checklist antes de responder sobre artifacts/pages:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions`/`suggestedAction` do envelope antes de declarar not-found?
- Confirmei que a operação que expõe conteúdo público levou `--execute` de propósito?

## Criar Artifact

```bash
ravi artifacts create \
  --title "Diagrama Ravi Artifacts" \
  --path /tmp/diagram.png \
  --kind image \
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
ravi artifacts list --session dev --limit 50 --offset 0
ravi artifacts list --task task-123 --json
ravi artifacts list --rich --json --limit 50 --offset 0
```

Listagens seguem o contrato padrao de paginacao do Ravi:

- `total`: total filtrado no ledger, nao apenas a pagina atual
- `pagination.limit`: tamanho da pagina aplicada
- `pagination.offset`: posicao inicial da pagina
- `pagination.returned`: itens retornados nesta pagina
- `pagination.hasMore`: se existe proxima pagina
- `pagination.nextCommand`: comando pronto para a proxima pagina quando existir
- `items`: lista canonica para agentes consumirem
- `artifacts`: alias de compatibilidade

Para agentes: nunca assuma que `items.length` e o universo completo. Use
`pagination.total`/`pagination.hasMore` e execute `pagination.nextCommand`
quando precisar continuar.

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

## Publicar Conteúdo em Ravi Pages

Para subir HTML/site no Ravi Pages, use `ravi pages publish`. `ravi pages`
cria/edita o site, mas não sobe bytes sem o publish.

Fluxo canônico para diretório local (`publish` é freado: sem `--execute` é dry-run com exit 3):

```bash
ravi pages create <project-ref> <site-slug> --visibility public
ravi pages publish <project-ref> <site-slug> ./site --route / --visibility public --entrypoint index.html --execute
```

Se já existe artifact local:

```bash
ravi pages publish <project-ref> <site-slug> <artifact-id> --route / --visibility public --execute
```

O upload de conteúdo do Pages é `ravi pages publish`.

Para proteger uma rota já publicada sem reenviar o conteúdo (`set`/`remove` são freados; o `set` sem `--execute` nem pede a senha):

```bash
ravi pages password set <project-ref> <site-slug> --route / --execute
ravi pages password status <project-ref> <site-slug> --route / --json
ravi pages password remove <project-ref> <site-slug> --route / --visibility private --execute
```

`password set` usa prompt oculto e confirmação. Em automação, use somente
`--stdin` com entrada redirecionada; nunca inclua a senha em argumento, variável
de ambiente, log ou saída JSON.

## Integração Atual

`ravi image generate` registra automaticamente artifacts `kind=image` usando lifecycle.
`ravi image atlas split` registra um artifact `kind=image.atlas.split` para o
manifest e um artifact `kind=image.crop` para cada crop derivado.

O registro inclui:
- path original e cópia no blob store local
- sha256 e tamanho
- provider, model, prompt e comando
- sessão, agent e canal quando houver contexto Ravi
- duração da geração
- tokens/usage quando o provider retorna
- input/output estruturados
- metadata e lineage básicos
- provenance de atlas/crop: grid, posição, parent artifact e split artifact

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
