---
id: contacts/crm/forecast
title: CRM Forecast Simulation
kind: feature
domain: contacts
capability: crm
feature: forecast
---

# Why

Operators need a fast way to answer whether a funnel has enough volume to produce the month. The useful first model is simple: count items in a stage, multiply by conversion rate, multiply by average ticket.

The simulation is intentionally read-only. It is planning math, not pipeline truth. Moving stages, applying tags, or confirming facts from a simulation would hide business assumptions inside state changes.

Forecast inputs must carry sources because a forecast with explicit assumptions is different from one inferred from thin history. Showing the source of each number lets an operator trust or challenge the forecast.

## Alternatives Rejected

- Forecast by raw chat count: rejected because chats are channel containers and can contain multiple people or no sales work item.
- Forecast as automatic opportunity mutation: rejected because simulation should not change CRM state.
- Forecast with silent default zeros: rejected because zero values hide missing assumptions and make the result look precise.
- Float money math: rejected because currency should use integer cents until formatting.
