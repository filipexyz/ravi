---
id: quality
title: "Runtime Quality Rationale"
kind: domain
domain: quality
status: draft
---

# Why Runtime Quality Exists

## Problem

Ravi already records many surfaces: session traces, runtime events, tasks, artifacts, daemon logs, crons, insights, projects, and life-review notes. The gap is not data. The gap is converting production behavior into a reliable diagnosis and follow-up loop.

The 604s stall incident showed the problem clearly:

- The first hypothesis focused on native steer and image generation.
- The real issue involved provider protocol shape and tool lifecycle semantics.
- A second layer appeared after the first patch.
- The useful operator loop was: detect, packetize evidence, patch, restart, watch for recurrence.

That loop should be a reusable system, not a heroic manual investigation.

## External Pattern

Nexus demonstrates the product shape: production agent observability centered on silent failures, multi-turn behavior, root cause, dedupe, and turning findings into actionable work.

Ravi should not copy Nexus as an external product. Ravi has a deeper internal substrate: it owns the runtime, tasks, projects, skills, artifacts, and channel bridge. Therefore the quality layer can close the loop inside Ravi instead of only sending alerts to an external PM tool.

## Design Choice

Quality is a domain, not just a log scanner.

The key decision is to model failures as versioned modes with evidence and actions. This prevents vague "something broke" reports and lets agents learn how to investigate recurring classes of failure.

## Tradeoffs

- Strict failure modes can miss novel failures. Mitigation: allow investigation-mode candidates with low confidence and promote repeated findings into formal modes.
- Auto-created tasks can create noise. Mitigation: dedupe, severity thresholds, cooldowns, and owner policies are mandatory.
- Too much evidence can overwhelm workers. Mitigation: root-cause packets must contain a minimal repro slice plus links to expanded artifacts.
