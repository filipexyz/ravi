# Plano de implementação — CRM agent-first

## Objetivo

Fazer o domínio CRM do Ravi operar de forma descobrível e segura para agentes, mantendo os comandos existentes durante a migração.

## Escopo fechado

Incluído:

- INC-1: erros específicos para alvo inexistente em mutações;
- INC-2: validação uniforme de filtros;
- INC-3: mensagens, ajuda e exposição acionável;
- INC-4: paginação, payloads e contratos de saída;
- INC-5: metadata de pipeline e estados publicados;
- fachada CRM para intenção, plano, aplicação, verificação e recuperação;
- contratos decorados, SDK/OpenAPI gerados e testes.

Fora do escopo:

- alteração direta da VPS;
- uso dos containers `crm-assistant` e `aprovacao-oportunidade-router`;
- criação de outro domínio ou outro banco CRM;
- migração destrutiva dos consumidores existentes.

## Sequência de commits

### Commit 1 — contrato e rastreabilidade

Publicar este plano, as decisões e o mapa requisito → código → teste.

### Commit 2 — INC-1 e INC-2

Aplicar erros específicos e rejeição uniforme de filtros inválidos. Preservar o caminho feliz e o comportamento de leitura já compatível.

### Commit 3 — INC-3 e INC-4

Corrigir mensagens, ajuda, paginação e respostas. Alias existentes não serão removidos sem migração documentada.

### Commit 4 — INC-5

Publicar a regra da metadata de pipeline: o schema é normativo; `review` é um relatório derivado. Publicar os estados observáveis do CRM.

### Commit 5 — fachada de leitura e planejamento

Adicionar intenção, resolução de zero/um/muitos alvos e plano imutável. Nenhuma escrita ocorre nesta fase.

### Commit 6 — aplicação, verificação e recuperação

Adicionar confirmação ligada ao plano, journal de efeitos, leitura de confirmação e terminais seguros para resultado desconhecido ou parcial.

### Commit 7 — projeções públicas

Regenerar SDK/OpenAPI/manifestos e adicionar testes de transporte e compatibilidade.

### Commit 8 — documentação do PR

Registrar decisões, limitações, comandos de CI esperados e instruções de implantação pós-merge.

## Critério de término

O PR estará pronto para merge quando cada item declarado `implemented` tiver
teste, consumidor identificado e resultado do CI. Itens `partial` e `projected`
devem permanecer visíveis na rastreabilidade; eles não bloqueiam o piloto nem
podem ser apresentados como comportamento completo do domínio.

Testes locais só começam depois do freeze da implementação e não substituem o
CI.

## Máquina de estados executada pela fachada

A candidata persiste somente estes avanços de estado:

| Origem | Evento | Destino | Regra executada |
|---|---|---|---|
| inexistente | `plan` válido | `planned` | resolve alvo e referências, cria hash e expiração de 15 minutos; não escreve no CRM |
| `planned` | aprovação externa positiva | `approved` | exige plano íntegro e não expirado; persiste hash, destino e instante |
| `approved` | `apply` reivindica o plano | `applying` | operação atômica, de uso único, exige aprovação ligada ao hash e plano não expirado |
| `applying` | efeito e leitura terminam sem exceção | `applied` | registra o efeito e o readback; `verify` ainda pode detectar divergência |
| `applying` | efeito ou leitura lança erro | `unknown` | bloqueia reaplicação e exige inspeção manual por `verify`/`recover` |

`verify` e `recover` não alteram o estado persistido. Eles classificam a leitura
como `applied`, `not_applied`, `partial` ou `not_determined`; `recover` sempre
retorna `replay: false`. Expiração é um bloqueio e um indicador de leitura, não
um estado. A candidata não reabre planos `applied` ou `unknown`, não volta um
plano alterado para `planned` e não persiste `not_applied` como estado. Embora
`partial` exista no tipo de estado, os comandos atuais o produzem como resultado
de verificação, não como transição persistida.

## Política de lifecycle e comportamento legado

`crm lifecycle show` publica a política-alvo para agentes descobrirem estados e
operações. Nesta etapa, ela não é uma barreira global de escrita:

