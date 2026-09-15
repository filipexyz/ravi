# Insights agent-first CLI contract / WHY

Insights exists so agents record operational learning as they work. That use
pattern decides the brake question: `create` runs inside the routine loop
("I just learned something, write it down"), writes only local reversible
rows — an insight, maybe a comment, tag bindings — and nothing leaves the
machine. An exit-3 wall there would tax every learning moment to protect a
write that has an obvious inverse. So the domain declares no braked op, the
same reasoning `cli/heartbeat` recorded for its reversible config writes.

What was actually broken was the failure taxonomy. `show` on a bad id, an
invalid `--kind`, a zero `--limit` — all collapsed into the same generic
`fail()` (plain text, exit 1), indistinguishable to an agent from a real
provider error. The migration splits them: unknown id → `INSIGHT_NOT_FOUND`
with real local ids as suggestions (the retry is one of them); bad enum or
limit → `USAGE_ERROR` exit 2 with `acceptedValues` (the retry is a corrected
flag). On `create`, the enum validation also guarantees nothing is written on
a usage failure — before, validation ran mid-construction of the insert
input, which happened to be safe but only by accident of evaluation order;
now it is explicit and tested.

`--fields` lands on `list` and `search` because insight rows carry full
lineage (author, origin, links, comments) and agents usually want two or
three columns of it. The `--rich` path is deliberately exempt: it is a
purpose-built overlay projection with its own shape, and pretending
`--fields` composes with it would lie about the payload.
