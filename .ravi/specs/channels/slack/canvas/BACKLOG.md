# Slack Canvas Backlog

## Ja implementado

- Web API client para `canvases.create`.
- Web API client para `conversations.canvases.create`.
- Web API client para `canvases.edit`.
- Web API client para `canvases.sections.lookup`.
- Web API client para `canvases.access.set`.
- Web API client para `canvases.access.delete`.
- Web API client para `canvases.delete`.
- CLI com dry-run/execute para operacoes de risco e remocao de acesso imediata.
- Validacao local de combinacoes invalidas de edit/access.
- Header JSON com `charset=utf-8`.
- Showcase repetivel em Canvas.
- Reuso de aba Canvas existente por `properties.tabs[].data.file_id` antes de criar showcase de canal.
- Artifact Markdown como fonte nativa de Canvas (`--artifact` em create/channel-create/edit).
- Status local de publish (`canvas-artifact-status`).
- Metadata `slackCanvas.current`, evento `slack.canvas.published` e links artifact -> Slack Canvas/canal.

## Falta para produto Ravi Canvas 100%

1. Modelo canonico `ChannelCanvas`
   - `canvas_id`, `channel_id`, `instance_id`, `owner`, `source`, `created_by`, `updated_by`.
   - Vinculo com session/chat/thread/artifact.
   - Versao local do documento gerado pelo Ravi.

2. Anchors semanticos locais
   - Nao depender de `section_id` temporario como chave duravel.
   - Mapear secoes por `semantic_key`, titulo e hash de conteudo.
   - Reconstruir patches quando o Slack trocar IDs temporarios.

3. Renderer Ravi -> Canvas
   - Renderer de specs, runbooks, PR summaries e task status.
   - Templates versionados para documentos recorrentes.
   - Markdown gerado a partir de schema, nao string manual espalhada.

4. Sync/diff
   - Detectar diferenca entre estado canonico local e ultimo publish registrado.
   - Publicar patch minimo por secao quando possivel.
   - Fallback para replace inteiro quando anchors falharem.
   - Nao prometer diff remoto enquanto Slack nao expuser export/eventos suficientes.

5. Observabilidade e replay
   - Registrar create/edit/access/delete no ledger de eventos.
   - Permitir replay idempotente de publicacao.
   - Expor diagnostico: ultimo publish, ultimo erro, canvas alvo.

6. Permissoes Ravi
   - Policies por agent/session/chat para criar, editar, deletar e compartilhar Canvas.
   - Separar capacidade de publicar conteudo de capacidade de alterar acesso.
   - Auditar quem pediu a mutacao e qual credential executou.

7. Eventos de edicao manual
   - Estudar se Slack expoe eventos suficientes para reconciliar mudancas manuais.
   - Caso nao exponha, documentar limitacao e usar reconcile manual/periodico.

8. User tokens e ownership
   - Avaliar quando bot token basta e quando user token e necessario.
   - Modelar login/consentimento sem vazar segredo para agents.

9. SDK/codegen
   - Gerar tipos e SDK a partir do contrato canonical de Canvas.
   - Evitar duplicar contratos entre CLI, client e runtime.

10. Testes live controlados
   - Suite opcional `RAVI_LIVE_TESTS=1` para workspace Slack real.
   - Criar canvas temporario, editar, lookup, compartilhar e apagar.
   - Garantir limpeza mesmo em falha.
