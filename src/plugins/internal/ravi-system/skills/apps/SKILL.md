---
name: apps
description: |
  Gerencia Ravi Apps. Use quando precisar:
  - Listar, mostrar ou validar manifests de apps
  - Criar scaffold de um novo Ravi App
  - Entender interfaces CLI, SDK, UI, tool e stream de um app
  - Usar operations, storage, events, artifacts, skills e health checks declarados em ravi.app.json
  - Ensinar agentes a operar apps via `ravi apps`
---

# Ravi Apps

Ravi Apps sao a camada de aplicacoes do Ravi OS.

Um app e uma unidade operacional com manifesto, interfaces, operations, permissoes,
storage, events, skills e health checks. O manifesto e metadata declarativa; ele
nao concede permissao e discovery/check nao executam codigo do app.

## Comandos Canonicos

```bash
ravi apps list --json
ravi apps show <app-id> --json
ravi apps check [app-id] --json
ravi apps scaffold <app-id> --name "Nome" --description "Descricao" --json
ravi apps scaffold <app-id> --dry-run --json
ravi apps guide [app-id] --json
ravi apps prompts [app-id] --json
```

## Fluxo Para Operar Um App

1. Descubra apps:

```bash
ravi apps list --json
```

2. Abra o manifesto:

```bash
ravi apps show <app-id> --json
```

3. Valide antes de confiar:

```bash
ravi apps check <app-id> --json
```

4. Leia estes campos antes de operar:

- `manifest.interfaces`: superficies CLI, SDK, UI, stream e tool.
- `manifest.operations`: acoes e snapshots que agentes/UI podem chamar.
- `manifest.permissions`: capacidades requeridas; requisitos, nao grants.
- `manifest.storage`: storage que o app possui.
- `manifest.events`: eventos emitidos/consumidos.
- `manifest.skills`: skills que ensinam agentes a operar o app.
- `manifest.health`: checks seguros e nao destrutivos.

## Fluxo Para Criar Um App

1. Gere um plano sem escrever arquivos:

```bash
ravi apps scaffold <app-id> --dry-run --json
```

2. Gere o scaffold:

```bash
ravi apps scaffold <app-id> --name "Nome" --description "O que o app faz" --json
```

3. Revise os arquivos criados:

- `src/apps/<app-id>/ravi.app.json`
- `.ravi/specs/apps/<app-id>/SPEC.md`
- `src/plugins/internal/ravi-system/skills/<app-id>/SKILL.md`

4. Rode:

```bash
ravi apps check <app-id> --json
ravi apps guide <app-id> --json
```

5. Implemente a logica real do CLI/SDK/tool/stream depois do manifesto estar coerente.

## Regras

- Nao invente comandos. Use apenas operations declaradas.
- Nao raspe stdout quando houver JSON.
- Nao execute health checks durante discovery.
- Nao use manifesto como grant de permissao.
- Mutacoes precisam de permissao declarada e autorizacao runtime real.
- UI de app e declarativa: routes, views, actions, query e refreshOn. CSS/HTML/JS/bundles ficam fora de `ravi.app/v1`.
- Stateful apps devem declarar storage proprio quando persistencia agrega reuse, lineage, audit ou recovery.
- Apps eventful devem declarar eventos para UIs e agentes observarem sem scraping.

## Specs Relacionadas

```bash
ravi specs get apps/manifest --mode rules --json
ravi specs get apps/cli --mode rules --json
ravi specs get apps/ui --mode rules --json
ravi specs get apps/scaffold --mode rules --json
```
