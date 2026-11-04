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
