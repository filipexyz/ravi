# Intenção na saída por canal — revisão 2

**Estado:** desenho proposto; implementação bloqueada até revisão aprovada. **Base:** `origin/dev` em `206093f8cdc7736ec5638c5a314f8a90dd17237a` (15/11/2026). **Dona:** sessão `main-t-1794776629328249`; worktree `/Users/luis/dev/filipelabs/ravi-channel-intent-20261115`, branch `plan/ravi-channel-intent-20261115`.

Substitui a revisão 1, artifact `art_mwiby9q1_d75e3ef339`. Os quatro REQUEST_CHANGES são gates de implementação. A correção transversal de delivery é do item 2, não do item 3. A nova ordem é: **recibos/retomada → executor Slack/Canvas/arquivo seguro → contrato/produtores → autorização/mídia → projeção Slack → WhatsApp**. Nenhum renderer de purpose será habilitado antes dos dois primeiros PRs.

## 1. Contrato e limites

Reutilizar `ChannelOutputEnvelope`; acrescentar intenção, não outra linguagem de conteúdo. O envelope de um produtor novo terá:

```ts
type OutputPurpose = "decisao" | "resultado" | "blocker" | "artefato";
type OutputActionRef = { label: string; url: string };

type OutputOrigin =
  | { kind: "turn"; agentId: string; sessionId: string; traceTurnId: string }
  | { kind: "service"; producer: "cron.failure"; eventId: string };
type AuthoredChannelOutput = Omit<ExistingChannelOutputEnvelope, "schemaVersion" | "binding"> & {
  schemaVersion: 2;
  origin: OutputOrigin;
  binding?: LocalChannelMessageBinding; // somente quando há ingress real
  purpose: OutputPurpose;
  summary: string;
  actionRefs?: OutputActionRef[];
};
// Preservados: protocol, outputId, correlationId, causationId?,
// traceTurnId?, target, kind, emittedAt; binding conserva seu significado.
// assistant_message: content: Array<text | artifact>, sem error.
// safe_error: error: ChannelSafeError, sem content, purpose: "blocker".
```

**Ajuste estrutural justificado pelo proativo:** reaproveitar o mesmo envelope, introduzindo versão de saída 2; a versão de ingress continua 1. Quando binding existe, verificar sua correlação real; nunca fabricar mensagem de entrada para notificação. Origin é proveniência, não autoridade. O outputId de serviço deriva do evento persistido e o de turno do turno físico/ordinal; alvo capturado no primeiro aceite. Turno aceito pelo backend e turno físico de trace são identidades distintas: validar a associação, não impor igualdade artificial.

- `summary`: texto não vazio, até 1.200 pontos de código; explicita o resultado ou o que a pessoa precisa responder. É independente de `content` e obrigatório também para `safe_error`. Não depende de botão, cor, imagem ou anexo. Texto completo continua em `content`.
- `actionRefs`: no máximo três links de navegação, em ordem de importância; `label` entre 1 e 60 caracteres; URL HTTPS ou deep link Slack validado. Nunca shell, callback, permissão, token ou `file://`. Autorizar o conteúdo para o público do destino ANTES de verificar disponibilidade do link. Negado/desconhecido não pode virar arquivo ou resumo; link indisponível só pode mudar de representação quando a divulgação do conteúdo já foi autorizada.
- Esta fase usa ações de **abrir/revisar/consultar**. “Aprovar” não será um botão fictício: opções de resposta aparecem no resumo e seguem o fluxo humano existente. Não implementar handlers genéricos, aprovação por clique ou respostas numéricas automáticas. A referência não concede autoridade.
- `purpose` vem de produtores concretos descritos na seção 1.1, não de regex/LLM sobre perguntas. A declaração é consumida pelo host; um campo arbitrário vindo do provider não autoriza envio ou acesso.
- Default determinístico: erro seguro → `blocker`; conteúdo exclusivamente de artefatos → `artefato`; demais respostas → `resultado`. `decisao` exige intenção explícita. Conteúdo misto não é automaticamente `artefato`.

