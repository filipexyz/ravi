import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "./logger.js";
const actualNatsModule = await import("nats");

const fakeNatsConnection = {
  drain: mock(async () => {}),
  publish: mock(() => {}),
  subscribe: mock(() => (async function* () {})()),
  status: async function* () {},
};

const connectMock = mock(async () => fakeNatsConnection);

mock.module("nats", () => ({
  ...actualNatsModule,
  connect: connectMock,
  StringCodec: () => ({
    encode: (value: string) => Buffer.from(value),
    decode: (value: Uint8Array) => Buffer.from(value).toString("utf8"),
  }),
}));

const { connectNats, closeNats } = await import("../nats.js");

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

  it("keeps NATS lifecycle logs off stdout", async () => {
    connectMock.mockClear();
    fakeNatsConnection.drain.mockClear();

    await connectNats("nats://127.0.0.1:4222");
    await closeNats();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(fakeNatsConnection.drain).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();

    const stderrOutput = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? "")).join("");
    expect(stderrOutput).toContain("[ravi:nats] Connected to NATS");
    expect(stderrOutput).toContain("[ravi:nats] NATS connection closed");
  });
});
afterAll(() => mock.restore());
