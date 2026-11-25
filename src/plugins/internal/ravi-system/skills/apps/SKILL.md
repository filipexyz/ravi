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
  - Procurar apps na loja oficial (instalar e liberar sao do operador)
---

# Ravi Apps

> Verbos: AGIR (operação de app) · GUARDAR (storage do app). Compõe com: bases e pages (o app grava linha e publica página pelo CLI público), threads e tasks (quem chama o app define quem age), cron (rotina que chama o app).
> Solução com mais de uma peça? `ravi skills show solucoes` primeiro.

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

### App chamado por agente, thread, task ou cron

- Quem age dentro do app é quem chamou: o app herda o turno de origem. Numa thread, num dispatch de task ou num cron, o app grava em Bases e publica em Pages por quem pediu ou pelo dono (`ravi skills show bases --file references/autoria.md`). Turno de outro agente ou de terceiro sai `ACTOR_UNKNOWN`.
- Se o alias `ravi <app-id> <op>` falhar num turno de agente com `REAL_STATE_ACCESS_REFUSED` (runtime instalado mais antigo), use `ravi apps run <app-id> <op> --execute --json -- <args>`.
- `ravi pages ship --html|--dir` de dentro do app precisa de `use:tool:Read` no `context.allow`. Prefira passar o conteúdo com `--body` (sem leitura de arquivo), que não pede essa permissão.
- Operação que faz mais de um ship ou upload pode passar de 25 s e virar job destacado. Confira o resultado por uma operação de leitura do próprio app (ex.: `list --json`), sem repetir a escrita.

## Loja De Apps

Apps de terceiros chegam pela loja oficial (indice assinado em
`filipexyz/ravi-apps`). Instalar e liberar sao decisoes do operador, no
terminal dele; de um turno de agente esses comandos saem `APP_STORE_OPERATOR_ONLY`
(exit 3). O agente pode procurar e conferir:

```bash
ravi apps search [texto] --json
ravi apps verify [app-id] --json
```

O operador instala e escolhe quem ve:

```bash
ravi apps install <app-id>                 # plano, exit 3
ravi apps install <app-id> --execute
ravi apps allow <app-id> --agent <agent> --execute
```

- App instalado pela loja fica invisivel para todo agente ate `apps allow`,
  mesmo com `full-access` ou `use:app:*`. Se um app da loja "sumiu", peca ao
  operador para rodar `ravi apps verify` e `ravi apps allow`.
- O indice so aceita apps `compose`: todo comando e o proprio `ravi`, e o
  codigo do app roda como operacao `script` no sandbox (QuickJS em
  WebAssembly, sem disco, rede, ambiente ou processos). O app nunca faz mais
  que o agente que chama ja pode; a permissao do comando de baixo (ex.:
  `pages ship`) continua sendo do agente.
- Operacao `script` com `input.dir` (ex.: `--posts posts`) le so uma pasta
  dentro do seu diretorio de trabalho, sem links simbolicos. Erros
  `APP_SCRIPT_*` dizem o que corrigir.
- Nao copie pastas para `~/.ravi/apps`: depois que a loja e usada, pasta sem
  recibo nao carrega. Ferramentas de escrita de arquivo do agente tambem nao
  escrevem ali.

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

## Composicao De Apps

Um app pode oferecer um servico a outros apps (`provides`) e declarar os
servicos de que precisa (`requires`). E um contrato do manifesto, mediado pelo
App Router. Nao existe protocolo entre apps: o consumidor chama o provedor pelo
CLI publico, `ravi <provedor> <operacao>`, com a chave do proprio contexto-filho.

```json
{ "id": "md-render",
  "provides": { "md-render/html": { "version": "1.0.0", "operations": ["md-render.html"] } },
  "context": { "allow": ["execute:group:pages"] } }
```

```json
{ "id": "blog",
  "requires": { "md-render/html": "^1" },
  "context": { "allow": ["execute:group:pages"] } }
```

