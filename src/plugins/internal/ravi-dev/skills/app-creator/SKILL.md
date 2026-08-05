---
name: app-creator
description: >-
  Constrói Ravi Apps ponta a ponta a partir de documentação de API pública,
  um CLI existente ou uma nova capacidade de domínio. Use quando precisar
  pesquisar o contrato-fonte, desenhar o CLI real, criar ou importar o
  ravi.app.json, integrar credenciais e contexto-filho, classificar permissões,
  decidir storage/eventos/artifacts/UI, criar a skill operacional e provar a
  aplicação com testes funcionais. Não use para apenas listar, inspecionar ou
  operar um app existente; nesse caso use ravi-system-apps.
---

# Ravi App Creator

Um Ravi App é um CLI real mais um `ravi.app.json`. O App Router autoriza a
operação, emite um contexto-filho mínimo e lança o CLI sem shell. O app fala com
o restante do Ravi chamando comandos públicos `ravi ...` sob esse contexto.
Não existe protocolo JSON privado entre app e host; `--json` é o contrato de
saída legível por agentes, UI e automações.

## Comece Pelo Contrato

Antes de alterar código:

```bash
ravi specs get apps/builder --mode full --json
ravi apps guide --json
ravi skills show ravi-dev-cli-creator --json
ravi skills show ravi-dev-context-cli --json
```

Leia também [references/review-checklist.md](references/review-checklist.md).
Para testar se o método é independente de domínio, use os dois briefs de
[references/acceptance-cases.md](references/acceptance-cases.md).

## Entradas Aceitas

- documentação oficial de uma API;
- um CLI que já possui contrato estável;
- uma capacidade nova cujo CLI ainda será criado.

Se a fonte for API, registre URLs oficiais, autenticação, recursos, métodos,
paginação, limites e envelope de erro antes de escrever operações. Se a fonte
for CLI, capture `manifest --json`, o registry decorado ou, como último recurso,
o help humano.

## Fluxo Canônico

### 1. Defina o produto

Escreva em uma frase o problema do operador e o usuário-alvo. Monte uma matriz
de operações com:

- nome público;
- recurso/endpoint ou comando-fonte;
- read, sensitive-read, write ou destructive;
- entrada e saída estáveis;
- paginação;
- idempotência;
- falhas esperadas;
- prova funcional.

Não publique cada endpoint ou subcomando automaticamente. Um app expõe o fluxo
útil e seguro; comandos raros, interativos, streaming ou de diagnóstico podem
continuar CLI-only.

### 2. Escolha o CLI real

Para um CLI novo:

```bash
ravi apps scaffold <app-id> --dry-run --json
ravi apps scaffold <app-id> --name "Nome" --description "Resultado" --json
```

O default cria `src/apps/<app-id>/cli.ts` e usa `bun cli.ts` como
`interfaces.cli.command`.

Para um CLI existente:

```bash
ravi apps import-cli "<cli-real>" --id <app-id> --dry-run --json
```

`import-cli` é somente um gerador de rascunho. Ele não prova auth, segurança,
qualidade dos schemas nem prontidão funcional. Revise todos os candidatos antes
de escrever:

```bash
ravi apps import-cli "<cli-real>" --id <app-id> --json
```

`interfaces.cli.command` aponta para a implementação real. Nunca aponte para o
alias público `ravi <app-id>`, pois o CLI reentraria no App Router.

### 3. Implemente o contrato agent-first

Cada operação pública deve ter:

- argumentos explícitos e limites;
- `--json` com forma estável;
- stdout reservado ao dado e stderr a diagnóstico;
- exit `0` para sucesso e não zero para falha;
- erro tipado e sanitizado;
- cursor/offset preservado quando a fonte pagina;
- timeout e retry limitados;
- comportamento de idempotência documentado.

Não execute declarations por shell. Use executable + argv e trate argumentos do
usuário como dados literais.

### 4. Modele autenticação sem expor segredos

Escolha uma destas fronteiras:

