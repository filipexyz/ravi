# Checks

- Criar canvas standalone deve chamar `canvases.create` com `document_content` markdown quando markdown for informado.
- Criar channel canvas deve chamar `conversations.canvases.create`; com `--ensure`, `channel_canvas_already_exists` deve retornar o canvas existente via `conversations.info`.
- `canvas-edit` deve validar requisitos por operacao: markdown para insert/replace, section id para delete e insert relativo, title para rename.
- `canvas-sections-lookup` deve expor `section_types` e `contains_text`.
- `canvas-access-set` e `canvas-access-delete` devem rejeitar uso simultaneo de `--users` e `--channels`.
- `canvas-access-set owner` deve rejeitar `--channels`; owner so pode mirar usuarios.
- `canvas-showcase` deve publicar markdown rico e a lista de lacunas atuais.
- `canvas-channel-showcase` deve garantir o channel canvas antes de publicar o showcase.
- `canvas-channel-showcase` deve reutilizar aba Canvas existente com o mesmo titulo antes de criar nova aba.
- `canvas-create`, `canvas-channel-create` e `canvas-edit` devem aceitar `--artifact` como fonte Markdown canonica.
- `canvas-create`, `canvas-channel-create` e `canvas-edit` devem rejeitar combinacao simultanea de `--markdown`, `--markdown-file` e `--artifact`.
- Publicacao com `--artifact` deve registrar snapshot/version, metadata `slackCanvas.current`, evento `slack.canvas.published` e links para `slack_canvas`/`slack_channel` quando a operacao publicar o documento inteiro.
- Patch por secao com `--artifact` nao deve sobrescrever `slackCanvas.current`.
- Publicacao com `--artifact` deve declarar `syncDirection=artifact_to_slack` e `remoteContentExportSupported=false`.
- `canvas-artifact-status` deve mostrar hash local, ultimo hash publicado e drift local conhecido sem prometer diff remoto contra o Slack.
- Mutacoes devem ser dry-run por padrao e so executar com `--execute`.
- Testes devem cobrir serializacao JSON dos argumentos complexos da Slack Web API.
