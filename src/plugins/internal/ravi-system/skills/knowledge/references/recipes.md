# Receitas de Knowledge

## "O que o cliente X falou sobre o orçamento?"

```bash
ravi knowledge search "orçamento" --about contact:<contact-id> --since 30d --json
ravi knowledge read <ref> --around 2 --json
```

Resposta: cite a frase entre aspas, diga quem disse e quando, e coloque o `url`
quando houver. Resultado local de chat tem confiança `said`.

## "O que decidimos na reunião de ontem?"

```bash
ravi knowledge search "decisão" --type meeting,transcript --since 2d --json
ravi knowledge read <ref> --around 2 --json
```

Fala de reunião não é decisão. Escreva "fala atribuída a «Nome»" e, se o
operador quiser registrar como decisão, proponha uma nota:

```bash
ravi knowledge propose --note "<decisão em uma frase>" --from <ref> --project <projeto> --execute
```

## A busca não achou nada

```bash
ravi knowledge search "<nome da outra pessoa>" --since 30d --json
ravi knowledge read <ref> --around 2 --json
ravi knowledge why --last --json
```

## Resumo publicado

```bash
ravi knowledge search "<tema>" --since 7d --json
ravi pages ship --title "Resumo da semana" --route /resumo --body "<html com links das fontes>" --json
```

A rota fica privada. Não use `ravi pages visibility` para abrir.

## Corrigir uma informação errada

```bash
ravi knowledge search "<tema>" --json
ravi knowledge propose --correction "<texto certo>" --supersedes <ref> --project <projeto> --execute
```
