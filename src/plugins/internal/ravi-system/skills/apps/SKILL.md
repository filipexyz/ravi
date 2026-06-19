---
name: apps
description: |
  Gerencia Ravi Apps. Use quando precisar:
  - Listar, mostrar ou validar manifests de apps
  - Criar scaffold de um novo Ravi App
  - Entender interfaces CLI, SDK, UI, tool e stream de um app
  - Usar operations, storage, events, artifacts, skills e health checks declarados em ravi.app.json
  - Ensinar agentes a operar apps via `ravi <app-id> <operation>`
---

# Ravi Apps

Ravi Apps sao a camada de aplicacoes do Ravi OS.

Um app e uma unidade operacional com manifesto, interfaces, operations, permissoes,
storage, events, skills e health checks. O manifesto e metadata declarativa; ele
nao concede permissao e discovery/check nao executam codigo do app.

## Comandos De Registry

```bash
ravi apps list --json
ravi apps show <app-id> --json
ravi apps check [app-id] --json
ravi apps scaffold <app-id> --name "Nome" --description "Descricao" --json
ravi apps scaffold <app-id> --dry-run --json
ravi apps guide [app-id] --json
ravi apps prompts [app-id] --json
```

Esses comandos gerenciam o registry/manifest. Para operar o app no dia a dia,
prefira sempre:

```bash
ravi <app-id> <operation> --json
```

Use `ravi apps run <app-id> <operation> --json` apenas como fallback/debug
quando houver colisao com comando estatico ou quando estiver testando o router.

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

5. Opere pelo alias do app:

```bash
ravi <app-id> <operation> --json
```

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
- Nao ensine agentes a usar `ravi apps run` como caminho normal do app; use `ravi <app-id> <operation>`.
- Operations com caminho pontuado podem ser chamadas em CLI como tokens separados quando declaradas. Exemplo: `app.test.a` pode ser invocado como `ravi app test a`.
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
