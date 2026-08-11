# Checks

- Standalone canvas creation MUST call `canvases.create` with markdown `document_content` when markdown is provided.
- Channel canvas creation MUST call `conversations.canvases.create`; with `--ensure`, `channel_canvas_already_exists` MUST return the existing canvas via `conversations.info`.
- `canvas-edit` MUST validate operation requirements: markdown for insert/replace, section id for delete and relative insert, title for rename.
- `canvas-sections-lookup` MUST expose `section_types` and `contains_text`.
- `canvas-access-set` and `canvas-access-delete` MUST reject simultaneous `--users` and `--channels`.
- `canvas-access-set owner` MUST reject `--channels`; owner can target users only.
- `canvas-access-delete` MUST execute immediately without `--execute` because it reduces sharing.
- `canvas-showcase` MUST publish rich markdown and the current gap list.
- `canvas-channel-showcase` MUST ensure the channel canvas before publishing the showcase.
- `canvas-channel-showcase` MUST reuse an existing Canvas tab with the same title before creating a new tab.
- `canvas-create`, `canvas-channel-create` and `canvas-edit` MUST accept `--artifact` as canonical Markdown input.
- `canvas-create`, `canvas-channel-create` and `canvas-edit` MUST reject simultaneous `--markdown`, `--markdown-file` and `--artifact`.
- Publishing with `--artifact` MUST register snapshot/version, `slackCanvas.current` metadata, `slack.canvas.published` event and `slack_canvas`/`slack_channel` links when the operation publishes the full document.
- Section patching with `--artifact` MUST NOT overwrite `slackCanvas.current`.
- Publishing with `--artifact` MUST declare `syncDirection=artifact_to_slack` and `remoteContentExportSupported=false`.
- `canvas-artifact-status` MUST show local hash, last published hash and known local drift without promising remote diff against Slack.
- Risky mutations MUST default to dry-run and MUST execute only with `--execute`.
- Tests MUST cover JSON serialization of complex Slack Web API arguments.
