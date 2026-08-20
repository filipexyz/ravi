# Postmortem 0002: pacote Windows publicou launcher CRLF

**Data:** 2026-08-20
**Severidade:** baixa
**Status:** fechado
**Projeto:** RAVI CRM INC-1

## Resumo

O primeiro artefato chegou intacto ao prefixo isolado da VPS, mas o launcher
`bin/ravi` falhou antes do E2E. Producao nao foi alterada.

## Expectativa e resultado

Esperavamos que o tarball preservasse o LF registrado no Git. O checkout tinha
`w/crlf`, e o empacotador preservou esses bytes; Bash encontrou `\r` e encerrou.

## Causa-raiz

O artefato foi montado a partir da working tree Windows sem normalizar o unico
script Bash distribuido no pacote.

## O que funcionou

O gate temporario detectou a incompatibilidade antes da instalacao global, e o
hash confirmou que nao houve corrupcao de transporte.

## Acao

- [x] Normalizar `bin/ravi` para LF antes de reempacotar.
- [ ] Adicionar verificacao de EOL dos launchers ao pipeline de release em slice separado.
