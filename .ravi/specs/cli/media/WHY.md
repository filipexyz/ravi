# Media agent-first CLI contract / WHY

`ravi media send` is the generic "put a file in a real chat" op — the one every
other generation surface (image, audio, atlas crops) funnels into. A wrong send
is visible to a real person and cannot be unsent, which is exactly the class of
mutation the Manual v2 write brake exists for. The brake runs before ANY
delivery-side code: `sendMediaWithOmniCli` mixes validation, target resolution
and the actual spawn of the `omni` binary in one call, so the command
re-implements the two cheap local checks (file existence, mime inference) to
fail fast with `FILE_NOT_FOUND` and to render an honest plan without spawning
anything.

The riskiest consumer is not a human: `ravi sessions actions` and the image and
audio payloads TEACH this command to live agents. If any of those strings drop
`--execute`, agents dry-run forever (exit-3 loop) believing they sent media.
That is why the builders in `sessions.ts` and the `sendCommand` fields are part
of this spec's applies_to surface.

There is no dedicated `media` skill today — a registered gap. The sessions
action hints are currently the only prompt-level teaching surface, which makes
their correctness load-bearing.
