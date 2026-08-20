# PR — CRM agent-first

## Objetivo

Implementar o comportamento agent-first do CRM no próprio domínio CRM, preservando os comandos atuais durante a migração.

## Validação esperada no CI

```text
bun run build
bun run typecheck
bun run test:cli-commands
bun run test:sdk
bun run sdk:check
git diff --check
```

## Política de execução

Os testes serão escritos, mas não executados localmente neste trabalho. O PR deve mostrar claramente o que foi escrito e deixar o resultado para o CI.

## Não incluído

- deploy direto na VPS;
- alteração de dados de produção;
- alteração dos containers `crm-assistant` e `aprovacao-oportunidade-router`.
