# Proposta para revisão — identidade e classificação das skills

Estado: proposta, não aprovada nem implementada. Complementa o [resultado da migração](migration-resultados.md); não autoriza alterações na VPS.

## Problema e limite

O catálogo atual gera aliases curtos automaticamente para todas as origens. Assim, `ravi-system:sessions` e `ravi-user-skills:sessions` disputam `sessions`, e ambas são omitidas. Grants qualificados, sozinhos, não resolvem esse conflito. Dos 29 pares capturados, somente dois possuem o mesmo hash de conteúdo; os outros 27 não são byte a byte iguais. Essa diferença não prova alteração semântica, mas impede presumir que todas as cópias são intercambiáveis.

A meta é recuperar uma identidade inequívoca para as skills necessárias, mantendo arquivos pessoais e histórico intactos. Autoridade da origem, elegibilidade e autorização de ferramenta continuam sendo decisões separadas. Não haverá escolha automática por ordem de descoberta, nome de adapter ou privilégio administrativo.

## Alternativas mínimas

| Opção | Mudança proposta | Vantagem | Custo e risco |
| --- | --- | --- | --- |
| A — IDs qualificados e aliases explícitos | IDs canônicos permanecem distintos. Aliases curtos passam a ser opt-in, com dono explicitamente declarado no catálogo central. A configuração de migração pode atribuir um alias à versão interna ou à pessoal, sem editar o arquivo de origem. | Permite preservar e eventualmente expor as duas variantes por IDs diferentes; evita nova colisão por simples instalação de uma cópia. | Esforço estimado médio: compatibilidade de grants e descoberta precisa ser testada. Referências curtas antigas exigem decisão; não podem ser reatribuídas silenciosamente. |
| B — Escolha explícita de fonte por skill | Uma declaração central aprovada admite determinada origem na descoberta gerenciada; versões não admitidas ficam inventariadas para o operador, preservadas no disco e fora do catálogo dessa execução. | Menor mudança no contrato de aliases; adequada quando só uma variante deve ser utilizável. | Esforço estimado pequeno a médio: cria configuração de fontes por skill. A variante preservada não continua acessível ao agente por esse caminho; seleção ampla de um plugin inteiro poderia ocultar skills pessoais úteis. |

Recomendação para revisão: A, por separar identidade estável de apelidos de compatibilidade e permitir variantes sem conflito. Não se propõe ignorar uma ambiguidade: o catálogo precisa chegar ao resolvedor com cada alias aprovado pertencendo a uma única identidade. Qualquer colisão não resolvida continua omitida e diagnosticada. B é uma alternativa quando a escolha humana for manter apenas a versão interna na descoberta gerenciada.

As declarações seriam centrais e independentes de adapter. Hoje não existe essa configuração pronta: o catálogo constrói aliases automaticamente em `src/runtime/skill-policy-catalog.ts`; essa proposta requer desenho e testes próprios antes de implementação. Não é um procedimento de configuração já disponível.

## Classificação first-party: lote seguro de revisão

Manter os requisitos já migrados por grupos reais, incluindo as alternativas explícitas `whatsapp.dm`/`whatsapp.group`. Para os casos restantes, revisar somente fontes internas conhecidas; o nome ou a origem de uma skill externa não demonstram independência de ferramentas.

