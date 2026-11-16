# Intenção na saída por canal — revisão 5: oráculo de compatibilidade

**Estado:** plano para revisão; somente documentação, sem implementação ou ativação. Worktree `/Users/luis/dev/filipelabs/ravi-channel-intent-20261115`, branch `plan/ravi-channel-intent-20261115`; dona: sessão `main-t-1794776629328249`.

Esta revisão torna verificável o requisito “novos compatíveis” da [R4](channel-output-purpose-plan-20261115-r4.md), artifact `art_mwif4txv_beaa1196a3`. Preserva R2/R3/R4, inclusive prova física de parada do antigo, exclusão de starts concorrentes, uncertain sem reenvio, hook/CAS e origem attention. **Readiness de processo e protocolo de Threads do item 1 não são provas de compatibilidade de delivery.** São oráculos distintos; nenhum implica o outro.

## 1. Fonte consultável por boot

**Fonte escolhida: arquivo de declaração de delivery por boot**, separado do receipt genérico de runtime já existente em `runtime-processes/<name>.json`. Novo módulo `src/channels/delivery-boot.ts` publica atomicamente, antes de iniciar qualquer loop de delivery:

`<stateDir>/runtime-processes/delivery/<processName>-<pid>-<bootId>.json`

Diretório privado e arquivo com as mesmas permissões do registro de runtime; escrita temporária + rename. Um arquivo por boot impede que dois consumidores sobrescrevam a evidência um do outro. O controlador conhece o inventário esperado por seu interlock; não considera a mera listagem de arquivos um inventário completo.

Exemplo do contrato novo — valores extraídos das constantes do **bundle em execução**, não de flags, env ou request de health:

```json
{
  "bootFormatVersion": 1,
  "processName": "ravi-channels",
  "pid": 42001,
  "bootId": "boot-exemplo-1",
  "processStartedAt": 1794780000000,
  "bundleSha256": "<digest-do-bundle-carregado>",
  "stateIdentity": "<identidade-canonica-do-state-e-db>",
  "consumerDomain": "<dominio-da-fila-e-dos-writers>",
  "deliveryProtocolVersions": [2],
  "receiptSchemaReadVersions": [2],
  "receiptSchemaWriteVersions": [2],
  "features": ["part_receipts", "uncertain"]
}
```

As listas declaram versões efetivamente suportadas, não uma promessa de compatibilidade futura. `part_receipts` significa persistir/consultar identidade, estado e recibo por operação; `uncertain` significa reconhecer, reter e impedir resend/takeover automático desse estado. O contrato exige ambos; números de versão isolados não suprem features ausentes. O formato do arquivo, a versão de `ChannelOutputEnvelope`, a versão do schema de recibos e o protocolo de Threads são domínios separados, ainda que algum número coincida.

Todos os processos capazes de consumir, reclamar, enviar, reconciliar ou podar esse domínio precisam declarar delivery: inclui `ravi-channels` e o daemon `ravi` quando ele tem o caminho de envio direto/WA. Bootstrap de ambos publica a declaração e permanece em standby. Um processo vivo sem declaração entra como desconhecido; não é ignorado por não estar no diretório. Dois processos novos também não podem se liberar individualmente por aprovarem apenas a própria declaração.

**Leitura do controlador:** `channels/delivery-activation.ts` lê esses arquivos diretamente e vincula cada declaração ao PID + identidade de início/boot observados pelo controlador de processos e à identidade de bundle carregado. Confere state/domínio e epoch do inventário sob o interlock do item 1. Arquivo de boot morto, PID reutilizado, hash divergente, origem não verificável, formato ilegível ou arquivo faltante não provam suporte. Não consulta health para preencher campos e não deduz protocolo da versão do pacote, do nome do branch ou de um arquivo de bundle substituído em disco depois do boot.

A consulta proposta `ravi channels delivery-compatibility --json`, em `src/cli/commands/channels.ts`, usa o mesmo leitor/comparador do controlador e retorna floor, protocolo ativo, schema requerido, cada identidade de boot, declaração, relação e motivo, além da relação agregada. É somente leitura e não libera o gate. Se for necessário conhecer um boot antes de o gateway subir, o controlador lê o arquivo diretamente; não depende dessa rota CLI nem de endpoint de health.

