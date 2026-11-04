import Foundation
import XCTest
@testable import RaviSDK

final class RaviErrorTests: XCTestCase {
  func testRejectsMalformedContractIdentifiersWithoutDiscardingCause() throws {
    for (code, op) in [
      ("rctx_sdk_code_secret798", "rctx_sdk_op_secret798"),
      ("AUTH_REQUIRED?token=SDK_CODE_QUERY_798", "audio generate?key=SDK_OP_QUERY_798"),
      (String(repeating: "A", count: 97), String(repeating: "a", count: 161)),
    ] {
      let data = try JSONSerialization.data(withJSONObject: [
        "success": false, "op": op, "exitCode": 1, "outcome": "failed",
        "error": ["code": code, "message": "Provider refused request", "cause": "provider rejected the request", "retryable": false],
      ])
      guard case .contract(let body, _) = buildRaviError(statusCode: 422, data: data) else {
        return XCTFail("Expected diagnostic contract")
      }
      XCTAssertEqual(body.error.code, "REMOTE_ERROR")
      XCTAssertEqual(body.op, "gateway")
      XCTAssertEqual(body.error.cause, "provider rejected the request")
      XCTAssertFalse(String(describing: body).contains(code))
      XCTAssertFalse(String(describing: body).contains(op))
    }
    let data = try JSONSerialization.data(withJSONObject: [
      "success": false, "op": "apps showManifest", "exitCode": 1, "outcome": "failed",
      "error": ["code": "not_found", "message": "App missing", "retryable": false],
    ])
    let body = try JSONDecoder().decode(RaviContractErrorBody.self, from: data)
    XCTAssertEqual(body.error.code, "not_found")
    XCTAssertEqual(body.op, "apps showManifest")
  }

  func testPreservesSpecificCauseAndTypedContext() throws {
    let cause = "Cannot read audio\nCaused by: EACCES: permission denied, open /tmp/audio.wav; token=[redacted:token]"
    let sentinel = "PRIVATE_DIAGNOSTIC_PAYLOAD"
    let data = try JSONSerialization.data(withJSONObject: [
      "success": false, "op": "transcribe file", "exitCode": 1, "outcome": "failed",
      "error": [
        "code": "TRANSCRIPTION_FAILED", "message": "Cannot read audio", "retryable": false,
        "cause": cause, "body": sentinel, "headers": ["cookie": sentinel], "stack": sentinel,
        "context": [
          "status": 403, "provider": "openai", "model": "whisper-1", "operation": "transcribe file",
          "code": "EACCES", "syscall": "open", "file": "/tmp/audio.wav",
          "actor": ["type": "agent", "id": "main", "profile": sentinel, "credential": sentinel],
          "headers": sentinel, "cookies": sentinel, "query": sentinel, "body": sentinel, "stack": sentinel,
        ],
      ],
    ])
    guard case .contract(let body, _) = buildRaviError(statusCode: 422, data: data) else {
      return XCTFail("Expected diagnostic contract")
    }
    XCTAssertEqual(body.error.code, "TRANSCRIPTION_FAILED")
    XCTAssertEqual(body.error.cause, cause)
    XCTAssertEqual(body.error.details["cause"], .string(cause))
    XCTAssertEqual(body.error.context?.status, 403)
    XCTAssertEqual(body.error.context?.provider, "openai")
    XCTAssertEqual(body.error.context?.model, "whisper-1")
    XCTAssertEqual(body.error.context?.operation, "transcribe file")
    XCTAssertEqual(body.error.context?.code, "EACCES")
    XCTAssertEqual(body.error.context?.syscall, "open")
    XCTAssertEqual(body.error.context?.file, "/tmp/audio.wav")
    XCTAssertEqual(body.error.context?.actor?.type, "agent")
    XCTAssertEqual(body.error.context?.actor?.id, "main")
    XCTAssertFalse(String(describing: body).contains(sentinel))
  }

  func testRejectsInvalidDiagnosticFieldsWithoutDiscardingCause() throws {
    for status in [99, 600, 401.5] {
      let data = try JSONSerialization.data(withJSONObject: [
        "success": false, "op": "transcribe file", "exitCode": 1, "outcome": "failed",
        "error": [
          "code": "TRANSCRIPTION_FAILED", "message": "quota exceeded", "retryable": false,
          "cause": "quota exceeded", "context": [
            "status": status, "provider": "https://host?key=private",
            "actor": ["type": "agent", "id": "rctx_privatecredential"],
          ],
        ],
      ])
      guard case .contract(let body, _) = buildRaviError(statusCode: 422, data: data) else {
        return XCTFail("Expected diagnostic contract")
      }
      XCTAssertEqual(body.error.cause, "quota exceeded")
      XCTAssertNil(body.error.context?.status)
      XCTAssertNil(body.error.context?.provider)
      XCTAssertNil(body.error.context?.actor)
    }
  }

