# ravi_os_sdk

Generated Dart HTTP client for the Ravi SDK gateway.

This package is **HTTP-only**. It talks to a running Ravi gateway over
`POST /api/v1/<group>/<command>` and `GET /api/v1/_stream/<channel>`. It does
not spawn a PATH `ravi` process, embed Flutter widgets, or parse OpenAPI.

The command surface is generated from Ravi's live `RegistrySnapshot`. If a
command exists in the registry and is not `@CliOnly()`, this client gets the
same path, flat JSON body, and return typing.

## Install

```yaml
dependencies:
  ravi_os_sdk: ^0.1.0
```

The package is pure Dart. It depends on `package:http` and works on the Dart VM
and the web. It does **not** depend on the Flutter SDK.

## Create A Client

Every call needs a gateway `baseUrl` and a runtime context key (`rctx_*`).

```dart
import 'package:ravi_os_sdk/ravi_os_sdk.dart';

final client = RaviClient(
  HttpTransport(
    baseUrl: Uri.parse('http://127.0.0.1:7777'),
    contextKey: const String.fromEnvironment(
      'RAVI_CONTEXT_KEY',
      defaultValue: 'rctx_replace_me',
    ),
  ),
);
```

`HttpTransport` sends:

- `Authorization: Bearer <rctx_*>`
- `x-ravi-sdk-version`
- `x-ravi-registry-hash`

The registry hash this package was generated from is `raviRegistryHash`.

## Example Calls

```dart
final whoami = await client.context.whoami();

final history = await client.sessions.read(
  'main',
  const SessionsReadOptions(count: '10'),
);

final reply = await client.sessions.send(
  'main',
  'Summarize the current work.',
  const SessionsSendOptions(wait: true),
);
```

`sessions.read` and `sessions.send` use the gateway `@Returns` shapes. An HTTP
`{}` body is a contract/return-shape error, not a successful empty transcript.

## Streaming

```dart
final stream = RaviStreamClient(
  baseUrl: Uri.parse('http://127.0.0.1:7777'),
  contextKey: 'rctx_replace_me',
);

await for (final event in stream.session('main', const SessionStreamOptions(timeout: 60))) {
  print('${event.event} ${event.data}');
}
```

Streams use the official SSE parser over `GET /api/v1/_stream/<channel>` with
Bearer auth. They do not use `EventSource`, which cannot send `Authorization`.

## Wire Contract

```text
POST /api/v1/<group-segments>/<command>
```

The request body is flat JSON. Positional args and options are merged at the
top level. Never wrap input as `{ "args": ..., "options": ... }`.

## Errors

Transports throw the same hierarchy as the TypeScript SDK:

- `RaviAuthError` — 401
- `RaviPermissionError` — 403
- `RaviValidationError` — other 4xx, exposes `issues`
- `RaviInternalError` — 5xx
- `RaviTransportError` — network/timeout
- `RaviContractError` — gateway contract envelope or return-shape mismatch

## Codegen And Drift

Regenerate and check from the Ravi repo root:

```bash
bun src/cli/index.ts sdk dart generate
bun src/cli/index.ts sdk dart check
```

Never edit `.generated.dart` files by hand. The source of truth is
`src/cli/registry-snapshot.ts`, not OpenAPI.
