# Owner DM Guard / WHY

On 04/11/2026 a colleague (Thiago) DMed the RBBT Slack bot. The `ravi-slack`
instance had `dmPolicy: open`, agent `main`, no DM route and
`defaultDmScope: main`, so his DM resolved to `agent:main:main`, the owner's
full-access session; the reply went out on both DMs. #803 fixed the delivery,
not the routing. The 19/11 study of a colleague bridge
(https://ravi-prs.ravi.page/blog/2026-11-19-ponte-colega-raphael) found the
configuration unchanged: any colleague who DMs the bot lands in the owner's
session with the owner's history and the agent's ceiling.

On 26/11/2026 the owner's own DM in the same session (`agent:main:main`)
was refused as the operator's turn: `pages read` of a private Page and
Knowledge (`audience=none`) answered as if a stranger had asked
(https://ravi-prs.ravi.page/blog/2026-11-26-o-dm-do-luis-no-slack-nunca-contou-como-turno-do-operador).
The private-session check refused every `dmScope: main` key, because the guard
still let a colleague in through a route naming them or an attached chat. The
owner asked that his DM stay in that session and work, and that every other
person's DM stay out of it. The exception went away. The same day he decided
that his own message counts wherever he writes ("se eu escrevo eu quero que
esse dado venha, independente de onde estar"), so the turn no longer depends
on this guard; a chat other people read asks for his confirmation there.

