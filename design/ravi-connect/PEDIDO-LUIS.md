# Pedido ao Luis: login durável de Ravi Page nas instalações

O teste "conectar instalações" roda sem mudar o gateway: a página guarda uma chave própria não extraível e um envelope selado, o agente do dono aprova no chat e emite com `context issue` uma chave de link (60 dias) por instalação, e a página cria chaves de acesso de 1 hora. Foi medido com o código do gateway (cópia do fonte), em estado isolado e sem NATS (`MEASURED.md`, rodadas 1 a 7, e o teste de ponta a ponta deste pacote em `test/e2e`). Na rodada 7 e no teste de ponta a ponta, o lado remoto já usa o CLI de verdade (o ponto de entrada do fonte, falando com o gateway por `RAVI_GATEWAY_URL`).

O que esse teste NÃO exercitou: ssh e sshd de verdade (o passo remoto usou um `ssh` substituto que roda o comando num shell limpo), o CLI `ravi` instalado e empacotado numa VPS, o daemon e o socket dele, o Chrome normal do dono (foi o Chromium de automação, com a permissão de rede local concedida pelo teste), o envio real por NATS (`sessions send` passou da autorização e parou na publicação) e dados reais. As listas só mostram algo com as relações de escopo (item 6): nas primeiras rodadas elas voltaram vazias.

Para passar de teste a produto, com mais de 90 dias e com permissões de escrita, o gateway precisa de sete coisas. Todas mexem em fronteira de autorização, por isso peço aprovação antes de qualquer implementação.

## 1. Um registro de emissor ou de cliente que sobreviva à chave admin

- Hoje: toda chave é filha de outra e não vive mais que o pai. `--ttl 365d` sai com 90 dias (o resto da admin); revogar a admin derruba em cascata todas as filhas (rodadas 3 e 4). Rotacionar a admin desliga todas as páginas, e `daemon init-admin-key` recusa criar a nova enquanto a antiga vive (`ADMIN_CONTEXT_EXISTS`), então toda rotação passa por uma janela sem conexões.
- Pedido: um registro por (instalação, origem, impressão da chave pública da página), fora da cascata da admin, com validade própria (teto absoluto e expiração por inatividade), reaprovação perto do fim, e uso que nunca estende a validade.

## 2. Trocar prova de posse da chave da página por chaves curtas

- Hoje: aberto, o link é um portador de 60 dias em memória; qualquer script da mesma origem (todas as rotas do projeto dividem o host) pode copiá-lo e usá-lo de outro lugar (rodada 5). Em repouso não há `rctx_` em claro (medido), mas em uso há.
- Pedido: uma rota que recebe um JWS assinado pela chave não extraível da página (ECDSA P-256), confere o cabeçalho `Origin` exato contra o registro do item 1, `iat` de até 60 s e `jti` de uso único, e devolve uma chave de 1 hora. Sem portador de longa duração no navegador. É a condição para liberar escrita além de `sessions send`.

## 3. Chaves guardadas com hash

- Hoje: `contexts.context_key` é a chave em claro, `UNIQUE`, procurada direto (`router-db.ts`). Quem lê o `ravi.db` usa qualquer chave viva, inclusive os links de 60 dias.
- Pedido: guardar só o hash (com prefixo de busca) e comparar em tempo constante.

## 4. `context revoke` só para quem tem direito sobre o contexto

- Hoje: uma chave com `mutate:context:revoke` revogou o contexto de OUTRO cliente pelo id (200), e a outra chave passou a receber 401 (rodada 3). Revogar a admin derruba tudo. Por isso nenhuma página, extensão ou link pode ter revoke. No teste, o helper por padrão nem revoga: devolve o comando para o dono rodar e depois confere; uma chave separada só para revogar é opcional.
- Pedido: revoke só de contexto que descende do chamador (ou com `admin`), com auditoria do chamador.

## 5. Aprovação imposta pelo gateway

- Hoje: a frase, o "sim" e o nonce são disciplina da skill. Quem lê `issuer.key` emite links sem perguntar, inclusive um agente enganado por injeção num turno do dono.
- Pedido: emitir um link (o registro do item 1) exige um cartão de aprovação do serviço de aprovação, ligado ao hash do pedido, mostrado com a frase, aprovado só pelo dono identificado. A chave emissora em disco deixa de existir.

## 6. Escopo de sessões e agentes para chaves de página

- Hoje (rodada 6): uma chave filha do admin herda o agente `bootstrap`; com só as capacidades de comando, `sessions list` volta vazia, `agents list` mostra só o próprio agente e `sessions info`/`send` dão "não encontrada". Só com as relações `access:session:<nome>` e `view:agent:<id>` as listas aparecem. Com `access:session:*` e `view:agent:*` aparece tudo.
- No teste: o dono lista na config os nomes exatos de sessões e agentes por instalação, e a emissora e cada link levam só esses nomes. Nenhum curinga. Mudar o escopo exige refazer a emissora.
- Pergunta: as duas relações com curinga (`access:session:*`, `view:agent:*`) podem entrar num preset de página? Ou o gateway ganha um escopo próprio para chaves de página (por exemplo, "sessões do agente X", ou uma lista mantida no registro do item 1) que dispense refazer a emissora? Até a resposta, fica a lista nomeada.

## 7. Teto de ttl para filhas

- Hoje: quem tem `mutate:context:issue` cria filhas que vivem até o fim do pai (`--ttl 0m` herda os 60 dias; `59d` dá 59 dias, medido no e2e). A hora de validade das chaves de acesso é só regra do `connect.js`.
- Pedido: um teto de ttl para filhas, gravado no contexto do link (por exemplo 1 hora), e um bit que impede a filha de herdar `mutate:context:issue`.

## O que não muda

- `rctx_*` continua a única credencial aceita; `context issue` continua limitando a filha às capacidades e à validade do pai (403 "Capability not granted by parent context", medido).
- CORS por lista exata (`RAVI_CORS_ORIGINS`), gateway em loopback ou atrás de túnel, nunca exposto.
- Revogar e expirar continuam fechando streams abertos (o servidor confere a cada evento e a cada ~5 s; 314 ms depois do revoke com um evento a cada 500 ms, medido) e os códigos `CONTEXT_EXPIRED` e `AUTH_REQUIRED` continuam distintos.
- O lado da página (chave em IndexedDB, frase, envelope, cartão) e o fluxo pelo chat do agente continuam; o helper vira cliente das rotas novas.

Enquanto 2, 4 e 7 não existirem, o teste fica nos presets `ver` e `conversar`, com escopo nomeado e links de até 60 dias.
