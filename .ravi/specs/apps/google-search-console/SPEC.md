---
id: apps/google-search-console
title: "Google Search Console"
kind: capability
domain: apps
capability: google-search-console
capabilities:
  - manifest
  - cli
  - operations
tags:
  - apps
  - google-search-console
applies_to:
  - src/apps/google-search-console
  - src/cli/commands/google-search-console.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Google Search Console Ravi App

## Objective

Provide a native, portable Google Search Console capability through Ravi CLI,
SDK and Apps. A clean Ravi installation must not require the external `sde`
binary or organization-specific defaults.

## Contract

- Credentials are resolved through Ravi's credential broker under provider
  `google-search-console` and a caller-selected connection.
- The secret is a JSON envelope containing `clientId`, `clientSecret` and
  `refreshToken`; secret values never appear in command output or traces.
- Every command accepts explicit property identifiers. No property, domain or
  account is compiled into Ravi.
- Native operations cover Search Analytics, Sites, Sitemaps, URL Inspection
  and Site Verification.
- Read and mutation operations have distinct `CommandAccess` declarations;
  destructive operations require confirmation.
- Public commands declare concrete return schemas and are generated into the
  TypeScript SDK.
- The Ravi App manifest delegates only to native `ravi gsc` commands.

## Non-goals

- Changing existing agents, grants or skills.
- Replacing any existing production workflow.
- Executing destructive Google operations as part of validation.

## Completion evidence

- Source and packaged manifest validation.
- SDK generation/check, typecheck, tests and lint.
- A clean packaged CLI lists the complete native command surface.
- Real authenticated read calls exercise properties, analytics, inspection
  and sitemaps without the external SDE CLI.
