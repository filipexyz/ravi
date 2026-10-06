import { spawnSync } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { isSessionResponseTopic } from "./nats.js";

describe("isSessionResponseTopic", () => {
  it("matches only session chat response topics", () => {
    expect(isSessionResponseTopic("ravi.session.demo-agent.response")).toBe(true);
    expect(isSessionResponseTopic("ravi.session.demo-group.response")).toBe(true);
  });

  it("does not treat approval or other .response topics as ghost chat emits", () => {
    expect(isSessionResponseTopic("ravi.approval.response")).toBe(false);
    expect(isSessionResponseTopic("ravi.session.demo-agent.runtime")).toBe(false);
    expect(isSessionResponseTopic("ravi.outbound.deliver")).toBe(false);
  });
});

describe("lazy NATS connect failure logging", () => {
  // Each case runs in a fresh process so the module-level connection state and
  // NATS_URL (read at import time) point at a port nothing listens on.
  const natsModule = new URL("./nats.ts", import.meta.url).pathname;

  function failureLinesFor(script: string): number {
    const result = spawnSync(process.execPath, ["-e", `import * as n from ${JSON.stringify(natsModule)};\n${script}`], {
      env: { ...process.env, NATS_URL: "nats://127.0.0.1:1", RAVI_LOG_LEVEL: "info" },
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;
    return output.split("\n").filter((line) => line.includes("Failed to connect to NATS")).length;
  }

  it("stays silent for a best-effort emit such as the CLI audit event", () => {
    expect(failureLinesFor(`await n.publish("ravi._cli.cli.x.y", {}, { quietConnect: true }).catch(() => {});`)).toBe(
      0,
    );
  });

  it("still prints one error for callers that need NATS", () => {
    expect(
      failureLinesFor(`await Promise.all([n.ensureConnected().catch(() => {}), n.ensureConnected().catch(() => {})]);`),
    ).toBe(1);
  });

  it("prints the error once when a caller that needs NATS joins a quiet attempt", () => {
    expect(
      failureLinesFor(
        `await Promise.all([
          n.ensureConnected({ quiet: true }).catch(() => {}),
          n.ensureConnected().catch(() => {}),
          n.ensureConnected().catch(() => {}),
        ]);`,
      ),
    ).toBe(1);
  });
});