**Compatibilidade solicitada:** decoder aceita V1 sem purpose, sem modificar seus bytes/hash, e V2 com intenção/origem obrigatórias. Normalizador deriva resultado/artefato/blocker para V1, preservando o corpo integral; ele não é uma autorização. V2 só é emitida para os consumers atualizados desta entrega; drivers antigos continuam no contrato V1. Jobs antigos usam o novo executor de recibos sem reescrever o request original. V1 `claimed` expirado sem prova de não-envio migra para uncertain; `sent/persisted/complete` nunca reenvia, apenas conclui bookkeeping. Não inferir recibos individuais inexistentes em jobs históricos. Essa mudança deliberada corrige a suposição insegura da revisão 1 de manter renderer/retry antigos.

### 1.1. Produtores obrigatórios e caminho ponta a ponta

**Resposta conversacional:** criar `ravi sessions output-intent --purpose decisao --summary "O plano está pronto. Responda aprovar ou descreva o ajuste."` com actionRefs opcionais. É declaração de metadados para o próximo final do turno atual; não publica outra mensagem, não muda target e não aceita session/turn arbitrários. `src/cli/commands/sessions.ts` chama um serviço novo `src/runtime/output-intent.ts`; a skill de sessões e o prompt operacional ensinam o agente a chamar antes de um final que pede decisão, comunica blocker ou entrega artefato. Portanto existe uma superfície utilizável pelo agente, não somente um campo TypeScript.

O contexto autenticado precisa carregar turno físico e geração: ajustar `runtime-request-context.ts` e `runtime-request-builder.ts` na emissão/rotação de contexto. Persistir declaração em `turn_output_intents`, chave turno+geração; repetição idêntica é idempotente, alteração antes do freeze exige expectedVersion. Contexto revogado, turno encerrado ou declaração após freeze são recusados. Commentary não consome intenção; interrupção encerra a declaração sem transferi-la ao turno seguinte. `host-event-loop.ts` captura a intenção com o final, persiste a associação outputId/revisão e só então congela/enfileira. Falha entre persistência e publish retoma o mesmo output; não volta a resultado.

**Proativo real, sem sessão/binding:** `src/cron/failure-notification.ts::notifyCronFailure` passa a emitir `purpose:blocker`, seu resumo sanitizado e origem `cron.failure`. Sua identidade vem do item da inbox deduplicado por job/run. Caminho real: produtor → `cloud-agents/chat-target.ts::deliverToChat` → `ravi.outbound.deliver` → `gateway.ts::handleDirectSendEvent` → autorização → journal/partes → adapter. Esse caminho hoje bypassa o outbox terminal: será integrado, não simulado no teste. `DirectSendRequest` carrega intenção e chave estável; o gateway valida evento/owner/alvo contra registros e contexto interno de serviço, nunca confia em um producerPrincipal enviado no payload. O destino do primeiro aceite fica persistido; retries não o trocam pelo default atual.

`notifyCronFailure` só grava `cron.failure.notified` quando o recibo agregado comprovar entrega. Pending/partial/uncertain permanecem estados factuais na inbox; timeout do request/reply não dispara uma nova identidade. Nenhum cron novo é criado. Isso protege o aviso existente; não habilita a política de avisos proativos do item 3.

**Outros purposes:** o mesmo comando declara resultado/artefato; safe_error do runtime e cron failure são produtores determinísticos de blocker. Default legado continua resultado quando não houver declaração. Não alegar classificação automática perfeita. Não alterar `decisions/delivery.ts`, cards de decisão de thread ou polls nesta fase; os testes de decisão usam o comando real acima.

## 2. Exemplos de apresentação

Exemplos de produto com recursos de teste, não envios reais. Nas fixtures, plano, resultado e relatório têm divulgação autorizada para o público do destino. Mesma semântica nos dois canais; target e projeção diferem. Qualquer alternativa de formato na tabela pressupõe essa autorização e ausência comprovada de efeito da variante anterior.

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

**Limite da inspeção atual:** o repositório não forneceu screenshot/protótipo renderizado; builders e fixtures não comprovam UX visual. A análise acima é preliminar sobre o novo fluxo. Antes de escrever a implementação visual da PR 5, inspecionar a experiência renderizada em superfície de teste ou protótipo aprovado, registrar screenshots e ajustar este diagnóstico. Validar novamente após implementação nos mesmos tamanhos. Este gate não está dado como concluído.

## 4. Montagem atual → proposta

