# Postmortem 0007: gate agent-contract nao portavel no Windows

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI

## Resumo

O gate `test:agent-contract` falhou em dois cenarios de artifact store no
Windows. Um assert exigia separadores Unix e o teste de link simbolico exigia
um privilegio que nao faz parte do ambiente padrao. A implementacao testada nao
falhou.

## Causa-raiz

A suite codificava detalhes do ambiente Linux em vez de expressar o contrato
portavel: o blob deve estar sob `artifacts/blobs` e pacotes nao podem atravessar
links do sistema de arquivos.

## Acao

- [x] Construir o fragmento esperado com `node:path`.
- [x] Usar junction de diretorio no Windows e symlink de diretorio nos demais
  sistemas para exercer a mesma protecao.
- [x] Reexecutar a suite isolada e o gate agent-first completo.

