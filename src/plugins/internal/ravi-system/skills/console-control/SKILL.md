---
name: ravi-system-console-control
description: |
  Opera o Ravi App Console Backoffice / Control. Use quando precisar:
  - Controlar ou diagnosticar usuarios e organizacoes do Ravi Console
  - Inspecionar feature access, entitlements e acesso interno do Console
  - Diagnosticar acesso ao Ravi Console
  - Inspecionar identidade CLI, projetos, Pages e audit pelo contrato declarado
  - Entender o manifesto interno console/control
  - Preparar operacoes de suporte que exigem autorizacao do Console
---

# Console Backoffice

Console Backoffice e o app operacional interno para suporte, controle de usuarios, backoffice de organizacoes, feature access e diagnostico do Ravi Console.

Ele nao concede permissoes sozinho. O manifesto declara requisitos; a autorizacao real fica no Console e nas permissoes runtime.

## Fluxo Canonico

1. Comece pelo manifesto:

```bash
ravi apps show console/control --json
```

2. Valide antes de operar:

```bash
ravi apps check console/control --json
ravi apps run console/control check --json
```

3. Use apenas operations declaradas:

```bash
ravi apps run console/control me --json
ravi apps run console/control users --json
ravi apps run console/control orgs --json
ravi apps run console/control features --json
ravi apps run console/control requests --json
ravi apps run console/control projects --json
ravi apps run console/control pages-sites <project-ref> --json
ravi apps run console/control pages-diag --json
ravi apps run console/control audit --json
```

4. Para mutacoes de usuario, org, acesso, feature entitlement ou Pages, procure o contrato Console correspondente antes de agir. Se o endpoint/CLI ainda nao existir, trate como blocker de implementacao, nao como permissao para escrever direto no banco.

## Escopo esperado

- Users: lookup autorizado, memberships, identidades linkadas e estado da conta.
- Organizations: owners/admins, billing summary, membros e readiness por produto.
- Feature access: catalogo, plano efetivo, entitlements explicitos e features internas.
- Access requests: intake, approve/reject/fulfill via Console auditado.
- Diagnostics: Pages, Channels, Connectors e GitHub com payload sanitizado.
- Audit: timeline segura de acoes de suporte e plataforma.

## Regras

- Nao copie regra proprietaria do Console para o OSS.
- Nao adicione usuario a organizacao sem endpoint Console auditado.
- Nao altere entitlement, role, membership, WorkOS ou provider direto do OSS.
- Nao exponha tokens, request headers internos, email bodies ou dados cross-tenant.
- Nao raspe UI do Console se houver endpoint CLI/API.
- Mutacoes futuras precisam declarar permissao no app e revalidar no Console.
