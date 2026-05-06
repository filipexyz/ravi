---
name: prox-calls
description: |
  Opera prox.city Calls no Ravi. Use quando precisar:
  - Fazer ligacoes via `ravi prox calls`
  - Escolher ou explicar provider ElevenLabs/Twilio vs Agora SIP
  - Configurar call profiles, first message, prompt, pipeline/agent id e numero de origem
  - Consultar eventos, transcript e resultado de calls
  - Debugar webhooks, hangup por `end_call`, quiet-hours/rules e modo `--force`
---

# prox.city Calls

`ravi prox calls` e a superficie operacional de ligacoes do prox.city. Calls sao canal de ativacao humana: check-in, follow-up, entrevista, convite, assessment e coleta de resposta.

Antes de alterar codigo ou regra, consulte a spec normativa:

```bash
/Users/luis/dev/filipelabs/ravi.bot/bin/ravi specs get prox/calls --mode full --json
```

Use sempre o wrapper canonico do repo fonte:

```bash
/Users/luis/dev/filipelabs/ravi.bot/bin/ravi
```

## Modelo Mental

- `call_profile` escolhe **como** a call roda: provider, prompt, first message, numero de origem, agent/pipeline id e placeholders.
- `call_rules` decide **se/quando** pode ligar: quiet hours, cooldown, max attempts, snooze, aprovacao e cancelamento por resposta.
- `call_request` e o pedido logico de ligar para uma pessoa.
- `call_run` e uma tentativa concreta no provider.
- `call_event` e a timeline auditavel.
- `call_result` e o resultado final com transcript/resumo/next action.

Provider e escolhido pelo `profile`, nao por flag no `request`.

## Providers

### ElevenLabs/Twilio

Use `provider=elevenlabs_twilio`.

- `provider_agent_id`: ElevenLabs agent id.
- `twilio_number_id`: ElevenLabs phone number id.
- Transcript pode ser sincronizado manualmente com `transcript --sync`.
- Sync de prompt/first message pelo CLI e suportado para ElevenLabs.

### Agora SIP

Use `provider=agora_sip`.

- `provider_agent_id` vazio: Ravi usa full-config dinamico por API.
- `provider_agent_id=<pipeline_id>`: Ravi usa pipeline/agent salvo no Agora Studio.
- `twilio_number_id`: numero E.164 de origem, exemplo `+551150289990`.
- Transcript e webhook-first: vem pelo evento Agora `103`.
- `transcript --sync` nao busca transcript na Agora; leia o cache criado pelo webhook.

Tradeoff importante:

- Full-config dinamico permite Ravi injetar `llm.mcp_servers` com a tool `end_call`.
- Pipeline do Agora Studio nao recebe `llm.mcp_servers` pelo payload do Ravi; nesse caso a tool equivalente precisa estar configurada dentro do pipeline no Agora.

## Comandos Principais

Listar profiles:

```bash
ravi prox calls profiles list
ravi prox calls profiles list --json
```

Ver um profile:

```bash
ravi prox calls profiles show followup --json
```

Configurar provider:

```bash
ravi prox calls profiles configure followup \
  --provider agora_sip \
  --twilio-number-id +551150289990 \
  --agent-id <pipeline_id-ou-vazio>
```

Para limpar `provider_agent_id` e voltar ao full-config dinamico, use o comando de profile apropriado se existir; se o CLI ainda nao tiver unset explicito, nao improvise direto no DB sem revisar a storage layer.

Criar ligacao:

```bash
ravi prox calls request \
  --profile followup \
  --person luis \
  --phone +5511947879044 \
  --reason "Motivo objetivo da ligacao" \
  --var "opening_line=Oi, Luis. E o Ravi." \
  --var "goal=Faca X, pergunte Y, depois encerre." \
  --json
```

Use `--force` so para chamada explicitamente pedida pelo operador, especialmente fora de janela normal:

```bash
ravi prox calls request ... --force --json
```

Ver status:

```bash
ravi prox calls show <call_request_id> --json
```

Ver timeline:

