---
id: artifacts/image-atlas
title: "Image Atlas Artifacts"
kind: capability
domain: artifacts
capabilities:
  - image-atlas
  - derived-artifacts
tags:
  - artifacts
  - image
  - atlas
  - crop
applies_to:
  - src/image/atlas.ts
  - src/cli/commands/image.ts
  - src/artifacts
owners:
  - ravi-dev
status: active
normative: true
---

# Image Atlas Artifacts

## Intent

Image atlas turns one generated contact sheet into multiple reusable image outputs through deterministic local splitting.

The first production path is intentionally simple: generate a controlled atlas with no external margin, no internal gutter, no padding, and no frames; then split by a raw `cols x rows` grid. This avoids paying for multiple provider calls and keeps visual consistency across variants.

## Invariants

- Atlas split MUST be a native Ravi image operation, not a loose script in a personal workspace.
- The default split mode MUST be raw grid cells. It MUST NOT trim, infer visual bboxes, add padding, resize, or inspect content unless explicitly requested.
- A raw grid split MUST compute cell bounds from the source image dimensions and `cols/rows` only.
- The operation MUST write a `manifest.json` with source path, source dimensions, grid config, cell names, crop file paths, and crop bounds.
- The split operation MUST create a parent artifact for the split manifest.
- Each crop MUST create a derived `image.crop` artifact with provenance to the split artifact and, when available, to the atlas artifact.
- Artifact lineage MUST include grid position, crop bounds, source image path, and parent artifact ids when provided.
- Sending crops to a chat MUST use the current Ravi/Omni context or explicit target options. It MUST NOT guess routes.
- Provider fallback remains forbidden. Atlas generation is still just image generation; split is local and deterministic.

## CLI

Initial native surface:

```bash
ravi image atlas split atlas.png \
  --cols 3 \
  --rows 2 \
  --names ravi-dev,ravi-omni,ravi-app,ravi-genie,ravi-gtm,ravi-ideias \
  --output /tmp/ravi-atlas
```

Expected behavior:

- Writes one PNG per grid cell.
- Writes `/tmp/ravi-atlas/manifest.json`.
- Returns split artifact id and crop artifact ids.
- `--send` sends each crop to the session/chat context after artifacts are registered.

## Deferred

- Visual bbox refinement.
- Safety inset.
- Roundtrip reconstruction report.
- One-shot `generate -> split -> send` orchestration.
- Provider-specific atlas prompt templates.
