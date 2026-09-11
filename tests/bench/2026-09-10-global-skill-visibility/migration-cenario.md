# Cenário — migração de skills do Jarvis

## Escopo

Comparar conjuntos nominais do Jarvis observados na VPS com a política local proposta. A coleta remota consulta SQLite em modo somente leitura e arquivos do pacote ativo; não inicia o RAVI, não carrega credenciais, não envia mensagens e não altera permissões ou arquivos remotos. Os testes usam estado local isolado.

## Critérios registrados antes da execução

1. Capturar somente identidade do pacote, concessões de skills, capacidades declaradas, capacidades de contextos sanitizados e metadados de catálogo. Credenciais, chaves de contexto e conteúdo de conversas ficam excluídos.
2. Distinguir capacidades declaradas do agente, materialização do bootstrap e autoridade de um contexto real; nenhuma dessas fontes pode ser tratada como sinônimo das demais.
3. Comparar IDs canônicos e proveniência, não exigir contagens fixas do incidente.
4. Concessão explícita não pode expor uma skill com requisito ausente, inválido, indisponível ou negado.
5. Skills first-party só usam a migração explícita existente. Skills externas sem requisitos permanecem pendentes de classificação.
6. O conjunto anunciado/materializado na fixture deve coincidir com o snapshot central; nenhuma skill omitida pode reaparecer.
7. A regressão deve acusar contaminação com uma skill excluída e revogação após preparação; remover a superfície de ferramentas não pode ser compensado por grants.

## Evidência e limite

A fixture sanitizada preservará nomes e relações verificadas, acompanhada de origem e data. O relatório separará dados observados, simulação local e pendências. Não haverá promessa de melhoria de latência nem alegação de descoberta efetiva na produção após migração. O registro não será commitado nesta tarefa, conforme a instrução explícita de não criar commits.
