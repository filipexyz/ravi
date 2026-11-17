# Intenção na saída por canal — plano para revisão

**Estado:** desenho proposto; implementação bloqueada até revisão aprovada. **Base:** `origin/dev` em `206093f8cdc7736ec5638c5a314f8a90dd17237a` (15/11/2026). **Dona:** sessão `main-t-1794776629328249`; worktree `/Users/luis/dev/filipelabs/ravi-channel-intent-20261115`, branch `plan/ravi-channel-intent-20261115`.

## 1. Contrato e limites

Reutilizar `ChannelOutputEnvelope`; acrescentar intenção, não outra linguagem de conteúdo. O envelope de um produtor novo terá:

```ts
type OutputPurpose = "decisao" | "resultado" | "blocker" | "artefato";
type OutputActionRef = { label: string; url: string };

type AuthoredChannelOutput = ExistingChannelOutputEnvelope & {
  purpose: OutputPurpose;
  summary: string;
  actionRefs?: OutputActionRef[];
};
// Preservados: protocol, schemaVersion, outputId, correlationId, causationId?,
// traceTurnId?, binding, target, kind, emittedAt.
// assistant_message: content: Array<text | artifact>, sem error.
// safe_error: error: ChannelSafeError, sem content, purpose: "blocker".
```

- `summary`: texto não vazio, até 1.200 pontos de código; explicita o resultado ou o que a pessoa precisa responder. É independente de `content` e obrigatório também para `safe_error`. Não depende de botão, cor, imagem ou anexo. Texto completo continua em `content`.
- `actionRefs`: no máximo três links de navegação, em ordem de importância; `label` entre 1 e 60 caracteres; URL HTTPS ou deep link Slack validado. Nunca shell, callback, permissão, token ou `file://`. Link interno só entra se o recurso já tiver acesso válido para o destinatário. Sem acesso confirmado: arquivo entregue no canal ou texto.
- Esta fase usa ações de **abrir/revisar/consultar**. “Aprovar” não será um botão fictício: opções de resposta aparecem no resumo e seguem o fluxo humano existente. Não implementar handlers genéricos, aprovação por clique ou respostas numéricas automáticas. A referência não concede autoridade.
- `purpose` vem do produtor tipado; não de regex sobre perguntas, Markdown ou texto de ferramentas. Acrescentar `outputIntent?: {purpose, summary, actionRefs?}` ao contrato de metadados de resposta e propagá-lo até a montagem do envelope. Produtores que já emitem envelopes podem preenchê-lo diretamente; respostas de modelo sem essa informação usam a normalização abaixo. **Não há hoje um emissor estruturado de intenção nos providers**: esta entrega fornece o contrato e os defaults, sem prometer classificar automaticamente toda pergunta como `decisao`.
- Default determinístico: erro seguro → `blocker`; conteúdo exclusivamente de artefatos → `artefato`; demais respostas → `resultado`. `decisao` exige intenção explícita. Conteúdo misto não é automaticamente `artefato`.

**Compatibilidade solicitada:** manter `schemaVersion: 1` e aceitar ausência conjunta de `purpose/summary/actionRefs` na borda antiga. Não preencher defaults no parser que participa do hash. Um normalizador puro produz a visão de apresentação sem regravar o envelope/job antigo: resumo extraído do primeiro parágrafo útil, corpo integral preservado; artefato usa nome legível; erro usa mensagem segura. Novos produtores validam os campos antes de congelar o output. Payload parcialmente preenchido/inválido é erro de contrato, não silêncio; resposta antiga válida continua entregável. Jobs já persistidos conservam bytes, hash e renderer antigos; campos novos entram no fingerprint apenas quando presentes. A compatibilidade fica em uma borda, sem duas implementações de domínio.

## 2. Exemplos de apresentação

Exemplos de produto com recursos de teste, não envios reais. Nas fixtures, `plano`, `resultado` e `relatório` apontam para recursos autorizados do destinatário. O mesmo envelope alimenta os dois canais; somente `target` e a projeção diferem.