**Slack hoje:** `host-event-loop.ts:2334/2401` passa texto para `projectChannelRuntimeEvent`; `runtime-events.ts:838` monta o envelope terminal; `slack/driver.ts:128–158` o reduz a um job textual; `outbound-consumer.ts:962` passa texto/formato para o adapter; `slack/socket-mode.ts:347` chama o renderer. Manter a montagem terminal no mesmo local, acrescentando intenção antes da persistência e levando-a inteira até a entrega.

**WhatsApp hoje:** `omni/consumer.ts:1055` persiste a mensagem canônica, mas não guarda o retorno. `host-event-loop.ts:3013–3078` resolve o destino e emite `ResponseMessage`; `gateway.ts:1160` normaliza `text|media`; `gateway.ts:1434/1603` envia via `OmniSender`. Não existe envelope backend nesse trajeto.

**Ponte WA proposta:** capturar o ID canônico já retornado pelo consumer e carregá-lo em metadado de origem de saída, separado de `_channelBackend`. No host, após política e resolução de destino, montar `ResponseMessage.output?: ChannelOutputEnvelopeV2` com origem de turno real, binding somente quando existente e destino capturado. O transporte de transição continua sendo o evento de resposta: `output` é a fonte semântica quando presente; `response/content` não geram uma segunda entrega. Saída direta de serviço, como cron failure, entra pelo gateway direto e converge no mesmo journal sem inventar turno.

- `binding.messageId` continua sendo a mensagem canônica de origem; `binding.chatId` não muda para disfarçar um attach a outro chat. `target` aponta para o destino já autorizado. Nenhum ID de Chat/Message/Turn será inventado para satisfazer o schema.
- Para WA, usar o Chat canônico do destino como handle opaco de `target.conversationId`; o adapter resolve o JID pela proveniência desse chat e valida conta/instância. JID com `@` não é aceito pelo schema de ID opaco. O target resolvido é congelado, nunca substituído pelo default atual da sessão durante entrega.
- Não marcar o prompt WA como `_channelBackend`: hoje isso suprime o texto em `emitResponse` e mudaria ownership/ingress. O novo metadado só fornece proveniência para egress.
- **Sem exceção por falta de binding:** cron failure sem ingress e finais de turnos proativos atravessam intenção, autorização e recibos completos. V1 continua sendo decodificável, mas não oferece um bypass de segurança. Origem inválida é erro explícito; ausência legítima de binding é aceita pela origem de turno/serviço. O modo proativo do item 3 continua desabilitado em WA até seu próprio guard de atenção; fallback textual não o habilita.
- `ResponseMessage.content` continua `text|media`; não inserir `artifact` ali. O vínculo tipado e a resolução pré-freeze da seção 4.2 substituem a promessa vaga de upload único da revisão 1.

### 4.1. Recibo por parte, incerteza e restart — responsabilidade do item 2

Hoje `outbound-consumer.ts:572` libera claim após qualquer erro do adapter; `recordSent` só ocorre após o adapter inteiro. `markdown-delivery.ts:69/105` faz fallback em qualquer erro de Canvas/upload. Um único recibo lógico não cobre esses múltiplos efeitos remotos.

Manter `channel_outbound_receipts` como agregado e acrescentar plano congelado e `channel_outbound_parts`. `deliveryId` identifica outputId+destino canônico+conta/subconversa; `planFingerprint` cobre intenção, conteúdo, política capturada, versões de mídia e grafo de operações. Cada efeito recebe `partId` estável derivado de deliveryId+slot lógico+variante+ordinal; `requestFingerprint` cobre método, alvo e payload exatos. Reuso com payload diferente conflita. Guardar estado, owner/fencing token, tentativa, timestamps, providerRef e evidência sanitizada por parte.

Estados de parte: `planned → in_flight → confirmed | rejected | uncertain`; cancelamento por política fica distinto de falha. O agregado distingue pending, partial, uncertain, delivered e failed. `delivered` exige todas as partes obrigatórias confirmadas ou substituídas por alternativa confirmada; envio de resumo não prova entrega de arquivo. Persistir plano antes de I/O, `in_flight` antes de cada chamada e confirmação imediatamente depois, antes da próxima etapa. O grafo contém alternativas explícitas, não uma DSL pública.

