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
tags and materializes provider-runtime capabilities for the matching contact
only from provider-owned configuration.

## Contact Permission Tags

`contact-policy-permissions` MUST materialize contact tags only when all are
true:

- the contact policy is `allowed`;
- the contact is not opted out;
- the tag is permission-scoped after normalization, e.g. `permission.family`
  becomes `permission-family`;
- the tag definition exists in `tag_definitions`;
- the tag definition has `kind=system` and `source=permissions`;
- the tag definition metadata declares explicit permission capabilities.

Permission capabilities MAY be declared as canonical strings or objects:

```json
{
  "permissions": {
    "capabilities": [
      "mutate:image:generate",
      "use:tool:image_generate",
      { "permission": "read", "objectType": "skills", "objectId": "show" }
    ]
  }
}
```

Compatibility operator tags `permission.admin`, `permission.owner`, and
`permission.superadmin` MAY continue to materialize `admin:system:*` for trusted
operators until they are migrated into tag definitions.

Generic tags such as `family`, `admin`, `vip`, or `customer` MUST NOT
materialize capabilities.

Rules:

- Generic CRM tags MUST NOT grant authority.
- Permission-bearing tags MUST use a permission namespace.
- A provider MUST explicitly consume a tag before that tag affects
  authorization.
- Deleting a tag binding MUST affect the next provider-runtime materialization
  without requiring cleanup of removed policy tables.
- Tag management MUST NOT write authorization directly into unrelated provider
  state.
