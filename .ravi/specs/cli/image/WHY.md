# Image agent-first CLI contract / WHY

Image generation is the clearest case of the "external API money" brake class:
every `image generate` call bills a provider account, and agents call it
speculatively while iterating on prompts. The dry-run plan surfaces the
resolved provider/model/size — resolution crosses five fallback layers (flag >
agent defaults > instance defaults > setting > env), so what the agent THINKS
it asked for and what would be billed can differ; the plan closes that gap
before money moves.

Two structural findings shaped the brake placement:

- The async default creates an artifact record and spawns a detached worker
  before any provider call. Braking after that point would litter the artifact
  store with `pending` records on every dry-run, so the brake sits before both
  side effects.
- The worker re-invokes the same CLI command. Since the brake keys on
  `--execute`, the spawn args must carry the flag — otherwise the worker itself
  dry-runs, exits 3, and the artifact hangs in `pending` with no failure event.

`image atlas split` stays unbraked deliberately: it is a local
ImageMagick derive over an existing file (kind: read), and its `--send` is
already an explicit opt-in that funnels through the braked-by-contract media
surface when agents use the taught commands.