```bash
ravi prox calls events <call_request_id> --json
```

Ver transcript:

```bash
ravi prox calls transcript <call_request_id> --json
```

Para ElevenLabs, `--sync` forca refresh:

```bash
ravi prox calls transcript <call_request_id> --sync --json
```

Nao use `--sync` esperando buscar transcript da Agora.

## Escolhendo Entre 11 e Agora

Escolha pelo profile.

Exemplos atuais podem variar por ambiente, entao sempre confirme:

```bash
ravi prox calls profiles list --json
```

Regra pratica:

- Use ElevenLabs/Twilio quando quiser comportamento gerenciado por agent/voice config do ElevenLabs e sync manual de conversation.
- Use Agora SIP quando quiser fluxo SIP/RTC, webhooks Agora, controle por full-config dinamico e tool `end_call` injetada pelo Ravi.
- Para evitar substituicao invisivel, prefira profiles explicitos como `followup-agora` e `followup-elevenlabs`.

## Hangup / end_call

No Agora full-config, Ravi pode anunciar um MCP server:

```text
POST /webhooks/agora/tools?request_id=<call_request_id>
```

A tool `end_call`:

- resolve o `call_run` Agora pelo `call_request_id`;
- chama `POST /projects/{appid}/calls/{agent_id}/hangup`;
- registra `call_event` com `status=hangup_requested`;
- e idempotente se o provider chamar a tool mais de uma vez durante shutdown.

Para a tool ser anunciada no payload Agora, precisam existir:

- `RAVI_WEBHOOK_PUBLIC_BASE_URL` ou `RAVI_PUBLIC_BASE_URL`
- `RAVI_AGORA_TOOL_SECRET`

Nunca imprima esses valores. So confirme se estao setados.

## Webhooks

Rotas canonicas:

```text
POST /webhooks/elevenlabs/post-call
POST /webhooks/agora/convoai
POST /webhooks/agora/tools?request_id=<call_request_id>
```

Ambiente:

- `RAVI_HTTP_PORT` ou `RAVI_WEBHOOK_PORT`: habilita o HTTP server.
- `RAVI_HTTP_HOST` ou `RAVI_WEBHOOK_HOST`: host bind, default `127.0.0.1`.
- `ELEVENLABS_WEBHOOK_SECRET`: assinatura ElevenLabs.
- `AGORA_WEBHOOK_SECRET`: assinatura Agora Notifications.
- `RAVI_ELEVENLABS_WEBHOOK_ALLOW_UNSIGNED=1`: so local/dev.
- `RAVI_AGORA_WEBHOOK_ALLOW_UNSIGNED=1`: so local/dev.

## Debug Rapido

Se a call nao toca:

```bash
ravi prox calls show <id> --json
ravi prox calls events <id> --json
```

Verifique:

- profile correto;
- provider registrado;
- numero destino E.164;
- numero origem correto;
- se `--force` era necessario por rules/quiet-hours;
- eventos `run.started`, `CALLING`, `RINGING`, `ANSWERED`, `HANGUP`;
- provider failure em `provider.error`.

Se a Agora mostra um agent diferente no site:

- Com `provider_agent_id=""`, Ravi usa full-config dinamico e a Agora cria um runtime agent/call instance.
- Com `provider_agent_id=<pipeline_id>`, Ravi usa o pipeline salvo no Agora Studio.

Se nao desligou sozinho:

- Em full-config, procure evento `status=hangup_requested`.
- Se estiver usando `pipeline_id`, confirme se o pipeline do Agora tem tool equivalente configurada.
- Se houver `hangup_failed` com conflito durante shutdown, trate como bug se nao estiver coberto por idempotencia.

## Cuidados

- Nao exponha API keys, webhook secrets, bearer tokens, app certificates ou customer secrets.
- Nao edite DB direto para operacao normal.
- Nao reinicie daemon sem autorizacao.
- Nao trate calls como modulo isolado fora de `ravi prox`.
- Nao use wrappers de WhatsApp para responder sobre call; texto da sessao ja e a resposta.
