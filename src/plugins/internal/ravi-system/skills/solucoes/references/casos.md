# Casos: nove fichas preenchidas

São exemplos de composição, não modelos a copiar. Todo `--shell` usa caminho absoluto, porque roda no cwd do daemon.

## PME-1 · Pet shop: boca sem mão, mão sem boca

Por que é bom: quem fala com estranhos não tem ferramenta, e quem envia não lê texto livre.

```text
FICHA banho-e-tosa
Pessoas: membros=atendentes | de fora=tutores no WhatsApp
CAPTAR: recepcao chat-only na rota (`ravi instances routes add petshop "*" recepcao --dm-scope per-peer`); observer extrator (`ravi observers rules set`)
GUARDAR: solicitacoes (pet, serviço, horário, status, aviso_enviado, conversa = chave da sessão, não o telefone)
MOSTRAR: /agenda private; a view escreve só horário e status
REAGIR: `ravi bases subscribe solicitacoes` + trigger --shell, `data.actor.type == "user"`, --cooldown 5s
AGIR: drena "Horário proposto" sem aviso: `ravi sessions send <conversa> "<campos tipados>"`
RELATAR: — (o board já mostra o dia)
Agents: recepcao chat-only; extrator bootstrap + read:bases.rows:query, mutate:bases.rows:add, mutate:bases.rows:update
Ousadia: observer calado → construída
Não dá hoje: cartão que muda sozinho → a página consulta de novo
```

Regras que pesam aqui: 1, 5, 6, 7, 8.

## PME-5 · Hamburgueria: o boletim de segunda vira promoção

Por que é bom: o dono ouve um áudio no carro, vê a arte e aprova com 👍.

```text
FICHA boletim
Pessoas: membros=dono, cozinheiro | de fora=clientes do grupo de promoções
CAPTAR: PDV por `ravi cron add --shell` + `ravi bases rows import vendas <csv> --execute`; sobras no formulário /estoque
GUARDAR: vendas, estoque, promos (status, msg_aprovacao)
MOSTRAR: gráfico da view de 7 dias (`ravi bases charts data`)
REAGIR: trigger em ravi.inbound.reaction, --cooldown 1s; promo por targetMessageId; sem linha → @@SILENT@@
AGIR: `ravi audio generate` + `ravi media send --ptt --account <conta>`; `ravi image generate`; pedido por `ravi whatsapp group send <grupo-do-dono> "..." --json`, messageId na linha
RELATAR: cron segunda 6h, --message --isolated
Agents: gerente com bases, audio, image, media, whatsapp
Ousadia: voz com arte → construída: dá para ouvir dirigindo
Não dá hoje: texto confiável na arte → preço na legenda
```

Regras que pesam aqui: 1 (cardápio público é snapshot noutro projeto), 5, 7, 8.

## TIM-3 · Contratação: scorecards cegos que congelam

Por que é bom: "ninguém vê a nota do outro antes de enviar a sua" vira um flag que tira a linha da view editável.

```text
FICHA scorecards
Pessoas: membros=entrevistadores, head de pessoas | de fora=candidatos
CAPTAR: formulário (read: [] + create, write.set entrevistador = $viewer.raviUserId)
GUARDAR: candidatos (entrevistadores, data_entrevista), scorecards (candidato_id, liberado, leitores), pessoas (slack_id)
MOSTRAR: /entrevistas private: "Meus" filtra liberado eq false; "Debrief", liberado e leitores contains $viewer
REAGIR: `ravi bases subscribe scorecards` + trigger, actor.type == "user", --cooldown 5s
AGIR: todos enviados → `ravi bases rows update ... --expected-version <v>` liga liberado; `ravi slack messages-send <canal> "Debrief liberado" --execute`
RELATAR: cron 9h cobra scorecard atrasado
Agents: pessoas, com bases e slack
Ousadia: resumo do debrief → construída; CV entra como dado
Não dá hoje: relação entre bases → id em texto
```

Regras que pesam aqui: 4 (sem `false` em write.set), 5, 6, 7.

## TIM-4 · Redação: gente escreve intenção, o agente escreve estado

Por que é bom: repórter marca "pedir revisão", editora marca "aprovar"; só o agente muda o status e publica.

```text
FICHA redacao
Pessoas: membros=repórteres, editores | de fora=leitores do portal
CAPTAR: "Minha mesa" filtra reporter e status eq Pauta; escreve título, body, pedir_revisao
GUARDAR: pautas (pedir_revisao, decisao, pedido_correcao, status); equipe (membro, papel)
MOSTRAR: /redacao private; matéria em snapshot no projeto portal-publico (`ravi cloud projects create portal-publico --visibility public --default-page-site --execute`)
REAGIR: `ravi bases subscribe pautas` + trigger, actor.type == "user", --cooldown 5s, drena três filas
AGIR: publica só se `ravi bases rows history` mostra a decisão de um editor; HTML escapado; `ravi pages ship --project portal-publico --visibility public`
RELATAR: —
Agents: revisor com bases e pages
Ousadia: revisor pelo manual de estilo → construído
Não dá hoje: comentário que acorda → coluna pedido_correcao
```

Regras que pesam aqui: 2 (outro projeto, sem união), 4, 5, 7.

## TIM-7 · Almoxarifado: o celular bipa, a máquina calcula

Por que é bom: a câmera vira leitor de código de barras, e um `--shell` calcula o saldo que Bases não calcula.

