# PR — CRM agent-first

## Objective

Entregar um piloto agent-first dentro do domínio CRM, preservando a
compatibilidade dos comandos existentes enquanto nove mutações passam a ter
planejamento, aprovação externa, aplicação de uso único e leitura de
confirmação.

## Problem

A superfície CRM tinha filtros inválidos tratados como listas vazias, erros de
alvo pouco acionáveis, respostas grandes ou inconsistentes e nenhuma rota
uniforme para um agente planejar e confirmar efeitos. A análise também mostrou
que os freios das mutações legadas e algumas transições de lifecycle ainda não
formam uma política única e executável.

## Solution

- uniformiza validação e erros nas superfícies CRM estudadas;
- publica board paginado, descoberta JSON, lifecycle e schema normativo de
  pipeline;
- adiciona planos persistidos, íntegros e válidos por 15 minutos;
- exige a resposta do transporte de aprovação já existente antes da aplicação;
- aplica uma única vez e registra o journal antes do efeito;
- compara leitura pós-efeito para `task.done`, `task.cancel`, `task.snooze`,
  `opportunity.move`, `fact.confirm`, `fact.reject`, `contact.set`,
  `account.link-contact` e `opportunity.link-contact`;
- publica os contratos derivados em TypeScript, OpenAPI e Swift.

## Practical impact

Agentes que optarem pela fachada podem descobrir o contrato, resolver os alvos
das nove operações, obter um plano revisável e distinguir efeito aplicado, não
aplicado, parcial ou indeterminado. Isso cria uma rota incremental de migração;
não transforma ainda toda mutação CRM em agent-first.

## What does NOT change

- Os comandos CRM legados e suas escritas diretas continuam disponíveis.
- A política de lifecycle publicada não passa a bloquear automaticamente todas
  as transições aceitas pelo armazenamento legado.
- Não há deploy direto na VPS nem alteração de dados de produção nesta PR.
- Os containers `crm-assistant` e `aprovacao-oportunidade-router` não são
  alterados.
- Não é criado outro domínio, outro banco CRM ou um segundo serviço de
  aprovação.

## Validation

Executado após o freeze da implementação:

```text
bun run typecheck                                               PASS
bun run build                                                   PASS
bun test crm/facade/pipeline                                    87 pass
bun test src/approval/service.test.ts                             6 pass
bun run test:sdk                                                74 pass
bun test src/sdk/openapi/emit.test.ts                            23 pass
sdk openapi check (docs/openapi.json e openapi.json)             PASS
sdk swift check                                                 PASS
git diff --check                                                PASS
```

A suíte agregada local alcançou testes fora do CRM, mas não pode ser usada como
gate terminal no Windows: testes preexistentes de Slack e artifacts assumem
separadores de caminho Unix, e a criação de symlink de artifacts exige uma
permissão não disponível neste host. A compilação do SDK Swift também depende do
executável `swift`, ausente localmente; o drift do artefato Swift foi verificado.
O CI Linux permanece como gate da matriz completa.

## Risks

- Consumidores ainda podem contornar a fachada pelos comandos de escrita
  legados; a cobertura agent-first é opt-in durante o piloto.
- A aprovação usa a resposta do transporte existente. A fachada CRM persiste
  o recibo da mensagem e exige o remetente autorizado, mas essa identidade ainda
  depende do transporte e não possui assinatura criptográfica independente.
- Antes do efeito, a fachada relê alvo, transição e referências resolvidas. Essa
  checagem não é um snapshot transacional completo do contexto de negócio; mudanças
  entre a releitura e a escrita continuam como risco residual do piloto.
- `applied` só é registrado quando o readback confirma o efeito esperado; uma
  divergência posterior é exposta por `verify` como `partial`, sem replay
  automático.
- As regras de lifecycle publicadas são política-alvo. As diferenças do
  comportamento legado estão caracterizadas no plano de implementação e não
  devem ser interpretadas como enforcement global.

## Rollback

Reverter os commits desta PR remove comandos, contratos e projeções da fachada
sem retirar os comandos CRM anteriores. As tabelas persistidas pela candidata
podem permanecer inertes para preservar evidência; sua exclusão não é necessária
para restaurar o comportamento anterior. Se o problema aparecer após o merge,
os consumidores devem voltar primeiro às rotas legadas e o deploy deve retornar
ao último commit aprovado da branch `dev`.