| Purpose / conteúdo | Resumo obrigatório | Slack | WhatsApp |
| --- | --- | --- | --- |
| `decisao`, `text` com plano | “O plano de saída por canal está pronto para revisão. Responda ‘aprovar plano’ ou diga o ajuste necessário.” | Card “Revisão do plano”, resumo e botão **Revisar plano**, ligado ao documento. As duas opções permanecem no texto acessível. | O mesmo resumo; “1. Revisar plano: <link>”. As respostas são texto comum, sem confirmação automática de decisão. |
| `resultado`, `text` com evidências | “A correção passou nos testes focados. A PR está pronta para revisão; produção ainda não foi alterada.” | Card “Correção pronta”, resumo e **Abrir PR**. | Resumo e “1. Abrir PR: <link>”. |
| `blocker`, `text` com dependência | “A publicação está parada porque falta o arquivo de entrada. Envie o CSV neste chat para continuar.” | Card “Falta o CSV”, resumo e **Ver formato do CSV**, se houver referência válida. | Resumo e “1. Ver formato do CSV: <link>”. Sem referência, só a instrução de enviar o arquivo. |
| `artefato`, `artifact` com ID do relatório | “O relatório está pronto. Ele reúne os resultados e as limitações dos testes.” | Card “Relatório pronto”, resumo e **Abrir relatório** após confirmar acesso; na ausência de link, arquivo no canal. | Resumo seguido do arquivo; link opcional “1. Abrir relatório”. Nunca mostrar caminho local ou ID cru como se fossem acesso. |

O exemplo `safe_error` é `purpose: blocker`, resumo seguro como “Não consegui concluir esta solicitação. Tente novamente mais tarde.” e `error` estruturado existente; nenhum stack trace ou texto bruto de exceção.

## 3. Composição e gate visual antes de código

Objetivo da pessoa: identificar se precisa agir, saber o próximo passo e acessar detalhes sem percorrer um relatório. Ordem: estado/pergunta → resumo → ação → detalhe. Uma resposta resolvida deixa de pedir decisão; este trabalho não modifica nem sincroniza cards de threads.

Diagnóstico a partir do fluxo e requisitos: hoje intenção desaparece quando o envelope vira string; anexos podem aparecer como rótulo sem acesso; detalhes longos competem com a instrução. Proposta: uma região compacta, uma ação principal e até duas secundárias; detalhes extensos em documento/arquivo. Labels técnicos, IDs e telemetria ficam fora da mensagem.

| Princípio Gestalt | Composição proposta e conflito a validar |
| --- | --- |
| Hierarquia visual/atencional | Resumo completo e verbo da ação antes dos detalhes; título curto não repete a primeira frase. Evitar quatro badges competindo com o pedido. |
| Proximidade e região comum | Resumo e links do mesmo output agrupados; no WhatsApp, legenda/resumo imediatamente antes do arquivo. |
| Similaridade | Mesma ordem nos quatro purposes e nos dois canais; diferenciar propósito por palavras, não apenas cor. |
| Continuidade e alinhamento | Leitura vertical única e alinhamento à esquerda; links na ordem do texto, sem colunas no mobile. |
| Figura-fundo | Card delimitado no Slack; separação por parágrafos no WhatsApp. Contraste nativo, sem depender de fundo colorido. |
| Fechamento | Resumo compreensível sozinho, incluindo a ação requerida; arquivo indisponível recebe feedback explícito, sem parecer entrega completa. |
| Simetria | Equilíbrio do bloco, sem impor botões iguais que escondam a ação principal. |
| Destino comum | Resumo, ações e anexo pertencem ao mesmo output congelado; falha do anexo não transforma o texto em sucesso total. |
| Prägnanz | Uma composição fixa por canal; nenhuma DSL, catálogo de widgets ou informação de implementação. |

Densidade: até três links, corpo longo fora do card; ritmo: um título, um resumo, ações. Escala tipográfica nativa; rótulos autoexplicativos; acessibilidade inclui todo resumo, opções e destinos no `text` top-level. Empty: não inventar um card sem conteúdo. Loading: presença existente, sem novos avisos periódicos. Error: texto independente do renderer. Success: resultado e acesso ao material. Responsividade: validar Slack desktop/mobile e WhatsApp mobile, links extensos, leitores de tela e caracteres/emoji.

