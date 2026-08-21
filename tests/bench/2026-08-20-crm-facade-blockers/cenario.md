# Cenario de fechamento dos gates da facade CRM

## Objetivo

Comprovar os limites de journal e processo da aplicacao e completar a matriz
semantica exigida para as nove operacoes da facade CRM.

## Baseline

A facade possui 48 testes verdes. A baseline cobre normalizacao, aplicacao,
readback, divergencia, estado desconhecido, recheck e idempotencia, mas nao
prova os cenarios abaixo.

## Criterios de aceite

- falha ao persistir o journal depois do claim nao executa o efeito;
- encerramento controlado do processo depois do claim preserva o plano como
  `applying` em banco descartavel;
- cada operacao rejeita um argumento invalido ou um alvo indisponivel antes do
  dispatch;
- omitir `primary` preserva um vinculo primario existente em account e
  opportunity;
- eventos, readback minimo e ausencia de replay continuam comprovados para as
  nove operacoes;
- facade, CLI CRM, identidade, typecheck, build, contratos e SDK permanecem
  verdes.

## Ataque

- provocar erro deterministico no journal;
- matar um subprocesso imediatamente depois de gravar o claim;
- aplicar novamente os dois vinculos sem a flag `primary`;
- usar entradas invalidas especificas de cada operacao;
- repetir as suites focadas e o quality gate completo.

## Limites

Os testes usam mocks ou bancos descartaveis. Nenhuma mutacao sera executada no
banco CRM de producao.
