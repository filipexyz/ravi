import { resolve } from "node:path";
import { initializeNodeAuthority } from "../src/server/console/fleet/node-pki-setup";
const [directory, hostname] = process.argv.slice(2);
if (!directory || !hostname) { console.error("Usage: bun scripts/fleet-init.ts <private-directory> <transport-hostname>"); process.exit(2); }
await initializeNodeAuthority(resolve(directory), hostname);
console.log("Installation authority created. Keep this directory only in the Console environment. Configure the CA and transport file paths; never copy the CA private key to a Ravi executor.");
