# Intenção na saída por canal — revisão 3: contrato com atenção

**Estado:** plano para revisão; nenhuma implementação autorizada ou iniciada. **Dona:** sessão `main-t-1794776629328249`, worktree `ravi-channel-intent-20261115`, branch `plan/ravi-channel-intent-20261115`. Base inspecionada: `origin/dev` em `206093f8cdc7736ec5638c5a314f8a90dd17237a`.

Esta revisão substitui o contrato genérico de pre-send e a união de origens da [revisão 2](channel-output-purpose-plan-20261115-r2.md), artifact `art_mwidl5wm_24cab9792e`. Os demais contratos, exemplos, quatro bloqueios, mapas de arquivos e gates da R2 continuam valendo. Para a integração do item 3, a referência é **D3/SQL2/SQL3, D4 e D5.3–D5.4 do adendo vigente**, artifact `art_mwid8crt_141f3fca88`, em `/Users/luis/ravi/main/artifacts/contract-addendum-2026-11-15.md`. Usa-se `state='prepared' → 'handoff_started'`; a coluna antiga `handoff_state` do plano-base não integra este contrato.

**Decisões fechadas nesta revisão:** o hook é síncrono e participa da mesma transação do executor e do CAS de atenção; o executor possui o commit. Emissões `attention` entram no mesmo caminho de serviço V2 e no mesmo journal. Purpose continua somente intenção de conteúdo, separado de admissão, operação e autorização.

## 1. Hook transacional: assinatura e responsabilidade

Porta nova, pertencente ao item 2, em `src/channels/output-pre-send.ts`. Tipos abaixo são contrato proposto, não APIs já existentes:

```ts
type AttentionHandoff = Readonly<{
  deliveryId: string;
  admission: AdmissionRef<"attention">; // nominal, reidratada pelo runtime
} & (
  | { stage: "first"; expectedCasVersion: number }
  | { stage: "next"; startedCasVersion: number }
)>;

type VerifiedOperationContext = Readonly<{
  outputId: string;
  receiptKey: string;
  partId: string;
  owner: string;
  fence: number;
  outboxKey: string;
  requestFingerprint: string;
  planFingerprint: string;
  partFingerprint: string;
  target: VerifiedCanonicalTarget;
  origin: VerifiedOutputOrigin;
  operation: "create" | "update";
  targetMessageId?: string; // obrigatório e fixado para update
  attention: AttentionHandoff | null;
  nowMs: number;
}>;

type PreSendVerdict =
  | { kind: "allow"; attention?: { deliveryId: string; startedCasVersion: number } }
  | { kind: "deny"; code: string }
  | { kind: "pending"; code: string };

type PreSendGuard = (
  tx: ActiveExecutorTransaction,
  input: VerifiedOperationContext,
  proofs: PreloadedDisclosureProofs,
) => PreSendVerdict; // síncrono: Promise não é admitida
```

`ActiveExecutorTransaction` é um token nominal válido apenas durante a chamada, vinculado à conexão SQLite de `ravi.db` que grava os receipts/partes. Os repositórios participantes recebem esse token e executam seu DML nessa conexão. A porta não expõe begin/commit/rollback nem transporte; não abre conexão, transação, savepoint ou commit próprios. O executor controla a transação e invalida o token ao sair. Retorno assíncrono inesperado é erro e rollback, nunca permissão implícita.

`VerifiedCanonicalTarget` contém conta, chat canônico, subdestino e fingerprint da audiência. `VerifiedOutputOrigin` resulta da resolução de registros/contexto autenticados, não de cast do envelope. `PreloadedDisclosureProofs` contém refs/revisões dos comprovantes de divulgação, público, fontes e contexto carregados antes do lock; não contém autoridade produzida pelo modelo. Dentro da transação, o gate de conteúdo do item 2 e o guard do item 3 revalidam **sincronamente** digest, source lineage, proofId/revision, contextEpoch, política, membros e atualidade do roster. Seguem D5.3–D5.4: leitura externa necessária retorna `pending/ACL_UNSUPPORTED`; roster não comprovado retorna `pending/ROSTER_UNPROVEN`. Não há HTTP ou `await` dentro do lock.

Item 2 fornece a composição, journal e gate de conteúdo; item 3 implementa o guard semântico em seu `orchestration/delivery-store.ts`. O guard só altera a linha semântica de atenção pelo token recebido. Não altera claims, fencing, partes ou proteção contra reenvio. `first/next`, versões e owner são derivados do ledger pelo executor; não são parâmetros confiáveis enviados pelo job. A versão original da `AdmissionRef` permanece vinculada ao lote; a versão pós-handoff é registrada separadamente.

