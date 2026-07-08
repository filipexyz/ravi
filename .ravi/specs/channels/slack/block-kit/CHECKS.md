# Checks

- `blocks-validate` MUST call `blocks.validate` and support targets `blocks`,
  `message` and `view`.
- `blocks-send` MUST be dry-run by default and MUST require `--execute` before
  `chat.postMessage`.
- `blocks-update` MUST be dry-run by default and MUST require `--execute` before
  `chat.update`.
- Block Kit messages MUST include top-level fallback `text`.
- Local validation MUST reject message payloads with more than 50 blocks.
- Local validation MUST reject `actions` blocks with more than 25 elements.
- Local validation MUST reject `block_id` and `action_id` above 255 characters.
- Socket Mode MUST publish Block Kit interactions to
  `ravi.inbound.interaction`.
- Interaction events MUST NOT expose `response_url` or Slack tokens.
- Interaction events SHOULD expose `responseUrlId` when Slack provides a
  response URL.
- `responseUrlId` MUST resolve through a local broker and MUST support
  `replace_original` for ephemeral interactive messages.
- Block Kit specs and skill docs MUST keep Canvas as a separate document
  surface.
