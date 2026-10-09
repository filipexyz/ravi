---
name: tasks-eval
description: |
  Usa o eval harness do Ravi para medir trabalho real. Use quando o usuário quiser:
  - Testar um agent, skill ou workflow de forma reproduzível
  - Criar ou rodar task specs de benchmark
  - Validar regressão de comportamento no Ravi
  - Comparar motores, agents ou prompts no mesmo terreno
---

# Tasks Eval

O `ravi eval` é a bancada de teste do Ravi.

Ele não substitui o task runtime operacional.

Leitura certa:

- `ravi sessions ...`
  - comunicação e coordenação entre sessões
- `ravi tasks ...`
  - trabalho vivo, dono, progresso, conclusão
- `ravi eval ...`
  - medição reproduzível, snapshot, diff, rubrica

## Quando usar

Use `eval` quando a pergunta for:

- esse agent realmente faz isso?
- essa mudança regrediu o Ravi?
- esse workflow funciona de forma repetível?
- esse motor/prompt é melhor que o outro?

Não use `eval` quando a necessidade for só:

- despachar trabalho real
- acompanhar execução viva
- coordenar agents no dia a dia

## Tese

O loop do harness é:

1. carregar um `task spec`
2. executar numa sessão real do Ravi
3. tirar snapshot `before/after`
4. calcular `diff`
5. aplicar rubrica determinística

O objetivo é parar de avaliar no feeling.

## CLI

```bash
ravi eval run <spec.json>
ravi eval run <spec.json> --json
```

Exemplo:

```bash
ravi eval run examples/eval/session-response-smoke.json --json
```

## O que o v0 já suporta

### Task spec

JSON com:

- `id`
- `title`
- `prompt`
- `session`
- `artifacts`
- `rubric`
- `runner`

### Artifacts

Hoje o v0 mede:

- `files`
- `transcript`

### Rubrica binária

Critérios suportados:

- `response.contains`
- `transcript.contains`
- `file.exists`
- `file.contains`
- `file.changed`

## Exemplo de spec

```json
{
  "version": 1,
  "id": "session-response-smoke",
  "title": "Smoke: resposta simples da sessão",
  "prompt": "Responda exatamente com EVAL_OK",
  "session": {
    "name": "eval-smoke",
    "agentId": "dev"
  },
  "artifacts": {
    "files": [],
    "transcript": true
  },
  "rubric": [
    {
      "id": "response_contains_eval_ok",
      "type": "response.contains",
      "needle": "EVAL_OK"
    }
  ],
  "runner": {
    "timeoutMs": 120000
  }
}
```

## Onde o run fica salvo

Cada execução persiste em:

```bash
~/.ravi/evals/<task-id>/<run-id>/
```

Arquivos típicos:

- `task.json`
- `execution.json`
- `before.json`
- `after.json`
- `diff.json`
- `grade.json`
- `run.json`

## Como pensar junto com `sessions`, `tasks` e `eval`

O jeito certo de combinar essas superfícies é:

- `sessions`
  - para perguntar, informar e coordenar
- `tasks`
  - para executar trabalho
- `eval`
  - para medir se o trabalho/skill/runtime ficou melhor

Exemplos bons:

- criou uma skill nova
  - depois cria um spec e roda `eval`
- mudou o router ou sessions
  - depois roda um pack de regressão
- quer comparar dois agents
  - roda a mesma spec nos dois

Exemplos ruins:

- usar `eval` como backlog
- usar `eval` para acompanhar progresso humano
- misturar benchmark com task operacional do dia a dia

## Heurística prática

Começa com tasks pequenas, binárias e objetivas:

- resposta exata
- criação/edição de arquivo
- leitura de contexto
- comportamento de sessão

Quanto mais objetiva a rubrica, melhor.

## Próximo passo natural

Depois do v0, o caminho certo é:

1. packs de specs reais do Ravi
2. critérios de DB/route/session
3. melhor integração com o substrate `v3`
4. comparação de agents/motores no mesmo pacote
