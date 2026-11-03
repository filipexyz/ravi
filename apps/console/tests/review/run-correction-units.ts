/** Separate processes prevent module mocks leaking into unrelated acceptance. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = await mkdtemp(join(tmpdir(), "fleet-correction-units-"));
const files = ["tests/fleet/service.test.ts", "tests/fleet/vault.test.ts", "tests/fleet/sso-policy.test.ts",
  "tests/fleet/http-contract.test.ts", "tests/fleet/operational-template.test.ts", "tests/fleet/ssh.integration.test.ts",
  "tests/review/authorization-cost.test.ts", "tests/review/operation-digest.test.ts", "tests/review/sso-callback.test.ts",
  "src/server/console/bases/service-principal.test.ts", "src/server/console/authorization/engine.test.ts",
  "src/server/console/authorization/membership.test.ts", "src/server/mcp/console-tools.test.ts", "src/lib/auth/oidc.test.ts"];
const results = [];
for (const [index, file] of files.entries()) {
  const child = Bun.spawn([process.execPath, "test", file], { stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC",
      ...(process.env.FLEET_TEST_NODE_BIN ? { FLEET_TEST_NODE_BIN: process.env.FLEET_TEST_NODE_BIN } : {}) } });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await writeFile(join(root, `${index}.log`), out + err, { mode: 0o600 });
  const result = { file, code, counts: err.match(/\d+ (?:pass|fail|skip|expect\(\) calls)/g) ?? [] };
  results.push(result); console.log(JSON.stringify(result));
}
await writeFile(join(root, "summary.json"), JSON.stringify({ root, results }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ root, passed: results.every(result => result.code === 0) }));
if (results.some(result => result.code !== 0)) process.exitCode = 1;
