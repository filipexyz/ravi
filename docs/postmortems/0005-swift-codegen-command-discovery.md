# Postmortem 0005: subcomando Swift inferido incorretamente

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI CRM facade

## Resumo

A primeira tentativa de regenerar o SDK Swift usou `sdk swift emit`, mas a CLI
publica `generate` e `check`. Nenhum arquivo foi alterado pelo comando invalido.

## Causa-raiz

O nome foi inferido a partir do comando OpenAPI em vez de descoberto pelo help
da superficie Swift.

## Acao

- [x] Consultar `ravi sdk swift --help`.
- [x] Usar `ravi sdk swift generate` e validar com `check`.