## 2. Uma transação, um dono do commit

O executor do item 2 executa esta sequência por operação remota; o primeiro efeito inclui `canvases.create` e abertura de ticket de upload, não apenas o post final:

1. Carregar provas e resolver contexto/capacidade fora da transação, sem enviar conteúdo. Abrir **`BEGIN IMMEDIATE` na mesma conexão** das tabelas `channel_outbound_receipts`, partes e `chat_attention_deliveries`.
2. Reler plano/parte/claim; validar fingerprint, owner/fence vigente, parte `planned`, predecessores e ausência de efeito anterior incerto. Revalidar autorização de divulgação e contexto pelas portas síncronas.
3. Invocar o guard. Para `first`, item 3 executa seu CAS exato: `WHERE id=:id AND state='prepared' AND cas_version=:expected`, mudando para `handoff_started`, incrementando a versão e gravando `send_owner`/hora. O mesmo DML vincula `receipt_key` ao recibo validado, exigindo que esteja vazio ou já corresponda a ele. Zero linhas é negação, mesmo para o mesmo owner.
4. Na **mesma transação**, item 2 faz o CAS da parte `planned → in_flight`, com owner/fence/fingerprint, e grava a proteção durável do receipt contra takeover/reenvio. Se qualquer CAS, prova, constraint ou operação falhar, **rollback de todos os efeitos locais**, inclusive do CAS de atenção. Não produzir permit e não chamar provider.
5. **Somente o executor comita.** O helper transacional retorna apenas após COMMIT bem-sucedido, incluindo validação de FKs diferidas. Só então o executor emite um `CommittedPartPermit` nominal, local e consumível uma vez, ligado a parte/payload/destino/operação/owner/fence. A chamada de transporte exige esse permit. O permit não é serializado no job nem reconstruído de um receipt `in_flight`.
6. Fora da transação, chamar a operação externa uma única vez e registrar seu recibo antes da próxima parte. Timeout, sucesso sem recibo válido, falha de persistência após sucesso ou crash entre commit e checkpoint geram `uncertain`, com a política conservadora da R2.

`deny/pending` não comita um handoff parcial. A razão sanitizada pode ser registrada depois do rollback, sem autorização de transporte. Falha ao gravar essa razão também não autoriza fallback ou envio. A parte não sai de `planned` antes de toda a composição ser aprovada.

O cancelamento/reagrupamento do item 3 conserva sua própria transação concorrente `BEGIN IMMEDIATE` e o mesmo predicado CAS. Se cancel ganha, o executor perde e faz zero chamadas; se begin ganha, cancel perde e não cria B. Preservar `replacement_id ... DEFERRABLE INITIALLY DEFERRED` e o índice de membro ativo único. Não separar pre-send e handoff em duas transações, nem entregar ao hook a responsabilidade pelo commit.

**Limite exato da garantia:** o ponto de autorização é o commit local conjunto. Não existe transação atômica SQLite/provider; mudança externa de ACL após o commit não pode ser apresentada como revogação instantânea da chamada já autorizada. Isso não reabre reagrupamento: a linha já está `handoff_started`, e a proteção de receipt já proíbe takeover. Antes de cada operação seguinte ocorre nova revalidação local. Provas externas continuam observações versionadas segundo D5, não uma promessa de membership global instantânea.

### 2.1. Partes seguintes e restart

O CAS prepared→handoff_started acontece **uma vez por lote**. Em `next`, o guard exige a mesma linha em `handoff_started`, versão pós-CAS, `send_owner`, AdmissionRef original, outbox/fingerprint e receipt. O executor exige o fence vigente e uma parte futura ainda `planned`; predecessores devem estar confirmados ou comprovadamente sem efeito, e nenhuma operação pode estar `in_flight/uncertain`. Revalidação e CAS dessa nova parte continuam dentro da transação acima. Não repetir o CAS inicial nem usar o mesmo owner para reenviar parte anterior.

**Decisão conservadora para atenção após crash/perda de owner:** lote que já entrou em `handoff_started` fica `uncertain`; não transferir owner nem continuar automaticamente partes restantes, mesmo que estejam `planned`. É a regra explícita SQL3 do item 3, mais restritiva que recovery genérico da R2. A reconciliação do item 2 pode fazer leituras e registrar comprovantes positivos; se provar todas as partes obrigatórias, conclui o mesmo lote. Se faltarem partes, mantém partial/uncertain durável, sem reset para prepared, novo lote B ou nova chamada automática. Não estamos prometendo um protocolo de retomada de owner que o adendo não define.

