# O que este teste não protege

Leia antes de aprovar o primeiro pedido. São limites aceitos para um teste nas máquinas do próprio dono, com preset de leitura e escopo escolhido sessão por sessão.

## Origem compartilhada do projeto do Pages

Todas as rotas de um projeto moram no mesmo host (`<org>-<projeto>.ravi.page`), ou seja, na mesma origem. Qualquer script de qualquer rota desse host lê o IndexedDB da página, abre o envelope e usa o link, enquanto o dono estiver com o navegador aberto. Por isso: um projeto só para isto, ninguém mais publica nele, nada de Page Chat nem script de CDN. Uma rota `/evil` publicada no mesmo projeto consegue usar o link: isto é limite conhecido, não bug.

## A aprovação é da skill, não do gateway

Quem lê o arquivo da chave emissora emite links sem perguntar a ninguém. A frase, o "sim" e o nonce são disciplina do agente e do helper. Um agente enganado por injeção de prompt num turno do dono pode emitir. O estrago fica limitado ao que a chave emissora tem (leitura das sessões e agentes do escopo, inclusive o que acontece nelas ao vivo: mensagens, respostas, ferramentas e pedidos de aprovação; e, se o dono quiser, `sessions send` para elas) e às instalações alcançáveis por loopback ou túnel. `ravi context list` em cada instalação mostra tudo que foi emitido. O ledger (`~/.ravi/pairing/ledger.json`) registra cada instalação antes de emitir: uma emissão interrompida (ssh que travou depois de criar a chave lá) aparece como "emissão interrompida", com o nome do contexto para procurar e revogar.

## Quem vê a rota privada

Membro da org que abre a rota privada pode montar um pedido com a origem do dono e a chave pública desse membro. Se o dono colar no chat o pedido do membro em vez do pedido da própria página, esse membro recebe um envelope que ele abre.

A frase serve para pegar engano (pedido trocado, aba errada, dois pedidos ao mesmo tempo), não é barreira contra quem ataca: são 3 palavras de 256, 24 bits, e quem vê a frase do dono acha um pedido próprio com a mesma frase em segundos (cerca de 2^24 hashes SHA-256). O que segura é o dono copiar o pedido da própria página e responder "sim <FRASE>" para aquele pedido; o helper recusa a frase errada e recusa aprovar se houver mais de um pedido conferido esperando.

## Só Chrome desktop

A página é HTTPS e chama `http://127.0.0.1:<porta>`. Chrome pede a permissão de "rede local" e deixa. Safari e iOS bloqueiam esse acesso. Celular não funciona neste teste.

## Teto de 90 dias

A chave admin (`ravi daemon init-admin-key`) vive 90 dias. A emissora vem dela (89 dias) e os links vêm da emissora (60 dias). Toda chave filha morre junto com o pai: trocar ou revogar a chave admin derruba a emissora e todos os links daquela instalação. "Logar uma vez para sempre" precisa de mudança no gateway (`PEDIDO-LUIS.md`).

## Perfil do navegador copiado

"Não extraível" é uma regra da API do navegador, não do disco. Quem copia a pasta do perfil do Chrome leva a chave e o envelope e pode usar o link até ele vencer ou ser revogado. Revogue com "desconectar <frase>" se o computador sumir.

## O link aberto é portador

Depois de aberto, o link fica em memória da página como uma chave comum: quem roda script naquela origem naquele momento pode copiá-lo e usá-lo de outro lugar, até 60 dias, enquanto alcançar o gateway. Por isso o gateway fica em loopback ou atrás de túnel SSH, nunca exposto, e nunca com `RAVI_GATEWAY_NETWORK_AUTHORIZED=1`.

A hora de validade das chaves de acesso é regra do `connect.js`, não do gateway. Quem tem o link aberto pede filhas com o ttl que quiser até o fim do link (com `--ttl 0m` a filha herda os 60 dias; com `59d`, 59 dias, medido) e pode passar `mutate:context:issue` adiante. Essas filhas sobrevivem a fechar a página; só morrem com o link, porque revogar o link derruba as filhas em cascata. Um teto de ttl por contexto no gateway é pedido ao Luis (`PEDIDO-LUIS.md`).

## O envelope não é assinado

O envelope é selado para a chave da página, mas não traz assinatura do agente, e o pedido é público. Quem consegue publicar `/_link/<código>` no projeto, ou fazer o dono colar um texto, pode selar um envelope válido com chaves dele. Por isso a página fixa o endereço de cada instalação em `createConnect` (só loopback) e recusa envelope que aponte para outro endereço ou traga permissões fora do preset: o máximo que um envelope falso faz é ligar a página a uma chave que vale no gateway do próprio dono. Um envelope falso colado antes não impede o verdadeiro do mesmo pedido: a página guarda cada pedido por 15 minutos e o envelope aberto por último vale. Assinar a concessão com uma chave do helper, cuja parte pública a página fixe, fica para depois do teste.

## Outros

- As chaves ficam guardadas sem hash no `ravi.db` de cada instalação, como todo contexto hoje.
- Cada visita cria em cada instalação um contexto `<host>-acesso` de 1 hora. Em 60 dias de uso, `ravi context list` acumula esses contextos vencidos; aceito no teste. Limpar fica com o operador.
- O túnel SSH caído aparece como "offline", não como "deslogado". Se ele não volta sozinho depois de reiniciar, a página parece ter esquecido a VPS.
- Esquecer o navegador (botão) só apaga o lado do navegador; quem corta o acesso é "desconectar".
- O gateway libera CORS para qualquer origem `chrome-extension://` (fora desta skill). Uma extensão instalada no Chrome do dono e com uma chave `rctx_` em mãos chama o gateway; sem chave, não faz nada.
- A trava do ledger tem uma janela curta entre conferir e apagar uma trava velha (mais de 30 s ou de um processo morto); não apareceu em 600 execuções paralelas.
