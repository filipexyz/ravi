# Teste: conectar uma Ravi Page às suas instalações

## Antes

- Chrome no computador (Safari e celular não funcionam neste teste).
- A skill instalada e liberada para o seu agente, no computador onde ele roda (agentes com perfil full-access também a enxergam):

  ```bash
  ravi skills install --source <repositório>/design/ravi-connect/skill/connect-installations
  ravi skills grant <agente> connect-installations
  ```

- `skill/connect-installations/references/instalacao.md` feito no computador e em cada VPS, na ordem de lá: porta HTTP em loopback, `RAVI_CORS_ORIGINS` com o host do projeto, o helper em `~/.ravi/pairing/pair.ts`, `config.json` com o `scope` de cada instalação (duas ou três sessões suas, pelo nome exato, e os agentes que quer ver), chave emissora em arquivo 600 (a de revogação é opcional), túnel com autossh.
- O agente consegue rodar `bun ~/.ravi/pairing/pair.ts` no shell dele.
- Um projeto do Pages novo, só para isto.
- `bun ~/.ravi/pairing/pair.ts status --probe` sem PROBLEMA (ele também confere se cada `baseUrl` responde com o CORS do projeto, ou seja, o túnel e o daemon).

## Etapa A (copiar e colar)

1. Na DM com o agente (WhatsApp ou Slack): "Monta uma página privada /painel no projeto <projeto>, com a skill connect-installations, que mostra quem sou e as sessões de local e vps-a. Expõe `window.conn` para eu testar."
   Confira no `index.html`: `createConnect({ installations: { local: "http://127.0.0.1:<porta>", "vps-a": "http://127.0.0.1:7801" }, ... })`, os mesmos `baseUrl` da config.
   Confira: rota private, sem `--uses`, `--theme none`; `ravi pages read <url> --format files --out "$(mktemp -d)"` e `grep -r rctx_` na pasta não acha nada.
2. Abra a página no Chrome, permita o acesso à rede local e clique em Conectar. Aparecem uma frase de 3 palavras e o pedido.
3. Copiar pedido, colar na DM. O agente responde a confirmação: página certa, local e vps-a, preset ver, as sessões e agentes do escopo de cada uma, 60 dias, a MESMA frase. Responda "sim <FRASE>".
4. Cole o envelope que ele devolveu no campo "Envelope devolvido pelo agente" e clique em "Usar este envelope". Cada instalação mostra "conectada (até <data>)" e os dados aparecem sem recarregar. A lista de sessões mostra as do escopo e nenhuma outra; a de agentes, o agente da chave mais os do escopo. Lista vazia aqui é falha (escopo errado ou emissora sem as relações; rode `pair.ts status --probe`).

O que olhar:
- DevTools > Application > IndexedDB > `ravi-connect`: procure `rctx_`; nada.
- Em cada instalação, `ravi context list`: um `connect:<host>:<8 primeiros caracteres do nonce>` vencendo em 60 dias.
- `pair.ts list`: a frase, as duas instalações, "ativa".

## Ataques (todos devem falhar)

- Mande de novo o mesmo pedido: recusado (já usado).
- Mude uma letra do pedido: recusado, ou outra frase.
- Responda "sim" com outra frase: recusado, nada emitido, e o pedido é cancelado (depois disso nem a frase certa aprova; clique em Conectar de novo).
- Responda "sim" com a frase certa escrita com acento ou em minúsculas com espaços ("sim cedro farol uvá"): aceito.
- Copie um pedido, espere 11 minutos e mande esse mesmo pedido: recusado (velho).
- Mande o pedido num grupo, ou peça a outra pessoa para mandar: recusado.
- Outro perfil do Chrome: abra a página, Conectar, cole o envelope antigo: recusado.
- No console da página: `[...conn.installs.values()][0].call("context/issue", { cliName: "x", allow: "admin:system:*", ttl: "1h" })`: 403. O mesmo com `"context/revoke"` e `"sessions/send"`: 403. `[...conn.installs.values()][0].fetch("/api/v1/_stream/events").then((r) => r.status)`: 403. `[...conn.installs.values()][0].call("sessions/info", { nameOrKey: "<sessão fora do escopo>" })`: erro 422 `SESSION_NOT_FOUND`.
- Opcional, num projeto rascunho: uma rota `/evil` no mesmo projeto consegue usar a conexão. É o limite conhecido (`references/limites.md`).

## Volta

- Feche o Chrome. No dia seguinte abra a página: conectada, sem pedir nada.
- Pare o túnel da VPS: vps-a "offline", local segue. Suba o túnel e recarregue: volta.

## Desconectar

- "desconectar <FRASE> na vps-a": com `revoke.via: manual` (padrão), o agente devolve o comando `ravi context revoke <id>` para você rodar na VPS; rode e repita o pedido: agora ele responde "revogada". vps-a mostra "precisa reconectar" na próxima chamada; local segue.
- "desconectar <FRASE>": o mesmo para as que restam. Tudo "precisa reconectar"; um stream de sessão aberto fecha em até ~5 s.
- "desconectar <FRASE> na vps-z" (instalação que essa conexão não tem): "não encontrada", nada revogado.
- Com a chave de revogação (passo 5 de `instalacao.md`), o agente revoga direto, sem o comando.
- Conectar de novo gera um pedido novo, com outra frase.
- Renovar antes do fim: com a página conectada não aparece Conectar. Desconecte pela frase antiga (nunca pela origem), espere "precisa reconectar" e clique em Conectar.

## Etapa B (link do chat e entrega na página)

1. Peça ao agente para ligar `stageB: true` com os links de chat da config.
2. Conectar. "Abrir no WhatsApp" abre a conversa com o pedido já escrito: envie. No Slack: "Copiar e abrir o Slack" e cole.
3. Confira a frase e responda "sim <FRASE>". A página conecta sozinha em poucos segundos, sem colar nada.
4. Diga ao agente que conectou: ele sobrescreve `/_link/<código>`; a rota passa a mostrar "removido".
