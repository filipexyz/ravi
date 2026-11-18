# Preparar cada instalação (uma vez)

Quem faz é o dono, no terminal dele, com o CLI instalado (o que bate com o daemon que está rodando). Nenhuma chave passa pelo chat. Use os nomes da config (`local`, `vps-a`, ...) e troque os `<...>`. Faça na ordem: 1 e 2, a config (3), a chave emissora (4), a de revogação se quiser (5), o túnel (6) e só então confira (7).

## 1. Gateway HTTP só em loopback e a origem da página no CORS

Em `~/.ravi/.env` de cada instalação (a do computador e a de cada VPS):

```bash
RAVI_HTTP_HOST=127.0.0.1
RAVI_HTTP_PORT=<porta>                                   # ex.: 4211
RAVI_CORS_ORIGINS=https://<org>-<projeto>.ravi.page      # o projeto dedicado; várias separadas por vírgula
```

Nunca `RAVI_GATEWAY_NETWORK_AUTHORIZED=1`. Depois, um restart autorizado do daemon instalado (`ravi daemon restart`, com o CLI instalado). Confira: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<porta>/api/v1/_meta/version` imprime `200`.

## 2. Pasta do helper e o helper

No computador onde o agente roda (o helper fica só nele; nas VPSs basta a pasta). Pelo gateway, `skills show --raw` devolve JSON, por isso o conteúdo sai com `--json` e um filtro:

```bash
mkdir -p ~/.ravi/pairing && chmod 700 ~/.ravi/pairing
ravi skills show connect-installations --file scripts/pair.ts --json \
  | bun -e 'const j = JSON.parse(await Bun.stdin.text()); if (!j.file) process.exit(1); process.stdout.write(j.file.content)' > ~/.ravi/pairing/pair.ts
chmod 600 ~/.ravi/pairing/pair.ts
head -2 ~/.ravi/pairing/pair.ts   # deve começar com "#!/usr/bin/env bun"; se não, copie o arquivo da pasta da skill
```

O agente que vai aprovar precisa conseguir rodar `bun ~/.ravi/pairing/pair.ts` no shell dele e ler essa pasta. Nas VPSs:

```bash
ssh -a <alias> 'mkdir -p ~/.ravi/pairing && chmod 700 ~/.ravi/pairing'
```

## 3. Config do helper

`~/.ravi/pairing/config.json` (ou o caminho em `RAVI_CONNECT_CONFIG`), modo 600:

```json
{
  "allowedOrigins": ["https://<org>-<projeto>.ravi.page"],
  "linkTtlDays": 60,
  "chat": {
    "whatsapp": "https://wa.me/<numero-do-agente>",
    "slack": "https://<workspace>.slack.com/app_redirect?channel=<id-da-dm-com-o-agente>"
  },
  "installations": {
    "local": {
      "baseUrl": "http://127.0.0.1:<porta>",
      "reach": { "type": "http", "url": "http://127.0.0.1:<porta>", "issuerKeyFile": "~/.ravi/pairing/issuer.key" },
      "revoke": { "via": "manual" },
      "scope": { "sessions": ["<sessao-1>", "<sessao-2>"], "agents": ["<agente-1>"] }
    },
    "vps-a": {
      "baseUrl": "http://127.0.0.1:7801",
      "reach": { "type": "ssh", "alias": "vps-a", "issuerKeyFile": "~/.ravi/pairing/issuer.key", "ravi": "ravi" },
      "revoke": { "via": "manual" },
      "scope": { "sessions": ["<sessao-3>"], "agents": [] }
    }
  }
}
```

- `baseUrl`: como a página vê a instalação (a porta local ou a do túnel). Só loopback. O mesmo valor vai fixo no `createConnect` da página.
- `scope`: o que a página enxerga ali. `sessions`: nomes exatos de `ravi sessions list`; `agents`: ids de `ravi agents list`. Sem curinga. Lista vazia é permitida, mas então a página não vê sessão nenhuma. Escolha só sessões que você aceita ver na página ao vivo: mensagens, respostas, chamadas de ferramentas e pedidos de aprovação.
- `reach`: como o helper chega nela. `http` só aceita loopback. `ssh`: o helper roda `ssh -a -x <alias> ravi context issue ...` com a chave da própria VPS (os caminhos `issuerKeyFile` e `keyFile` são da VPS). Ele acrescenta `~/.bun/bin` e `~/.local/bin` ao PATH lá; se `ravi` estiver em outro lugar, ponha o caminho completo.
- `revoke.via`: `manual` (padrão; só imprime o comando para você rodar e não precisa do passo 5). Com a chave do passo 5, o agente desconecta sozinho: na instalação local `{ "via": "http", "keyFile": "~/.ravi/pairing/revoker.key" }`; numa VPS `{ "via": "cli", "keyFile": "~/.ravi/pairing/revoker.key" }` (roda `ravi context revoke` lá, pela ssh, com o arquivo da VPS).
- `linkTtlDays`: de 1 a 60. O helper recusa 0 e acima de 60.

## 4. Chave emissora (TTL explícito, direto para arquivo 0600)

O CLI do operador usa a chave admin (`daemon init-admin-key`), que vive 90 dias. A emissora vem dela, com 89 dias e só o que os presets e o escopo daquela instalação precisam. Nunca rode `context issue` sem `--ttl` ou com `--ttl 0m`: ttl 0 herda a validade inteira do pai.

```bash
CAPS="$(bun ~/.ravi/pairing/pair.ts caps <instalação>)"   # ex.: read:context:info,mutate:context:issue,read:...,access:session:<nome>,view:agent:<id>
echo "$CAPS"   # confira: nenhum *, nenhum admin, nenhum revoke
(umask 077; ravi context issue pairing-issuer --allow "$CAPS" --ttl 89d --json \
  | OUT="$HOME/.ravi/pairing/issuer.key" bun -e 'const j = JSON.parse(await Bun.stdin.text()); if (!j.contextKey) { console.error(JSON.stringify(j.error ?? j)); process.exit(1); } await Bun.write(process.env.OUT, j.contextKey + "\n"); console.log("gravado", j.contextId, "vence", new Date(j.expiresAt).toISOString())')
