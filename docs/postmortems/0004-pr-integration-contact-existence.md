# Postmortem 0004: preflight da PR nao exigia existencia do contato

**Data:** 2026-08-20
**Severidade:** media
**Status:** fechado
**Projeto:** RAVI CRM INC-1

## Resumo

Ao integrar o hotfix na PR 425, o teste de contato ausente falhou porque o
helper da branch verificava permissao, mas nao existencia, quando o enforcement
global estava desligado. O typecheck tambem detectou um resolver `getCrmFact`
duplicado pelo cherry-pick. Nenhuma alteracao foi enviada ao remoto nesse estado.

## Causa-raiz

O preflight usava apenas `canReadCrmContact`. Sem enforcement, essa funcao
retorna verdadeiro por contrato e nao prova que o alvo existe.

## Acao

- [x] Exigir conjuntamente perfil existente e permissao de leitura.
- [x] Manter o teste de zero chamada ao mutator para contato ausente.
- [x] Alinhar o teste legado de opportunity ao contrato sem `suggestions` em mutacoes.
- [x] Preservar o resolver da facade e remover a copia redundante do hotfix.
