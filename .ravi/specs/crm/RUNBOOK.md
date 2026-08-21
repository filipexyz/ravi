# CRM / RUNBOOK

## Debug Flow

1. Read `ravi specs get crm --mode rules --json`.
2. Select the narrowest owner:
   - data model, projections, events, or mutation audit: `contacts/crm`;
   - pipeline/stage topology, movement, or configuration audit:
     `contacts/crm/pipelines`;
   - pipeline metadata or engine consumers: `crm/pipeline`;
   - controlled effects: `crm/facade`;
   - command interface, discovery, or errors: `cli/crm`;
   - contact-linked data: `contacts/authorization` and
     `contacts/crm/authorization`.
3. Resolve each referenced entity and confirm its kind before inspecting
   persistence.
4. Reproduce contact-linked behavior under the same principal and scope; local
   operator visibility is not proof of agent authorization.
5. Validate every applicable spec, including cross-domain owners, then the
   shared CRM surface.

## Validation

Choose focused checks from the owning child spec. For a cross-layer CRM change:

```bash
bun test src/cli/commands/crm.test.ts src/crm/facade.test.ts src/crm/pipeline-metadata.test.ts src/crm/pipeline-engines.test.ts
```

When the public interface changes, also run the checks required by `cli`.