Antes de qualquer handoff, um lote ainda `prepared` pode ser retomado, mas precisa vencer seu CAS na nova execução. `confirmed` nunca reenvia. Reentrada na mesma operação `in_flight` falha até pelo mesmo owner. Isso fecha a janela commit→provider conservadoramente, sem alegar exactly-once.

### 2.2. Compatibilidade com capacidades de edição

Aceitar a separação D4 em `channels/native/types.ts`: `CreateCapability` exige `AdmissionRef`; `UpdateCapability` só oferece update no alvo fixado, sem create/post/upload/sender. O permit por parte não amplia a capability. A composição compara operação, ref nominal quando aplicável, chat/outbox/fingerprint e alvo.

Fallback de update só pode atualizar o mesmo alvo após rejeição comprovadamente não aplicada. Não pode publicar texto em partes, Canvas ou arquivo novo. `EditFailed` segue para `admitEditFailure` do item 3, consumidor sem transporte. Uma readmissão válida cria outro evento `attention`, com nova admissão/CAS; efeito desconhecido não produz readmissão automática. O item 2 entrega a fronteira de executor; não edita projeção ou lifecycle de threads para implementá-la.

## 3. Origem attention: mesmo caminho V2 de serviços

Substituir a união `OutputOrigin` da R2 por:

```ts
type OutputOrigin =
  | { kind: "turn"; agentId: string; sessionId: string; traceTurnId: string }
  | { kind: "service"; producer: "cron.failure"; eventId: string }
  | { kind: "service"; producer: "attention"; eventId: string };
```

**Produtor nomeado:** `src/orchestration/reconciler.ts::reconcileAttention`, do item 3, depois de persistir o lote admitido `prepared`, chama a porta comum nova `enqueueServiceOutput({origin, output})` do item 2 em `src/channels/service-output.ts`, sob contexto interno autenticado. `cron.failure` converge na mesma porta através do gateway direto já descrito na R2. A porta valida a origem, prepara/congela o plano e usa a outbox/journal existentes; o consumer resolve novamente os fatos antes do send. Não há sender alternativo para atenção.

Para `attention`, `eventId = chat_attention_deliveries.id`; `outputId` deriva dessa identidade; `outboxKey` é o persistido no lote. Resolver alvo, audiência, membros, envelope e `request_fingerprint` do registro persistido e conferir contra a emissão. Um replay recupera o mesmo output/recibo; fingerprint ou destino divergente conflita antes de efeitos. Admitir retry de enqueue para a mesma identidade após crash entre commit do lote e publicação. A AdmissionRef nominal é reidratada do store autenticado, separada do envelope serializável; conhecer eventId ou escrever `producer:"attention"` não autoriza nada.

O produtor do item 3 materializa `purpose` e resumo a partir dos fatos admitidos: pedido de decisão → decisao, impedimento → blocker, conclusão → resultado, entrega de documento → artefato. Purpose não decide se é reply, attention, projection ou internal. O novo serviço não exige nem inventa turno ou ingress binding. `cron.failure` continua sua origem própria e não passa a ser atenção por ter purpose blocker.

**Ativação fechada:** o item 2 entrega schema, porta comum, validação e hook. O item 3 registra seu resolvedor de origem/admissão e seu guard após as mudanças Slack do item 2, com testes de integração verdes. Origem attention sem esse registro é recusada explicitamente (`ATTENTION_INTEGRATION_UNAVAILABLE`), permanece pendente no produtor e causa zero I/O; não vira cron.failure, reply, resultado legado ou fallback textual. Slack é o primeiro canal habilitável. WhatsApp aceita o contrato no decoder, mas o modo attention fica desabilitado enquanto binding de público, provas, guard e recibos exigidos pelo item 3 não estiverem presentes. O decoder não habilita envio.

## 4. Ordem, arquivos e coordenação

Os seis PRs da R2 mantêm a ordem; estas entregas entram nos PRs correspondentes, sem transferir delivery para o item 3:

