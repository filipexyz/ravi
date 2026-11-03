import { describe, expect, test } from "bun:test";

import { readBoundedText } from "./route-body";

function streamed(chunks: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://console.test/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("bounded body reads", () => {
  test("returns the text when it fits", async () => {
    expect(await readBoundedText(streamed(['{"a":', "1}"]), 16)).toBe('{"a":1}');
  });

  test("stops once the streamed body passes the limit", async () => {
    expect(await readBoundedText(streamed(["x".repeat(10), "x".repeat(10)]), 16)).toBeNull();
  });

  test("refuses a declared length over the limit without reading", async () => {
    expect(await readBoundedText(streamed(["{}"], { "content-length": "999" }), 16)).toBeNull();
  });

  test("counts bytes, not characters", async () => {
    expect(await readBoundedText(streamed(["é".repeat(9)]), 16)).toBeNull();
  });
});
