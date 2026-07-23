# Por que Slack Canvas

O Ravi precisa de uma superficie melhor que mensagem para artefatos longos e vivos.

Canvas permite publicar estado compartilhado no proprio Slack:

- plano de trabalho;
- checklist de migracao;
- spec resumida;
- status de sessao;
- runbook do canal;
- resumo de PR ou release.

O ganho principal e reduzir ruido de mensagens sem perder contexto operacional.

## Por que manter modelo canonico local

A API oficial e forte para escrever e localizar secoes, mas nao deve ser tratada como banco canonico do Ravi. O Ravi precisa saber o que publicou, qual anchor semantico representa cada secao e como reconstruir o documento sem depender de export completo do Slack.

## Por que artifact primeiro

O caminho mais seguro e tratar Markdown como artifact canônico do Ravi e Canvas como projecao publicada.

Isso preserva:

- versionamento local;
- lineage por sessao/agent/canal;
- eventos de publish;
- possibilidade de replay;
- politica de permissao do Ravi;
- rollback via artifact version.

Sync bidirecional automatico foi descartado nesta fase porque a API usada aqui nao entrega leitura completa do documento nem eventos suficientes de edicao manual. Sem isso, qualquer "duas vias" seria heuristica fragil e poderia sobrescrever conteudo sem auditoria clara.