| Situação | Regra de execução/recuperação |
| --- | --- |
| Erro local antes de invocar transporte | Nenhum efeito iniciado; corrigir/selecionar alternativa por CAS, preservando identidade e evidência. |
| Rejeição remota tipada que prove não aplicação | `rejected`; retry ou variante alternativa permitidos conforme a operação. Não classificar só por texto da exceção. |
| Timeout, conexão perdida, resposta inválida, sucesso sem ID obrigatório ou queda após resposta antes de persistir | `uncertain`; não reenviar nem trocar representação. Uma lease vencida não prova ausência de efeito. |
| Restart | Reabrir plano persistido; pular confirmed; retomar planned; in_flight de owner perdido vira uncertain. Fencing impede owner velho de iniciar outra parte. |
| Reconciliação | Leitura do recurso/providerRef pode provar entrega e confirmar. “Não apareceu na listagem” não prova não-envio. Sem prova, manter uncertain e blocker operacional único; sem retry cego. |
| Falha local após envio confirmado | Repetir só persistência canônica/trace/ACK. Nenhuma chamada remota repetida. |
| ACK/NATS | ACK do agregado uncertain só depois de journal durável assumir reconciliação. Falha de journal → NAK, mas leitura do estado impede novo efeito. |

`releaseClaim` deixa de existir como recuperação genérica pós-adapter. Só libera execução comprovadamente não iniciada; parte in_flight não pode ser tomada para enviar. Retenção não remove uncertain/in_flight, identidade ou blobs pendentes. `channels/runner.ts` recupera no startup e reconcilia em lotes limitados; não depende de cron novo. Saída de uncertain exige evidência positiva do provider, ou resolução operacional autenticada e auditada com parte/fingerprint/expectedVersion/evidência de confirmed ou not-applied. “Tentar novamente” sem evidência não limpa o estado. Enquanto faltar prova, assumimos possível perda de disponibilidade para evitar duplicata, e mostramos essa limitação.

**Checkpoint em cada chamada, não só por mensagem:**

| Operação | Partes/checkpoints e fallback permitido |
| --- | --- |
| Texto Slack/WA | Um post por parte; parte 1 confirmada nunca é repetida se a 2 falhar. `client_msg_id` ajuda correlação, mas não substitui recibo. invalid_blocks comprovado permite criar variante mrkdwn antes de enviar. |
| Canvas | create → guardar canvasId → share → comprovar audiência → leitura de permalink → post do link. Cada mutação tem recibo. Timeout de create sem ID não cria outro Canvas; permalink indisponível repete só leitura. |
| Canvas recusado/abandonado | Só mudar para arquivo se criação não ocorreu, ou se recurso conhecido foi comprovadamente removido e nenhum link foi publicado. Delete é outra operação; delete incerto bloqueia fallback. Não apagar Canvas após share incerto com um catch genérico. |
| Arquivo Slack | Separar getUploadURLExternal, upload bytes e complete/share. Persistir fileId desde o ticket; URL assinada fica em armazenamento restrito/handle, nunca em logs/metadados genéricos. Complete incerto reconcilia o mesmo fileId/acesso; não abre novo ticket nem manda texto alternativo. |
| Arquivo WA | Uma parte com digest e referência estáveis; retirar retry cego TypeError/5xx desse caminho. Sem readback conclusivo, manter uncertain. |
| Documento substituído | Alternativa ocupa o mesmo slot lógico; somente uma variante pode vencer. Após efeito confirmado/uncertain não regenerar o plano inteiro. Slots/IDs remotos retornados são checkpoints; payload resolvido de cada chamada é congelado antes do seu in_flight. |

Erros do cliente serão tipados com certeza (`not_started`, `rejected_without_effect`, `unknown`) e método/código sanitizados. Renderização pura ocorre antes dos efeitos sempre que possível; fallback de renderer é permitido apenas para slots ainda não iniciados. Corrigir isso nos PRs 1–2, antes de habilitar purpose no Slack. A PR 2 é o conserto do executor, não o antigo segundo PR de UI.

### 4.2. Mídia: vínculo tipado e resolução antes do freeze

Hoje imagens do provider não são registradas como Artifact; `ResponseMediaAttachment` não tem artifactId, e o allocator congela o descriptor antes de escrever bytes. Acrescentar `artifactRef: {artifactId, versionId, assetId, sha256, sizeBytes, mediaType}` e `memberId` tipados ao descriptor. O bloco `content.artifact` referencia a mesma versão e memberId; não confiar em metadata livre, latest, caminho ou filename.

