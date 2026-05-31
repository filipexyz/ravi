---
id: runtime/cloud-trace-export
title: "Why Cloud Trace Export"
kind: why
domain: runtime
capability: cloud-trace-export
owners:
  - ravi-dev
status: draft
normative: true
---

# Why

Console needs to show remote and local agent executions, but Ravi local must not
depend on Console to execute.

The existing runtime already has canonical events and local trace tables. Cloud
export should reuse those instead of adding provider-specific reporting paths.

Best-effort export prevents observability outages from becoming runtime outages.
Enterprise blocking policies can be introduced later as explicit controls.
