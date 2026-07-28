---
name: cnpj-server
description: >-
  Consulta dados cadastrais de empresas brasileiras no CNPJ Server privado.
  Use para localizar empresas por nome, UF, CNAE, cidade, porte, capital ou
  data de abertura; conferir um CNPJ conhecido; ou validar a conectividade
  read-only via Tailscale; ou preparar uma seleção pinada para Ravi CRM.
  NAO cobre: lookalike, exportacao em massa, criação automática de contatos ou
  oportunidades, ou acesso fora da tailnet.
---

# Consulta de Empresas por CNPJ

Use o CLI como fonte do contrato operacional:

```bash
ravi cnpj --help
ravi cnpj health --help
ravi cnpj get --help
ravi cnpj search --help
ravi cnpj export-crm --help
```

## Roteamento

- CNPJ conhecido: `ravi cnpj get`.
- Empresa desconhecida ou shortlist: `ravi cnpj search`.
- Exportação segura: `ravi cnpj export-crm` em dry-run; só execute o
  `nextCommand` pinado após revisão e com a capability `write_contacts`.
- Diagnóstico de acesso privado: `ravi cnpj health`.
- Manifesto/permissões do App: `ravi apps show cnpj-server --json`.

Sempre prefira `--json`. Para paginação, siga `pagination.nextCommand` em vez
de montar uma leitura ilimitada. `ravi crm accounts` também exige
`write_contacts`, pois inclui accounts ainda sem contatos vinculados.

## Contrato Completo

Leia [references/contract.md](references/contract.md) quando precisar escolher
filtros, interpretar erros ou validar a fronteira de rede.
