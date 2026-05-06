process.stdout.write(
  `${JSON.stringify({
    v: 1,
    type: "hello",
    id: "hello_fixture",
    ts: new Date().toISOString(),
    source: "fixture.stream",
    body: {
      scope: "overlay.whatsapp",
      topicPatterns: ["ravi.session.>"],
      capabilities: ["snapshot.open", "ping"],
      protocolVersion: 1,
    },
  })}\n`,
);

process.stdin.setEncoding("utf8");

let buffer = "";

function write(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf("\n");
    if (!line) continue;

    const input = JSON.parse(line) as {
      type: string;
      id: string;
      body?: { name?: string; args?: Record<string, unknown> };
    };

    if (input.type === "hello") {
      write({
        v: 1,
        type: "hello",
        id: "hello_fixture_repeat",
        ts: new Date().toISOString(),
        source: "fixture.stream",
        body: {
          scope: "overlay.whatsapp",
          topicPatterns: ["ravi.session.>"],
          capabilities: ["snapshot.open", "ping"],
          protocolVersion: 1,
        },
      });
      continue;
    }

    if (input.body?.name === "snapshot.open") {
      write({
        v: 1,
        type: "snapshot",
        id: "snapshot_fixture",
        ts: new Date().toISOString(),
        source: "fixture.stream",
        cursor: "local:1",
        body: {
          scope: "overlay.whatsapp",
          entities: {
            sessions: [{ name: "dev" }],
          },
          filters: { topicPatterns: ["ravi.session.>"] },
          runtime: {
            pid: process.pid,
            startedAt: new Date().toISOString(),
          },
          capabilities: ["snapshot.open", "ping"],
        },
      });
      write({
        v: 1,
        type: "ack",
        id: "ack_snapshot",
        ts: new Date().toISOString(),
        source: "fixture.stream",
        body: {
          commandId: input.id,
          ok: true,
          result: { emitted: "snapshot" },
        },
      });
      continue;
    }

    if (input.body?.name === "ping") {
      write({
        v: 1,
        type: "ack",
        id: "ack_ping",
        ts: new Date().toISOString(),
        source: "fixture.stream",
        body: {
          commandId: input.id,
          ok: true,
          result: { pong: true },
        },
      });
      continue;
    }

    if (input.body?.name === "fail") {
      write({
        v: 1,
        type: "error",
        id: "err_fail",
        ts: new Date().toISOString(),
        source: "fixture.stream",
        body: {
          commandId: input.id,
          code: "boom",
          message: "fixture failure",
          retryable: false,
        },
      });
    }
  }
});
