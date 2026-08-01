---
name: apps
description: |
  Gerencia Ravi Apps. Use quando precisar:
  - Listar, mostrar ou validar manifests de apps
  - Criar scaffold de um novo Ravi App
  - Importar um CLI existente como Ravi App
  - Encaminhar construção ponta a ponta para ravi-dev-app-creator
  - Entender o CLI real, o contexto delegado e as superficies consumidoras de um app
  - Usar operations, storage, events, artifacts, skills e health checks declarados em ravi.app.json
  - Ensinar agentes a operar apps via `ravi <app-id> <operation>`
---

# Ravi Apps

Ravi Apps sao a camada de aplicacoes do Ravi OS.

Um app e um CLI real acompanhado de `ravi.app.json`. O App Router recebe uma
operation, aplica autorizacao, emite um contexto-filho minimo e executa o CLI
diretamente, sem shell.

SDK, UI, tools e automacoes nao sao executores paralelos. Eles sao consumidores
do mesmo App Router e das mesmas operations.

O manifesto e metadata declarativa: nao concede permissao e discovery/check nao
executam codigo do app.

## Comandos De Registry

```bash
ravi apps list --json
ravi apps show <app-id> --json
ravi apps check [app-id] --json
ravi apps scaffold <app-id> --name "Nome" --description "Descricao" --json
ravi apps scaffold <app-id> --dry-run --json
ravi apps import-cli <cli-real> --id <app-id> --dry-run --json
ravi apps delete <app-id> --dry-run --json
ravi apps guide [app-id] --json
ravi apps prompts [app-id] --json
```

Esses comandos gerenciam o registry/manifest. Para operar o app no dia a dia,
prefira sempre:

```bash
ravi <app-id> <operation> --json
```

Use `ravi apps run <app-id> <operation> --json` apenas como superfície
interna/debug quando houver colisao com comando estatico ou quando estiver
testando o router.

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

- `manifest.interfaces.cli`: comando do CLI real que implementa o app.
- `manifest.context.allow`: capacidades Ravi delegadas ao processo filho.
- `manifest.operations`: acoes e snapshots que agentes/UI podem chamar.
- `manifest.permissions`: permissoes do dominio do app; requisitos, nao grants.
- `manifest.storage`: storage que o app possui.
- `manifest.events`: eventos emitidos/consumidos.
- `manifest.skills`: skills que ensinam agentes a operar o app.
- `manifest.health`: checks seguros e nao destrutivos.

5. Opere pelo alias do app:

```bash
ravi <app-id> <operation> --json
```

## Fluxo Para Criar Um App

Carregue primeiro a skill de construção:

```bash
ravi skills show ravi-dev-app-creator --json
ravi specs get apps/builder --mode full --json
```

Ela governa pesquisa do contrato-fonte, desenho do CLI, auth/credentials,
permissions/context, skill grants, decisões de storage/events/artifacts/UI,
testes funcionais e o gate de release. Esta skill de sistema continua sendo a
camada operacional de Apps.

1. Gere um plano sem escrever arquivos:

```bash
ravi apps scaffold <app-id> --dry-run --json
```

2. Para um CLI novo, gere o scaffold:

```bash
ravi apps scaffold <app-id> --name "Nome" --description "O que o app faz" --json
```

Sem `--command`, o scaffold gera um `src/apps/<app-id>/cli.ts` executavel por
`bun cli.ts` e conecta a operation inicial `list` a ele. O resultado ja deve
funcionar por `ravi <app-id> list --json`.

Depois da primeira geracao, esse `cli.ts` e implementacao autoral. Um novo
scaffold com `--force` atualiza os contratos, mas preserva o CLI existente e o
reporta como `preserved`.

Use `--command "<cli-real>"` somente quando o CLI de implementacao ja existir;
nesse modo o scaffold nao gera `cli.ts`.

Para um CLI existente, importe primeiro em dry-run:

```bash
ravi apps import-cli <cli-real> --id <app-id> --dry-run --json
ravi apps import-cli <cli-real> --id <app-id> --json
```

`import-cli` e um gerador de rascunho. Nao prova auth, schemas, segurança,
prontidão funcional nem que todos os subcomandos pertencem à superfície
pública. O resultado retorna a skill de builder e um review checklist
estruturado; complete os dois antes de chamar o app de pronto.

3. Revise os arquivos criados:

- `src/apps/<app-id>/cli.ts` (quando o scaffold criou um CLI novo)
- `src/apps/<app-id>/ravi.app.json`
- `.ravi/specs/apps/<app-id>/SPEC.md`
- `src/plugins/internal/ravi-system/skills/<app-id>/SKILL.md`

4. Rode:

```bash
ravi apps check <app-id> --json
ravi <app-id> list --json
ravi apps guide <app-id> --json
```

5. Implemente ou ajuste o CLI real a partir do entrypoint executavel. Cada
operation de dominio deve usar `interface: "cli"` e um comando tokenizavel;
operations internas do registry podem usar `interface: "builtin"`.

