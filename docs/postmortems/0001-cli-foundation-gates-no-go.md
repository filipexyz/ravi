# Postmortem 0001: fundação CLI bloqueada pelos gates finais

**Data:** 2026-08-21  
**Severidade:** média  
**Status:** aberto  
**Projeto:** Ravi

## Resumo

A primeira candidata da fundação agent-first passou nos testes focados, mas foi
corretamente classificada como NO-GO pela revisão independente. Gates oficiais
excederam limites de tempo e a Ravi Spec declarava cobertura mais ampla do que a
migração realmente entregava.

## Hipótese / Expectativa

Esperávamos que os testes focados, build, typecheck e quality gate fossem
suficientes para apresentar a candidata aos gates oficiais sem nova regressão.

## O que aconteceu de fato

O gate `test:agent-contract` ficou instável ao carregar o catálogo completo em
um teste pequeno. O gate do SDK também excedeu seu limite de tempo. A auditoria
ainda encontrou campos estritos migrados somente em `agents`, mutações reais
ainda não classificadas e caminhos de encerramento fora da nova fronteira.

## Causa-raiz

O recorte foi validado por mecanismo, mas a declaração normativa foi escrita
como estado final do programa. Além disso, o custo de inicialização global não
foi medido nos gates que executam o catálogo completo em máquina sem aquecimento.

## O que foi bem

O revisor foi independente, executou os gates oficiais e bloqueou a candidata
antes de commit, push, PR ou VPS. O empacotamento e os testes de saída também
produziram evidência útil sem criar bancada externa.

## O que foi mal

Os dois testes centrais novos não estavam listados em `CHECKS.md`, a spec foi
marcada como ativa cedo demais e a execução local inicial não incluiu o gate do
SDK.

## Lições aprendidas

Uma fundação de migração deve declarar explicitamente o que já é obrigatório e
o que ainda é legado. Testes pequenos não devem pagar inicialização global
desnecessária, e os gates oficiais precisam rodar antes da promoção documental.

## Ações

- [ ] Remover inicialização global desnecessária dos testes e repetir os gates oficiais — Codex — imediato
- [ ] Tornar a Ravi Spec fiel ao recorte migrado e adicionar os testes centrais ao `CHECKS.md` — Codex — imediato
- [ ] Documentar exceções de encerramento e a quebra deliberada de paginação — Codex — antes do PR
- [ ] Reexecutar revisão independente após todos os gates aplicáveis — Codex — antes de commit e push

## Nota de revisão — 2026-08-21

O `sdk:check` não possuía cinco diferenças de conteúdo: quatro arquivos eram
idênticos após normalizar CRLF/LF, e o quinto diferia adicionalmente apenas no
`GIT_SHA`, que o comparador já trata como informativo. O check comparava bytes
de checkout e foi corrigido para ignorar somente finais de linha, mantendo uma
prova explícita de que qualquer mudança real de fonte continua falhando.

## Nota de revisão — 2026-08-21 (portão local)

A primeira repetição local do quality gate usou a base padrão `main`, embora o
PR tenha `dev` como base, e foi descartada. A segunda tentativa também foi
descartada porque o PowerShell agrupou a lista de arquivos como dois objetos.
A execução aceita passou a fornecer uma lista plana do estado de trabalho,
removeu o cabeçalho informativo do `rtk` e mostrou nominalmente os 34 caminhos
reais antes de aprovar spec e cobertura. Quality gates que sincronizam o índice
de specs também não devem rodar em paralelo no mesmo estado local.

## Nota de revisão — 2026-08-21 (segunda revisão independente)

A segunda revisão manteve o estado **NO-GO** ao encontrar uma emissão NATS sem
a guarda de supressão no caminho de permissão negada, uma máscara de
`GIT_SHA` ampla o bastante para ocultar conteúdo adicional na mesma linha e
duas divergências entre a Ravi Spec e o comportamento implementado. A correção
passou a guardar também a negação, adicionou prova de zero emissão para chamadas
permitidas e negadas, restringiu a máscara ao literal JSON da constante e
incluiu uma prova de drift na própria linha. A taxonomia reserva exit `3` para
bloqueios seguros e o runbook deixou de prometer `acceptedFields` no manifesto.
Uma terceira revisão independente continua obrigatória antes de qualquer
commit, push ou PR.

