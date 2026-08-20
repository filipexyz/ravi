# PR — CRM agent-first

## Objetivo

Implementar o comportamento agent-first do CRM no próprio domínio CRM, preservando os comandos atuais durante a migração.

## Entrega

- erros tipados e validação uniforme nas superfícies CRM;
- board paginado, descoberta JSON e lifecycle publicado;
- schema de pipeline normativo com review derivado;
- fachada `plan → approve → apply → verify/recover` persistente, de uso único,
  com verificação de integridade, journal antes do efeito e readback;
- contratos TypeScript, OpenAPI e Swift regenerados.

## Validação executada

```text
bun run typecheck                                               PASS
bun run build                                                   PASS
bun test crm/facade/pipeline                                    79 pass
bun run test:sdk                                                73 pass
bun run sdk:check                                               PASS
sdk openapi check (docs/openapi.json e openapi.json)             PASS
sdk swift check                                                 PASS
git diff --check                                                PASS
```

`bun run test:cli-commands` usa um `for` POSIX e não é executável diretamente
no PowerShell. A execução equivalente avançou até um teste preexistente de
autodescrição de apps dependente do ambiente. O CI Linux continua sendo o gate
da matriz completa de comandos.

## Validação esperada no CI

```text
bun run build
bun run typecheck
bun run test:cli-commands
bun run test:sdk
bun run sdk:check
git diff --check
```

## Limites da migração

- Os comandos CRM legados continuam disponíveis para compatibilidade. Esta PR
  protege a rota da fachada; a retirada de escrita bruta exige migração e
  telemetria dos consumidores.
- A aprovação usa o transporte externo já existente no Ravi. O domínio CRM
  persiste o hash, destino e instante recebidos, mas não inventa um segundo
  serviço de aprovação.

## Não incluído

- deploy direto na VPS;
- alteração de dados de produção;
- alteração dos containers `crm-assistant` e `aprovacao-oportunidade-router`.
