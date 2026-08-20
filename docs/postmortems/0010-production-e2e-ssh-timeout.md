# Postmortem 0010: sessao SSH encerrou durante E2E combinado

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI CRM facade

## Resumo

A primeira execucao combinada dos dois smokes pos-instalacao perdeu a sessao
SSH antes de devolver stdout. O bundle permaneceu ativo, nao havia runner orfao
e os dois bancos descartaveis foram criados.

## Causa-raiz

O transporte agrupou duas execucoes com inicializacao completa do runtime sem
um timeout externo por smoke. A desconexao tornou o resultado ambiguo, embora
nao tenha afetado dados de producao.

## Acao

- [x] Reconciliar processos, hashes e diretorios descartaveis antes de repetir.
- [x] Executar cada smoke separadamente com `timeout 120`.
- [x] Confirmar ambos os resultados e uma leitura real de producao.