**Limite da inspeção atual:** o repositório não forneceu screenshot/protótipo renderizado; builders e fixtures não comprovam UX visual. A análise acima é preliminar sobre o novo fluxo. Antes de escrever a implementação visual da PR 2, inspecionar a experiência renderizada em superfície de teste ou protótipo aprovado, registrar screenshots e ajustar este diagnóstico. Validar novamente após implementação nos mesmos tamanhos. Este gate não está dado como concluído.

## 4. Montagem atual → proposta

**Slack hoje:** `host-event-loop.ts:2334/2401` passa texto para `projectChannelRuntimeEvent`; `runtime-events.ts:838` monta o envelope terminal; `slack/driver.ts:128–158` o reduz a um job textual; `outbound-consumer.ts:962` passa texto/formato para o adapter; `slack/socket-mode.ts:347` chama o renderer. Manter a montagem terminal no mesmo local, acrescentando intenção antes da persistência e levando-a inteira até a entrega.

**WhatsApp hoje:** `omni/consumer.ts:1055` persiste a mensagem canônica, mas não guarda o retorno. `host-event-loop.ts:3013–3078` resolve o destino e emite `ResponseMessage`; `gateway.ts:1160` normaliza `text|media`; `gateway.ts:1434/1603` envia via `OmniSender`. Não existe envelope backend nesse trajeto.

**Ponte WA proposta:** capturar o ID canônico já retornado pelo consumer e carregá-lo em metadado de origem de saída, separado de `_channelBackend`. No host, após a política e resolução de destino existentes, montar `ResponseMessage.output?: ChannelOutputEnvelope` com esse binding, sessão real, `traceTurnId` físico e destino capturado. O transporte de transição continua sendo o mesmo evento de resposta: `output` é a fonte semântica quando presente; `response/content` são apenas representação legada e não uma segunda entrega.

- `binding.messageId` continua sendo a mensagem canônica de origem; `binding.chatId` não muda para disfarçar um attach a outro chat. `target` aponta para o destino já autorizado. Nenhum ID de Chat/Message/Turn será inventado para satisfazer o schema.
- Para WA, usar o Chat canônico do destino como handle opaco de `target.conversationId`; o adapter resolve o JID pela proveniência desse chat e valida conta/instância. JID com `@` não é aceito pelo schema de ID opaco. O target resolvido é congelado, nunca substituído pelo default atual da sessão durante entrega.
- Não marcar o prompt WA como `_channelBackend`: hoje isso suprime o texto em `emitResponse` e mudaria ownership/ingress. O novo metadado só fornece proveniência para egress.
- **Borda explícita de migração:** respostas antigas, turnos sem origem canônica e saídas proativas sem binding completo continuam no caminho `ResponseMessage`, com o mesmo normalizador/projetor textual. A primeira integração de envelope completo cobre respostas de turnos WA com origem canônica; migrar ingress/cron/triggers não é requisito desta fase. Nunca perder a resposta antiga por ausência de binding.
- `ResponseMessage.content` continua `text|media`; não inserir `artifact` ali. Resolver referências do envelope para arquivo/link autorizado antes de projetá-las em partes de transporte. Mídia gerada preserva descriptor, chave idempotente e ownership; não duplicar upload quando envelope e descriptor referirem o mesmo artifact.

## 5. Arquivos e PRs pequenos, em ordem