## 2. Floor da migração e três relações

**Fonte do requisito:** singleton novo `channel_delivery_contract` no mesmo SQLite dos receipts, escrito apenas pela migração explícita depois do gate de parada da R4. A migração declara estaticamente o mesmo requisito para seu preflight; a linha persistida confirma o contrato instalado. Não alterar floor pelo caminho de status/health. Campos:

| Campo | Valor desta entrega / significado |
| --- | --- |
| `id` | Singleton `delivery` |
| `migration_id`, `migration_digest` | Identidade verificável da migração instalada |
| `contract_epoch` | Revisão monotônica do contrato; invalida permits anteriores |
| `delivery_protocol_floor` | `2`: menor protocolo elegível |
| `active_delivery_protocol` | `2`: protocolo escolhido para todo este domínio |
| `receipt_schema_version` | `2`: versão exata do schema de recibos instalado |
| `required_features_json` | `["part_receipts","uncertain"]` |

O leitor abre o state existente em modo somente leitura, sem create/migrate/getDb que inicialize schema implicitamente. Ausência de tabela/linha, contrato ilegível, digest não verificável ou protocolo ativo abaixo do floor retornam desconhecido e não tentam “corrigir” o state. Durante migração, o dono offline usa o requisito estático e seu permit próprio; recovery exige contrato instalado e validado. Uma mudança futura do protocolo ativo/floor/schema exige nova migração/epoch e nova avaliação, não negociação oportunista entre consumidores.

Para cada boot válido, a comparação é determinística:

| Relação | Condição | Autoriza |
| --- | --- | --- |
| **suporta** (`supports`) | Protocolo ativo é ≥ floor **e pertence** a `deliveryProtocolVersions`; schema instalado pertence às listas de leitura **e** escrita; todas as features obrigatórias estão declaradas. Identidade, requisito e declaração são verificáveis. | É elegível para compor o gate. Recovery só pode abrir quando **todos** os boots esperados suportam e os demais gates da R4 estão satisfeitos. |
| **não suporta** (`unsupported`) | Declaração íntegra e identidade verificável, mas falta a versão ativa, suporte de leitura/escrita do schema ou feature obrigatória. | **Zero recovery/pull/claim/send/prune** para todo o conjunto; manter standby. Readiness verde não muda o resultado. |
| **desconhecido** (`unknown`) | Falta evidência verificável do boot, contrato ou inventário; arquivo ausente/stale/malformado; versão do formato desconhecida; PID/boot/hash/state inconclusivos. | O mesmo bloqueio integral. Não presumir suporte, converter para legacy ou “tentar” delivery para descobrir. |

Um consumidor que só declara protocolo 3 **não** suporta automaticamente um domínio ativo em 2, apesar de 3 superar o floor. Precisa declarar 2 explicitamente ou esperar novo contrato de migração. Schema de leitura sem escrita também não libera um writer. Boot sem campos novos é unknown, não versão 1 inferida nem supports por backward compatibility.

**Regra agregada:** inventário completo, estável e não vazio, com `supports` para cada membro esperado. Qualquer unsupported/unknown mantém gate fechado para todos. O permit de ativação vincula contract_epoch, digest dos requisitos, conjunto de PID/boot/bundle, state/domínio e epoch do cutover. Boot novo, substituto, mudança de requisito ou perda do interlock invalida o permit antes de nova operação; reavaliar o conjunto inteiro. Não tratar uma prova antiga como autorização perpétua. Chamadas já em handoff seguem os recibos/uncertain da R2/R3, sem alegar desfazer efeito externo.

Readiness continua podendo informar que um processo novo está vivo/em standby. **Ele pode estar ready e incompatível.** Protocolo/floor de Threads informa se o processo respeita contratos de threads e seu fence; não informa nada sobre representação de receipts, partes ou uncertain. Na resposta de status e no corpo do PR, mostrar esses três resultados separadamente. Nunca substituir a comparação de delivery por readiness AND threadProtocolReady.

