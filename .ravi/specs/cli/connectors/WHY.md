# Connectors agent-first CLI contract / WHY

A connector is stored third-party authority: revoking one deletes the OAuth
tokens minted at the provider. That is the exact shape of mistake the write
brake exists for — one wrong id in an agent loop and Gmail/Calendar stop
working for every consumer of that connector. So `revoke` got the brake, and
the pre-existing `--yes` confirmation was kept as the documented equivalent
instead of being renamed: existing scripts that pass `--yes` keep working, and
the agent-facing contract gains the standard `--execute` polarity with an
inspectable plan.

`connect` deliberately did NOT get the brake. It opens a browser on a Console
page that only the Console user who started it can continue, sends that
person to the provider's consent page, and polls until the link expires (10
minutes). The human consent screen IS the brake; an exit-3 dry-run in front of
it would only teach agents to always pass `--execute` on an op that cannot
silently write anything. Starting through the Console instead of Link closes
the old hole where whoever opened the raw provider URL attached their own
account to the requester.

The other design decision is about not-found envelopes: connectors live in
Console/Link, not in a local table. Cheap local suggestions do not exist, and
fabricating them would mean an extra remote list call inside every error path.
The domain therefore keeps the legacy CloudAuthError funnel for remote errors
— with the one correction that matters: a `ContractError` from the brake is
rethrown before `cloudAuthErrorFromUnknown`, because the funnel used to
flatten it into `SERVER_UNAVAILABLE` exit 5 and silently destroy the exit-3
semantics for agent callers.

## Personal connections

Connections used to hang off a Console project, and any connector call used
whichever Console session the machine had. That made the operator's Gmail
available to anyone who could talk to the agent: a contact in a group, a
stranger in a direct chat, another agent relaying a request, or a trigger fed
by outside events. A connection is now one person's own account, and the
default use is "Only when I ask": the owner's terminal, the owner's own direct
chat (once `ravi link` proved who they are), and routines the owner owns.

The check lives in the OSS CLI because only the local runtime knows who is
speaking in a turn. It runs before any remote call, fails closed when the turn
cannot be classified, and never borrows another stored session, because a
fallback to "the session we have" is exactly the hole it closes. The Worker
repeats the essential part from `X-Ravi-Exec-Context` (group and speaker), so
an old or modified CLI cannot skip it for exec. Groups are refused even for
the owner: a reply in a group is read by everyone in it, so the agent moves
the conversation to the owner's direct chat instead.

The block is exit 3, not 1, because nothing failed: the policy said no. The
error tells the agent what to say, in English and Portuguese, so the person
gets a clear sentence instead of a stack of codes. Cron jobs record who
created them so a routine runs with its creator's rights, not the operator's.
Legacy jobs (no owner) keep running as the operator so existing routines keep
working; before owners existed a contact could also have had an agent
schedule one, so this is a policy choice, not a fact about who wrote them.

"No runtime context" is only the terminal when nothing else says otherwise.
PM2 strips the runtime env from the daemon, so the commands it spawns for
shell crons, shell triggers and background jobs used to look exactly like the
operator typing. The daemon now marks each of them with the automation it runs
for, after the job's own env file so the job cannot remove the mark there.
The same reasoning ties the operator relay to its origin: `ravi sessions send`
and `ask` from the terminal are the operator speaking, but a session-goal wake
or any other producer that happens to have no caller is not.

A turn context outlives its turn: turn rotation revokes the old context
without cascading, and a child issued during the owner's turn could otherwise
keep speaking as the owner after the session moved on to someone else. So
every context on the lineage walk must still be live.

A routine that answers into a chat is allowed only when Ravi knows that chat
is the owner's own linked direct chat, from the `chats` table and the contact
binding; anything less certain is treated as a group.
