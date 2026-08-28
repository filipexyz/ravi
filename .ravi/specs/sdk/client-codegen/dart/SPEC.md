---
id: sdk/client-codegen/dart
title: "Dart SDK Codegen"
kind: feature
domain: sdk
capabilities:
  - client-codegen
  - dart
tags:
  - sdk
  - dart
  - generated-client
  - pub
applies_to:
  - src/sdk/dart-codegen
  - src/cli/commands/sdk.ts
  - packages/ravi-os-dart-sdk
owners:
  - dev
status: draft
normative: true
---

# Dart SDK Codegen

Status: draft
Owner: dev
Last updated: 2026-08-28

## Intent

Generate a pure Dart SDK from the Ravi registry so Dart (and Flutter, if a
caller chooses to depend on this package) apps can call the Ravi gateway with
Dart-native `Future`/`Stream`, JSON models, and `package:http` primitives.

Dart is a **fourth** official client-codegen backend. It MUST use the same
registry projection and wire contract as TypeScript and Swift. It MUST NOT be
hand-maintained command glue. Rust remains the planned third backend
(spec-only); Dart does not replace it.

Dart SDK generation MUST consume `RegistrySnapshot`. It MUST NOT parse OpenAPI
as its primary input.

## Package Shape

The package SHOULD live at:

```text
packages/ravi-os-dart-sdk/
  pubspec.yaml
  LICENSE
  README.md
  CHANGELOG.md
  analysis_options.yaml
  example/
    ravi_sdk_example.dart
  lib/
    ravi_sdk.dart
    src/
      ravi_client.generated.dart
      ravi_types.generated.dart
      ravi_schemas.generated.dart
      ravi_version.generated.dart
      ravi_streaming.generated.dart
      http_transport.dart
      ravi_transport.dart
      ravi_error.dart
      ravi_json.dart
```

The pub name MUST be `ravi_sdk`.
The package MUST be pure Dart. It MUST NOT depend on the Flutter SDK.

Generated files MUST use `.generated.dart` suffixes.
Hand-written files MUST NOT be overwritten by the generator.

## CLI Surface

The Ravi CLI SHOULD expose:

```bash
ravi sdk dart generate --out packages/ravi-os-dart-sdk/lib/src
ravi sdk dart check --out packages/ravi-os-dart-sdk/lib/src
```

Optional flags:

- `--version <semver>` overrides package version baked into
  `ravi_version.generated.dart`.
- `--json` prints machine-readable result.

`ravi sdk dart check` MUST fail on generated-source drift.

## Dart API Shape

Generated usage SHOULD feel natural in Dart:

```dart
final client = RaviClient(
  HttpTransport(
    baseUrl: Uri.parse('http://127.0.0.1:7777'),
    contextKey: 'rctx_...',
  ),
);

final artifact = await client.artifacts.show('art_123');
final sessions = await client.sessions.list(const SessionsListOptions(live: true));
```

Rules:

- Namespaces MUST follow registry `groupSegments`.
- Namespaces SHOULD be exposed as nested getters on `RaviClient`.
- Method names SHOULD be lower camel case.
- Positional args SHOULD be positional Dart parameters.
- Options MUST be generated as classes with optional fields unless the schema
  marks a field as required.
- A command with options SHOULD take one trailing options object with a default
  empty const constructor when all options are optional.
- Request encoding MUST produce the same flat JSON body the gateway expects.
- Commands MUST POST to `/api/v1/<group-segments>/<command>` and MUST NEVER
  wrap the body as `{args, options}`.

Example:

```dart
Future<SessionsTraceReturn> trace(
  String nameOrKey, [
  SessionsTraceOptions options = const SessionsTraceOptions(),
]) async
```

## Transport Contract

The hand-written transport MUST be interface-based:

```dart
abstract class RaviTransport {
  Future<T> callJson<T>({
    required List<String> groupSegments,
    required String command,
    required Map<String, RaviJson> body,
    required T Function(Object? json) decode,
  });

  Future<RaviBinaryResponse> callBinary({
    required List<String> groupSegments,
    required String command,
    required Map<String, RaviJson> body,
  });
}
```

