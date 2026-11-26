---
name: decisions
description: |
  Registra perguntas, donos e respostas imutáveis, com origem task ou thread.
  Use para abrir ou consultar uma decisão, registrar a resposta explícita,
  verificar entrega à thread e recuperar falhas sem duplicar o trabalho.
---

# Decisões

A decisão guarda pergunta, dono, resposta e histórico. Task e thread são origens; não crie task artificial para perguntar algo numa thread.

> Compõe com: sessions (threads), tasks (pergunta que bloqueia e deixa a task `parked`).

## Contrato

O namespace precisa estar autorizado (`execute:group:decisions` ou grants específicos). Isso não dá acesso à origem: a task ou sessão continua decidindo quem lê e quem altera. Nenhuma permissão é ampliada automaticamente. Uma negação pede o operador correto, não uma tentativa de contorno.

```bash
# Task: gravação local imediata
ravi decisions ask --task <task-id> --key janela --ask "Qual janela?" --owner human:<contact-id> --blocks --json
# Thread gerenciada: publica pergunta e atualiza card
ravi decisions ask --thread <sessão-filha> --key janela --ask "Qual janela?" --owner human:<contact-id> --execute --json
ravi decisions list --thread <sessão-filha> --json
ravi decisions list --task <task-id> --all --json
ravi decisions show <decision-id> --json
# Resposta por uma sessão autorizada que não é o worker que espera
ravi decisions answer <decision-id> --text "Após 18h" --execute --json
ravi decisions retry <decision-id> --execute --json
```

`--task` e `--thread` são exclusivos. `--thread` aceita a sessão filha ou o id de lifecycle retornado por `sessions threads`; não é o namespace separado de threads de conhecimento.

`--key` é slug minúsculo de até 64 caracteres (`a-z`, números, `.`, `_`, `-`). `--owner` é `human:<contact-id>`, `agent:<agent-id>` ou `unassigned`. Repasse dono e blocks ao reabrir uma pergunta aberta: omissões usam defaults. Re-ask altera a pergunta aberta preservando id, askedBy e askedAt; repetição idêntica não publica novamente. Após answer, usar a mesma chave cria outro id.

A resposta referencia **id** e é imutável: uma decisão nova pode substituir a antiga (ver Escopo), mas o texto respondido nunca muda. `--by` acrescenta proveniência e não muda a autoridade. O dono também não prova aprovação humana autenticada. Não invente a resposta: a filha/assignment ativa recebe `DECISION_SELF_ANSWER`, mesmo com `--by`. Registre explicitamente pela sessão pai autorizada ou pelo operador. Texto normal no chat não encerra decisões.

`ask` e `answer` de thread precisam de `--execute`, pois publicam ou retomam trabalho. Para task, ambos gravam imediatamente; não há retomada ou notificação automática de task. `list` e `show` são leituras. `list` pagina com `--limit` (50 por padrão, máximo 500) e `--offset`; `pagination.nextCommand` preserva filtros. Erros: exit 1 entidade/autoridade/lifecycle, 2 uso, 3 preview sem executar. Preview valida antes e não grava.

Task mantém `parked` derivado de pergunta aberta, blocking, dona human, em task não terminal/não arquivada. Use `tasks attention` para esse agrupamento. Eventos `task.decision.open|answered` continuam nas automações existentes.

## Escopo, fonte e substituição

Toda decisão tem escopo: `thread` (a origem, padrão), `agent:<id>`, `project:<id>` ou `org`. Quem pergunta propõe (`ask --scope`); a resposta fixa (`answer --scope`), ampliando ou estreitando. Respondida, a decisão entra no contexto de todo turno que ela cobre (org, o agent do turno, o projeto da meta da sessão, a própria thread), das mais novas para as mais antigas, no máximo 20.

Ampliar além da thread exige a palavra verificada do dono: `--source-message <id da mensagem dele>`, ou o operador local no terminal. Agent nenhum amplia por conta própria, por maior que seja o grant (`DECISION_SCOPE_NOT_AUTHORIZED`). A fonte precisa ser uma mensagem do dono depois da pergunta, no chat da decisão ou numa DM, e amarrada a esta decisão: cita o id da decisão ou contém o trecho passado em `--source-quote`. O trecho fica gravado na decisão.

```bash
ravi decisions answer <id> --text "Sem confirmação em grupos" --scope org \
  --source-message <msg-do-dono> --source-quote "sem confirmação em grupo" --execute --json
# Substitui uma decisão respondida; a antiga sai do contexto e mantém o histórico
ravi decisions answer <id-novo> --text "..." --supersedes <id-antigo> --execute --json
ravi decisions supersede <id-antigo> --by <id-novo> --execute --json
# Decisões da org respondidas hoje (digest e status do dia)
ravi decisions list --scope org --answered-since 2026-11-26T00:00:00-03:00 --json
```

Substituir uma decisão de thread pede a mesma autoridade de responder nela; substituir uma mais ampla pede o operador ou uma substituta com fonte do dono no mesmo escopo ou na org.

## Thread e entrega

O card mostra a pergunta pendente, e a pergunta inteira aparece na própria thread. `THREAD_DECISIONS_PENDING` impede fechar qualquer pergunta aberta e qualquer resposta ainda não admitida. Não force fechamento nem descarte a pergunta.

`show --json` separa a decisão e `deliveries`:

- `pending|failed`: obrigação persistida, retry com backoff; `retry` tenta o mesmo id.
- `published`: publicada, ainda aguardando admissão pelo runtime.
- `delivered`: resposta admitida pelo dispatcher; não significa que o trabalho terminou. Para pergunta, significa repassada ao outbox durável do canal, que cuida da entrega e retry no Slack.
- `uncertain`: houve falha/crash depois do início da admissão; não repetir às cegas.
- `superseded`: uma notificação de pergunta antiga tornou-se obsoleta.

O vínculo fixa chat canônico e chave da sessão. Renomear mantém o vínculo; sessão apagada/trocada ou chat reatribuído falha fechado. Nunca encaminhe a resposta a uma irmã para fazer a entrega parecer concluída.

## Recuperação pelo operador

Em `uncertain`, inspecione `ravi sessions trace <sessão-filha>` e `decisions show`. Só o operador local pode resolver, com evidência explícita; agents e gateway são recusados:

```bash
ravi decisions resolve-delivery <decision-id> --outcome received --evidence "Trace <turn-ref> confirma admissão" --execute --json
# Somente após excluir admissão anterior:
ravi decisions resolve-delivery <decision-id> --outcome not_received --evidence "Trace <ref> e inspeção confirmam que não entrou" --execute --json
```

`received` encerra a pendência de entrega; `not_received` libera nova tentativa do mesmo registro. A evidência fica no histórico. Nunca use essa recuperação a partir de um palpite do worker.