Criar preparação única em `runtime/output-media.ts` + `artifacts/store.ts`: origem da emissão + idempotencyKey do produtor identifica um membro; índice único idempotente recupera/cria artifact e versão e compara bytes. Mesmo par com digest diferente é conflito. Duplicidade artifact+descriptor do mesmo membro vira um upload; mesmo arquivo em dois slots intencionais continua dois membros distintos. O plano escolhe link OU upload para cada membro, nunca os dois por acidente.

Refatorar `generated-media-allocation.ts` em preparação privada de storage/bytes → criação/recuperação da versão → descriptor definitivo → seal/adopt. Não enriquecer/clonar descriptor depois de adotado: isso quebra o ownership atual. Preparador continua dono do cleanup até adoção; falha antes do freeze não libera referência incompleta. A versão e seu mapeamento precisam estar commitados antes do manifesto; crash nesse intervalo retoma pela chave idempotente, sem novo artifact.

Ordem: capturar origem/destino → resolver versões/bytes e proveniência → autorizar conteúdo → congelar envelope, intenção, mapa de membros/descriptors e manifesto → persistir plano de delivery → executar partes. O manifesto cobre memberId, artifactRef, idempotencyKey, digest do descriptor e bytes. Antes do upload, verificar novamente a versão/digest e enviar os mesmos bytes verificados. Mudança gera falha de integridade, nunca resolução de latest. Cleanup remove somente temporários próprios após confirmação; versões/blobs necessários a partial/uncertain ficam retidos para retomada.

### 4.3. Autorização de conteúdo não é disponibilidade de link

Criar uma decisão de divulgação por **conteúdo/versão + público canônico do destino + produtor/principal autenticado**, antes de qualquer renderer, upload ou compartilhamento. Ler Artifact, ter acesso ao arquivo local, conhecer URL pública ou poder enviar ao chat não equivale a poder divulgar aquele conteúdo. `getArtifact` e o guard atual de Knowledge não implementam essa decisão; é trabalho novo explícito.

`channels/output-authorization.ts` consulta políticas de origem pelo facade de permissões e produz evidência vinculada ao digest e audiência. Para texto gerado no turno, usar a autoridade do pedido e suas fontes; para Artifact, política/grant de divulgação vinculado à versão e audiência, armazenado com proveniência. Geração para um destinatário autorizado pode registrar esse escopo a partir do pedido autenticado; nunca a partir de uma alegação do modelo. Conteúdo derivado de fonte restrita herda suas restrições. Política/fonte sem decisão confiável retorna unknown, não allow. Não prometer classificação automática/DLP de toda string arbitrária.

Contrato concreto do gate: `authorizeOutputContent({principal, producerEvent, targetAudience, contentDigest, sourceRefs, artifactVersions}) → allowed(proofId, policyRevision, audienceFingerprint) | denied(reason) | unknown(reason)`. A evidência é persistida com o plano, não dentro de actionRefs. Em Artifact, guardar política versionada e grants por audience canônica com issuer/provenance; mídia criada para a resposta herda somente o escopo já autorizado do pedido e de suas fontes. Artifact antigo sem política de divulgação retorna unknown. Cron failure autoriza apenas o resumo sanitizado dirigido ao dono verificado do job; não autoriza anexar logs brutos. O pre-send recusa prova de outro digest, audiência ou revisão. Essa PR não concede permissões novas a agents nem transforma permissões de leitura em grants de divulgação.

O gate cobre resumo, nome/título, caption, corpo, links, arquivo, imagem, áudio/TTS e texto fragmentado. Denied/unknown não entrega nada derivado do recurso: registra motivo e só pode emitir aviso neutro separadamente autorizado, como “Não posso compartilhar esse conteúdo neste destino.” Não incluir nome, trecho ou existência sensível do recurso. Allowed + link inacessível permite arquivo/texto **somente** dentro da mesma autorização de divulgação. Proibição específica de documentos pelo guard continua sendo respeitada.