Na implementação inspecionada do item 1, os nomes concretos são `THREAD_WRITER_PROTOCOL` versus `thread_schema_fence.min_protocol/phase/epoch`, leases em `thread_schema_write_lease` e readiness de stores em `state_schema_versions`. Nenhum publica suporte de delivery. O boot receipt genérico atual tem identidade/bundle e formato `schemaVersion:1`, sem protocolo de delivery; esse 1 não pode ser reutilizado como versão de recibo. A declaração nova também não é autorização isolada de escrita: só alimenta o comparador, e a liberação exige conjuntamente floor instalado, inventário, interlock e parada comprovada da R4. Confirmação de entrega continua vindo dos recibos do provider, nunca do boot.

## 3. Teste obrigatório com subprocessos reais

`delivery_ready_but_incompatible_boot_blocks_all_effects`, novo teste focado de `channels/delivery-activation.test.ts`:

1. Criar DB/NATS isolados, contrato de delivery já instalado com protocolo ativo/floor `2`, schema `2`, features obrigatórias e uma linha uncertain. Preparar evidência válida de parada dos antigos. Assim o teste isola o oráculo novo, sem falhar antes por falta de cutover.
2. Iniciar **dois subprocessos novos reais**, ambos executando o bootstrap em standby e declarando readiness e protocolo de Threads válidos. A declara delivery `[2]`; B, um bundle de fixture com declaração válida e identidade verificável, declara somente `[1]`. As constantes divergentes pertencem aos bundles de teste; não criar override de produção que possa mentir sobre capabilities.
3. O controlador lê os dois arquivos de boot, os vincula aos processos vivos e compara com a linha instalada. Resultado: A supports, B unsupported, agregado bloqueado. Disparar startup/recovery, timer de manutenção, wake de fila e tentativas pelos caminhos normais enquanto a barreira mantém ambos vivos.
4. Assertar **ZERO recovery, ZERO pull, ZERO claim, ZERO send, ZERO prune**, tanto agregado quanto por processo. Instrumentar entradas do reconciler, consumo NATS, writes de ledger e adapter externo; conferir recibos/partes/uncertain e filas inalterados. Proibir que o processo A comece antes de B apresentar sua declaração. Leitura de evidências e escrita do arquivo de boot são permitidas; nenhuma dessas ações pode executar DDL/DML de delivery ou mascarar efeitos com rollback posterior.
5. Retirar B com prova física, substituir por boot real que suporte `[2]`, revalidar inventário/epoch e abrir o gate. Só agora recovery pode iniciar; a linha uncertain segue a reconciliação conservadora da R4, sem resend. Não editar o arquivo de B vivo para “curar” o teste.

Repetir com uncertain ausente; incompatibilidade bloqueia independentemente dos dados existentes. Variantes obrigatórias: protocolo 3 sem 2, schema sem suporte de escrita, ausência de part_receipts/uncertain, declaração ausente ou arquivo de outro boot, PID reutilizado e processo adicional não inventariado. Os casos de declaração válida incompatível devem resultar unsupported; os de evidência ausente/inverificável, unknown. Todos mantêm os cinco contadores em zero. Readiness e Threads permanecem verdes nos casos principais para provar a independência dos oráculos.

## 4. Entregas e critério do PR

PR1 mantém infraestrutura inativa: constantes/tipos em novo `channels/delivery-protocol.ts`, contrato de schema/migração e comparador puro, sem ativação. PR2 entrega publisher/leitor de boot em `channels/delivery-boot.ts`, comparação agregada em `channels/delivery-activation.ts`, publicação de evidência no bootstrap de runner/daemon e guards antes de maintenance/recovery/pruner/pull/claim/send. A CLI de consulta usa esse mesmo comparador. O controlador do item 1 fornece identidade/interlock; o oráculo específico de delivery é responsabilidade do item 2. Não modificar protocolo de Threads para fazê-lo representar delivery.

Acrescentar ao corpo dos PRs, junto da matriz de quatro células da R4: caminho da declaração por boot, requisito da migração, resultados individuais/agregado, distinção readiness/Threads/delivery, SHA e resultado do teste com dois subprocessos e os cinco contadores. “Novo compatível” na matriz significa **supports pelo oráculo desta R5**, com os demais gates da R4 válidos.

**Validação desta revisão:** plano documental; testes acima são critérios futuros, não resultados já executados. Nenhum código alterado, consumer iniciado, migração aplicada ou restart executado. Publicar implementação por `ravi pr publish` após aprovação. Aguarda revisão final.