| PR | Arquivo | Mudança prevista |
| --- | --- | --- |
| 1 — contrato | `src/channels/backend.ts` | Schema de intenção opcional na leitura legada, validação de produtor novo, invariantes `kind/content/error`. |
| 1 | `src/channels/output-intent.ts` (novo) | Normalizador puro, resumo seguro e serialização textual completa de resumo/opções/links; sem I/O e sem inferência de aprovação. |
| 1 | `packages/ravi-os-sdk/src/channel-backend.ts`, fixtures e `src/generated/channel-backend-core.schema.json` do SDK | Espelhar contrato e atualizar snapshots verificados pelos testes do SDK; preservar envelopes antigos e hashes. |
| 1 | `src/runtime/types.ts`, `src/runtime/message-types.ts` | Metadado tipado `outputIntent`, proveniência de egress WA e `ResponseMessage.output` opcional. Sem habilitar produção antes dos consumidores. |
| 2 — Slack | `src/channels/runtime-events.ts`, `src/runtime/host-event-loop.ts` | Montagem de intenção e captura antes de congelar terminal; persistir intenção no payload terminal para readback/replay. |
| 2 | `src/channels/slack/driver.ts` | Parar de perder intenção ao criar job; resolver conteúdo de artefato por mecanismo autorizado, não `[Attachment: id]`. |
| 2 | `src/channels/outbound-stream.ts`, `src/channels/native/types.ts`, `src/channels/outbound-consumer.ts` | Campo tipado de intenção/conteúdo no job e request; preservar destino, idempotência e policy guards. |
| 2 | `src/channels/slack/output-intent.ts` (novo), `slack/socket-mode.ts`, `slack/markdown-delivery.ts` | Composição fixa, ação de link, `text` acessível completo e fallback local. Alterar só a entrega de mensagens em socket-mode, nenhuma lógica de thread. |
| 2 | `src/channels/slack/automatic-terminal-manifest.ts` | Incluir digest da intenção/conteúdo estruturado no manifesto novo; validar no consumer. Manifestos antigos mantêm sua identidade; mudança de resumo/link com outputId reutilizado conflita. |
| 3 — proveniência WA | `src/omni/consumer.ts`, `src/runtime/message-types.ts` | Carregar retorno canônico da mensagem para o host; testes de reply/edit/attach. Sem migrar backend ingress ou rotas. Ainda não trocar o sender. |
| 4 — entrega WA | `src/channels/whatsapp/output.ts` (novo), `src/runtime/host-event-loop.ts`, `src/gateway.ts` | Montar envelope elegível; ramo exclusivo de projeção; resumo primeiro, opções textuais, arquivo/link e partes; reutilizar queue por sessão e entrega de mídia existentes. |
| 4 | `src/omni/sender.ts` | Somente se necessário, opção explícita para não repetir automaticamente envio de partes sem garantia de idempotência; preservar defaults legados. Sem regras de layout neste arquivo. |

Em cada PR, acompanhar testes do comportamento e specs: `channels/backend`, `sessions/turn-output`, `channels/adapters/slack`/`channels/slack/block-kit` e nova `channels/output-intent` com CHECKS/WHY/RUNBOOK. Nenhum arquivo `thread-*`, lifecycle de thread ou `decisions/delivery.ts` entra no diff. Se item 1 exigir tocar a mesma região de entrega, parar e reportar ao orquestrador antes da edição.

Cada PR precisa passar isoladamente. Habilitar produção somente quando o consumidor daquela PR existir; nenhuma migração de rows/hashes antigos. Publicar commits pela sessão autenticada usando `ravi pr publish` (preview, conferir, `--execute`) e registrar testes/comandos no corpo. Revisão do plano primeiro; revisão independente do diff depois. Não executar restart/deploy, instalação pesada, build ou suíte completos neste host.

## 6. Excesso, erro e silêncio

