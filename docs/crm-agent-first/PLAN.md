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

O PR só estará pronto quando cada requisito tiver implementação, teste escrito, consumidor identificado e resultado do CI. Como não haverá bancada local, nenhum teste será marcado como executado antes do CI.

## Gate de implantação

Depois do merge, implantar somente o commit aprovado na branch `dev`, verificar leitura e contratos primeiro e habilitar mutações somente após confirmação separada.
