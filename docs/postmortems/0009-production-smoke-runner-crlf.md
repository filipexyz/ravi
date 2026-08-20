# Postmortem 0009: runner de smoke chegou com CRLF na VPS

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI CRM facade

## Resumo

O primeiro smoke no prefixo isolado nao iniciou porque o runner Bash copiado do
checkout Windows tinha CRLF. O pacote candidato instalou corretamente e
producao permaneceu intocada.

## Causa-raiz

O empacotamento ja normalizava o launcher distribuido, mas o mesmo gate de EOL
nao era aplicado aos scripts de bench transferidos separadamente.

## Acao

- [x] Normalizar o runner temporario antes da execucao isolada.
- [x] Preservar o novo runner de smoke da facade com LF.
- [x] Executar o smoke isolado antes da unica instalacao global.

