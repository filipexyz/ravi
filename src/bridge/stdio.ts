/** Restricted SSH adapter. Deliberately imports no CLI, environment loader or runtime database. */
import { createConnection } from "node:net";
import { pipeline } from "node:stream/promises";

export async function forwardBridgeStdio(path: string) {
  const socket = createConnection(path);
  socket.setTimeout(45_000, () => socket.destroy(new Error("Bridge idle")));
  try {
    await Promise.all([pipeline(process.stdin, socket), pipeline(socket, process.stdout)]);
  } catch {
    socket.destroy();
    process.exitCode = 1;
  }
}
if (import.meta.main) {
  const path = process.env.RAVI_BRIDGE_SOCKET;
  if (!path || !path.startsWith("/") || process.argv.length !== 2) {
    process.stderr.write("Bridge socket configuration required\n");
    process.exitCode = 2;
  } else await forwardBridgeStdio(path);
}
