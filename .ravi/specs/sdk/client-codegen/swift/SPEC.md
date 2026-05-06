---
id: sdk/client-codegen/swift
title: "Swift SDK Codegen"
kind: feature
domain: sdk
capabilities:
  - client-codegen
  - swift
tags:
  - sdk
  - swift
  - macos
  - native-apps
  - generated-client
applies_to:
  - src/sdk/swift-codegen
  - src/cli/commands/sdk.ts
  - packages/ravi-os-swift-sdk
owners:
  - dev
status: draft
normative: true
---

# Swift SDK Codegen

Status: draft
Owner: dev
Last updated: 2026-05-05

## Intent

Generate a Swift SDK from the Ravi registry so native macOS apps can call the
Ravi gateway with Swift-native `async/await`, `Codable`, `Sendable`, and
`URLSession` primitives.

Swift SDK generation MUST be a new backend over the same registry projection as
the TypeScript SDK. It MUST NOT be hand-maintained command glue.

## Package Shape

The package SHOULD live at:

```text
packages/ravi-os-swift-sdk/
  Package.swift
  Sources/RaviSDK/
    RaviClient.generated.swift
    RaviTypes.generated.swift
    RaviSchemas.generated.swift
    RaviVersion.generated.swift
    HTTPTransport.swift
    RaviTransport.swift
    RaviError.swift
    RaviJSON.swift
```

Generated files MUST use `.generated.swift` suffixes.
Hand-written files MUST NOT be overwritten by the generator.

## CLI Surface

The Ravi CLI SHOULD expose:

```bash
ravi sdk swift generate --out packages/ravi-os-swift-sdk/Sources/RaviSDK
ravi sdk swift check --out packages/ravi-os-swift-sdk/Sources/RaviSDK
```

Optional flags:

- `--version <semver>` overrides package version baked into
  `RaviVersion.generated.swift`.
- `--json` prints machine-readable result.

## Swift API Shape

Generated usage SHOULD feel natural in Swift:

```swift
let client = RaviClient(
  transport: HTTPTransport(
    baseURL: URL(string: "http://127.0.0.1:7777")!,
    contextKey: "rctx_..."
  )
)

let artifact = try await client.artifacts.show("art_123")
let sessions = try await client.sessions.list(.init(live: true))
```

Rules:

- Namespaces MUST follow registry `groupSegments`.
- Namespaces SHOULD be exposed as nested properties on `RaviClient`.
- Method names SHOULD be lower camel case.
- Positional args SHOULD be positional Swift parameters.
- Options MUST be generated as `Codable & Sendable` structs with optional
  properties unless the schema marks a field as required.
- A command with options SHOULD take one trailing options struct with a default
  `.init()` when all options are optional.
- Request encoding MUST produce the same flat JSON body the gateway expects.

Example:

```swift
public func trace(
  _ nameOrKey: String,
  _ options: SessionsTraceOptions = .init()
) async throws -> SessionsTraceReturn
```

## Transport Contract

The hand-written transport MUST be protocol-based:

```swift
public protocol RaviTransport: Sendable {
  func call<T: Decodable>(
    groupSegments: [String],
    command: String,
    body: [String: RaviJSON],
    as type: T.Type
  ) async throws -> T

  func callBinary(
    groupSegments: [String],
    command: String,
    body: [String: RaviJSON]
  ) async throws -> RaviBinaryResponse
}
```

`HTTPTransport` MUST:

- POST to `/api/v1/<segments>/<command>`;
- send `Authorization: Bearer <rctx>`;
- send `Content-Type: application/json`;
- send `Accept: application/json` for JSON commands;
- send `Accept: application/octet-stream, */*` for binary commands;
- send SDK version and registry hash headers;
- decode gateway error bodies into typed `RaviError` cases.

## Type Mapping

The initial JSON Schema to Swift mapping MUST be conservative:

- `string` -> `String`
- `boolean` -> `Bool`
- `integer` -> `Int`
- `number` -> `Double`
- `array<T>` -> `[T]`
- `object` with known properties -> `struct`
- string enum -> `enum <Name>: String, Codable, Sendable`
- `additionalProperties` object -> `[String: RaviJSON]`
- unknown schema -> `RaviJSON`
- unsupported `anyOf`/`oneOf`/complex unions -> `RaviJSON` in MVP

The generator MUST prefer compiling Swift over perfect specificity. When a
schema cannot be represented safely, fall back to `RaviJSON`.

Generated models MUST conform to `Codable` and `Sendable`.

## Generic JSON

The Swift package MUST define a hand-written `RaviJSON` enum that can encode
and decode arbitrary JSON:

```swift
public enum RaviJSON: Codable, Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([RaviJSON])
  case object([String: RaviJSON])
}
```

Commands without `@Returns` MUST return `RaviJSON`.

## Binary Commands

Commands marked `@Returns.binary()` MUST generate methods returning
`RaviBinaryResponse`.

```swift
public struct RaviBinaryResponse: Sendable {
  public let data: Data
  public let contentType: String?
  public let statusCode: Int
  public let headers: [String: String]
}
```

The Swift SDK MUST NOT base64-wrap binary responses.

## Streaming

Streaming is not required for the first Swift SDK milestone.

When added, streaming MUST follow `sdk/streaming` and expose SSE as
`AsyncThrowingStream` over typed event payloads.

## Non-Goals For MVP

- No SwiftUI/Observable wrappers in the generated client.
- No Combine surface.
- No WebSocket control channel.
- No binary request uploads.
- No OpenAPI-driven Swift generation.
- No attempt to model every JSON Schema union as a Swift enum in the first
  implementation.

## Acceptance Criteria

- Running `ravi sdk swift generate` creates a buildable SwiftPM package.
- `client.artifacts.show("id")` compiles and sends `{ "id": "..." }`.
- A command with options generates an options struct and flat request body.
- A command without `@Returns` returns `RaviJSON`.
- A binary command returns `RaviBinaryResponse`.
- `RaviVersion.generated.swift` includes SDK version, registry hash, and source
  Git SHA or `"unknown"`.
- `ravi sdk swift check` detects drift in generated Swift files.
- If `swift` is available, `swift build` passes for
  `packages/ravi-os-swift-sdk`.
