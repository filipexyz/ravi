---
id: prox/intake
title: "prox.city Intake"
kind: capability
domain: prox
capability: intake
capabilities:
  - voice-video
  - profile-extraction
  - human-approval
tags:
  - prox-city
  - intake
  - agora
  - profile
applies_to:
  - ../../../ravi/cognition-hackathon/src/lib/agora.ts
  - ../../../ravi/cognition-hackathon/src/app/api/agora
owners:
  - ravi-dev
status: draft
normative: true
---

# prox.city Intake

## Intent

Intake is the front door of `prox.city`.

It converts a live human conversation into structured context that can support profile creation, opportunity matching, deal formation, and human-approved execution.

## Boundaries

- Intake MUST capture the human's capabilities, intent, constraints, and preferred activation mode.
- Intake MUST preserve enough transcript/provenance to review or regenerate the structured profile.
- Intake MUST NOT present the human as a passive prompt target. The person remains the decision maker.
- Intake MUST NOT trigger outreach, hiring, payment, or execution without an explicit downstream approval step.
- Voice/video providers MUST stay behind a runtime/provider boundary. `prox` owns the normalized profile and deal semantics.

## Required Output

An intake run SHOULD produce:

- transcript;
- structured person profile;
- confidence or uncertainty notes;
- suggested opportunity/match inputs;
- explicit limits and contact preferences;
- artifacts or links to generated outputs.

## Person Profile Fields

The initial profile SHOULD include:

- name or display label when available;
- skills and proficiency level;
- accepted task/project types;
- availability and response expectations;
- price, payment preference, or compensation expectation when provided;
- quality criteria;
- boundaries and unacceptable work;
- how agents should contact the person;
- what information must be sent before asking for commitment.

## Lifecycle

1. Create an intake session.
2. Start the live provider/runtime.
3. Conduct short guided conversation.
4. Persist transcript or provider history.
5. Extract structured profile.
6. Present profile for human review.
7. Use approved profile for matching/deal generation.

## Implementation Status

The current intake implementation is in the Cognition hackathon prototype.

Ravi core does not yet have `src/prox/intake` or a `ravi prox` CLI. Those are planned target surfaces.

## Acceptance Criteria

- The human can complete intake in a short live conversation.
- The system produces a usable structured profile.
- The profile has clear provenance to the source conversation.
- The human can approve, correct, or reject generated information.
- The resulting profile can feed opportunity matching without re-reading the full transcript.
