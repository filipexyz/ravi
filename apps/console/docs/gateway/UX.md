# Gate Gestalt — integração do gateway (antes do código da interface)

Inspeção em 31/10/2026: screenshots renderizados `staging/human-bridge-test/evidence/bridge-approval-1280.png` e `bridge-approval-390.png` do workspace console-infra. São referências da implementação anterior, não validação dos novos commits.

Objetivo: escolher instalação/projeto e agente, abrir uma conversa privada, enviar uma mensagem, acompanhar a execução e decidir uma ação quando necessário. A ação principal muda de enviar para decidir enquanto há aprovação pendente. Depois da decisão, os botões desaparecem; o registro permanece. Tentativa incerta conserva seu identificador e conteúdo até confirmação.

- Hierarquia: título/identidade, escolha de contexto e conversa têm níveis claros. Aprovação tem a ação visualmente mais forte. A mensagem de estado duplicada junto ao compositor compete com a decisão, mas ajuda fora do scroll; manter a correlação e não acrescentar outra faixa de status.
- Proximidade: descrição e botões da aprovação estão juntos. Estado e cancelamento ficam no mesmo grupo. O retry deve continuar junto ao aviso da tentativa incerta.
- Similaridade: mensagens do usuário têm fundo próprio; respostas usam texto aberto. Estados terminais seguem o mesmo formato, sem serem confundidos com novas mensagens.
- Região comum: borda contém conversa e decisão; seleção/contexto ficam fora. Preservar essa separação.
- Continuidade/alinhamento: fluxo vertical contexto → histórico → decisão → compositor. No mobile a lista some ao abrir conversa e o retorno fica no topo, evitando duas colunas espremidas.
- Figura-fundo: fundo neutro e cartão branco separam conversa. Não expor HTTP, SSH, cursor ou JWT na experiência humana.
- Fechamento: cartão da decisão comunica unidade; conclusão deve remover affordances ativas e preservar o recibo no histórico.
- Simetria: alinhamento regular ajuda leitura, mas aprovar/recusar não precisam ter pesos iguais; a ação explícita mantém destaque e rótulo completo.
- Destino comum: estado/cancelamento/decisão devem evoluir pelo mesmo turno; mensagens deduplicam pelo ID e eventos pela sequência. Reconnect não cria novo turno.
- Pragnanz: conservar o modelo de conversa, sem painel de comandos técnicos ou segundo protocolo visível.

Densidade e espaço: desktop tem lista de 260px e conversa flexível; mobile usa largura única com margens e controles de pelo menos 44px. Tipografia estabelece título, identidade e texto de 14px com entrelinha legível. Contraste dos botões e figura-fundo estão claros nas referências; verificar estados disabled e foco no teste renderizado. Textos longos quebram linha. O scroll interno pode afastar a aprovação do compositor no mobile: manter status resumido sem CTA extra.

Affordances/feedback: enviar desabilitado durante execução; cancelamento explícito; aprovação exclusiva da ação. Loading, vazio, erro, reconexão, tentativa incerta e sucesso já existem e serão exercitados novamente. Progressive disclosure remove seleção/lista no mobile após abrir, e remove botões após decisão. Acessibilidade: preservar labels, alert/status, navegação por teclado, Enter/Shift+Enter e proteção de IME; validar ausência de overflow em 390 e 1280px.

Composição proposta: manter a composição renderizada e substituir somente o adaptador de chamadas/eventos. Agrupar a tradução do envelope no cliente, conservar IDs de tentativa no retry e encerrar o stream quando acesso for perdido. Não acrescentar controles de canal: a migração é futura. Validar novamente a renderização e os estados depois da integração.

## Permissão de configuração de sessão

Antes de adicionar o rótulo, foi renderizado um protótipo do componente existente
`ProjectPolicyEditor` com o catálogo anterior e CSS da compilação Next, em 1280 e
390px (`policy-before-*.png` no relatório local). A autorização continua seguindo
editar rascunho → salvar → conferir impacto → publicar. O objetivo é conceder uma
ação concreta a uma pessoa/projeto; a ação principal é salvar enquanto há edição,
depois revisar/publicar. O rascunho deixa de competir após publicação.

Hierarquia e continuidade estão bem resolvidas pelas etapas numeradas; proximidade,
região comum e fechamento reúnem Who/Projects/Actions na mesma regra. Similaridade
faz os seletores parecerem equivalentes e a simetria em colunas facilita comparação;
o conflito é a densidade quando Actions está aberto. A nova opção usa uma linha
nesse mesmo grupo. Figura-fundo separa regra e fundo; contraste e tipografia atuais
são preservados. Destino comum: o resumo de Actions acompanha as escolhas e a
prévia da mesma revisão. Pragnanz: um rótulo concreto, sem HTTP/gateway ou nomes de
capability na interface. No mobile, as colunas empilham sem overflow; o protótipo
confirma ambos os tamanhos. Disclosure de roles/grupos/audit reduz ruído. Os estados
de salvamento, erro, draft vazio e revisão vencida permanecem no fluxo existente;
não adicionar CTA, painel ou confirmação. O checkbox mantém label e foco nativos.

Composição: adicionar “Change session model, thinking and display name” ao seletor
de ações de projeto, sem seleção automática e sem alterar o botão de publicação.
Validar depois a presença/legibilidade da opção aberta e a ausência de overflow.

## Verificação renderizada após a mudança

A conversa foi exercitada em Next/OIDC/Postgres de teste, com backend remoto
simulado, em 1280 e 390px. A tela de aprovação desktop e conclusão mobile
preservam hierarquia, agrupamentos e quebra de texto; sem overflow horizontal.
O teste cobre retry com identidade estável, aprovação, cancelamento e perda de
acesso. O editor foi renderizado como protótipo do componente real com CSS Next
e Actions aberto nas duas larguras. A nova opção usa o scroll interno existente,
sem deslocar as etapas ou criar outra ação principal. A publicação de policy
não foi executada neste protótipo.