| PR do item 2 | Acréscimo concreto |
| --- | --- |
| 1 — recibos/recovery | Token transacional e CAS de partes/fencing; persistir correlação receipt↔lote e tratamento conservador de atenção após crash. Não criar tabelas semânticas do item 3. |
| 2 — executor seguro | Novo `channels/output-pre-send.ts`; composição/commit/permits em `channels/outbound-consumer.ts` e `channels/outbound-parts.ts`; capacidades create/update em `channels/native/types.ts`; checkpoints de texto/Canvas/upload chamam a mesma fronteira. Zero callback que comita isoladamente. |
| 3 — contrato/produtores | V2 inclui attention em backend/SDK/schemas; novo `channels/service-output.ts`; gateway e cron convergem nessa porta. Registro de produtor interno obrigatório; sem guard registrado, attention não envia. |
| 4 — autorização/mídia | `channels/output-authorization.ts` fornece carregamento externo e revalidação síncrona no token; refs/digest/mídia são os congelados da R2. Portas de proveniência consomem os comprovantes reais do item 1; não fabricam grants para satisfazer o guard. |
| 5 — Slack | Testes de contrato da composição e executor; item 3 integra depois deste merge em seus novos `orchestration/*`, sem escrita concorrente em outbound-consumer. O teste final usa o guard/store reais do item 3. |
| 6 — WhatsApp | Mesmo journal/porta/hook, mantendo o bloqueio explícito do modo attention até seus pré-requisitos completos. |

Preservada integralmente a seção 5.1 da R2: esperar merge do PR1 do item 1 e rebasear sobre ele antes da implementação dependente. **Nenhuma alteração prevista** nos sete arquivos reservados (`thread-lifecycle-store`, `thread-turn-health-store`, `thread-attention-admission`, `decisions/store`, `decisions/delivery`, `decisions/schema`, `threads/service`). O hook de envio não escreve nesses stores nem abre `withThreadWriteLease` aninhado; lê os fatos/provas já emitidos. Não muda assinatura do wrapper. Necessidade nova de DML protegido ou mudança de assinatura é levada ao main antes de editar, preservando o teste anti-bypass.

## 5. Testes obrigatórios adicionais

Testes focados com SQLite real isolado, duas conexões e barreiras; stub só na fronteira externa. No item 2, testar o executor e a porta com participante transacional de teste; antes de habilitar atenção, repetir com **guard/CAS/store reais do item 3**, sem tratar stub como prova da integração final.

| Caso | Prova exigida |
| --- | --- |
| `begin_handoff_and_receipt_protection_commit_together` | CAS semântico, parte in_flight e proteção do receipt aparecem juntos após commit. Injetar falha entre cada escrita e no COMMIT: nenhuma escrita parcial, nenhum permit, zero provider calls. |
| `cancel_vs_begin_handoff_has_one_winner` | Duas ordens concorrentes: cancel vencedor → zero send; begin vencedor → nenhum B. Testar FK diferida com B ausente e UNIQUE de membro ativo; rollback mantém estado original. |
| `same_owner_retry_cannot_reenter_handoff` | Replay com mesmo owner/ref/parte não reenvia. `next` só autoriza outra parte planned após checkpoints confirmados; não permite novo begin. |
| `attention_restart_does_not_take_over` | Crash após commit antes do provider, depois de sucesso antes do recibo e entre partes: uncertain durável; nenhum send/novo B/takeover. Reconciliação só de leitura; receipt confirmado nunca duplica. |
| `proof_and_part_fence_are_checked_in_same_transaction` | Revogar epoch/revisão/audiência ou perder fence antes do lock bloqueia o CAS. Prova que exige rede retorna pending. API stub verifica que nenhuma transação está aberta no momento do send. |
| `attention_service_output_without_ingress` | Reconciler real → lote prepared → porta comum → outbox/consumer → guard real → executor → Slack stub, sem binding/turno fictício. Purpose, identidade, fingerprint e destino preservados; replay idempotente. No item 2, preparar o harness; a integração real é gate do item 3. |
| `attention_origin_cannot_bypass_registration_or_capability` | Registro/guard ausente, eventId falso, ref/operação/alvo divergente e WA sem requisitos: zero I/O, erro explícito. Mesmo purpose não converte cron em attention. |
| `update_failure_cannot_create_without_readmission` | Capability update não alcança post/upload/Canvas. Falha incerta não cria saída; readmissão comprovada exige novo evento attention e CAS completo. |

Os oito casos purpose×canal e os gates de mídia, autorização, excesso, falha de render e delivery da R2 permanecem. **Validação desta revisão:** somente documento e consistência do contrato; nenhum teste de produto executado, nenhum código editado, nenhum restart. Publicação de PR continua por `ravi pr publish` após aprovação do plano. A próxima ação é revisão deste contrato, não implementação.
