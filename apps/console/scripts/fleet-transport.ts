import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createNodeServer } from "../src/server/console/fleet/node-server";
import { NodeManagementService } from "../src/server/console/fleet/nodes";
import { FileNodeCertificateIssuer, protectedFile } from "../src/server/console/fleet/node-pki";

if (process.versions.bun) throw new Error("The Fleet TLS service requires Node.js; use bun run fleet:transport");
const database = process.env.DATABASE_URL, organizationId = process.env.RAVI_SINGLE_TENANT_ORGANIZATION_ID;
if (!database || !organizationId || !/^[a-f0-9-]{36}$/.test(organizationId)) throw new Error("Console database and organization are required");
const consoleUrl = new URL(process.env.NEXT_PUBLIC_CONSOLE_URL!), transportUrl = new URL(process.env.RAVI_FLEET_TRANSPORT_ORIGIN!);
for (const url of [consoleUrl, transportUrl]) if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('HTTPS origins are required');
const [key, cert, ca] = await Promise.all([protectedFile(process.env.RAVI_FLEET_TLS_KEY_FILE),
  readFile(process.env.RAVI_FLEET_TLS_CERT_FILE!, "utf8"), protectedFile(process.env.RAVI_FLEET_CA_CERT_FILE)]);
const port = Number(process.env.RAVI_FLEET_PORT ?? "7443");
if (!Number.isInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) throw new Error("Invalid Fleet port");
const sql = postgres(database, { max: 10, prepare: false });
const service = new NodeManagementService(sql, organizationId, new FileNodeCertificateIssuer(), { console: consoleUrl.origin, transport: transportUrl.origin });
const server = createNodeServer({ key, cert, ca }, service);
server.listen(port, process.env.RAVI_FLEET_BIND ?? "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== 'string') { console.log(`Fleet transport listening on port ${address.port}`); process.send?.({ port: address.port }); }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.closeAllConnections(); server.close(async () => { await sql.end(); process.exit(0); });
});
