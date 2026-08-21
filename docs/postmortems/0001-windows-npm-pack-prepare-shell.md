# Postmortem 0001: npm pack acionou prepare POSIX no Windows

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI CRM INC-1

## Resumo

O primeiro empacotamento local falhou antes de criar o artefato. Nao houve
impacto em codigo, dados ou producao; o pacote foi gerado em seguida com
`bun pm pack --ignore-scripts`.

## Expectativa e resultado

Esperavamos que `npm pack --ignore-scripts` ignorasse todos os lifecycles. O npm
executou `prepare`, cujo comando usa `2>/dev/null || true`; sob `cmd.exe`, essa
sintaxe falhou.

## Causa-raiz

O script `prepare` e portavel em shell POSIX, mas nao em `cmd.exe`, e o npm nao
aplicou `--ignore-scripts` ao lifecycle observado neste fluxo de pack.

## O que funcionou

O build completo ja estava verde e o empacotador nativo do Bun oferece uma
opcao efetiva para ignorar scripts sem alterar o projeto.

## Acao

- [x] Usar `bun pm pack --ignore-scripts --destination <dir>` neste rollout.
- [ ] Tratar portabilidade do script `prepare` em slice separado do INC-1.
