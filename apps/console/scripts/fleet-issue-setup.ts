import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { issueBootstrap } from "../src/server/console/fleet/bootstrap";
import { getOidcBaseConfig } from "../src/lib/auth/oidc-config";

// Operator-only issuance. No web route calls it; no token printed to stdout.
const { values } = parseArgs({ args: process.argv.slice(2), options: { apply: { type: "boolean" },
  name: { type: "string" }, slug: { type: "string" }, email: { type: "string" }, "output-dir": { type: "string" } } });
if (!values.apply || !values["output-dir"] || !isAbsolute(values["output-dir"]) || !process.env.DATABASE_URL) throw new Error("Explicit --apply, --name, --slug, --email, --output-dir outside checkout and installation config required.");
const base = getOidcBaseConfig();
const directory = values["output-dir"];
await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
const stat = await lstat(directory), resolved = await realpath(directory), cwd = await realpath(process.cwd());
const outside = relative(cwd, resolved);
if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || !(outside === ".." || outside.startsWith("../"))) throw new Error("Output must be a private operator-owned directory outside this checkout.");
const file = await open(join(resolved, "setup-code.txt"), "wx", 0o600);
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const token = await issueBootstrap(sql, { organizationId: base.organizationId, name: values.name, slug: values.slug, email: values.email });
  await file.writeFile(token, "utf8"); await file.sync();
  const link = await open(join(resolved, "setup-link.txt"), "wx", 0o600);
  try { await link.writeFile(`${base.origin}/setup#setup=${token}`, "utf8"); await link.sync(); } finally { await link.close(); }
  console.log(JSON.stringify({ issued: true, path: join(resolved, "setup-code.txt"), linkPath: join(resolved, "setup-link.txt"), expiresInSeconds: 1800, setupUrl: `${base.origin}/setup` }));
} catch { throw new Error("Setup issuance failed. No credential was printed; inspect operator configuration and private output state."); }
finally { await file.close(); await sql.end(); }
