---
name: frete
description: |
  Opera o Ravi App de cotacao de frete pela API oficial da Olist. Use quando precisar:
  - Cotar um SKU para um CEP sem contratar transporte
  - Inspecionar o contrato, manifesto e permissoes do App frete
  - Interpretar opcoes, valores e prazos retornados por `ravi frete quote`
  NAO use para compra, pagamento, despacho, etiqueta ou cancelamento de frete.
---

# Frete

O App `frete` consulta opcoes configuradas na conta Olist. A operacao e
read-only no dominio: nao contrata, compra, paga, despacha nem cancela frete.

## Fluxo Canonico

1. Inspecione e valide o App:

```bash
ravi apps show frete --json
ravi apps check frete --json
```

2. Leia o contrato completo do comando:

```bash
ravi frete quote --help
```

3. Depois que uma conexao Ravi suportada estiver configurada, cote:

```bash
ravi frete quote \
  123 \
  01310100 \
  SKU-01 \
  --quantity 2 \
  --json
```

4. Escolha entre as opcoes usando `price`, `deadlineDays`,
`shippingMethodName`, `freightMethodName` e `deliveryType`.

## Permissoes E Limites

- Cotacao requer `frete:quotes:read`.
- `frete:shipments:write`, `frete:shipments:destructive` e
  `frete:charges:financial` sao fronteiras reservadas, nao operacoes liberadas.
- Nunca passe credencial em flag, mensagem ou arquivo do App.
- Se a conexao estiver ausente, pare no erro de onboarding; nao leia o token do
  SDE legado.
- Se o pedido for contratar, pagar, enviar ou cancelar, pare e obtenha contrato
  oficial + permissao + HITL em uma fase futura.

## Fonte De Verdade

- Manifesto: `src/apps/frete/ravi.app.json`.
- Regras: `ravi specs get apps/frete --mode rules --json`.
- Contrato operacional: `ravi frete quote --help`.
- Documentacao oficial verificada:
  `https://tiny.com.br/api-docs/api2-cotacao-fretes`.