Capturar público/conta/chat e versão da política; revalidar imediatamente antes de cada efeito remoto. Mudança de destinatário, membros relevantes ou revogação invalida o aceite anterior. Parar partes futuras, não fingir desfazer dados já entregues; registrar partial/denied. Nenhum fallback amplia ACL, cria link público ou ignora restrição. O hook de pre-send recebe contexto verificado do executor, não campos do envelope como autoridade. Item 3 poderá compor nele seu guard de atenção separado (`reply/attention/projection/internal`), depois deste trabalho. Purpose continua só conteúdo.

## 5. Nova sequência de PRs e mapa de arquivos

| PR | Arquivos | Entrega e gate |
| --- | --- | --- |
| **1 — recibos e recovery** | `channels/outbound-receipts.ts`, novo `channels/outbound-parts.ts`, `router/router-db.ts`, `channels/runner.ts` | Plano/partes duráveis, estados/fencing, migração conservadora, recuperação de restart e retenção. Infraestrutura, sem habilitar purpose. |
| **2 — executor seguro** | `channels/outbound-consumer.ts`, `channels/native/types.ts`, `channels/slack/markdown-delivery.ts`, `channels/slack/client.ts`, `channels/slack/socket-mode.ts` | Remover liberação e catches genéricos; checkpoints texto/Canvas/ticket/bytes/complete; erros tipados e variantes exclusivas. Ativar proteção do texto legado. Sem este gate verde, nenhum rich output novo. |
| **3 — contrato e produtores** | `channels/backend.ts`, novo `channels/output-intent.ts`, `runtime/message-types.ts`, `runtime/types.ts`; SDK `channel-backend.ts`/schemas/fixtures | V1/V2, origem independente de ingress, intenção/defaults; preparar consumidores sem ativar V2 externo. |
| 3 | `cli/commands/sessions.ts`, novo `runtime/output-intent.ts`, `runtime/runtime-request-context.ts`, `runtime/runtime-request-builder.ts`, `runtime/host-event-loop.ts`, `router/router-db.ts`, skill de sessões e prompt operacional | Comando real turn-scoped, contexto físico/geração, declaração durável e captura pelo final; gerar SDKs afetados. |
| 3 | `cron/failure-notification.ts`, `cloud-agents/chat-target.ts`, `gateway.ts` | Produtor blocker real sem binding; identidade/target persistidos, retorno pending/partial/uncertain/delivered e direct send no journal. Não habilitar modo item 3. |
| **4 — autorização e mídia** | Novos `channels/output-authorization.ts`, `runtime/output-media.ts`; `artifacts/store.ts`, `runtime/generated-media-allocation.ts`, `runtime/message-types.ts` | Política de divulgação/proveniência versionada, pre-send gate, artifactRef/memberId/idempotencyKey antes de seal/adopt; sem grants inferidos de URL/leitura. |
| 4 | `channels/slack/automatic-terminal-manifest.ts`, `channels/slack/automatic-media-output.ts`, `runtime/host-event-loop.ts`, `gateway.ts` | Congelar versões/bytes/intent; validar mapa; mídia também usa recibos por parte. |
| **5 — projeção Slack** | `channels/runtime-events.ts`, `channels/slack/driver.ts`, `channels/outbound-stream.ts`, `channels/native/types.ts`, `channels/outbound-consumer.ts`, novo `channels/slack/output-intent.ts`, `channels/slack/socket-mode.ts`, `channels/slack/markdown-delivery.ts` | Carry de intenção/readback, composição fixa e fallback seguro; ativar V2 com e2e CLI/cron reais até API externa stub. Gate visual antes desta PR. |
| **6 — WhatsApp** | `omni/consumer.ts`, `runtime/host-event-loop.ts`, `gateway.ts`, novo `channels/whatsapp/output.ts`, `omni/sender.ts` | Binding quando real, origem sem binding quando legítima, projeção/journal/autorizações comuns, sem retry cego; ativar com e2e de cron e turno proativo. |

Caminhos da tabela são relativos a `src/`, exceto o SDK em `packages/ravi-os-sdk/src/`. Cada PR atualiza testes e specs da área; a nova `channels/output-intent` terá CHECKS/WHY/RUNBOOK. PRs 3–4 preparam produtores e validação; emissão V2 externa só é ativada por canal quando todos os consumidores estão presentes. Não reescrever hashes de requests existentes; a migração dos receipts está explícita na seção 4.1.

