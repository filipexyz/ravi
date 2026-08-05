import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

import { CloudAuthError } from "../cloud-auth/errors.js";

const DEFAULT_MAX_BYTES = 1_024;

type SecretInputStream = Readable & {
  isRaw?: boolean;
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};

export type ConfirmedSecretInputOptions = {
  confirmPrompt?: string;
  fromStdin?: boolean;
  prompt: string;
};

export type ConfirmedSecretInputDeps = {
  input?: SecretInputStream;
  maxBytes?: number;
  output?: Pick<Writable, "write">;
};

export async function readConfirmedSecret(
  options: ConfirmedSecretInputOptions,
  deps: ConfirmedSecretInputDeps = {},
): Promise<string> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stderr;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;

  if (options.fromStdin) {
    if (input.isTTY) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        "--stdin requires redirected input. Omit --stdin to use the hidden prompt.",
      );
    }
    return requireSecret(await readBoundedStdin(input, maxBytes));
  }

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new CloudAuthError("PAYLOAD_INVALID", "Non-interactive password input requires --stdin.");
  }

  const secret = requireSecret(await readHiddenLine(input, output, options.prompt, maxBytes));
  const confirmation = requireSecret(
    await readHiddenLine(input, output, options.confirmPrompt ?? "Confirm password: ", maxBytes),
  );
  if (secret !== confirmation) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Passwords do not match.");
  }
  return secret;
}

async function readBoundedStdin(input: Readable, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new CloudAuthError("PAYLOAD_INVALID", "Password input is too large.");
    }
    chunks.push(buffer);
  }
  return removeOneTrailingLineEnding(Buffer.concat(chunks).toString("utf8"));
}

function readHiddenLine(
  input: SecretInputStream,
  output: Pick<Writable, "write">,
  prompt: string,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing;
    let value = "";
    let settled = false;

    const cleanup = () => {
      input.off("data", onData);
      input.off("error", onError);
      input.setRawMode?.(wasRaw);
      if (wasFlowing !== true) input.pause();
    };
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      output.write("\n");
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      output.write("\n");
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onData = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      for (const character of text) {
        if (character === "\u0003") {
          fail(new CloudAuthError("PAYLOAD_INVALID", "Password input cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
          continue;
        }
        if (character.charCodeAt(0) < 0x20 || character === "\u001b") continue;
        value += character;
        if (Buffer.byteLength(value, "utf8") > maxBytes) {
          fail(new CloudAuthError("PAYLOAD_INVALID", "Password input is too large."));
          return;
        }
      }
    };

    output.write(prompt);
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
    input.on("error", onError);
  });
}

function requireSecret(value: string): string {
  if (value.length === 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Password cannot be empty.");
  }
  if (value.includes("\u0000")) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Password contains an invalid character.");
  }
  return value;
}

function removeOneTrailingLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
  return value;
}
