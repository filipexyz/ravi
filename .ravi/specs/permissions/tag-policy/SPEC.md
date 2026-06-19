---
id: permissions/tag-policy
title: "Permission Tags"
kind: capability
domain: permissions
capability: tag-policy
capabilities:
  - provider-runtime
  - contact-policy-permissions
  - tags
tags:
  - permissions
  - tags
  - security
applies_to:
  - src/tags
  - src/permissions/contact-policy-permissions-provider.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Permission Tags

Tags are selectors and metadata. Tags MUST NOT authorize runtime behavior by
themselves.

The current supported permission tag path is the explicit
`contact-policy-permissions` provider. It recognizes permission-scoped contact
tags such as `permission.admin` and materializes provider-runtime capabilities
for the matching contact.

Rules:

- Generic CRM tags MUST NOT grant authority.
- Permission-bearing tags MUST use a permission namespace.
- A provider MUST explicitly consume a tag before that tag affects
  authorization.
- Deleting a tag binding MUST affect the next provider-runtime materialization
  without requiring cleanup of removed policy tables.
- Tag management MUST NOT write authorization directly into unrelated provider
  state.
