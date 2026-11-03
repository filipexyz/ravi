import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const network = join(import.meta.dir, "network.py");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Managed Ravi appliance network", () => {
  test("derives the host-side gateway from the Deck /30 guest address", () => {
    const result = invoke("print(module.derive_gateway('172.16.40.2/30'))");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("172.16.40.1");
  });

  test("rejects unsupported network prefixes", () => {
    const result = invoke("print(module.derive_gateway('172.16.40.2/24'))");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("network_prefix_unsupported");
  });

  test("writes a bounded resolver configuration without replacing an existing resolver", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-appliance-network-"));
    roots.push(root);
    const resolv = join(root, "resolv.conf");
    const source = [
      `path=pathlib.Path(${JSON.stringify(resolv)})`,
      "module.ensure_resolver(path, '1.1.1.1,9.9.9.9')",
      "module.ensure_resolver(path, '8.8.8.8')",
    ].join("\n");

    const result = invoke(source);

    expect(result.exitCode).toBe(0);
    expect(readFileSync(resolv, "utf8")).toBe(
      "nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n",
    );
  });
});

function invoke(source: string) {
  const script = [
    "import importlib.util, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('network', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    source,
  ].join("\n");
  const result = Bun.spawnSync(["python3", "-c", script, network]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