- A chave do servico e `<app-id>/<servico>` e comeca pelo id de quem oferece.
  `provides` guarda uma versao exata `x.y.z` e as operacoes oferecidas: so elas
  podem ser chamadas por outros apps. `requires` guarda uma faixa simples
  (`^1`, `~1.2`, `1.4.0`, `>=1.2.0 <2`); texto que nao e faixa e erro de
  validacao.
- Quem requer declara, no proprio `context.allow`, tudo o que o provedor
  declara no dele (entradas explicitas, sem curinga). O contexto do provedor
  nasce do contexto do consumidor, entao a autoridade so estreita: provedor
  dentro do consumidor, consumidor dentro de quem invocou. O consumidor recebe,
  sem declarar, `use app:<provedor>` e o acesso a `apps run` do invocador, e
  tambem `execute app:<provedor>` quando um servico requerido oferece uma
  operacao mutante. O invocador precisa ter tudo isso (o `use app:<provedor>`
  de cada provedor do fecho, o `execute` quando couber e o `apps run`), ou o
  consumidor nem sobe. Invocador que so tem o grupo legado
  `execute:group:apps` nao leva consumidor composto.
- Antes de subir qualquer processo, o router recusa o app cujo provedor nao
  serve: `APP_DEPENDENCY_UNAVAILABLE`, com o motivo `not_installed`, `invalid`,
  `not_provided`, `version_mismatch` ou `insufficient_authority` (o provedor
  pede mais do que o consumidor declara; a lista do que falta vem junto).
  Quando o provedor volta, o app roda de novo sem mudar. `ravi <app-id> check
  --json` mostra o mesmo motivo como aviso.
- Quando o app chamado oferece servicos, o app que chama uma operacao fora de
  `provides`, ou de um servico que nao declarou em `requires`, recebe
  `APP_OPERATION_NOT_PROVIDED`. Vale tambem para credencial que o app derivou
  para si e para linhagem que nao se consegue seguir ate a raiz. Quem chama
  direto (turno, agente, operador) continua valendo por `use app:<id>` (e
  `execute app:<id>` nas operacoes mutantes): `provides` e o que os apps podem
  chamar uns dos outros, nao uma segunda permissao para quem ja tem o app. App
  chamado que nao declara `provides` mantem a regra de antes: quem tem
  `use app:<id>` (e `execute app:<id>` nas mutantes) o chama; nao ha servico
  para citar em `requires`, nem checagem de linhagem.
- Ciclo de `requires` e erro de validacao (`requires cycle: a -> b -> a.`).
  Provedor que nao esta instalado ainda nao invalida o consumidor: vira aviso,
  e quem barra e a execucao.
- A credencial de um app que oferece ou precisa de servico e revogada, com as
  descendentes, quando o processo termina. Se a revogacao falhar, o resultado
  da execucao nao muda, o `apps-router` registra o aviso "Could not revoke the
  app child context at the end of its operation" e a credencial vive ate o TTL.
  App que nao participa de composicao mantem a credencial ate o TTL, como
  antes.
- O audit ve a linhagem turno -> `app:<consumidor>` -> `app:<provedor>`, e o
  contexto do provedor registra o servico e o consumidor em
  `metadata.composition`.

Ao mudar um provedor: suba a versao maior quando uma operacao oferecida muda de
um jeito que um chamador perceberia, e saiba que pedir mais em `context.allow`
quebra os consumidores ate eles declararem. Ao adotar `provides` num app que ja
e chamado por outros, avise-os antes: passam a ser recusados ate declarar
`requires`.

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
- Para chamar de dentro de um app um app que oferece servicos (`provides`), declare `requires` e cubra, no proprio `context.allow`, o que o provedor declara no dele; sem isso o router recusa. Um app que nao declara `provides` segue a regra de antes (so a permissao, `use app:<id>` e `execute app:<id>` nas mutantes), e nao ha o que declarar em `requires`.
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
