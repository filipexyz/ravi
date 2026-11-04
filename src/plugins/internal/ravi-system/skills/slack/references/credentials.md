# Slack Credentials And Scopes

Use esta referencia para diagnosticar credenciais, scopes, connections e
permissoes Slack.

## Comandos

```bash
ravi slack permissions-list --json
ravi credentials connections list --json
```

## Regras

- Nao exiba token Slack bruto (`xox`, `xapp`) em resposta, log ou spec.
- O CLI comum deve trabalhar com connection/secret ref, nao com segredo.
- Se scopes foram alterados no app Slack, o app precisa ser reinstalado e a
  connection deve apontar para o token atualizado.
- Falta de credencial deve desabilitar adapter/operacao de forma fechada, nao
  cair em token desconhecido.
- Env fallback so deve ser usado quando houver opt-in explicito.

## Adicionar credencial pelo Slack

Use `ravi credentials request` no turno Slack. O comando recebe apenas metadados;
o humano recebe um botão privado e cola o token no modal. Nunca peça o valor no
chat nem o passe por uma tool.

```bash
ravi credentials request connection:slack:secondary --user UEXAMPLE --reason "Acessar o workspace solicitado" --label "Workspace secundário" --json
ravi credentials request connection:slack:secondary --user UEXAMPLE --reason "Acessar o workspace solicitado" --label "Workspace secundário" --json --execute
ravi credentials request env:ANTHROPIC_API_KEY --user UEXAMPLE --reason "Habilitar o acesso à API solicitado" --json --execute
```

Sem `--execute`, sai com dry-run (3). O agente precisa de
`mutate:credentials.requests:<target>`; a pessoa vinculada ao usuário Slack
precisa de `mutate:credentials.secrets:<target>`. O comando não concede permissões.
O alvo é fixo, o convite expira em dez minutos e aceita uma submissão. Destino já
cadastrado exige rotação separada.

O padrão é arquivo local privado (diretório 0700, arquivo 0600), funciona em
Linux e macOS. `--backend keychain|vault` é opcional. Env continua limitado à
allowlist, com escopo do host; uma conexão mantém as permissões de uso atuais.

Use tokens de API revogáveis. O Slack processa o valor e o mostra durante edição.
Senhas e tokens OAuth de longa duração pedem OAuth nativo ou intake privado
específico, fora deste modal. O fluxo exige Socket Mode direto; gateway de nuvem
é recusado antes de mostrar o campo secreto. A confirmação fica no modal e só
contém fingerprint. Env salva pode exigir recarregar os processos pelo fluxo
normal de operação; o cadastro não reinicia o servidor.

## Salvar uma chave em um servidor registrado

O destino remoto é `remote:<destino>:<VARIAVEL>`. O fluxo está implementado no
código; habilitar um servidor exige instalação e autorização explícitas do
operador. O agente recebe somente o pedido e o recibo. Nunca salve um `.env`
local para copiar por SCP, nem leia o arquivo remoto para preparar um merge.

```bash
ravi credentials request remote:api-prod:PAYMENTS_API_TOKEN --user UEXAMPLE --reason "Configurar a integração de pagamento solicitada" --json
ravi credentials request remote:api-prod:PAYMENTS_API_TOKEN --user UEXAMPLE --reason "Configurar a integração de pagamento solicitada" --json --execute
ravi credentials request-status remote:api-prod:PAYMENTS_API_TOKEN <request-id> --json
```

O humano confere ambiente, host, arquivo e variável antes do campo secreto. O
handler envia o token diretamente por SSH autenticado a um gravador restrito,
com host key fixada e política no receptor. A gravação adiciona somente uma
chave ausente, preserva as demais e recusa sobrescrita, versão alterada, links,
arquivo inseguro e sintaxe não suportada. O perfil inicial aceita tokens ASCII
de uma linha, até 8 KiB, sem espaços, aspas, interpolação ou quebras de linha.

`request-status` reconcilia estado e exige o agente, sessão, conversa e humano
autorizado do pedido original. É uma mutação: pode bloquear duravelmente um
pedido remoto ainda ausente/reservado para impedir uma gravação atrasada. Em
timeout, use o mesmo request-id; `stored` é sucesso, `uncertain` exige
reconciliação confiável. Não peça o segredo novamente nem tente outra gravação
às cegas. Salvar não significa ativar: o aplicativo é recarregado pelo fluxo
operacional normal.

A administração fica exclusivamente no CLI local:

```bash
ravi credentials destinations discover --config /absolute/operator/ssh-config --json
ravi credentials destinations list --json
ravi credentials destinations show api-prod --json
ravi credentials destinations export-helper --out /absolute/operator/ravi-credential-writer --json
ravi credentials destinations register api-prod --ssh-alias api-host --config /absolute/operator/ssh-config --host-key "ssh-ed25519 <VERIFIED_SERVER_PUBLIC_KEY>" --identity-file /absolute/private/api-writer-key --user apiwriter --path /srv/api/.env --remote-target api --keys PAYMENTS_API_TOKEN --label "API produção" --json
```

O registro mostra a prévia e sai com 3; `--execute` cadastra o destino sem
instalar helper, criar chaves ou conceder permissões. A descoberta lê aliases
literais como metadados e não executa configuração SSH. O usuário e a chave
pessoais do alias não são herdados. IDs registrados não são substituídos.
`export-helper` cria somente um arquivo novo e recusa overwrite.

O operador instala o helper como forced command, com conta/chave dedicadas,
sem shell livre ou forwarding, e política fixa em
`/etc/ravi/credential-writer.json`, fora do workspace do agente. Política e
helper precisam de controle do operador; env e estado precisam de isolamento
do processo do agente. Se o agente tiver a mesma conta, chave administrativa,
sudo ou puder alterar o aplicativo para extrair seu ambiente, `0600` não garante
que ele nunca verá o segredo. O registro não cria esse isolamento sozinho.