- provider client first-party resolve a conexão dentro do broker Ravi;
- connector gerenciado executa OAuth e entrega apenas a ação autorizada;
- adapter de credential broker específico do provider executa a chamada.

Nunca coloque token, refresh token, client secret, secret ref/path ou credencial
serializada no manifesto, argv, stdout, evento, spec ou skill. Health local pode
inspecionar metadata da conexão, mas não deve afirmar autenticação externa sem
uma prova externa separada.

O teste mínimo de auth deve provar que credencial ausente ou desabilitada falha
antes de `fetch`, sem vazar a causa interna do backend.

### 5. Separe permissão do app e capacidade do processo

- `manifest.permissions` descreve requisitos do caller e mutações.
- `manifest.context.allow` limita quais superfícies Ravi o CLI filho pode
  chamar.
- nenhum dos dois é grant.

Use o menor teto possível em `context.allow`; lista vazia é válida. Quando o app
chamar outra superfície, preserve `process.env` e use o CLI público:

```ts
const child = Bun.spawn(["ravi", "artifacts", "create", "--json"], {
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
```

Declare a capacidade necessária e prove que o router falha antes do spawn
quando o pai não pode delegá-la. Para um denial recorrente, prefira
`ravi permissions resolve <denial-id>` ou um profile estreito; não use
`full-access` como solução normal.

### 6. Decida as superfícies opcionais

Responda sim ou não, com justificativa:

- storage: cria reuse, lineage, audit, cache caro ou recovery?
- events: outro agente/UI precisa reagir sem scraping?
- artifacts: existe saída durável com provenance?
- UI semântica: há fluxo recorrente que merece route/view/action?

Ausência explícita é melhor que infraestrutura sem necessidade. UI, SDK,
tools e automações continuam clientes das mesmas operações do App Router.

### 7. Crie a skill operacional

O scaffold gera uma skill de domínio. Ajuste-a para ensinar:

- quando usar o app;
- como inspecionar e validar;
- operações públicas e outputs;
- riscos de mutação;
- falhas que exigem intervenção;
- health/readiness.

Depois confirme a visibilidade do agent:

```bash
ravi skills show <app-skill> --json
ravi skills inspect <agent-id> --json
```

Se o agent tiver allowlist e a skill não estiver visível, conceda somente a
skill necessária com `ravi skills grant <agent-id> <app-skill>`.

### 8. Prove o comportamento

Teste em camadas:

1. client com credencial injetada e HTTP fake;
2. CLI real com JSON, erro, paginação e mutações simuladas;
3. manifesto com `ravi apps check`;
4. operação pelo alias público `ravi <app-id> <operation> --json`;
5. router com contexto-filho e capability negada/permitida;
6. skill/specs e contratos gerados;
7. suíte completa.

Um teste de manifesto não torna o app funcional. Pelo menos uma operação real
deve atravessar o alias público até o client fake. Mutações e chamadas externas
reais só acontecem quando o usuário as autorizar explicitamente.

## Gate De Prontidão

Só chame o app de pronto quando:

- o CLI implementa as operações públicas;
- auth e secrets estão atrás de uma fronteira Ravi;
- permission e `context.allow` falham fechado;
- a skill está indexada ou explicitamente concedida;
- `ravi apps check <app-id> --json` passa;
- uma operação pelo alias público passa funcionalmente;
- erros e ausência de credencial foram exercitados;
- specs, schemas, SDK/OpenAPI e testes não apresentam drift.

Use o checklist estruturado retornado por `ravi apps scaffold ... --json` ou
`ravi apps import-cli ... --json`; ele é parte do contrato de geração.

## Comandos Finais

```bash
ravi apps show <app-id> --json
ravi apps check <app-id> --json
ravi <app-id> <operation> --json
ravi apps guide <app-id> --json
ravi specs get apps/<app-id> --mode full --json
```

`ravi apps run <app-id> <operation>` é diagnóstico interno do router. O caminho
normal do produto é `ravi <app-id> <operation>`.
