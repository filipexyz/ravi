import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, lstat, realpath } from "node:fs/promises";
import { resolve, join, isAbsolute, dirname, basename } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { initializeNodeAuthority } from "../src/server/console/fleet/node-pki-setup";

const httpsOrigin = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
});
const configSchema = z.object({
  directory: z.string().refine(isAbsolute), image: z.string().regex(/^(?:[a-zA-Z0-9/_.:-]+@)?sha256:[a-f0-9]{64}$/),
  consoleOrigin: httpsOrigin, transportOrigin: httpsOrigin,
  oidcIssuer: z.string().url(), oidcClientId: z.string().min(1), oidcSecretFile: z.string().refine(isAbsolute),
  oidcCaFile: z.string().refine(isAbsolute).optional(),
  ownerEmail: z.string().email(), organizationName: z.string().min(1).max(120), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
}).strict();

/** Source distribution installer: an empty control-plane environment, never a Ravi executor. */
export async function prepareConsoleInstallation(raw: unknown) {
  const config = configSchema.parse(raw);
  const directory = join(await realpath(dirname(resolve(config.directory))), basename(config.directory));
  if (!config.oidcIssuer.startsWith("https://")) throw new Error("OIDC issuer must use HTTPS");
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (!uid || gid === undefined) throw new Error("Run as the dedicated, non-root Console account");
  const secretStat = await lstat(config.oidcSecretFile);
  if (!secretStat.isFile() || secretStat.isSymbolicLink() || (secretStat.mode & 0o077)) throw new Error("OIDC secret must be a private regular file");
  const clientSecret = (await readFile(config.oidcSecretFile, "utf8")).trim();
  if (!clientSecret || clientSecret.length > 8192 || /[\r\n\0]/.test(clientSecret)) throw new Error("Invalid OIDC secret file");
  // mkdir without recursive is the ownership barrier: existing installs are never overwritten.
  await mkdir(directory, { mode: 0o700 });
  const parent = await realpath(directory);
  if (parent !== directory) throw new Error("Installation directory cannot traverse symlinks");
  async function privateFile(name: string, value: string) {
    const file = await open(join(directory, name), "wx", 0o600);
    try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  }
  await mkdir(join(directory, "setup"), { mode: 0o700 });
  await initializeNodeAuthority(join(directory, "authority"), new URL(config.transportOrigin).hostname);
  await privateFile("oidc-secret", clientSecret);
  if (config.oidcCaFile) await privateFile("oidc-ca.pem", await readFile(config.oidcCaFile, "utf8"));
  const password = randomBytes(32).toString("hex"), organizationId = randomUUID();
  await privateFile("postgres-password", password);
  const environment: Record<string, string> = {
    DATABASE_URL: `postgresql://console:${password}@postgres:5432/console`,
    RAVI_AUTH_MODE: "oidc", RAVI_AUTH_SECRET: randomBytes(48).toString("base64url"),
    RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: "true", RAVI_PAGES_AI_ENABLED: "0", RAVI_SINGLE_TENANT_ORGANIZATION_ID: organizationId,
    NEXT_PUBLIC_CONSOLE_URL: config.consoleOrigin, RAVI_OIDC_ISSUER: config.oidcIssuer, RAVI_OIDC_CLIENT_ID: config.oidcClientId,
    RAVI_OIDC_CLIENT_SECRET_FILE: "/run/console/oidc-secret", RAVI_FLEET_TRANSPORT_ORIGIN: config.transportOrigin,
    RAVI_FLEET_CA_CERT_FILE: "/run/console/authority/ca.pem", RAVI_FLEET_CA_KEY_FILE: "/run/console/authority/ca-key.pem",
    RAVI_FLEET_TLS_CERT_FILE: "/run/console/authority/server.pem", RAVI_FLEET_TLS_KEY_FILE: "/run/console/authority/server-key.pem",
    RAVI_FLEET_BIND: "0.0.0.0", RAVI_FLEET_PORT: "7443", ...(config.oidcCaFile ? { NODE_EXTRA_CA_CERTS: "/run/console/oidc-ca.pem" } : {}),
  };
  // JSON Compose avoids shell/env interpolation of operator-supplied values.
  const shared = { image: config.image, user: `${uid}:${gid}`, restart: "unless-stopped", read_only: true,
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], environment,
    volumes: [`${directory}/authority:/run/console/authority:ro`, `${directory}/oidc-secret:/run/console/oidc-secret:ro`, `${directory}/setup:/var/lib/console/setup`,
      ...(config.oidcCaFile ? [`${directory}/oidc-ca.pem:/run/console/oidc-ca.pem:ro`] : [])],
    tmpfs: ["/tmp:rw,nosuid,noexec,size=256m", "/app/apps/console/.next/cache:rw,nosuid,size=256m"],
    depends_on: { postgres: { condition: "service_healthy" } },
  };
  const compose = { name: `ravi-console-${config.slug}`, services: {
    postgres: { image: "postgres:17.11-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27", restart: "unless-stopped",
      environment: { POSTGRES_USER: "console", POSTGRES_DB: "console", POSTGRES_PASSWORD: password },
      volumes: ["database:/var/lib/postgresql/data"],
      healthcheck: { test: ["CMD-SHELL", "pg_isready -U console -d console"], interval: "5s", retries: 20 } },
    console: { ...shared, ports: ["127.0.0.1:3000:3000"] },
    transport: { ...shared, command: ["node", ".fleet-dist/transport.mjs"], ports: ["127.0.0.1:7443:7443"] },
  }, volumes: { database: {} } };
  // Compose interpolates dollar signs even in JSON; values remain literal.
  await privateFile("compose.json", JSON.stringify(compose, (_, value) => typeof value === "string" ? value.replaceAll("$", "$$") : value, 2));
  await privateFile("installation.json", JSON.stringify({ organizationId, consoleOrigin: config.consoleOrigin, transportOrigin: config.transportOrigin, image: config.image }));
  return { directory, organizationId, consoleOrigin: config.consoleOrigin, config };
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { config: { type: "string" }, execute: { type: "boolean" }, "prepare-only": { type: "boolean" } } });
  if (!values.config) throw new Error("Usage: bun scripts/prepare-installation.ts --config <operator-config.json> [--execute]");
  const input = configSchema.parse(JSON.parse(await readFile(values.config, "utf8")));
  if (!values.execute) { console.log(JSON.stringify({ plan: "Create a new isolated Console installation", directory: input.directory, image: input.image, consoleOrigin: input.consoleOrigin, requires: ["Dedicated control-plane environment", "Configured HTTPS reverse proxy and OIDC client", "Docker Compose"], execute: false })); }
  else {
    const prepared = await prepareConsoleInstallation(input);
    if (values["prepare-only"]) { console.log(JSON.stringify({ prepared: true, directory: prepared.directory, organizationId: prepared.organizationId, consoleOrigin: prepared.consoleOrigin, started: false })); process.exit(0); }
    async function compose(...args: string[]) {
      const child = Bun.spawn(["docker", "compose", "-f", join(prepared.directory, "compose.json"), ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
      if (await child.exited !== 0) throw new Error("Installation step failed; preserve the directory and inspect its state before resuming");
    }
    await compose("up", "-d", "--wait", "--wait-timeout", "90", "postgres");
    await compose("run", "--rm", "--no-deps", "console", "bun", "scripts/migrate-with-lock.ts");
    await compose("run", "--rm", "--no-deps", "console", "bun", "scripts/fleet-issue-setup.ts", "--apply", "--name", input.organizationName, "--slug", input.slug, "--email", input.ownerEmail, "--output-dir", "/var/lib/console/setup");
    await compose("up", "-d", "console", "transport");
    console.log(JSON.stringify({ prepared: true, consoleOrigin: input.consoleOrigin, setupLinkFile: join(prepared.directory, "setup/setup-link.txt"), next: "Open the private setup link, sign in, and associate a Ravi in its own environment. Service reachability still requires verification." }));
  }
}
