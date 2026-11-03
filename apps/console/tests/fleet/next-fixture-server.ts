// Node-only disposable Next dev server. No provider/production environment inherited.
import next from "next";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
const port = Number(process.env.FLEET_BROWSER_PORT);
if (!Number.isSafeInteger(port) || port < 1024 || !process.env.PGHOST?.includes("fleet-pg-test-")) throw new Error("Isolated Next fixture configuration required");
const app = next({ dev: true, hostname: "127.0.0.1", port });
await app.prepare();
const handle = app.getRequestHandler();
if (!process.env.FLEET_BROWSER_TLS_KEY?.includes("fleet-idp-test-") || !process.env.FLEET_BROWSER_TLS_CERT?.includes("fleet-idp-test-")) throw new Error("Isolated TLS required");
const server = createServer({ key: await readFile(process.env.FLEET_BROWSER_TLS_KEY), cert: await readFile(process.env.FLEET_BROWSER_TLS_CERT) }, (request, response) => void handle(request, response));
await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
process.stdout.write("FLEET_NEXT_READY\n");
process.on("SIGTERM", () => { server.closeAllConnections(); server.close(() => { void app.close().then(() => process.exit(0)); }); });
