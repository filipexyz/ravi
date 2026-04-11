# UX, Stack e Storage

## Stack Obrigatorio

Para CLIs do Ravi, use sempre:

- `bun`
- `commander`

Isso reduz variacao desnecessaria no codebase e facilita manutencao, leitura e evolucao.

## Regra de UX Agent-First

Os comandos serao usados primeiro por agentes. Entao:

- nomeie comandos com verbos concretos
- evite abreviacoes obscuras
- escreva `--help` como uma interface real, nao como lixo gerado
- inclua exemplos reais
- inclua hints e mensagens de proximo passo

## Superficie de Comandos

Prefira comandos como:

- `list`
- `get`
- `create`
- `update`
- `delete`
- `sync`
- `check`
- `run`

Evite comandos genericos demais como:

- `do`
- `process`
- `handle`
- `misc`

## Help de Alta Qualidade

Todo comando deve explicar:

- o que faz
- quando usar
- quais argumentos sao obrigatorios
- um exemplo real
- o que acontece depois

## Erros Bons

Mensagens de erro devem responder:

- o que falhou
- por que falhou
- como corrigir

Ruim:

- `invalid input`

Bom:

- `faltou --project-id; use o id estavel do projeto salvo em assets.db`

## SQLite por Dominio

Use `SQLite` proprio quando o CLI precisar:

- persistir ativos
- manter lineage
- guardar cache caro
- rastrear execucoes
- versionar outputs

Evite um banco unico e generico se isso misturar ownership de dominios diferentes.

## Resultado Esperado

Ao final, o CLI deve ser:

- previsivel para agentes
- legivel para humanos
- facil de operar por terminal
- rastreavel no storage
- barato de manter