1. Policy existente decide entrega/silêncio antes do renderer. `purpose` nunca silencia, concede acesso ou altera destino.
2. Mensagem normal: resumo completo e links; detalhes curtos podem seguir no corpo sem repetir resumo.
3. Excesso: Slack reaproveita Canvas compartilhado → arquivo → texto inline; WA usa arquivo/link com acesso confirmado. Orçamentos iniciais: preservar os limites locais Slack (11.000 Markdown / 3.500 mrkdwn por parte); WA, 3.500 pontos de código por parte como limite conservador do produto, não alegação de limite da API. Não cortar URLs, emoji ou cercas no meio.
4. Se documento/link falhar ou não puder ser compartilhado, enviar texto completo em partes numeradas e ordenadas, com resumo na primeira. Artefato binário indisponível produz resumo e aviso factual da indisponibilidade; não há conversão fictícia em texto.
5. Exceção/retorno vazio do renderer ou rejeição de payload rico comprovadamente não enviado → texto de fallback pré-validado, sem chamar o renderer quebrado. Não retornar `[]`, `empty_response` ou `silent` por falha visual.
6. Timeout após tentativa de envio é resultado incerto, não falha de render. Não enviar uma versão alternativa automaticamente. Manter estado de erro/incerteza e evidência; nunca afirmar entrega. Partes já confirmadas não são repetidas quando uma posterior falha. WA não ganha promessa de exactly-once: o sender atual repete TypeError/5xx sem chave idempotente; o caminho novo deve evitar esses retries ambíguos.
7. Guard de Knowledge, acessibilidade, menções, actor metadata, TTS, traceTurnId e cleanup de mídia continuam obrigatórios. Se o guard proibir arquivo/link, usar texto permitido em partes; não ampliar acesso para “resolver” excesso.

## 7. Critérios de teste e done

Matriz mínima: **oito fixtures** (cada linha da seção 2 em Slack e WA), assertando resumo legível, purpose, destino, ação/link ou instrução equivalente e ausência de IDs internos visíveis. Cada uma roda nos modos normal, excesso e renderer lançando/retornando vazio. Testes de transporte usam mocks; não enviar a pessoas para validar.

| Suítes focadas | Critérios adicionais |
| --- | --- |
| `src/channels/backend.test.ts`, `output-handoff.test.ts`, `runtime-events.test.ts`; SDK `channel-backend-core.test.ts` | Legado sem purpose preserva texto/hash; novo resumo vazio é recusado antes de entrega; safe_error sanitizado; alteração de summary/actionRefs conflita; readback/replay retém semântica. |
| `src/channels/slack/driver.test.ts`, `markdown-delivery.test.ts`, `markdown-layout.test.ts` | `text` top-level contém a instrução inteira; link/arquivo acessível; Canvas sem compartilhamento → arquivo; falha do arquivo → partes; `invalid_blocks` e throw local → texto. |
| `src/channels/outbound-consumer.test.ts`, `src/channels/slack/automatic-text-delivery.test.ts`, `src/runtime/slack-automatic-terminal.test.ts` | Manifesto inclui intenção; uma entrega por output; timeout não dispara fallback; destino/trace e mídia congelados. |
| `src/omni/consumer-context.test.ts`, novo `src/channels/whatsapp/output.test.ts` | Binding usa IDs persistidos; JID não entra como ID opaco; attach preserva origem e destino distintos; falta de binding usa borda legada; quatro purposes, links e partes. |
| `src/gateway-native-delivery.test.ts`, `gateway-response-order.test.ts`, `gateway-session-trace.test.ts`, `src/omni/sender.test.ts` | Envelope + fields legados não duplica; artifact não é descartado pelo normalizador; resumo antes da mídia nova; silêncio explícito inclusive marcador fragmentado; citação do marcador visível; ordem por sessão, falha na parte 2 não repete parte 1; incerteza remota visível. |
| `src/runtime/generated-media-allocation.test.ts` | Descriptor/idempotencyKey preservados; upload único, cleanup só após confirmação; falha de anexo não apaga texto. |

Rodar apenas arquivos tocados com estado isolado e preload de proteção do repo quando aplicável; comandos finais de teste dependem do diff de cada PR. CI mantém build/suíte completos e Quality Gate. Done também exige screenshots desktop/mobile confrontadas com o diagnóstico Gestalt, sem modificar threads.

**Fora desta fase:** interatividade rica WA; handlers novos de aprovação; classificação por LLM/regex; comando/DSL de templates; catálogo de componentes; migrar ingress Omni; migrar proactive sem binding; roteamento/política de silêncio; lifecycle/projeção de threads; alteração de permissões; restart/deploy. Este documento é o único conteúdo escrito neste estágio.