## Nota de revisão — 2026-08-21 (terceira revisão independente)

A terceira revisão emitiu **GO** para commit e abertura da PR. Foram confirmadas
as guardas NATS nos dois caminhos, a prova de drift na linha de `GIT_SHA`, a
taxonomia normativa e a propagação dos metadados de segurança até o runtime. O
pacote aprovado tem SHA-256
`581CA4862028E0A91C5025B9AE575188F8E16C1AA857731088F13DE436DF4B75` e
foi instalado em diretório vazio. As duas falhas de artifacts no Windows
continuam registradas como dívida reproduzida igualmente na base; CI Linux no
commit exato permanece obrigatória antes de merge ou VPS.

O primeiro commit foi bloqueado pelo hook porque 18 arquivos TypeScript
mantinham CRLF no worktree do Windows e o Biome exige LF. Nenhum commit foi
criado. A correção é mecânica e limitada aos arquivos TypeScript já revisados;
o hook, typecheck e os testes focados devem ser repetidos após a normalização.

Na primeira normalização, o Biome também identificou a constante antiga
`GIT_SHA_MASK` sem uso depois que a máscara passou a preservar prefixo e
sufixo da declaração. A constante foi removida; o algoritmo e sua prova
permanecem inalterados.

## Nota de revisão — 2026-08-21 (pré-envio no Windows)

O primeiro `git push` foi interrompido porque o hook completo permaneceu sem
progresso visível em `bun test src/channels/`. A interrupção encerrou o processo
Git, mas deixou dois processos Bun filhos órfãos, que continuaram consumindo CPU
e disputando os bancos temporários das reproduções seguintes. Os dois processos
foram identificados pelo comando e horário de criação e encerrados de forma
direcionada; nenhum arquivo ou estado do produto foi removido.

Em ambiente limpo, o teste filtrado de timeout do `auth.test` terminou da mesma
forma na candidata e na `dev`: o setup isolado excedeu o limite de 5 segundos.
A suíte completa também demonstrou flutuação na própria `dev`: uma execução
terminou em 57 segundos com somente a falha Windows de separador no caminho de
áudio; outra permaneceu no teste de timeout sem avançar. A candidata terminou
quando executada sem os processos órfãos, mas acumulou timeouts de setup sob a
carga local. O comportamento não foi atribuído à fundação e o hook local não é
registrado como aprovado.

A publicação deve usar o commit já aprovado pelos gates focados e pela revisão
independente, com o hook local explicitamente dispensado apenas para acionar a
CI Linux. Merge, pacote promovido e VPS continuam bloqueados até a CI do SHA
exato concluir todos os jobs obrigatórios.

## Nota de revisão — 2026-08-21 (espera de saída sem limite)

A investigação independente do congelamento descartou regressão no Slack, mas
encontrou um bloqueador real na nova fronteira de saída: enquanto o Bun
mantivesse `writableLength` ou `writableNeedDrain`, o código repetia
`setImmediate` sem prazo máximo. Um indicador preso poderia consumir CPU e
impedir o encerramento indefinidamente. A descarga adicional no `finally` da
CLI repetia a mesma exposição.

A correção troca a repetição por verificações espaçadas, com limite de cinco
segundos, remove a segunda descarga e garante `process.exit` em `finally`. O
teste nativo agora prova o limite com um stream permanentemente preso e mata,
observa e rejeita um processo-filho que ultrapassa seu próprio prazo. Assim, o
caminho normal continua comprovando saída integral, enquanto uma anomalia do
stream não cria laço de CPU nem processo órfão.

## Nota de revisão — 2026-08-21 (observação do processo-filho)

A revisão independente da correção manteve **NO-GO** porque o helper nativo
rejeitava imediatamente quando o primeiro `child.kill()` retornava falso, sem
aguardar o evento `close`. Isso contrariava a exigência recém-documentada de
matar e observar o filho antes de concluir. O ledger também permanecia na prova
anterior de 22 testes e 91 asserções, embora o HEAD já contivesse 23 testes e 93
asserções.

O helper agora solicita encerramento no prazo principal, escala para `SIGKILL`
depois de 250 ms e só resolve ou rejeita o timeout quando observa `close`.
Erros de sinalização após o timeout também aguardam esse fechamento. O ledger
foi alinhado à evidência final; nova execução e nova revisão do SHA exato
continuam obrigatórias.
