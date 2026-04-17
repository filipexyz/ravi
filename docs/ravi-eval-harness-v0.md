# Ravi Eval Harness v0

## Leitura operacional

Triangulo base:

- `sessions` = comunicacao e execucao real em uma sessao do Ravi
- `tasks` = trabalho vivo com dono, progresso e conclusao
- `eval` = medicao reproduzivel, diff e regressao

O eval pode reutilizar uma sessao real do Ravi, mas nao vira backlog nem runtime operacional.

## Tese

O `ravi eval` e um harness enxuto para medir trabalho real do Ravi sem misturar benchmark no loop principal do daemon.

O v0 faz 5 coisas:

1. carrega um `task spec`
2. executa um prompt numa sessao real do Ravi
3. tira `snapshot before/after` dos artefatos locais relevantes
4. calcula `diff`
5. aplica uma `rubrica binaria` deterministica

O objetivo aqui nao e copiar o Archipelago inteiro. E ganhar um banco de prova reproduzivel para:

- skills
- agents
- motores
- workflows
- regressao de autonomia

## Como encaixa no Ravi

O acoplamento e na borda, nao no core do daemon:

- `sessions` / `publishSessionPrompt`
  - runner usa uma sessao real do Ravi
- `transcripts`
  - transcript vira artefato observavel
- `filesystem`
  - arquivos relevantes entram no snapshot
- `CLI`
  - `ravi eval run` e a porta de entrada

Ou seja:

- o Ravi e o motor de execucao
- o harness e a bancada de teste

## O que o v0 suporta

### Task spec

Arquivo JSON com:

- `id`
- `title`
- `prompt`
- `session`
- `artifacts`
- `rubric`
- `runner`

### Artifacts

Hoje o v0 captura:

- `files`
- `transcript`

### Rubrica binaria

Critérios suportados:

- `response.contains`
- `transcript.contains`
- `file.exists`
- `file.contains`
- `file.changed`

## CLI

```bash
ravi eval run examples/eval/session-response-smoke.json
ravi eval run examples/eval/session-response-smoke.json --json
```

O run persiste artefatos em:

```bash
~/.ravi/evals/<task-id>/<run-id>/
```

Arquivos gravados:

- `task.json`
- `execution.json`
- `before.json`
- `after.json`
- `diff.json`
- `grade.json`
- `run.json`

## Exemplo de spec

```json
{
  "version": 1,
  "id": "session-response-smoke",
  "title": "Smoke: resposta simples da sessao",
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
    },
    {
      "id": "transcript_contains_eval_ok",
      "type": "transcript.contains",
      "needle": "EVAL_OK"
    }
  ],
  "runner": {
    "timeoutMs": 120000
  }
}
```

## O que a gente ganha com isso

1. para de avaliar no feeling
2. compara motores e agents no mesmo terreno
3. transforma wish/skill em coisa testavel
4. ganha regressao real pra autonomia
5. cria um benchmark interno do Ravi

## Limites do v0

O v0 ainda nao faz:

- sandbox isolado por task
- snapshot de DB inteiro
- scoring por judge LLM
- replay por cursor do barramento v3
- worlds complexos

Isso e intencional.

O v0 existe para provar o loop:

- `task spec`
- `run`
- `artifacts`
- `diff`
- `grade`

## Proximos passos naturais

1. adicionar criterios de DB/route/session
2. integrar melhor com `ravi stream`
3. criar packs de tasks reais do Ravi
4. comparar motores/agentes com o mesmo harness
5. evoluir para sandbox/task pack mais proximo de um `Archipelago-like`
