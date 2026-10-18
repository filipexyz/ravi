# Chat de texto da página

Parte da skill pages. Ligar, desligar e ajustar: seção "Chat de texto do Ravi"
da `SKILL.md`. Widgets da org: `widgets.md`. Views e `--uses`: `data-pages.md`.

O chat de texto é uma conversa com o Ravi dentro da Ravi Page. O agente roda no
Console (não nesta máquina), é medido por org e responde como a pessoa que
falou com ele, com o acesso dela.

## Onde aparece

| lugar | como |
|---|---|
| barra do Pages | campo "Fale com o Ravi": abre o painel à direita (embaixo em tela estreita) |
| dentro da página | `<ravi-chat></ravi-chat>`: o chat da rota atual ocupa o container da tag |
| convidado | o link flutuante de convidado abre o mesmo painel |

Dê altura ao container da tag (por exemplo `min-height: 70vh` ou uma página
só com o chat). A tag abre a sala compartilhada da rota.

## Salas e quem fala

- Uma sala compartilhada por rota: todo mundo que abre a página vê as mesmas
  mensagens, com o nome de quem escreveu, e quem está online.
- Uma sala privada por pessoa e rota: só ela e o agente.
- Entram membros da org que leem o projeto e convidados com acesso à rota ou
  ao site (`ravi pages share`). Sem login, não entra.
- A voz (`--enabled`) é um modo da mesma conversa: o que se fala vira mensagem
  na sala.
- Comentário feito na barra aparece na sala compartilhada, preso ao item.

## Quando o agente responde

Sala privada: sempre. Sala compartilhada, com `--reply-policy mention`
(padrão):

- quando alguém chama `@ravi` ou `@<nome do assistente>` (`--name`);
- quando alguém clica num botão de uma resposta dele;
- enquanto só uma pessoa escreveu na sala (ainda é uma conversa a dois).

Com `--reply-policy always`, responde a toda mensagem da sala compartilhada.

## Escrita pede clique

Ler roda na hora. Toda escrita (criar ou mudar linha de Bases, por exemplo)
vira um pedido de confirmação no painel, com o resumo da mudança, para a
pessoa que pediu. Só ela confirma ou cancela. Publicar, mudar visibilidade,
convidar e apagar não estão no chat.

## Blocos da resposta (`ravi.ui/v1`)

Além do texto, uma resposta pode trazer blocos:

| bloco | o que mostra |
|---|---|
| `widget` | um widget da Library da org, pelo ref, com os dados da resposta |
| `view` | uma view de Bases por referência (`list`, `table`, `board` ou `gallery`) |
| `chart` | um gráfico de Bases pelo id |
| `actions` | botões; o clique vira mensagem na sala |
| `card` | título, texto, campos e um link |

Uma `view` não leva linhas na mensagem: cada navegador carrega as linhas com o
acesso de quem está vendo. Duas pessoas na mesma sala podem ver linhas
diferentes, e quem não lê a view não vê nada dela.

## Conversas numa Base

Quando a org tem Bases, as mensagens das salas compartilhadas também vão para
uma Base somente leitura do projeto, `conversas-pages` (view `Conversas`, uma
linha por mensagem: texto, quem escreveu, papel, origem texto/voz/comentário,
página e hora). Leia com `ravi bases` como qualquer Base. Salas privadas nunca
entram; mensagem apagada perde o texto lá também.

## O que o autor da página controla

- Os dados: na sala compartilhada o agente só lê o que a página já usa (o
  `--uses` do host) e o conhecimento liberado para quem vê páginas. Quer que o
  chat responda sobre uma view? Use a view na página.
- Os widgets: o agente usa os widgets da Library da org. Um widget novo passa
  pela proposta de sempre (`widgets.md`).
- O tom: `--name` e `--instructions` valem para voz e texto.
- O modelo: `--text-model <provedor>/<modelo>`, ou `--clear-text-model` para o
  padrão da plataforma.
- Perguntar ao Ravi: `--ravi-agent <installation-id>/<agente>` deixa o agente
  da página mandar um pedido da Library para um agente de uma máquina Ravi da
  org. O agente precisa aceitar pedidos (`ravi agents requests <agente> on
  --execute`). O pedido chega como da pessoa que perguntou no chat (nunca do
  operador): o agente responde em texto e não age na máquina por ela. A
  máquina busca esses pedidos a cada 30 s enquanto tem agente aceitando
  pedidos.
