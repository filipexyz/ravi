# Por Que Channels Existe

Channels define a fronteira semântica entre o Ravi e os transportes externos.

O Ravi precisa ser dono de conceitos como chat, thread, mensagem, ator, rota,
policy, presença, delivery e credenciais. WhatsApp, Slack, Omni e futuros
adapters devem fornecer transporte, rendering e capacidades específicas, mas
não devem decidir identidade operacional ou estado de sessão.

Sem esse domínio raiz, cada adapter tende a recriar semântica própria. Isso
faz feature code depender de ids crus de provedor, vaza detalhes de transporte
para agents e torna migrações como Omni para canais nativos difíceis de
auditar.

O spec raiz existe para manter invariantes comuns. Sub-specs como
`channels/credentials`, `channels/messages`, `channels/presence` e
`channels/runner` detalham contratos específicos, mas não podem contrariar a
fronteira principal: canal entrega eventos e payloads; Ravi decide semântica e
runtime.
