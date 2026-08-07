import Foundation
import XCTest
@testable import RaviSDK

final class RaviErrorTests: XCTestCase {
  func testCanonicalContractFailuresPreserveEnvelopeAndTaxonomy() throws {
    let fixtures: [(statusCode: Int, exitCode: Int, outcome: RaviContractOutcome, code: String)] = [
      (422, 1, .failed, "PROVIDER_ERROR"),
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
      XCTAssertEqual(body.extraFields["traceId"], .string("trace_123"))
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