chmod 600 ~/.ravi/pairing/issuer.key
```

Anote o `contextId` que ele imprime (`status --probe` também mostra): é o que você revoga para trocar a emissora.

Se o comando responder `REMOTE_CONTEXT_REQUIRED` ou `Missing RAVI_CONTEXT_KEY`, o seu terminal não tem a chave admin: ela fica em `~/.ravi/credentials.json` quando `ravi daemon init-admin-key` roda sem `--print-only`.

Sem o `conversar`, tire `mutate:sessions:send` do `CAPS`. Para uma VPS: rode o `caps <vps>` no computador (a config fica nele) e copie o texto (não é segredo). Entre na VPS (`ssh vps-a`) e rode lá, num terminal normal, o mesmo bloco acima com `CAPS='<o texto copiado>'` no lugar da primeira linha. A chave da VPS nasce e fica na VPS, em `~/.ravi/pairing/issuer.key` com modo 600; o helper confere o modo antes de ler.

Mudou o escopo (sessões ou agentes)? Acrescentar basta refazer este passo e reconectar a página. Para tirar uma sessão, revogue antes a emissora antiga (`ravi context revoke <contextId da emissora>`; isso derruba os links dela), refaça este passo e reconecte.

## 5. Chave de revogação (opcional: só se o agente for desconectar sozinho)

O `context revoke` não confere dono: quem tem essa chave revoga qualquer contexto daquela instalação pelo id, inclusive o admin (o que derruba tudo que veio dele). O helper só a usa para os links que ele mesmo registrou, e confere nome e pai antes; mas o arquivo fica ao alcance do agente. Ela nunca vai para página nenhuma.

Se preferir não deixar essa chave em disco, pule este passo e use `"revoke": { "via": "manual" }` na config: no "desconectar", o helper imprime o comando `ravi context revoke <id>` e é você quem roda, no seu terminal.

Para o agente desconectar sozinho, crie a chave (ela só revoga e lê `context info`):

```bash
(umask 077; ravi context issue pairing-revoker --allow mutate:context:revoke,read:context:info --ttl 89d --json \
  | OUT="$HOME/.ravi/pairing/revoker.key" bun -e 'const j = JSON.parse(await Bun.stdin.text()); if (!j.contextKey) { console.error(JSON.stringify(j.error ?? j)); process.exit(1); } await Bun.write(process.env.OUT, j.contextKey + "\n"); console.log("gravado", j.contextId, "vence", new Date(j.expiresAt).toISOString())')
chmod 600 ~/.ravi/pairing/revoker.key
```

Na VPS, o mesmo, lá (entre com `ssh vps-a`).

## 6. Túnel para cada VPS, sempre de pé

`~/.ssh/config` no computador do dono:

```
Host vps-a
  HostName <host-da-vps>
  User <usuario>
  ForwardAgent no

Host vps-a-tunel
  HostName <host-da-vps>
  User <usuario>
  ForwardAgent no
  LocalForward 127.0.0.1:7801 127.0.0.1:<porta-da-vps>
  ExitOnForwardFailure yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

Mantenha com `autossh -M 0 -N vps-a-tunel` numa unidade que volta depois de reiniciar (systemd do usuário: `ExecStart=/usr/bin/autossh -M 0 -N vps-a-tunel`, `Restart=always`, `systemctl --user enable --now`; no macOS, um LaunchAgent com `KeepAlive`). O helper usa o alias `vps-a` com `-a`, `ClearAllForwardings=yes` e sem conexão mestre; ele não depende do túnel. A página depende.

## 7. Conferir

```bash
bun ~/.ravi/pairing/pair.ts status --probe
```

Confere, por instalação: arquivo da chave, validade e capacidades da emissora (falta, sobra ou proibida), e se cada `baseUrl` responde com o CORS de cada origem da config, como a página vai chamar (túnel e daemon). Nenhuma linha pode ter `PROBLEMA`.

## 8. Chrome

Na primeira vez que a página chamar `127.0.0.1`, o Chrome pergunta sobre acesso à rede local: permita para o host do projeto.

## Rotação (antes da chave admin vencer, a cada ~85 dias)

Não dá para criar a nova admin antes: `ravi daemon init-admin-key` recusa (`ADMIN_CONTEXT_EXISTS`) enquanto existe uma admin viva. Por isso a rotação derruba as conexões daquela instalação:

1. `ravi context whoami` mostra o `contextId` da admin; revogue-a: `ravi context revoke <id> --reason rotacao`. Isso derruba a emissora, a de revogação, todos os links dela e qualquer outra chave que você tenha emitido a partir da admin (de outros apps, por exemplo).
2. `ravi daemon init-admin-key` (grava a nova em `~/.ravi/credentials.json`).
3. Refaça os passos 4 e 5 e `status --probe`.
4. Reconecte as páginas (cada uma pede de novo). As linhas antigas de `pair.ts list` já caíram com a admin; elas aparecem como "ativa" até a data delas, e não precisam de "desconectar".
