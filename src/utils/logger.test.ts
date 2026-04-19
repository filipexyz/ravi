import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { logger } from "./logger.js";

describe("logger terminal stream", () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logger.setLevel("info");
    logger.setTerminalStream("stderr");
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    logger.setLevel("info");
    logger.setTerminalStream("stderr");
  });

  it("writes info logs to stderr by default", () => {
    logger.info("Connected to NATS", { server: "nats://127.0.0.1:4222" });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(String(stderrSpy.mock.calls[0]?.[0] ?? "")).toContain("[ravi] Connected to NATS");
  });

  it("can be explicitly redirected to stdout when a caller opts in", () => {
    logger.setTerminalStream("stdout");

    logger.info("stdout opt-in");

    expect(stderrSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(String(stdoutSpy.mock.calls[0]?.[0] ?? "")).toContain("[ravi] stdout opt-in");
  });

  it("includes Error stacks for warning-level logs", () => {
    logger.warn("recoverable failure", { error: new Error("boom") });

    const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("[ravi] recoverable failure");
    expect(output).toContain("error=boom");
    expect(output).toContain("errorName=Error");
    expect(output).toContain("stack=");
  });

  it("keeps NATS lifecycle logs off stdout", () => {
    const natsLog = logger.child("nats");

    natsLog.info("Connected to NATS", { server: "nats://127.0.0.1:4222" });
    natsLog.info("NATS connection closed");

    expect(stdoutSpy).not.toHaveBeenCalled();

    const stderrOutput = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? "")).join("");
    expect(stderrOutput).toContain("[ravi:nats] Connected to NATS");
    expect(stderrOutput).toContain("[ravi:nats] NATS connection closed");
  });
});
