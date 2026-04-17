# Brainstorm e Modelagem

Use esta referencia antes de escrever qualquer comando.

## Objetivo

O CLI nao comeca no parser. Ele comeca na pergunta:

- qual problema operacional este CLI resolve?
- qual decisao ele melhora?
- qual ativo ele produz?

## Perguntas de Brainstorm

Responda nesta ordem:

1. Qual trabalho hoje esta manual, difuso ou dificil de rastrear?
2. Qual decisao o usuario ou agente precisa tomar melhor depois do CLI existir?
3. Quais entidades existem no dominio?
4. Quais artefatos o processo gera?
5. O que precisa ser recuperavel depois?
6. O que precisa ser auditavel?
7. O que e deterministico e pode ser reaproveitado?
8. O que muda o suficiente para exigir versionamento?

## Regra de Valor dos Dados

Persista apenas o que agrega pelo menos um destes ganhos:

- reuso
- rastreabilidade
- lineage
- auditoria
- cache caro de recomputar
- consolidacao de ativos tecnicos

Se um dado nao melhora nenhum desses e pode ser recomputado barato, nao persista por default.

## Artefatos de Fronteira

Quando o processo for deterministico, prefira salvar:

- `input normalizado`
- `output da etapa`
- `metadata`
- `hash`
- `version`
- `depends_on`
- `created_at`
- `source`

Isso facilita reaproveitamento sem transformar memoria em lixo difuso.

## Modelagem Antes do Comando

Defina primeiro:

- entidades
- relacionamentos
- eventos relevantes
- artefatos gerados
- identificadores estaveis
- criterios de obsolescencia

So depois desenhe os comandos.

## Heuristicas Boas

- se ha lineage, cache ou reuso, pense em `SQLite`
- se ha etapas deterministicas, trate como pipeline de ativos
- se o usuario precisa descobrir "o que reaproveitar", a modelagem deve explicitar dependencias
- se o agente precisa operar sozinho, o schema precisa ser sem ambiguidades

## Resultado Esperado

Ao fim do brainstorm, voce deve conseguir responder:

- o que o CLI faz
- por que isso merece existir como ferramenta
- quais dados ele guarda
- por quanto tempo
- e como esses dados aumentam o valor do sistema