| Categoria | Tratamento proposto para revisão |
| --- | --- |
| `channels-manager` | Guia multidomínio: `channels` e `instances`, registrados em [channels.ts](../../../src/cli/commands/channels.ts) e [instances.ts](../../../src/cli/commands/instances.ts). Revisar os fluxos antes de escolher AND ou OR. |
| `crm-manager` e `observers` | Famílias com subgrupos reais, não apenas grupos pais: [crm.ts](../../../src/cli/commands/crm.ts) e [observers.ts](../../../src/cli/commands/observers.ts). Declarar as alternativas efetivamente cobertas pelo guia; não inventar uma capacidade de pai a partir de qualquer prefixo. |
| `meetings` | Usa `meetings`, `meetings.profiles` e artefatos de acompanhamento. Em [meetings.ts](../../../src/cli/commands/meetings.ts), login e entrada em chamada são `CliOnly`: ferramenta host disponível não prova disponibilidade dessas operações. |
| `slack` | Vínculo operacional com o grupo registrado em [slack.ts](../../../src/cli/commands/slack.ts); candidata a `ravi.cli.slack`, sem ampliar autorização de cada operação. |
| `tag-rules` | Inspeção e aplicação existem em [tag-rules.ts](../../../src/cli/commands/tag-rules.ts). Criação depende de arquivo; não existe uma operação CLI `create` que possa ser presumida disponível. |
| `tasks-manager` e `cross-manager` | Os textos internos os tratam como legados de `tasks` e `sessions`. Revisar uma migração de referência para esses sucessores, sem materializar de novo os corpos legados nem duplicar catálogo. |
| `matrix-manager` | Está retirada e não possui sucessor único comprovado. Manter omitida até decisão explícita; não criar alias genérico para canais. |
| `architect` | O texto anuncia `ravi architect`, mas não foi encontrado grupo correspondente no registry atual. Exige revisão de instruções ou retirada; não declarar `none`. |
| `automation-recipes` | Combina `cron.add --shell`, `triggers.add --shell`, estado local e publicação por canal. São fluxos compostos: AND dentro de uma receita e, quando cabível, OR entre receitas. Não possui grupo próprio que dispense essa revisão. |
| `app-creator` | Os caminhos `apps.scaffold` e `apps.import-cli` existem em [apps.ts](../../../src/cli/commands/apps.ts); as instruções também incluem consultas, edição e testes. Operações de credenciais e contexto são condicionais. |
| `cli-creator` | Desenvolvimento local exige leitura, escrita/edição e execução. O caminho Ravi nativo inclui descoberta por [tools.ts](../../../src/cli/commands/tools.ts), mas o caminho standalone não deve herdar automaticamente essa dependência. |
| `ravi-rules` | Consulta `rules.sources` e importação `rules.import` existem em [rules.ts](../../../src/cli/commands/rules.ts); alterar regras e o carregador acrescenta arquivos e testes. |
| `prompt-builder` e `ravi-architecture` | Misturam referência/consulta com desenvolvimento e diagnóstico. Separar os usos ou declarar os requisitos por fluxo; não exigir toda ferramenta apenas citada nem presumir `none` pela ausência de grupo próprio. |

As ligações acima são evidência para revisão, não declarações finais para os guias inteiros. As demais skills pessoais permanecem sem classificação; esta proposta não converte o catálogo externo em `requires: none` nem amplia concessões.

## Decisões ainda necessárias

1. Quando nomes colidirem, manter as duas variantes acessíveis por ID qualificado ou somente uma origem na descoberta gerenciada?
2. Para referências curtas já concedidas, qual versão deve ser a autoridade? A escolha pode ser em lote para o conjunto básico interno, com exceções explícitas; o conteúdo pessoal divergente não será sobrescrito.
3. Quais guias legados e skills sem requisitos devem continuar operacionalmente disponíveis? A resposta define a classificação, não uma quantidade-alvo.

## Sequência e gate propostos

Depois de aprovação: registrar a decisão de identidade; preparar a declaração migratória em estado local isolado; classificar o lote first-party escolhido; comparar os conjuntos antes de qualquer ativação. Os testes devem provar preservação dos hashes dos arquivos pessoais, resolução inequívoca de aliases, omissão de conflitos restantes, ausência de novas permissões, paridade entre adapters e reconstrução de contexto antigo sem repetir ações.

Somente então revisar o diff de dados que seria aplicado, a procedência completa do artefato e o retorno seguro. A comparação do conjunto autorizado com a descoberta efetiva de uma execução real permanece obrigatória. Nenhuma destas etapas foi executada por esta proposta.
