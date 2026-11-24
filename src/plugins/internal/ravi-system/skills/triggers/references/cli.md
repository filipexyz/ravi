# Triggers: CLI, opções e trigger shell

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Exit: `0` sucesso · `1` erro de execução (ex.: `TRIGGER_NOT_FOUND`; leia `suggestions` antes de concluir "não existe") · `2` uso (corrija pela lista `acceptedFlags`) · `3` freio de escrita, não erro nem política: nada foi gravado, o envelope traz `dryRun:true` e `plan`. Revise o plano e repita com `--execute`.

`triggers rm` (sem undo) e `triggers test` (o evento sintético pode ativar agent ou shell) são dry-run por padrão: sem `--execute`, exit 3 com o plano. `add`, `set`, `enable` e `disable` não têm freio, porque todas têm comando inverso.

## Comandos

```bash
ravi triggers list --fields id,name,topic,enabled   # modo compacto: só esses campos
ravi triggers show <id>
ravi triggers enable <id>                            # e disable <id>
ravi triggers set <id> <key> <value>
ravi triggers test <id> --execute                    # emite o evento sintético
ravi triggers rm <id> --execute                      # deleta de verdade
```

Para repontar o destinatário de um follow antes de fechar sua thread: `ravi triggers set <id> replySession <sessão-pai>`. Confira o destino com `ravi triggers show <id> --json`.

Chaves de `set`: name, message, shell, exec, timeout, env-file, on-error, topic, agent, session, cooldown, debounce, filter.

### Criar
```bash
ravi triggers add "<nome>" --topic "<pattern>" --message "<prompt>"
ravi triggers add "Novo email local" --topic "ravi.inbox.mail.received"
ravi triggers add "Ticket Slack" --topic "ravi.inbound.interaction" --filter 'data.provider == "slack" && data.blockId == "ticket"' --shell "bun /home/ops/ravi/ops/scripts/slack-ticket-flow.ts"
```

Opções:
- `--agent <id>` - Agent que processa (default: agent padrão)
- `--cooldown <duration>` - Intervalo mínimo entre disparos; descarta o que cai na janela (default: off; prefira `--debounce`)
- `--debounce <duration>` - Junta uma rajada de eventos num disparo só, depois desse tempo sem evento novo, levando todos os eventos (default em trigger de agent: 30s em `ravi.watch.*`, 5s nos demais; `off` desliga; com `--cooldown` explícito ou `--shell`, nenhum; lote guarda os últimos 200 eventos e se perde se o daemon parar)
- `--thread` - Cada disparo roda numa sessão própria que devolve o resultado uma vez (`--report-to <sessão>`; `--visible` mostra o run no Slack de quem recebe)
- `--session <nome>` - Sessão onde o trigger roda, por nome (default: a sessão atual, com aviso quando ela é uma conversa; fora de sessão, a main do agent). Sessão existente é reusada e responde onde conversou por último; se não existe, é criada. Aceita template com a sintaxe das mensagens (`{{data.<path>}}`, item de array por índice), ex.: `issue-{{data.payload.row.values.topic_id.0}}` = uma sessão persistente por issue. Evento cujo nome não resolve é pulado (log warn), sem fallback. Cooldown conta por sessão resolvida
- `--message <prompt>` - Prompt/template manual; opcional quando o tópico do catálogo tem `messageTemplate`
- `--shell <cmd>` / `--exec <cmd>` - Executa comando shell diretamente, sem acordar agent
- `--timeout <duration>` - Timeout de shell trigger, ex: `30`, `1m`, `5m`
- `--env-file <path>` - Env file carregado no processo shell
- `--on-error notify-session:<session>` - Notifica uma sessão somente em falha do shell

Triggers shell recebem:

- `RAVI_TRIGGER_EVENT_FILE` - JSON com `{ trigger, event, source }`
- `RAVI_TRIGGER_DATA_FILE` - JSON com `event.data`
- `RAVI_TRIGGER_ACTION_ID`, `RAVI_TRIGGER_BLOCK_ID`, `RAVI_TRIGGER_VALUE`
- `RAVI_TRIGGER_USER_ID`, `RAVI_TRIGGER_CHANNEL_ID`, `RAVI_TRIGGER_MESSAGE_TS`
- `RAVI_TRIGGER_SOURCE_CHAT_ID`, `RAVI_TRIGGER_SOURCE_ACCOUNT_ID`

Armadilhas do `--shell`:

- Só o operador cria ou muda um trigger shell (`TRIGGER_SHELL_NOT_OPERATOR`, como no cron shell), e só de um turno que o daemon verifica (o chat dele com o Ravi), nunca de um `ravi` local no terminal. Trigger shell cujo dono não é o operador não roda: o primeiro evento o desliga e avisa só o operador por mensagem direta (o dono, que pode ser um contato, não recebe nada, porque não tem como agir; a sessão principal recebe o aviso quando a mensagem não chega ao operador). De um turno de contato, use `--message`.
- Só o dono mexe num trigger shell: qualquer `set`, `enable` ou `disable` de outra pessoa é recusado, porque a edição deixaria o trigger sem dono e ele pararia. Para mudar o de outra pessoa ou um sem dono, crie um trigger shell novo e remova o antigo.
- O comando começa com o env filtrado dos agents, não com os segredos do daemon. O que ele precisa de propósito vai no `--env-file`, que não pode ficar dentro do state dir do Ravi (`TRIGGER_SHELL_ENV_FILE_IN_STATE_DIR`) nem ser hard link (`TRIGGER_SHELL_ENV_FILE_HARD_LINK`); tem que ser arquivo regular (`TRIGGER_SHELL_ENV_FILE_NOT_REGULAR`) de até 1 MiB (`TRIGGER_SHELL_ENV_FILE_TOO_LARGE`), do usuário que roda o Ravi (`TRIGGER_SHELL_ENV_FILE_NOT_OWNED`) e sem escrita para grupo ou outros (`TRIGGER_SHELL_ENV_FILE_WRITABLE_BY_OTHERS`; `chmod 600` resolve), porque quem escreve no env file decide o que o comando roda. Caminho que a checagem não consegue verificar (loop de symlink, diretório ou arquivo sem permissão de leitura) é recusado com `TRIGGER_SHELL_ENV_FILE_UNVERIFIABLE`. Limite conhecido: no macOS, ACL (`chmod +a`) dá escrita sem mudar os bits de modo e a checagem não vê; `ls -le` mostra e `chmod -N` remove. Trigger cujo env file passa a ser recusado é desligado no próximo evento, com um aviso por mensagem direta ao dono (ao operador, se ninguém for dono). A parte de localização é checagem de caminho, não fronteira de acesso.
- Roda no cwd do daemon, não no do agente. Use caminho absoluto no comando e dentro do script (`--html`, `--dir`, arquivos de estado), senão `bun scripts/x.ts` não acha nada.
- Leia o evento de `$RAVI_TRIGGER_DATA_FILE`, não de texto colado no comando.
- Script não tem chat de origem: `media send` precisa de `--account` e `--to`, `whatsapp dm send` de `--account`, e `ravi react send` não funciona ali.

Shell para automação determinística; agent quando a decisão pede linguagem natural ou julgamento.
