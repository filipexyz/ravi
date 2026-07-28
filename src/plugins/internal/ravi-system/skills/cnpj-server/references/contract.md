# Operação do CNPJ Server

## Pré-condições

- Execute em host conectado à tailnet autorizada.
- Passe explicitamente
  `--base-url http://100.77.169.127:8090`.
- Mantenha `--json` para consumo por agentes.

O código rejeita qualquer outro host, protocolo, porta, path, credencial, query
ou fragmento antes de abrir a rede. Não existe fallback público nem opção
insegura de TLS.

## Escolha do comando

### Verificar conectividade

```bash
ravi cnpj health \
  --base-url http://100.77.169.127:8090 --json
```

O probe executa uma busca `page=1&limit=1`. `ready=true` prova transporte e
shape da resposta; não autoriza a mutação CRM separada.

### Consultar CNPJ conhecido

```bash
ravi cnpj get 00.000.000/0001-91 \
  --base-url http://100.77.169.127:8090 --json
```

O CLI normaliza pontuação e valida os dígitos antes da rede. Use `data.empresa`,
`data.estabelecimento`, `data.simples` e `data.socios`.

### Buscar empresas

```bash
ravi cnpj search --uf SP --cnae 1340500 --limit 10 \
  --base-url http://100.77.169.127:8090 --json
```

Filtros:

- `--query`: razão social/nome;
- `--uf`: sigla em maiúsculas;
- `--cnae`: atividade ou prefixo;
- `--city`: município;
- `--capital-min` / `--capital-max`: intervalo não negativo;
- `--size`: `MICROEMPRESA`, `EPP` ou `GRANDES`;
- `--opened-from` / `--opened-to`: `YYYY-MM-DD`;
- `--page`: página >= 1;
- `--limit`: 1-100.

Leia `items` e `pagination`. Quando `hasMore=true`, execute `nextCommand`.

### Preparar exportação para CRM

```bash
ravi cnpj export-crm --uf SP --owner agent:main --limit 20 \
  --base-url http://100.77.169.127:8090 --json
```

O default é dry-run. Revise `candidates`, `dedupe` e `selectionHash`; o apply
exige `write_contacts` e deve usar o `nextCommand` exato com a lista de CNPJs
pinada. O fluxo cria/reusa somente accounts `lead` e facts `cnpj` confirmados,
sem criar contacts/opportunities e sem retry automático.

Recupere essas contas com paginação:

```bash
ravi crm accounts --source cnpj-server --lifecycle lead \
  --owner agent:main --limit 50 --offset 0 --json
```

Essa leitura também exige `write_contacts`, pois inclui accounts ainda sem
contatos ou oportunidades e não pode abrir um bypass de autorização CRM.

## Erros

- `INVALID_ENDPOINT` (`autorizar`): usar a URL Tailscale exata.
- `INVALID_CNPJ` / `INVALID_SEARCH` (`corrigir`): corrigir antes de repetir.
- `NOT_FOUND` (`parar`): buscar por filtros ou conferir o documento.
- `TIMEOUT` / `TRANSPORT_ERROR` / `UPSTREAM_UNAVAILABLE` (`retry`): confirmar
  tailnet e repetir manualmente a mesma leitura.
- `INVALID_RESPONSE` (`parar`): não usar os dados; investigar drift.

Cada erro contém `retryable` e `nextAction`. Não improvise fallback para o
hostname público, `oneplus`, loopback ou outro IP.

## Limites

O app não oferece lookalike, stream, exportação CSV, auto-paginação,
persistência própria ou tokens. Sua única mutação é a exportação CRM explícita
e pinada; o cliente do CNPJ Server permanece GET-only. Use o adaptador legado
apenas como baseline de comparação; esta integração não o desliga.
