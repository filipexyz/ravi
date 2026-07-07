# Why

Block Kit permite que Slack deixe de ser apenas texto e vire uma superficie de
operacao: aprovar, escolher, abrir fluxo, coletar input e disparar automacoes.

Sem contrato nativo, cada agent tenderia a chamar Slack Web API diretamente,
duplicando validacao, expondo detalhes de credencial e perdendo rastreabilidade.

O Ravi precisa de Block Kit nativo por tres motivos:

- mensagens ricas e consistentes no Slack;
- interacoes transformadas em eventos Ravi auditaveis;
- base para triggers, automacoes e futuras skills sem depender do Omni.

Canvas e documento. Block Kit e interface interativa. Manter essa fronteira evita
misturar publish documental com eventos de chat.