**Coordenação:** o item 2 é dono de delivery parcial/incerto e do hook pre-send. Item 3 integra seu modo depois das mudanças Slack, consumindo esse executor; não cria outra máquina de recibos. Nada em thread-*, lifecycle ou decisions/delivery.ts será editado. Se item 1 exigir região de thread, parar e reportar antes de editar. A política de atenção continua separada; WA proativo do novo modo não se habilita por fallback textual.

### 5.1. Fence do item 1 — ordem e rebase obrigatórios

Adendo de coordenação recebido do main após a publicação da revisão 2; não altera o escopo funcional. **O PR1 do item 1 entra primeiro. Depois de seu merge, atualizar origin/dev e rebasear esta branch sobre o SHA mergeado antes de iniciar a implementação dependente. Nunca pedir que o item 1 rebaseie sobre o item 2.** A aprovação do presente plano continua necessária; nem este adendo nem o merge são aprovação implícita.

| Arquivo reservado ao PR1 do item 1 | Alteração prevista pelo item 2 |
| --- | --- |
| `src/channels/slack/thread-lifecycle-store.ts` | Nenhuma. |
| `src/channels/slack/thread-turn-health-store.ts` | Nenhuma. |
| `src/channels/slack/thread-attention-admission.ts` | Nenhuma. |
| `src/decisions/store.ts` | Nenhuma. |
| `src/decisions/delivery.ts` | Nenhuma; produtor de decisão conversacional é sessions output-intent. |
| `src/decisions/schema.ts` | Nenhuma. |
| `src/threads/service.ts` | Nenhuma. |

O item 1 encapsula INSERT/UPDATE/DELETE existentes em `withThreadWriteLease`, com lease não commitado dentro de BEGIN IMMEDIATE; predicados, status e payloads permanecem iguais. O item 2 preservará essas APIs e a propriedade da transação. Se sua integração vier a precisar de DML nas superfícies protegidas, usará o wrapper/API com lease vigente, sem COMMIT cru, sem transação paralela que contorne o fence e sem chamar transporte enquanto a transação estiver aberta. Os DML de recibos, partes e output-intent ficam nas próprias tabelas; não serão usados para alterar indiretamente estado protegido de threads/decisões.

Após o rebase, conferir os contratos reais do wrapper e incluir o teste anti-bypass do PR1 nas verificações focadas relevantes. Mudança de assinatura ou necessidade de editar qualquer arquivo reservado exige pedido técnico ao main para arbitragem antes da edição; não adaptar o wrapper unilateralmente. Este plano não prevê mudança de assinatura. A sequência interna dos seis PRs permanece a mesma, precedida pelo merge/rebase obrigatório do item 1 nas dependências protegidas.

Publicação futura por `ravi pr publish` em sessão autenticada (preview/conferir/execute), com testes focados e revisão independente do diff. Não executar restart, deploy, instalação pesada, build ou suíte completa neste host. Plano precisa de aprovação antes de qualquer implementação.

## 6. Regras de projeção e fallback

1. Policy de silêncio e autorização são verificadas antes de renderizar. Purpose não silencia, concede acesso ou escolhe destinatário. O renderer nunca transforma falha em silêncio.
2. Resumo completo e opções precedem detalhes. Excesso autorizado usa Canvas/arquivo/link acessível; última alternativa é texto integral em partes. Orçamentos locais: Slack 11.000 Markdown/3.500 mrkdwn por parte; WA 3.500 pontos de código como limite conservador do produto. Preservar URLs, Unicode, cercas e ordem.
3. Documento/link indisponível só muda de representação com divulgação autorizada e ausência comprovada de efeito da alternativa anterior. Denied/unknown de conteúdo não vira resumo, arquivo, caption ou TTS.
4. Exceção local ou renderer vazio antes de efeitos seleciona texto pré-validado. Depois de efeitos, seguir ledger por slot. Timeout remoto é uncertain: sem fallback automático, sem afirmar entrega, sem reapresentar partes confirmadas.
5. Não prometemos exactly-once do provider: garantimos que incerteza não autoriza reenvio automático. Sem prova de reconciliação, a pendência fica durável e visível.
6. Menções, actor metadata, traceTurnId, guards de Knowledge e ownership de mídia permanecem. Silêncio explícito continua válido; citação do marcador de silêncio continua conteúdo.