`HttpTransport` MUST:

- POST to `/api/v1/<segments>/<command>`;
- send `Authorization: Bearer <rctx_*>`;
- send `Content-Type: application/json`;
- send `Accept: application/json` for JSON commands;
- send `Accept: application/octet-stream, */*` for binary commands;
- send `x-ravi-sdk-version` and `x-ravi-registry-hash`;
- decode gateway error bodies into the typed `RaviError` hierarchy;
- work on the Dart VM and the web (via `package:http` or an equivalent that
  supports both).

The official SDK MUST be HTTP-only. It MUST NOT spawn a PATH `ravi` CLI process
or otherwise hybridize with a local daemon binary.

## Type Mapping

The initial JSON Schema to Dart mapping MUST be conservative:

- `string` -> `String`
- `boolean` -> `bool`
- `integer` -> `int`
- `number` -> `double`
- `array<T>` -> `List<T>`
- `object` with known properties -> `class`
- string enum -> `String`
- `additionalProperties` object -> `Map<String, RaviJson>`
- unknown schema -> `RaviJson`
- unsupported `anyOf`/`oneOf`/complex unions -> `RaviJson` in MVP

The generator MUST prefer compiling Dart over perfect specificity. When a
schema cannot be represented safely, fall back to `RaviJson`.

## Generic JSON

The Dart package MUST define a hand-written `RaviJson` type that can encode
and decode arbitrary JSON, including unknown and `@Returns`-less payloads.

Commands without `@Returns` MUST return `RaviJson`.

HTTP `{}` on a command whose `@Returns` shape requires fields MUST be treated
as a contract/return-shape error. The client MUST NOT paper over
`sessions.read` / `sessions.send` (or any other typed command) by treating
`{}` as a successful empty transcript.

## Binary Commands

Commands marked `@Returns.binary()` MUST generate methods returning
`RaviBinaryResponse`.

```dart
class RaviBinaryResponse {
  const RaviBinaryResponse({
    required this.bytes,
    this.contentType,
    required this.statusCode,
    required this.headers,
  });

  final List<int> bytes;
  final String? contentType;
  final int statusCode;
  final Map<String, String> headers;
}
```

The Dart SDK MUST NOT base64-wrap binary responses.

## Streaming

Streaming MUST follow `sdk/streaming` and expose SSE as `Stream` over typed
event payloads.

The generated stream client MUST:

- GET `/api/v1/_stream/<channel>`;
- send `Authorization: Bearer <rctx_*>` (MUST NOT use `EventSource`; browser
  `EventSource` cannot send that header);
- send SDK version and registry hash headers;
- pass filters as query string parameters, never as a JSON body;
- parse official SSE fields (`id:`, `event:`, `data:`) and ignore `: ping`
  keepalives;
- surface `event: end` as a normal typed event when the server emits it.

## Versioning

- Generated SDK version constants SHOULD come from the package manifest
  version or an explicit `--version` argument.
- The default generator version MUST NOT silently diverge from the published
  package version.
- The generated package MUST expose the registry hash it was generated from.
- Registry hash MUST change when the generated client surface changes.

## Non-Goals For MVP

- No Flutter widgets, Riverpod, go_router, SharedPreferences, or UI chrome.
- No PATH `ravi` CLI spawn / hybrid client.
- No WebSocket control channel.
- No binary request uploads.
- No OpenAPI-driven Dart generation.
- No standalone repository. The package lives in this monorepo.
- No attempt to model every JSON Schema union as a Dart sealed type in the
  first implementation.

## Acceptance Criteria

- Running `ravi sdk dart generate` writes the package generated sources.
- `client.artifacts.show('id')` compiles and sends `{ "id": "..." }`.
- A command with options generates an options class and a flat request body.
- A command without `@Returns` returns `RaviJson`.
- A binary command returns `RaviBinaryResponse`.
- `ravi_version.generated.dart` includes SDK version, registry hash, and
  source Git SHA or `"unknown"`.
- `ravi sdk dart check` detects drift in generated Dart files.
- If `dart` is available, `dart analyze` passes for
  `packages/ravi-os-dart-sdk`.
