# Postmortem 0003: mutacao opportunity herdou sugestoes amplas

**Data:** 2026-08-20
**Severidade:** media
**Status:** fechado
**Projeto:** RAVI CRM INC-1

## Resumo

O primeiro readback de producao retornou o codigo correto, mas incluiu sugestoes
de opportunities obtidas fora do filtro normal da CLI. O gate de risco bloqueou
o encerramento; nao houve mutacao de dados.

## Expectativa e resultado

Esperavamos reutilizar integralmente o helper de not-found do `show`. Em uma
mutacao, as sugestoes poderiam ampliar a representacao visivel no erro.

## Causa-raiz

O helper combinava contrato de erro e descoberta de candidatos. O teste validava
codigo, acao sugerida e zero escrita, mas ainda nao negava o campo `suggestions`.

## O que funcionou

O readback independente e a revisao de risco detectaram o problema antes da
promocao ser declarada concluida.

## Acao

- [x] Desabilitar sugestoes em `move` e `link-contact` sem alterar `show`.
- [x] Testar explicitamente que o envelope de mutacao nao contem `suggestions`.
