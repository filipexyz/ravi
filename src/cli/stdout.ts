import type { Writable } from "node:stream";

type OutputStream = Pick<Writable, "once" | "removeListener" | "write">;

/** Resolve only after the complete JSON document has been accepted by stdout. */
export async function writeJsonToStdout(payload: unknown, stream: OutputStream = process.stdout): Promise<void> {
  const document = `${JSON.stringify(payload, null, 2)}\n`;

  await new Promise<void>((resolve, reject) => {
    let completed = false;
    const finish = (error?: Error | null) => {
      if (completed) return;
      completed = true;
      stream.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);

    stream.once("error", onError);
    try {
      stream.write(document, (error?: Error | null) => finish(error));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
