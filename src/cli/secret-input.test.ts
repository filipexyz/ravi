import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { CloudAuthError } from "../cloud-auth/errors.js";
import { readConfirmedSecret } from "./secret-input.js";

describe("confirmed secret input", () => {
  test("reads one redirected value without trimming meaningful whitespace", async () => {
    const input = new PassThrough();
    input.end("  secret value  \n");

    const result = await readConfirmedSecret({ fromStdin: true, prompt: "Password: " }, { input: input as never });

    expect(result).toBe("  secret value  ");
  });

  test("rejects non-interactive input unless stdin mode is explicit", async () => {
    const input = new PassThrough();
    input.end("secret\n");

    await expect(readConfirmedSecret({ prompt: "Password: " }, { input: input as never })).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
  });

  test("confirms TTY input without echoing either value", async () => {
    const input = new PassThrough() as PassThrough & {
      isRaw: boolean;
      isTTY: boolean;
      setRawMode(mode: boolean): void;
    };
    input.isRaw = false;
    input.isTTY = true;
    input.setRawMode = (mode) => {
      input.isRaw = mode;
    };
    let output = "";
    const pending = readConfirmedSecret(
      { confirmPrompt: "Confirm: ", prompt: "Password: " },
      {
        input,
        output: {
          write: (value) => {
            output += String(value);
            return true;
          },
        },
      },
    );
    input.write("super secret\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.write("super secret\n");

    await expect(pending).resolves.toBe("super secret");
    expect(output).toBe("Password: \nConfirm: \n");
    expect(output).not.toContain("super secret");
  });

  test("does not include submitted secret in size errors", async () => {
    const input = new PassThrough();
    const secret = "sensitive-value";
    input.end(`${secret}\n`);

    try {
      await readConfirmedSecret({ fromStdin: true, prompt: "Password: " }, { input: input as never, maxBytes: 4 });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