  func testCanonicalContractFailuresPreserveEnvelopeAndTaxonomy() throws {
    let fixtures: [(statusCode: Int, exitCode: Int, outcome: RaviContractOutcome, code: String)] = [
      (422, 1, .failed, "PROVIDER_ERROR"),
      (403, 1, .denied, "PERMISSION_DENIED"),
      (400, 2, .usageError, "USAGE_ERROR"),
      (409, 3, .blocked, "WRITE_REQUIRES_EXECUTE"),
    ]

    for fixture in fixtures {
      let data = Data(
        """
        {
          "success": false,
          "op": "audio generate",
          "error": {
            "code": "\(fixture.code)",
            "message": "contract stopped execution",
            "retryable": false,
            "suggestedAction": "inspect and retry"
          },
          "exitCode": \(fixture.exitCode),
          "outcome": "\(fixture.outcome.rawValue)",
          "traceId": "trace_123"
        }
        """.utf8
      )

      guard case .contract(let body, let statusCode) = buildRaviError(statusCode: fixture.statusCode, data: data)
      else {
        XCTFail("Expected canonical contract error for exit \(fixture.exitCode)")
        return
      }

      XCTAssertEqual(statusCode, fixture.statusCode)
      XCTAssertFalse(body.success)
      XCTAssertEqual(body.op, "audio generate")
      XCTAssertEqual(body.error.code, fixture.code)
      XCTAssertEqual(body.error.message, "contract stopped execution")
      XCTAssertFalse(body.error.retryable)
      XCTAssertEqual(body.error.details["suggestedAction"], .string("inspect and retry"))
      XCTAssertEqual(body.exitCode, fixture.exitCode)
      XCTAssertEqual(body.outcome, fixture.outcome)
    }
  }

  func testCanonicalContractProjectsAndSanitizesDetails() throws {
    let data = Data(
      """
      {
        "success": false,
        "op": "artifacts publish",
        "error": {
          "code": "WRITE_REQUIRES_EXECUTE",
          "message": "contract stopped execution",
          "retryable": false,
          "suggestedAction": "inspect and retry",
          "providerBody": "SENTINEL_SECRET_7M4Q",
          "dryRun": true,
          "plan": {
            "providerBody": "SENTINEL_SECRET_7M4Q",
            "caption": "PRIVATE_MESSAGE_8K2R",
            "filePath": "C:/private/SENTINEL_SECRET_7M4Q.txt",
            "key": "custom.password",
            "value": "SENTINEL_SECRET_7M4Q",
            "count": 2,
            "captionPresent": true
          },
          "issues": [{
            "path": ["caption"],
            "code": "invalid",
            "message": "PRIVATE_MESSAGE_8K2R",
            "providerBody": "SENTINEL_SECRET_7M4Q"
          }]
        },
        "exitCode": 3,
        "outcome": "blocked",
        "providerBody": "SENTINEL_SECRET_7M4Q"
      }
      """.utf8
    )

    guard case .contract(let body, _) = buildRaviError(statusCode: 409, data: data) else {
      XCTFail("Expected projected contract error")
      return
    }

    XCTAssertEqual(body.error.details["suggestedAction"], .string("inspect and retry"))
    XCTAssertEqual(body.error.details["dryRun"], .bool(true))
    XCTAssertEqual(
      body.error.details["plan"],
      .object([
        "caption": .string("[REDACTED:content length=20]"),
        "filePath": .string("[REDACTED:path]"),
        "key": .string("custom.password"),
        "value": .string("[REDACTED]"),
        "count": .number(2),
        "captionPresent": .bool(true),
      ])
    )
    XCTAssertNil(body.error.details["providerBody"])
    XCTAssertEqual(
      body.error.details["issues"],
      .array([
        .object([
          "path": .array([.string("caption")]),
          "code": .string("invalid"),
          "message": .string("[REDACTED:content length=20]"),
        ])
      ])
    )
    XCTAssertFalse(String(describing: body).contains("SENTINEL_SECRET_7M4Q"))
    XCTAssertFalse(String(describing: body).contains("PRIVATE_MESSAGE_8K2R"))
  }

  func testCanonicalContractRejectsIncoherentExitOutcomePairs() throws {
    let fixtures: [(exitCode: Int, outcome: String)] = [
      (1, "blocked"),
      (1, "usage_error"),
      (2, "failed"),
      (2, "denied"),
      (2, "blocked"),
      (3, "failed"),
      (3, "denied"),
      (3, "usage_error"),
    ]

    for fixture in fixtures {
      let data = Data(
        """
        {
          "success": false,
          "op": "audio generate",
          "error": {
            "code": "SOME_ERROR",
            "message": "contract stopped execution",
            "retryable": false
          },
          "exitCode": \(fixture.exitCode),
          "outcome": "\(fixture.outcome)"
        }
        """.utf8
      )

      if case .contract = buildRaviError(statusCode: 400, data: data) {
        XCTFail("Unexpected contract error for \(fixture.exitCode)/\(fixture.outcome)")
      }
    }
  }

  func testCanonicalContractRejectsIncoherentPermissionCodeAndOutcome() throws {
    let fixtures: [(outcome: String, code: String)] = [
      ("denied", "SOME_ERROR"),
      ("failed", "PERMISSION_DENIED"),
    ]

    for fixture in fixtures {
      let data = Data(
        """
        {
          "success": false,
          "op": "agents debounce",
          "error": {
            "code": "\(fixture.code)",
            "message": "contract stopped execution",
            "retryable": false
          },
          "exitCode": 1,
          "outcome": "\(fixture.outcome)"
        }
        """.utf8
      )

      if case .contract = buildRaviError(statusCode: 403, data: data) {
        XCTFail("Unexpected contract error for \(fixture.code)/\(fixture.outcome)")
      }
    }
  }

  func testLegacyValidationErrorsKeepTheirExistingMapping() throws {
    let data = Data(
      """
      {
        "error": "ValidationError",
        "message": "invalid input",
        "issues": [{"path": ["name"], "code": "invalid_type", "message": "Required"}]
      }
      """.utf8
    )

    guard case .validation(let message, let issues, let statusCode) = buildRaviError(statusCode: 400, data: data)
    else {
      XCTFail("Expected legacy validation error")
      return
    }

    XCTAssertEqual(message, "invalid input")
    XCTAssertEqual(statusCode, 400)
    XCTAssertEqual(issues, [RaviIssue(path: ["name"], code: "invalid_type", message: "Required")])
  }
}