```text
FICHA almox
Pessoas: membros=almoxarifes, comprador | de fora=—
CAPTAR: formulário /bipar com getUserMedia + BarcodeDetector; abertura por `ravi bases rows import`
GUARDAR: itens (minimo, saldo, situacao), movimentos (sku, qtd, processado), contagens
MOSTRAR: gráfico por corredor; /contagem no mesmo host, ship com a união do --uses
REAGIR: `ravi bases subscribe movimentos` + trigger --shell, actor.type == "user", --cooldown 5s; drena processado eq false
AGIR: recalcula do zero, grava com --expected-version, repete em VERSION_CONFLICT; chave cont:<lote>:<sku-normalizado>
RELATAR: cron 6h, rupturas ao comprador; cron 7h, divergências
Agents: almox com bases e whatsapp; o cálculo é script
Ousadia: página com câmera → construída
Não dá hoje: comparar colunas → coluna de estado recalculada
```

Regras que pesam aqui: 2, 4, 5, 6, 8.

## FOR-3 · Academia: a catraca que confia na página

Por que é bom: a asserção de 60 s do viewer vira chave: a catraca só abre para a equipe logada no tablet.

```text
FICHA catraca
Pessoas: membros=recepcionistas, dono | de fora=alunos
CAPTAR: /quiosque lê o QR e grava pelo formulário (operador = $viewer.raviUserId)
GUARDAR: alunos (codigo, plano_ate), checkins (resultado, hora, avisado)
MOSTRAR: /quiosque e /painel private, mesma união do --uses; lotação em snapshot público
REAGIR: barrados: `ravi bases subscribe checkins` + trigger --shell, surface == "page", --cooldown 5s; varre com `ravi cron add --every 5m`
AGIR: `ravi whatsapp dm send <tel> "<campos tipados>" --account <conta> --execute`; a API confere aud, exp e jti (`ravi pages assertion audiences set --site <host> --aud catraca --origin <url> --execute`)
RELATAR: QR do mês por `ravi media send --to <chat> --account <conta>`
Agents: nenhum LLM no caminho da catraca
Ousadia: asserção como chave → construída
Não dá hoje: sessão de dispositivo → tablet logado como pessoa
```

Regras que pesam aqui: 1, 2, 3, 5, 6.

## FOR-7 · Canal de vídeos: o jardim que responde

Por que é bom: a pergunta deixada num vídeo vira nota pública e volta a quem perguntou com texto aprovado.

```text
FICHA jardim
Pessoas: membros=autora, editor | de fora=quem comenta, leitores do site
CAPTAR: observer nas conversas da autora; cron --shell com `ravi yt unanswered <videoId> --json`; `ravi watch create`
GUARDAR: jardim (estagio, comentarios, respondidos, resposta_yt)
MOSTRAR: /jardim private para aprovar o texto exato; site estático noutro projeto
REAGIR: `ravi bases subscribe jardim` + trigger --shell, actor.type == "user", --cooldown 5s, varredura --every 15m
AGIR: grava o commentId em respondidos e só então `ravi yt reply <commentId> "<resposta_yt>" --execute`, um por vez
RELATAR: cron de domingo junta duplicadas
Agents: jardineiro com bases; o principal lê só estagio eq Árvore
Ousadia: observer que planta calado → construída
Não dá hoje: chave única → o script deduplica por commentId
```

Regras que pesam aqui: 5, 6, 7 (comentário é dado), 8.

## AGE-1 · Loja online: cofre de ações perigosas

Por que é bom: quem pede não executa; um sócio aprova na página e um guardião sem LLM confere no histórico que foi gente.

```text
FICHA cofre
Pessoas: membros=os dois sócios | de fora=clientes do grupo VIP
CAPTAR: solicitantes só criam: `ravi bases rows add cofre --values @pedido.json --idempotency-key carrinho:cupom-vip:2026-10-07`
GUARDAR: cofre (tipo fechado, alvo, decisao, resultado, body = prévia exata)
MOSTRAR: /cofre private; a view escreve só decisao e nota
REAGIR: `ravi bases subscribe cofre` + trigger --shell, surface == "page" e actor.type == "user", --cooldown 1s
AGIR: confere `ravi bases rows history` (actorId em `ravi bases show cofre --json`), reivindica com --expected-version, executa `ravi whatsapp group send`, `ravi pages visibility` ou `ravi bases rows purge`
RELATAR: cron por hora expira Pendente de mais de 24 h
Agents: solicitantes bootstrap + mutate:bases.rows:add
Ousadia: ledger como prova → construída
Não dá hoje: pôr membro no projeto pela CLI → UI do Console
```

Regras que pesam aqui: 4, 6, 7, 8.

## AGE-6 · Imobiliária: memória em quarentena

Por que é bom: o que um lead "ensina" ao agente só vira memória depois que a equipe confirma.

```text
FICHA memoria
Pessoas: membros=corretor, assistente | de fora=leads no WhatsApp
CAPTAR: observer extrator (`--source-agent leo --events message.user,turn.complete`); tudo nasce em Quarentena
GUARDAR: memoria (interlocutor, fato, status, motivo)
MOSTRAR: /memoria private para confirmar ou rejeitar
REAGIR: — (a mensagem do lead já acorda o agente da rota)
AGIR: leo lê `ravi bases views query memoria <view> --filter <json> --json`, só do interlocutor atual
RELATAR: —
Agents: leo só com read:bases.views:query; extrator bootstrap + mutate:bases.rows:add
Ousadia: ligação de retorno (`ravi prox calls request --profile followup --skip-origin-notify`) → considerada
Não dá hoje: leitura restrita por agente → o filtro é trilho, não muro
```

Regras que pesam aqui: 1, 7, 8.
