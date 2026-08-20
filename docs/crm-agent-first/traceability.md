# Rastreabilidade — CRM agent-first

Este documento separa código entregue de comportamento ainda projetado. A
candidata é um piloto incremental com nove operações; comandos de escrita
legados continuam disponíveis e não passam pela fachada automaticamente.

## Vocabulário de estado

- `implemented`: o comportamento descrito tem código na candidata; seu nível de
  teste é registrado separadamente e não implica aprovação do CI ou produção;
- `partial`: somente a parte descrita do requisito foi implementada;
- `projected`: permanece como política-alvo para uma próxima etapa;
- `ci-pending`: a evidência local existe, mas o gate oficial ainda é o PR.

## Incrementos originados no diagnóstico

| Fonte da análise | Estado | Entrega na candidata | Limite da evidência |
|---|---|---|---|
| RT-F1, INC-1 | `implemented` | alvo inexistente em mutações mapeado para erro específico | CI pendente; não elimina bypass legado fora dos caminhos alterados |
| RT-F2/RT-F3, INC-2 | `implemented` | enum, data e intervalo inválidos são rejeitados nas superfícies tratadas | não cria um interpretador de filtros em linguagem natural |
| RT-F4/RT-F10, INC-3 | `implemented` | mensagens, paths de metadata e ajuda acionáveis | recuperação de pipeline continua fora das nove operações |
| RT-F5–RT-F8, INC-4 | `partial` | paginação e descoberta JSON; aliases preservam compatibilidade | payload único depende da migração dos consumidores dos aliases legados |
| RT-F9/G-12, INC-5 | `partial` | schema normativo, relatório derivado e lifecycle publicados | a política de lifecycle não é enforcement global das mutações legadas |
| RT-F11/CL-7 | `partial` | journal, uso único, resultado incerto e readback na fachada | sem bancada viva; cobertura restrita às nove operações e ao transporte atual |

## Requisitos U-01 a U-17

| Requisito | Estado | Cobertura real nesta candidata | Limite ou próxima etapa |
|---|---|---|---|
| U-01 | `implemented` | resolve alvo primário antes de planejar as nove operações | não cobre entidades e mutações fora do piloto |
| U-02 | `partial` | alvo inexistente bloqueia o plano com código específico | sugestões e causa acionável não são uniformes em toda escrita legada |
| U-03 | `projected` | — | não há fluxo de candidatos nem pergunta de desambiguação |
| U-04 | `projected` | — | a CLI recebe flags explícitas; não consolida escolhas em uma pergunta |
| U-05 | `projected` | — | defaults materiais da intenção ainda não são resolvidos pela fachada |
| U-06 | `projected` | — | expansão de autoridade ainda não tem classificador próprio |
| U-07 | `implemented` | plano persistido com hash, expiração e efeito declarado | somente para as nove operações |
| U-08 | `partial` | hash, expiração, recibo durável da mensagem e resposta do remetente autorizado são vinculados antes do consumo único | a identidade vem do transporte existente; não há recibo com assinatura criptográfica independente |
| U-09 | `partial` | as nove operações usam `planned → approved → applying` | demais mutações e comandos crus continuam fora da fachada |
| U-10 | `implemented` | alvo e referências de stage, contato e conta são resolvidos antes do plano | somente as referências usadas pelas nove operações |
| U-11 | `partial` | erros da fachada usam códigos e envelopes JSON/texto | ação corretiva e causa não estão completas para toda falha e todo comando legado |
| U-12 | `partial` | filtros alterados validam enum, data e intervalo antes da consulta | a fachada não traduz intenções de listagem nem cobre toda futura opção de filtro |
| U-13 | `partial` | falha durante aplicação vira `unknown` e bloqueia reaplicação | timeout e falha pós-commit ainda precisam de exercício adverso em ambiente controlado |
| U-14 | `implemented` | as nove operações têm leitura pós-efeito comparada ao plano | o CI e o rollout controlado ainda precisam validar integrações reais |
| U-15 | `partial` | alvo, transição e referências resolvidas são relidos imediatamente antes de reivindicar o efeito | não existe snapshot geral de todo contexto de negócio nem bloqueio transacional entre a releitura e a escrita |
| U-16 | `partial` | descoberta JSON, paginação, schemas e lifecycle são publicados com escopo `facade-only` | a FSM publicada ainda diverge de transições aceitas pelo legado |
| U-17 | `projected` | — | ambiguidades materiais devem ser resolvidas pelo chamador antes de `plan` |

## Evidência disponível

- suíte CRM local: 79 testes aprovados;
- suíte SDK local: 73 testes aprovados;
- build, typecheck, checks de OpenAPI, Swift, SDK e whitespace: aprovados
  localmente;
- matriz completa de comandos: `ci-pending`;
- comportamento do transporte e das mutações reais em ambiente controlado:
  ainda não promovido a evidência de produção.

## Rollout e consumidores

1. O PR valida a candidata sem alterar a VPS.
2. Depois do merge, consumidores selecionados passam a chamar a fachada apenas
   para as nove operações.
3. Leituras e contratos são observados antes de habilitar essas mutações no Ravi
   do projeto.
4. Escritas cruas permanecem compatíveis e são medidas como bypass; sua retirada
   exige migração própria.
5. Os requisitos `partial` e `projected` orientam extensões futuras, não são
   condição implicitamente satisfeita por esta PR.

Consumidores afetados incluem o registro de comandos e gateway, SDK TypeScript,
OpenAPI, SDK Swift, `contacts profile --include-crm`, agentes que optarem pela
fachada e scripts que dependem dos aliases preservados.
