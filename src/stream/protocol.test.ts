import { describe, expect, it } from "bun:test";
import { formatStreamLine, parseStreamInputLine, parseStreamOutputLine, STREAM_PROTOCOL_VERSION } from "./protocol.js";

describe("stream protocol", () => {
  it("parses valid output envelopes", () => {
    const line = JSON.stringify({
      v: STREAM_PROTOCOL_VERSION,
      type: "event",
      id: "evt_1",
      ts: new Date().toISOString(),
      source: "ravi.stream",
      topic: "ravi.session.dev.runtime.tool",
      cursor: "local:1",
      body: { tool: "bash" },
    });

    const parsed = parseStreamOutputLine(line);
    expect(parsed.type).toBe("event");
    if (parsed.type === "event") {
      expect(parsed.topic).toBe("ravi.session.dev.runtime.tool");
    }
  });

  it("parses valid input envelopes", () => {
    const line = JSON.stringify({
      v: STREAM_PROTOCOL_VERSION,
      type: "command",
      id: "cmd_1",
      ts: new Date().toISOString(),
      body: {
        name: "snapshot.open",
        args: {},
        expectAck: true,
      },
    });

    const parsed = parseStreamInputLine(line);
    expect(parsed.type).toBe("command");
    if (parsed.type === "command") {
      expect(parsed.body.name).toBe("snapshot.open");
    }
  });

  it("formats JSONL with trailing newline", () => {
    const line = formatStreamLine({
      v: STREAM_PROTOCOL_VERSION,
      type: "hello",
      id: "hello_1",
      ts: new Date().toISOString(),
      body: {
        scope: "events",
        topicPatterns: [">"],
      },
    });

    expect(line.endsWith("\n")).toBe(true);
  });
});
