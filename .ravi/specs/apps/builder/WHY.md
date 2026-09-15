# Ravi App Builder / WHY

## Rationale

App creation previously existed as separate pieces: manifest discovery,
scaffold, CLI import, context isolation, skills, and router execution. That was
enough to build an app manually, but not enough for an agent to turn unfamiliar
API documentation into a complete, reviewed, functional app.

A dedicated builder contract closes that gap without inventing another runtime
abstraction. The implementation remains a normal CLI. The manifest describes
how Ravi discovers and authorizes it. The skill teaches the workflow.

## Why One Builder

The workflow should be domain-independent. Google Search Console exercises
OAuth, quotas, pagination, and multiple resources. Open-Meteo exercises an
unrelated unauthenticated API with a simpler resource model. Supporting both
with the same checklist is stronger evidence than hard-coding a single
provider walkthrough.

## Why Import Is a Draft

CLI metadata can identify candidate commands, but it cannot decide product
scope, prove auth safety, classify every mutation, choose storage, or establish
functional readiness. Calling import output “ready” would turn inference into
an unsafe production contract.

## Why Drift Is Tested

The registry is executable truth, while specs and skills are the truth agents
read. A command added to only one side creates predictable failures. A
deterministic contract eval makes that mismatch visible in CI.