6. Declare `context.allow` com a menor lista possivel. Uma lista vazia e valida
quando o CLI nao precisa chamar outras superficies Ravi.

7. Prove funcionalmente pelo alias público com HTTP/CLI fake. `apps check`
valida o manifesto, mas não prova que a operação de domínio funciona:

```bash
ravi <app-id> <operation> --json
ravi skills inspect <agent-id> --json
```

Se o agent usar allowlist e a skill do app não estiver visível, conceda apenas
essa skill com `ravi skills grant`.

## Lifecycle De Scaffold

Delete somente os artefatos de contrato que o scaffold possui:

```bash
ravi apps delete <app-id> --dry-run --json
ravi apps delete <app-id> --json
```

O delete deve preservar CLI autoral, storage, credenciais e arquivos não
gerados. Sempre faça dry-run primeiro.

## Contrato Do Processo

- O launcher usa `executable + argv` com `shell: false`.
- Novos manifests usam somente `{args}`, no maximo uma vez e como token inteiro.
- O leitor v1 aceita um placeholder nomeado legado, como `{id}`, somente como
  token inteiro, trata-o como `{args}` e emite aviso de migracao.
- Pipes, `;`, `&&`, redirecionamentos, backticks e substituicao de comando sao proibidos.
- O processo roda no diretorio raiz do app.
- O ambiente e allowlisted.
- Quando existe contexto de caller, o processo recebe somente
  `RAVI_CONTEXT_KEY` do contexto-filho, mais metadata `RAVI_APP_*`.
- O processo nao recebe a chave do contexto pai nem identidade legada como
  `RAVI_AGENT_ID` ou `RAVI_SESSION_*`.
- `context.allow` e um pedido de delegacao, nao um grant. Se o pai nao possui a
  capacidade, o router falha antes de iniciar o CLI.
- Manifests v1 ja instalados sem `context` sao lidos com aviso e recebem
  capacidade vazia. Nunca ha heranca implicita; novos manifests devem declarar
  `context.allow`.

Dentro do CLI, use:

```bash
ravi context whoami --json
ravi context check <permission> <object-type> <object-id> --json
ravi context authorize <permission> <object-type> <object-id> --json
```

Para chamar outra superficie do Ravi, o app apenas executa o CLI publico
normal, preservando `process.env`; nao existe um protocolo JSON privado entre o
app e o host. JSON e somente o formato de saida da operacao:

```ts
const child = Bun.spawn(["ravi", "contacts", "list", "--json"], {
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
```

Antes disso, o manifesto deve declarar
`context.allow: ["execute:group:contacts"]`. O app nunca cria, copia ou recebe a
chave pai: o App Router emite `RAVI_CONTEXT_KEY` do contexto-filho. Se o caller
nao puder delegar essa capability, o CLI do app nem chega a iniciar.

Ao importar um grupo `ravi <group>`, o importer pode inferir
`execute:group:<group>`, mas essa lista continua sendo um teto solicitado e
deve ser revisada.

## Regras

- Nao invente comandos. Use apenas operations declaradas.
- Nao trate `import-cli` como app pronto; ele produz um draft para review.
- Nao ensine agentes a usar `ravi apps run` como caminho normal do app; use `ravi <app-id> <operation>`.
- `interfaces.cli.command` deve apontar para o CLI real. Ele nunca deve chamar o
  proprio alias dinamico `ravi <app-id>`, pois isso cria recursao.
- Operations so podem executar `builtin` ou `cli`. Streaming e interatividade
  continuam sendo comportamento do CLI/launcher, nao tipos de executor.
- Operations com caminho pontuado podem ser chamadas em CLI como tokens separados quando declaradas. Exemplo: `app.test.a` pode ser invocado como `ravi app test a`.
- Nao raspe stdout quando houver JSON.
- Nao execute health checks durante discovery.
- Nao use manifesto como grant de permissao.
- Mutacoes precisam de permissao declarada e autorizacao runtime real. Se uma
  app bloquear por permissão recorrente, prefira `ravi permissions resolve
  <denial-id>` ou `ravi permissions allow <profile> --to <subject> --agent
  <agent> --capabilities <cap>`; nao peça `full-access` como caminho normal.
- UI de app e declarativa: routes, views, actions, query e refreshOn. CSS/HTML/JS/bundles ficam fora de `ravi.app/v1`.
- Stateful apps devem declarar storage proprio quando persistencia agrega reuse, lineage, audit ou recovery.
- Apps eventful devem declarar eventos para UIs e agentes observarem sem scraping.

## Specs Relacionadas

```bash
ravi specs get apps/manifest --mode rules --json
ravi specs get apps/router --mode rules --json
ravi specs get apps/cli --mode rules --json
ravi specs get apps/ui --mode rules --json
ravi specs get apps/scaffold --mode rules --json
ravi specs get apps/import-cli --mode rules --json
ravi specs get apps/builder --mode full --json
```
