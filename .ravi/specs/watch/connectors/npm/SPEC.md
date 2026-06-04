---
id: watch/connectors/npm
title: "Npm Watch Connector"
kind: feature
domain: watch
capability: connectors
feature: npm
tags:
  - watch
  - npm
applies_to:
  - src/watch/connectors/npm.ts
  - src/cli/commands/watch.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Npm Watch Connector

## Intent

The npm connector watches npm package metadata and emits normalized events when
packages publish versions or change important distribution metadata.

## Placement

- Public package metadata SHOULD support local polling.
- Private registries MAY run locally when the user has local credentials.
- Console placement MAY be used for always-on monitoring, managed credentials,
  or private registry access that should not live locally.

## Configuration

Required:

- `package`: npm package name, including scope when present.

Optional:

- `registry`: registry base URL, defaulting to the public npm registry.
- `distTag`: one or more dist-tags to watch, such as `latest` or `next`.
- `interval`: polling interval for local placement.
- `credentialRef`: local or Console credential reference for private registries.

## Event Types

The initial supported event types SHOULD be:

- `package.version_published`
- `package.dist_tag_changed`

Future event types MAY include deprecation or advisory signals when the data
source is reliable and payload redaction is defined.

## Dedupe

- Version published dedupe key SHOULD be
  `npm:<registry>:<package>:version:<version>`.
- Dist-tag changed dedupe key SHOULD be
  `npm:<registry>:<package>:dist-tag:<tag>:<version>`.

## Payload

Payload SHOULD include:

- package name;
- registry;
- version;
- changed dist-tag when relevant;
- package URL;
- publish time when available.

Payload MUST NOT include registry auth tokens, `.npmrc` contents, tarball
contents, or private package file content.

## Subject Examples

```text
ravi.watch.npm.package.version_published
ravi.watch.npm.package.dist_tag_changed
```
