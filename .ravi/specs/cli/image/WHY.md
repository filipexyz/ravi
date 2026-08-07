# Image agent-first CLI contract / WHY

Image generation can bill a provider, but this CLI has no configured spending
limit or reliable preflight quote. Requiring two calls for every generation
therefore adds friction without making a cost-based decision. The confirmation
boundary follows the externally visible effect: delivery to a live chat.

Two structural findings shaped the brake placement:

- The async default creates an artifact record and spawns a detached worker.
  When delivery is requested, confirmation must happen before both so dry-run
  remains side-effect free.
- The worker re-invokes the same CLI command. It inherits `--execute` only for
  an already approved delivery.

`image atlas split` stays immediate for local derivation. Its integrated
`--send` path previously bypassed the media command's confirmation because it
called the sender directly; it now has its own conditional brake.