## 7. Testes de aceitação — quatro bloqueios precisam ficar verdes

**E2E significa produtor real, persistência real em estado isolado e bus/consumer de teste; mock somente do provider de modelo e APIs externas. Não vale injetar envelope pronto no renderer, nem skip por falta de binding.**

| Caso obrigatório | Caminho e asserções |
| --- | --- |
| Decisão do agente, Slack e WA | Chamar o comando real `sessions output-intent` em contexto autenticado → provider fake emite final textual comum → host persiste/congela → bus/gateway → journal → API stub. Purpose precisa ser decisao nos dois canais, nunca resultado; uma única resposta externa. |
| Proativo real sem binding, Slack e WA | Chamar `notifyCronFailure` real → inbox → deliverToChat → ravi.outbound.deliver → gateway → autorização/journal → adapter stub. Sem sourceMessageId, sem _channelBackend, sem turno inventado. Blocker/resumo/destino preservados; notified somente após confirmação. Repetir após restart em confirmed e uncertain não reenvia. |
| Turno de automação sem ingress | Fixture de cron/trigger publica prompt real de teste → host/provider fake usa declaração → ResponseMessage/envelope → gateway → WA. Origem de turno física e target preservados, sem binding; conteúdo/mídia autorizados e recibos completos. |
| Isolamento da declaração | Commentary não consome; turno A interrompido não contamina B; contexto antigo/spoof de producer recusado; alteração após freeze conflita; versão/replay estáveis. |
| Entrega parcial e restart | Queda antes/depois de cada etapa de texto/Canvas/upload, dois runners e falha de DB após sucesso remoto. Parte 1 confirmada nunca reenvia; parte 2 in_flight vira uncertain. Lease expirada não permite takeover de send. |
| Canvas/arquivo | Create/share/complete incertos não produzem novo recurso ou texto alternativo; permalink/readback falho repete só leitura. Fallback apenas com prova de não aplicação/cleanup confirmado; delete incerto bloqueia. |
| Mídia correlacionada | Artifact+descriptor do mesmo memberId causa um upload; mesmo blob em dois slots intencionais causa duas partes. Versão/bytes alterados após freeze falham antes do send; replay recupera o mesmo artifact/version; sem cleanup de bytes em uncertain. |
| Autorização | Conteúdo negado com link público: zero conteúdo derivado em texto/arquivo/caption/TTS. Conteúdo permitido com link inacessível: fallback permitido e autorizado. Permissão de ler Artifact não concede divulgação. Revogação entre partes interrompe as futuras sem replay das confirmadas. |

Manter ainda as **oito fixtures purpose × canal** da seção 2, cada uma em normal/excesso/renderer throw e empty. Cobrir legado sem purpose, safe_error sanitizado, hash imutável, links/ações no texto acessível, marker explícito vs citado, destino após attach, ordem por sessão, mídia e silêncio fragmentado.

Suítes existentes a estender: `channels/outbound-receipts.test.ts`, `outbound-consumer.test.ts`, Slack `markdown-delivery.test.ts`, `client.test.ts`, `driver.test.ts`, `automatic-text-delivery.test.ts`; `runtime/runtime-request-context-lifetime.test.ts`, `runtime/generated-media-allocation.test.ts`, `runtime/slack-automatic-terminal.test.ts`; `cron/failure-notification.test.ts`; `gateway-native-delivery.test.ts`, `gateway-response-order.test.ts`, `gateway-session-trace.test.ts`; `artifacts/store.test.ts`, `omni/consumer-context.test.ts`, `omni/sender.test.ts`; SDK `channel-backend-core.test.ts`. Acrescentar testes de serviço/CLI, autorização/partes e e2e de saída onde não existirem. Rodar somente suites do diff com estado isolado/preload; CI faz validação completa.

Done inclui screenshots Slack desktop/mobile e WA mobile confrontadas com o diagnóstico Gestalt, além dos quatro gates acima. **Fora desta fase:** interatividade rica WA, handlers genéricos de aprovação, classificação por LLM/regex, DSL/catalogo de componentes, migração de ingress Omni, lifecycle/projeção de threads, política de atenção do item 3, grants/permissões de produção e deploy/restart. Somente documentos foram escritos nesta revisão.
