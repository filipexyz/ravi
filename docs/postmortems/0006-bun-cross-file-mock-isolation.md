# Postmortem 0006: isolamento de mocks entre arquivos no Bun

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI CRM facade

## Resumo

Uma execucao conjunta de tres arquivos de teste falhou porque os usos de
`mock.module` em suites diferentes compartilham o mesmo processo Bun. As mesmas
suites passam isoladamente, como executadas pelos scripts oficiais do projeto.
Nenhum comportamento de producao falhou.

## Causa-raiz

O comando ad hoc agrupou suites com substituicoes globais e incompatíveis dos
mesmos modulos. Restaurar os mocks ao fim de cada arquivo nao elimina a disputa
quando os arquivos sao carregados concorrentemente no mesmo processo.

## Acao

- [x] Validar cada suite em processo separado.
- [x] Manter os gates oficiais que isolam os arquivos de comando.
- [x] Registrar que suites com `mock.module` concorrente nao devem ser agrupadas
  em um unico comando ad hoc.

