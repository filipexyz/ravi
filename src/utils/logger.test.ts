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

  it("includes normalized causes without stacks for warning-level logs", () => {
    logger.warn("recoverable failure", { error: new Error("boom") });

    const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("[ravi] recoverable failure");
    expect(output).toContain("error=boom");
    expect(output).toContain("cause=boom");
    expect(output).not.toContain("stack=");
  });

  it("drops arbitrary exception fields from error log lines and normalizes persistent context", () => {
    logger.withContext({ sessionKey: "session?key=PRIVATE_QUERY" }).error("Provider failed", {
      code: "DENIED",
      message: "provider returned 401",
      cause: "provider returned 401; cookie=PRIVATE_COOKIE; PRIVATE_TAIL",
      context: { operation: "media send", status: 401 },
      arbitrary: "PRIVATE_UNKNOWN",
      body: "PRIVATE_BODY",
      stack: "PRIVATE_STACK",
    });
    const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("cause=provider returned 401; cookie=[redacted:cookie]");
    expect(output).toContain('"status":401');
    for (const secret of [
      "PRIVATE_QUERY",
      "PRIVATE_COOKIE",
      "PRIVATE_TAIL",
      "PRIVATE_UNKNOWN",
      "PRIVATE_BODY",
      "PRIVATE_STACK",
    ])
      expect(output).not.toContain(secret);
  });

  it("preserves typed SQLite retry instrumentation without exposing the database path or exception payload", () => {
    logger.error("SQLite statement failed", {
      error: new Error("out of memory"),
      operation: "session-goals.get",
      sqliteCode: "SQLITE_NOMEM",
      sqliteErrno: 7,
      willRetry: false,
      attempt: 2,
      statementsAgeMs: 0,
      rssMb: 128.5,
      heapUsedMb: 32,
      heapTotalMb: 64,
      externalMb: 4,
      suppressed: 3,
      dbPath: "/PRIVATE_DB_PATH/database.sqlite",
      body: "PRIVATE_PROVIDER_BODY",
      stack: "PRIVATE_STACK",
      arbitrary: { value: "PRIVATE_ARBITRARY" },
    });
    const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    for (const field of [
      "operation=session-goals.get",
      "sqliteCode=SQLITE_NOMEM",
      "sqliteErrno=7",
      "willRetry=false",
      "attempt=2",
      "statementsAgeMs=0",
      "rssMb=128.5",
      "heapUsedMb=32",
      "heapTotalMb=64",
      "externalMb=4",
      "suppressed=3",
      "cause=out of memory",
    ])
      expect(output).toContain(field);
    expect(output).not.toContain("PRIVATE_");
    expect(output).not.toContain("dbPath=");
  });

  it("rejects credentials and malformed values under allowed instrumentation names", () => {
    logger.error("SQLite statement failed", {
      error: new Error("out of memory"),
      operation: "get?key=PRIVATE_OPERATION",
      sqliteCode: "SQLITE_NOMEM?token=PRIVATE_CODE",
      willRetry: "PRIVATE_BOOLEAN",
      attempt: "PRIVATE_ATTEMPT",
      sqliteErrno: { code: "PRIVATE_ERRNO" },
      rssMb: "PRIVATE_MEMORY",
    });
    const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("cause=out of memory");
    expect(output).not.toContain("PRIVATE_");
    for (const key of ["operation", "sqliteCode", "willRetry", "attempt", "sqliteErrno", "rssMb"])
      expect(output).not.toContain(`${key}=`);
  });

  it.each([NaN, Infinity, -Infinity, -1, "12", null, { value: 12 }])(
    "rejects invalid numeric instrumentation %p without coercing it",
    (value) => {
      logger.error("SQLite statement failed", {
        error: new Error("out of memory"),
        sqliteErrno: value,
        attempt: value,
        suppressed: value,
        statementsAgeMs: value,
        rssMb: value,
        heapUsedMb: value,
        heapTotalMb: value,
        externalMb: value,
      });
      const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
      expect(output).toContain("cause=out of memory");
      for (const key of [
        "sqliteErrno",
        "attempt",
        "suppressed",
        "statementsAgeMs",
        "rssMb",
        "heapUsedMb",
        "heapTotalMb",
        "externalMb",
      ])
        expect(output).not.toContain(`${key}=`);
    },
  );

  it("rejects fractional and unsafe integer counters", () => {
    logger.error("SQLite statement failed", {
      error: new Error("out of memory"),
      sqliteErrno: 7.5,
      attempt: Number.MAX_SAFE_INTEGER + 1,
      suppressed: 0.5,
    });
    const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    for (const key of ["sqliteErrno", "attempt", "suppressed"]) expect(output).not.toContain(`${key}=`);
  });

  it("keeps the cause when an allowed field getter throws and never reads unknown properties", () => {
    let unknownReads = 0;
    const data = {
      error: new Error("out of memory"),
      sqliteCode: "SQLITE_NOMEM",
      get operation() {
        throw new Error("PRIVATE_GETTER_FAILURE");
      },
      get rssMb() {
        throw new Error("PRIVATE_MEMORY_FAILURE");
      },
      get arbitrary() {
        unknownReads++;
        throw new Error("PRIVATE_UNKNOWN_FAILURE");
      },
    };
    expect(() => logger.error("SQLite statement failed", data)).not.toThrow();
    const output = String(stderrSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("cause=out of memory");
    expect(output).toContain("sqliteCode=SQLITE_NOMEM");
    expect(output).not.toContain("PRIVATE_");
    expect(unknownReads).toBe(0);
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
