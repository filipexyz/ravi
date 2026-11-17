---
id: cloud
title: Ravi Cloud Decisions
kind: why
domain: cloud
status: draft
normative: false
owners:
  - ravi-dev
---

# Ravi Cloud Decisions

## Why The Console Owns The Remote State

The Console already holds the organization, its projects, the Library and the
roles. Putting cloud state there keeps one place that decides who may spend the
organization's money; the local install stays a client and never holds a
provider key.
