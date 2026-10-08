# Importar e exportar CSV

## Importar

```bash
ravi bases rows import pipeline deals.csv --json                       # dry-run: exit 3 com mapeamento e lotes
ravi bases rows import pipeline deals.csv --map "Deal Name=name" --map "Notas=body" --map "Interno=-" --json
ravi bases rows import pipeline deals.csv --map "Deal Name=name" --batch 200 --json --execute
```

Como funciona:

1. Lê o schema da base (precisa de escrita direta na base, não por view).
2. Casa cada coluna do CSV com uma propriedade: chave exata, cabeçalho
   normalizado (`Close Date` → `close_date`) ou nome da propriedade. `body`
   (ou `--map "Coluna=body"`) vai para o corpo da linha. `row_id`, `version` e
   colunas de sistema são ignoradas. Coluna sem par é pulada e aparece no plano.
3. Converte as células: `number` (aceita `1 200`), `checkbox`
   (`true`/`false`, `yes`/`no`, `1`/`0`, `x`), `multi_select`/`person` (separados por
   `,` `;` ou quebra de linha), `ref` (`tipo:id`), `date` (`2026-01-01` ou
   `2026-01-01/2026-01-31`). Selects vão pelo nome; o Console resolve o id.
4. Qualquer célula inválida para o tipo falha com `PAYLOAD_INVALID` e
   `issues` (linha, coluna) ANTES do freio. Corrija o CSV ou pule a coluna.
5. Sem `--execute`: exit 3 com linhas, lotes, mapeamento e prefixo de chave.
6. Com `--execute`: envia lotes de até 500 linhas (`--batch`, e no máximo
   ~900 KiB por request), em ordem.

Idempotência: o lote `i` usa a chave `ravi-import:<hash do arquivo, projeto,
base e mapeamento>:<i>`. Se a importação cair no meio, rode o MESMO comando:
lotes já gravados voltam como replay (`idempotentReplay: true`) e o resto é
criado. Mudar `--batch` muda os lotes; o Console recusa com `CONFLICT`
(`idempotency_conflict`) em vez de duplicar. Em falha, `error.importProgress`
diz qual lote falhou e quantas linhas já foram criadas. Chaves expiram em 24h.

Antes de importar muito: crie as propriedades com os tipos certos e as opções
de select (o Console aceita nomes de opção, mas nome desconhecido falha).

## Exportar

```bash
ravi bases rows export pipeline --format csv --out pipeline.csv
ravi bases rows export pipeline --view <view-id> --format json --out minha-view.json
ravi bases rows export pipeline --filter @filtro.json --sort amount:desc --include-body --format csv
```

- Segue todos os cursores até `--max-rows` (padrão e máximo 100.000) e marca
  `truncated` no JSON.
- CSV: cabeçalho `row_id,version,<colunas>`. Selects saem pelo nome, `person`
  sai como user id (reimportável), `ref` como `tipo:id`, datas com intervalo como
  `inicio/fim`.
- Texto livre que começa com `=`, `+`, `-`, `@`, tab ou CR sai prefixado com `'`
  para planilhas não executarem fórmula. A importação remove esse prefixo.
- `--view` exporta só o que a view mostra para você.
- `rows query --format csv` faz o mesmo para uma página.