- contatos: a lista publicada é vocabulário recomendado; `contact.set` ainda
  não valida uma matriz de transição entre valores de lifecycle;
- oportunidades: mover para um stage deriva o status da configuração desse
  stage, sem uma matriz geral de origem e destino;
- tasks: a política publicada diz que `done` e `canceled` são terminais. No
  comportamento legado, `snooze` rejeita esses dois estados, mas `done` pode
  sobrescrever `canceled` e `cancel` pode sobrescrever `done`;
- facts: a política publicada descreve `proposed → confirmed|rejected` e
  `confirmed → superseded`. O atualizador legado aceita mudar para esses estados
  a partir de outros estados; a fachada piloto oferece apenas `confirm` e
  `reject`.

Consequentemente, agentes não devem interpretar a saída de lifecycle como prova
de enforcement fora da fachada. Tornar essa política obrigatória exige decisão
de compatibilidade e migração dos consumidores legados.

## Plano de validação adversa

Os cenários abaixo são o contrato de teste do piloto. `covered-local` identifica
teste automatizado já executado; `test-required` é uma lacuna explícita que o CI
atual não transforma sozinho em cobertura; `controlled` requer ambiente
descartável ou rollout pós-merge autorizado.

| Cenário | Resultado exigido | Evidência requerida |
|---|---|---|
| alvo primário inexistente ou invisível | erro tipado, nenhum plano e nenhum efeito | `covered-local` para invisibilidade; demais tipos `test-required` |
| stage, contato ou conta derivada inexistente | plano recusado antes da persistência | `test-required` |
| operação, campo, número ou timestamp inválido | erro de uso com o parâmetro identificado | `test-required` |
| payload persistido alterado sem atualizar o hash | `PLAN_INTEGRITY_ERROR` | `covered-local` |
| plano expirado antes de aprovar ou aplicar | aprovação/aplicação recusada, zero efeito | `test-required` |
| aplicação sem aprovação | zero efeito e erro específico | `covered-local` |
| aprovação negada ou destino ausente | zero efeito e erro específico | `test-required` com transporte simulado |
| duas aplicações concorrentes do mesmo plano | somente uma reivindicação e no máximo um dispatch | `test-required` com concorrência |
| nova aplicação após `applied` | recusa sem replay | `covered-local` |
| nova aplicação após `unknown` | recusa sem replay | `test-required` |
| efeito lança erro depois do dispatch | estado `unknown`, journal preservado e `replay: false` | `test-required` com falha injetada |
| readback não confirma um plano marcado `applied` | resultado `partial`, sem correção automática | `test-required` com readback divergente |
| readback indisponível ou inconclusivo | resultado `not_determined`, revisão manual | `test-required` com falha injetada |
| contato relacionado sem visibilidade | resposta indistinguível de não encontrado, zero efeito | `test-required` |
| `done` depois de `canceled`, `cancel` depois de `done` e `snooze` terminal | caracterizar o legado descrito acima; não afirmar enforcement da política-alvo | `test-required` de regressão |
| transição de fact fora da política publicada | caracterizar o legado e impedir que a documentação prometa bloqueio | `test-required` de regressão |
| consumidor chama escrita crua | comando permanece compatível e é identificado como bypass da fachada | inspeção de superfície + rollout |
| resposta de aprovação no transporte real | hash e destino recebidos correspondem ao plano; identidade do aprovador continua limite declarado | `controlled`, após merge |

Os testes com transporte simulado demonstram integração e decisões positiva ou
negativa, mas não provam autenticação ponta a ponta. O transporte atual devolve a
decisão; a fachada CRM registra `channel`, `accountId`, `chatId`, hash e instante,
sem persistir recibo assinado ou identidade autenticada independente do
aprovador. Até essa capacidade existir, operações de maior impacto devem
permanecer sob rollout restrito e revisão humana no canal controlado.

## Gate de implantação

Depois do merge, implantar somente o commit aprovado na branch `dev`, verificar
leitura e contratos primeiro e habilitar as nove mutações somente após
confirmação separada. Esse gate é operacional: a candidata não inclui feature
flag que desabilite os comandos de escrita legados.
