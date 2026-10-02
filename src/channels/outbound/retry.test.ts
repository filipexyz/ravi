import { describe, expect, it, mock } from "bun:test";
import { ChannelTransportError } from "./errors.js";
import { withTransportRetry } from "./retry.js";

function harness() {
  const sleeps: number[] = [];
  const warnings: string[] = [];
  return {
    sleeps,
    warnings,
    options: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: {
        warn: (message: string) => {
          warnings.push(message);
        },
      },
    },
  };
}

const serverError = () => new ChannelTransportError("server", { status: 503, code: "NOT_CONNECTED" });

describe("withTransportRetry", () => {
  it("returns the first success without waiting", async () => {
    const { sleeps, options } = harness();
    const operation = mock(async () => "ok");

    await expect(withTransportRetry(operation, "send(a)", options)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("makes 3 attempts with 1s then 2s backoff on 5xx, then rethrows the last error", async () => {
    const { sleeps, warnings, options } = harness();
    const errors = [serverError(), serverError(), serverError()];
    let call = 0;
    const operation = mock(async () => {
      throw errors[call++];
    });

    await expect(withTransportRetry(operation, "send(a)", options)).rejects.toBe(errors[2]);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(warnings).toEqual([
      "send(a) failed (attempt 1/3), retrying in 1000ms",
      "send(a) failed (attempt 2/3), retrying in 2000ms",
    ]);
  });

  it("retries network TypeErrors and recovers", async () => {
    const { sleeps, options } = harness();
    let call = 0;
    const operation = mock(async () => {
      call += 1;
      if (call === 1) throw new TypeError("fetch failed");
      return "sent";
    });

    await expect(withTransportRetry(operation, "send(a)", options)).resolves.toBe("sent");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it("does not retry 4xx errors", async () => {
    const { sleeps, options } = harness();
    const err = new ChannelTransportError("bad", { status: 400, code: "INVALID_REQUEST" });
    const operation = mock(async () => {
      throw err;
    });

    await expect(withTransportRetry(operation, "send(a)", options)).rejects.toBe(err);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry a 5xx error marked retryable:false", async () => {
    const { sleeps, options } = harness();
    const err = new ChannelTransportError("no bridge", {
      status: 503,
      code: "LEGACY_BRIDGE_NOT_CONFIGURED",
      retryable: false,
    });
    const operation = mock(async () => {
      throw err;
    });

    await expect(withTransportRetry(operation, "send(a)", options)).rejects.toBe(err);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry unknown errors", async () => {
    const { options } = harness();
    const operation = mock(async () => {
      throw new Error("bug");
    });

    await expect(withTransportRetry(operation, "send(a)", options)).rejects.toThrow("bug");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("applies a per-call retry policy", async () => {
    const { sleeps, options } = harness();
    const timeout = new ChannelTransportError("timeout", { status: 504, code: "WHATSAPP_RPC_TIMEOUT" });
    const operation = mock(async () => {
      throw timeout;
    });

    await expect(
      withTransportRetry(operation, "send(a)", {
        ...options,
        isRetryable: (err) => err instanceof ChannelTransportError && err.code !== "WHATSAPP_RPC_TIMEOUT",
      }),
    ).rejects.toBe(timeout);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("waits at least the transport-provided retryAfterMs", async () => {
    const { sleeps, options } = harness();
    let call = 0;
    const operation = mock(async () => {
      call += 1;
      if (call === 1) {
        throw new ChannelTransportError("slow down", {
          status: 429,
          code: "RATE_LIMITED",
          retryable: true,
          retryAfterMs: 4_500,
        });
      }
      if (call === 2) {
        throw new ChannelTransportError("slow down", {
          status: 429,
          code: "RATE_LIMITED",
          retryable: true,
          retryAfterMs: 10,
        });
      }
      return "ok";
    });

    await expect(withTransportRetry(operation, "send(a)", options)).resolves.toBe("ok");
    expect(sleeps).toEqual([4500, 2000]);
  });

  it("honours custom attempts and base delay", async () => {
    const { sleeps, options } = harness();
    const operation = mock(async () => {
      throw serverError();
    });

    await expect(
      withTransportRetry(operation, "send(a)", { ...options, attempts: 4, baseDelayMs: 10 }),
    ).rejects.toBeInstanceOf(ChannelTransportError);
    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([10, 20, 30]);
  });
});
