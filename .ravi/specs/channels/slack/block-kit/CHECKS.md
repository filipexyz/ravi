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
- Socket Mode MUST publish ordinary Block Kit interactions to
  `ravi.inbound.interaction`; reserved credential intake callbacks MUST be
  consumed and scrubbed before generic publication or URL persistence.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/channels/slack/credential-intake.test.ts src/channels/slack/socket-mode.test.ts`
- Native Slack permission approval MUST use versioned action ids
  `ravi.approval.v1.approve` and `ravi.approval.v1.reject` and MUST NOT
  create a runtime turn from those clicks.
- Interaction events MUST NOT expose `response_url` or Slack tokens.
- Interaction events SHOULD expose `responseUrlId` when Slack provides a
  response URL.
- `responseUrlId` MUST resolve through a local broker and MUST support
  `replace_original` for ephemeral interactive messages.
- Block Kit specs and skill docs MUST keep Canvas as a separate document
  surface.
- A response handle MUST accept only `https://hooks.slack.com/actions/` and
  `https://hooks.slack.com/commands/`, MUST refuse the sixth post before any
  request, and MUST give each post a deadline. Two callers racing for the last
  use MUST NOT both post.
- Socket Mode MUST answer `app_home_opened` with `tab: "home"` by publishing a
  valid `type: "home"` view through `views.publish` for the event's user, and
  MUST ignore `tab: "messages"`.
- The default Home MUST work for an agent with no configuration, MUST show only
  the agent's name and, only when the agent is listed in the org directory,
  its directory description (escaped), and MUST keep every text within Block
  Kit limits and at most 100 blocks.
- The runner MUST NOT publish again a Home whose `private_metadata` fingerprint
  matches the view the user already has.
- A `views.publish` failure MUST be logged with Slack's error and MUST NOT fail
  the envelope or stop the runner.
- Each `views.publish` MUST be bounded by a timeout that aborts the request,
  so an unanswered publish settles its envelope and never blocks the drain.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/channels/slack/app-home.test.ts src/channels/slack/client.test.ts`
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/channels/slack/socket-mode.test.ts -t "Slack App Home"`
