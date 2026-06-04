import XCTest
@testable import RaviSDK

final class RaviStreamingTests: XCTestCase {
  func testParserDecodesEventIdAndJsonData() throws {
    var parser = RaviSseParser<RaviJSON>()

    XCTAssertNil(try parser.feedLine(": connected"))
    XCTAssertNil(try parser.feedLine(""))
    XCTAssertNil(try parser.feedLine("id: 7"))
    XCTAssertNil(try parser.feedLine("event: message"))
    XCTAssertNil(try parser.feedLine("data: {\"ok\":true}"))

    let event = try parser.feedLine("")
    XCTAssertEqual(event?.id, "7")
    XCTAssertEqual(event?.event, "message")
    XCTAssertEqual(event?.data, .object(["ok": .bool(true)]))
  }

  func testParserCancelsPartialCommentOnlyFrames() throws {
    var parser = RaviSseParser<RaviJSON>()

    XCTAssertNil(try parser.feedLine(": ping"))
    XCTAssertNil(try parser.feedLine(""))
    XCTAssertNil(try parser.finish())
  }

  func testSessionPayloadDecodesTimeoutEndEvent() throws {
    let raw = Data("""
    {"type":"stream.end","reason":"timeout","sessionName":"wa-overlay-dev","timeoutMs":60000}
    """.utf8)

    let payload = try JSONDecoder().decode(SessionStreamPayload.self, from: raw)
    XCTAssertEqual(payload.type, .string("stream.end"))
    XCTAssertEqual(payload.reason, "timeout")
    XCTAssertEqual(payload.sessionName, "wa-overlay-dev")
    XCTAssertEqual(payload.timeoutMs, 60000)
  }

  func testTaskPayloadKeepsAdditionalFields() throws {
    let raw = Data("""
    {"type":"task.event","topic":"ravi.task.t1.event","status":"done","progress":100}
    """.utf8)

    let payload = try JSONDecoder().decode(TaskStreamPayload.self, from: raw)
    XCTAssertEqual(payload.type, .string("task.event"))
    XCTAssertEqual(payload.topic, "ravi.task.t1.event")
    XCTAssertEqual(payload.extraFields["status"], .string("done"))
    XCTAssertEqual(payload.extraFields["progress"], .number(100))
  }

  func testBuildsSseRequestWithAuthHeadersAndEncodedQuery() throws {
    let client = RaviStreamClient(
      baseURL: URL(string: "http://ravi.test/")!,
      contextKey: "rctx_test",
      headers: ["x-custom": "yes"]
    )

    let request = try client.buildStreamRequest(
      pathSegments: ["sessions", "wa overlay/dev"],
      queryItems: [URLQueryItem(name: "timeout", value: "0")]
    )

    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.value(forHTTPHeaderField: "accept"), "text/event-stream")
    XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer rctx_test")
    XCTAssertEqual(request.value(forHTTPHeaderField: "x-custom"), "yes")
    XCTAssertEqual(request.url?.absoluteString, "http://ravi.test/api/v1/_stream/sessions/wa%20overlay%2Fdev?timeout=0")
  }
}
