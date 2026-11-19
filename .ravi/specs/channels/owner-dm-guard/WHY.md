# Owner DM Guard / WHY

On 04/11/2026 a colleague (Thiago) DMed the RBBT Slack bot. The `ravi-slack`
instance had `dmPolicy: open`, agent `main`, no DM route and
`defaultDmScope: main`, so his DM resolved to `agent:main:main`, the owner's
full-access session; the reply went out on both DMs. #803 fixed the delivery,
not the routing. The 19/11 study of a colleague bridge
(https://ravi-prs.ravi.page/blog/2026-11-19-ponte-colega-raphael) found the
configuration unchanged: any colleague who DMs the bot lands in the owner's
session with the owner's history and the agent's ceiling.
