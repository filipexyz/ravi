# Postmortem 0008: toolchain Swift indisponivel no Windows

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI CRM facade

## Resumo

O gate `test:swift-sdk` nao iniciou porque o executavel `swift` nao esta
instalado no ambiente Windows desta sessao. O check deterministico dos fontes
gerados do SDK Swift passou e nenhuma mudanca de assinatura foi introduzida.

## Causa-raiz

O repositorio publica o gate sem declarar o toolchain Swift como pre-requisito
do ambiente local. A compilacao permanece coberta pelo CI que fornece esse
toolchain.

## Acao

- [x] Executar `sdk swift check` para provar ausencia de drift gerado.
- [x] Manter `test:swift-sdk` como gate obrigatorio no CI da PR.
- [x] Nao instalar toolchain ad hoc no host de desenvolvimento durante o
  rollout de CRM.

