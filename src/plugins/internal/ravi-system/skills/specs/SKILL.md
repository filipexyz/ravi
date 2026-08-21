---
name: specs
description: |
  Gerencia a memória versionada de regras/specs do Ravi. Use quando precisar:
  - Criar ou consultar regras por domain/capability/feature
  - Recuperar contexto normativo antes de editar código
  - Linkar specs a Projects como contexto ou auditoria futura
  - Reindexar `.ravi/specs` no SQLite
---

# Specs

`ravi specs` é a memória durável de regras do Ravi.

Use specs para registrar invariantes, decisões, runbooks e checks que agents devem consultar antes de mexer em uma área.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedValues?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `SPEC_NOT_FOUND`). O envelope traz `suggestions` com ids reais parecidos do índice — consulte antes de concluir "não existe". `Spec already exists` no `new` também é exit 1: atualize a spec existente, não há overwrite.
- `2` erro de uso: `--mode`/`--kind` inválidos e `--title`/`--kind` faltando no `new`. O envelope traz `acceptedValues` — corrija a chamada, não insista na mesma sintaxe.
- `3` não existe neste domínio: NENHUMA op de specs usa o freio genérico `--execute`.

Sem freios (declarado): `new` só cria Markdown local por promoção atômica e falha em id existente; `sync` é reindexação local idempotente (Markdown é a fonte de verdade) e é usada pelo quality gate de CI e por dezenas de CHECKS — os dois gravam na hora, sem `--execute`.

Para automação nova, prefira `specs facade`: `plan` não grava, `apply` exige o `planHash` ligado ao cwd/raiz/banco reais e confirma por readback, e `verify|recover|readback` são somente leitura. `apply` já é o passo explícito de efeito local reversível; não acrescente `--execute`.

Compact mode: `specs list` aceita `--fields a,b,c` (ex.: `--fields id,kind`) — use em varredura para não arrastar o registro inteiro de cada spec.

Checklist antes de responder sobre specs:

- Consultei `suggestions` do envelope antes de declarar que a spec não existe?
- Se as suggestions vieram vazias, rodei `ravi specs sync --json` e tentei de novo?
- Usei `acceptedValues` para corrigir `--mode`/`--kind` em vez de repetir a chamada?

## Workflow

1. Antes de alterar uma área com regras conhecidas, consulte a spec explícita:

```bash
ravi specs get <domain>/<capability>/<feature> --mode rules --json
```

2. Se precisar entender decisão, operação ou validação, use o modo específico:

```bash
ravi specs get <spec-id> --mode why --json
ravi specs get <spec-id> --mode runbook --json
ravi specs get <spec-id> --mode checks --json
```

3. Depois de corrigir bug ou descobrir uma regra nova, atualize a spec afetada ou crie uma nova.

Para criação por agente, use o fluxo seguro:

```bash
ravi specs facade plan new channels/presence/lifecycle \
  --title "Presence Lifecycle" --kind feature --full --json
ravi specs facade apply new <planHash> channels/presence/lifecycle \
  --title "Presence Lifecycle" --kind feature --full --json
```

Crie os ancestrais indicados antes de reaplicar. `PLAN_STALE` exige um plano novo; `SPEC_TARGET_CONFLICT` exige inspeção, nunca overwrite. Uma reaplicação exatamente igual retorna `noop`.

4. Reindexe quando precisar validar a árvore toda:

```bash
ravi specs sync --json
```

Regra prática: se a regra vai prevenir regressão futura, ela pertence a uma spec, não só ao chat.

## Estrutura

Source of truth:

```text
.ravi/specs/
  <domain>/SPEC.md
  <domain>/<capability>/SPEC.md
  <domain>/<capability>/<feature>/SPEC.md
```

Arquivos opcionais por nó:

- `SPEC.md` — regras, invariantes, boundaries, acceptance criteria
- `WHY.md` — decisões, tradeoffs, alternativas descartadas
- `RUNBOOK.md` — debug/operação
- `CHECKS.md` — validações, regressões, queries

## Linguagem Normativa

Dentro de `SPEC.md`, prefira:

- `MUST` para regra obrigatória
- `MUST NOT` para comportamento proibido
- `SHOULD` para default esperado
- `MAY` para comportamento opcional

## Consultar

```bash
ravi specs list
ravi specs list --domain channels --kind feature
ravi specs get channels/presence/lifecycle
ravi specs get channels/presence/lifecycle --mode full
ravi specs get channels/presence/lifecycle --mode checks
```

Modos:

- `rules` — herança de `SPEC.md` do domain até feature. Default.
- `full` — inclui `SPEC.md`, `WHY.md`, `RUNBOOK.md`, `CHECKS.md`.
- `checks` — só `CHECKS.md`.
- `why` — só `WHY.md`.
- `runbook` — só `RUNBOOK.md`.

Sempre use `--json` quando a saída for consumida por outro agente ou script:

```bash
ravi specs get channels/presence/lifecycle --json
```

## Criar

```bash
ravi specs new channels --title "Channels" --kind domain
ravi specs new channels/presence --title "Presence" --kind capability
ravi specs new channels/presence/lifecycle --title "Presence Lifecycle" --kind feature --full
```

`--full` cria `WHY.md`, `RUNBOOK.md` e `CHECKS.md` junto do `SPEC.md`.

## Reindexar

```bash
ravi specs sync
ravi specs sync --json
```

O índice SQLite é rebuildável. Markdown continua sendo source of truth.

Para um ciclo verificável, use `specs facade plan sync --json`, copie o hash e execute `specs facade apply sync <planHash> --json`. A resposta indica `applied` ou `noop` e inclui a verificação independente.

## Linkar a Projects

```bash
ravi projects link spec ravi-core channels/presence/lifecycle \
  --role context \
  --meta '{"context":true,"audit":true}'
```

Projects não são donos da spec; eles apenas apontam quais regras importam para aquele workstream.
