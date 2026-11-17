/** One bounded scenario per fresh child; the outer runner checks fatal guard outcomes separately. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { probe as Probe } from "./retained-preload-contract.bootstrap.js";
import { runRetainedSqliteScenario } from "./retained-preload-sqlite-cases.js";

const scenario = process.env.RETAINED_GUARD_SCENARIO;
if (!scenario) throw new Error("Run this fixture through test:retained-preload; direct discovery is not validation");
const probe = (globalThis as typeof globalThis & { __retainedContractProbe: typeof Probe }).__retainedContractProbe;
if (!probe) throw new Error("Independent synthetic bootstrap is required");

test(`retained guard contract: ${scenario}`, async () => {
  const { Database } = await import("bun:sqlite");
  const control = new Database(":memory:");
  control.exec("CREATE TABLE probe_control(value TEXT); INSERT INTO probe_control VALUES ('present')");
  let observation: unknown;
  if (scenario === "root-alias" || scenario === "root-lexical") {
    const fs = await import("node:fs");
    const target = `${scenario === "root-alias" ? probe.resolvedPrivateRoot : probe.privateRoot}/synthetic.txt`;
    expect(() => fs.readFileSync(target, "utf8")).toThrow("TEST_RETAINED_FILE_ACCESS_BLOCKED");
    expect(probe.calls).toEqual([]);
  } else if (scenario.startsWith("link-")) {
    const fs = await import("node:fs");
    const target = `${probe.state}/virtual-linked.txt`;
    if (scenario === "link-sync") {
      expect(() => fs.linkSync(probe.outside, target)).toThrow("TEST_RETAINED_FILE_ACCESS_BLOCKED");
    } else if (scenario === "link-callback") {
      expect(() => fs.link(probe.outside, target, () => {})).toThrow("TEST_RETAINED_FILE_ACCESS_BLOCKED");
    } else if (scenario === "link-promises") {
      const promises = await import("node:fs/promises");
      await expect(Promise.resolve().then(() => promises.link(probe.outside, target))).rejects.toThrow(
        "TEST_RETAINED_FILE_ACCESS_BLOCKED",
      );
    } else if (scenario === "link-inside") {
      fs.linkSync(`${probe.state}/synthetic-source`, target);
      expect(probe.calls).toEqual([{ operation: "linkSync", path: `${probe.state}/synthetic-source` }]);
    } else throw new Error(`Unknown link scenario ${scenario}`);
    if (scenario !== "link-inside") expect(probe.calls).toEqual([]);
  } else if (scenario === "account-identity") {
    const { resolveAccountHome } = await import("../utils/account-home.js");
    const processes = await import("node:child_process");
    // biome-ignore lint/style/useNodejsImportProtocol: the bare builtin alias must retain the same process guard.
    const bare = await import("child_process");
    const uid = process.getuid!();
    const darwin = process.platform === "darwin";
    const command = darwin ? "/usr/bin/dscacheutil" : "/usr/bin/getent";
    const args = darwin ? ["-q", "user", "-a", "uid", String(uid)] : ["passwd", String(uid)];
    expect(resolveAccountHome()).toBe(join(probe.state, "home"));
    expect(bare.spawnSync(command, args, { encoding: "utf8" }).status).toBe(0);
    expect(() => processes.spawnSync("/__ravi_synthetic_never_exists__", [])).toThrow(
      "TEST_NETWORK_OR_PROCESS_BLOCKED",
    );
    expect(() => processes.spawnSync(command, [...args, "extra"], { encoding: "utf8" })).toThrow(
      "TEST_NETWORK_OR_PROCESS_BLOCKED",
    );
    expect(() => processes.spawnSync(command, args)).toThrow("TEST_NETWORK_OR_PROCESS_BLOCKED");
    expect(() =>
      processes.default.spawnSync(command, [...args.slice(0, -1), String(uid + 1)], { encoding: "utf8" }),
    ).toThrow("TEST_NETWORK_OR_PROCESS_BLOCKED");
    expect(() => processes.spawn(command, args)).toThrow("TEST_NETWORK_OR_PROCESS_BLOCKED");
  } else if (scenario.startsWith("dns-")) {
    const dns = await import("node:dns");
    // biome-ignore lint/style/useNodejsImportProtocol: the bare builtin alias is the regression surface.
    const bare = await import("dns");
    const promises = await import("node:dns/promises");
    // biome-ignore lint/style/useNodejsImportProtocol: the bare promises alias must be guarded too.
    const barePromises = await import("dns/promises");
    const candidates: Record<string, () => unknown> = {
      "dns-nested": () => dns.promises.lookup("SYNTHETIC_ARGUMENT_NEVER_RESOLVED"),
      "dns-default": () => dns.default.promises.resolve("SYNTHETIC_ARGUMENT_NEVER_RESOLVED"),
      "dns-bare": () => bare.promises.resolve4("SYNTHETIC_ARGUMENT_NEVER_RESOLVED"),
      "dns-standalone": () => promises.lookup("SYNTHETIC_ARGUMENT_NEVER_RESOLVED"),
      "dns-bare-standalone": () => barePromises.resolve6("SYNTHETIC_ARGUMENT_NEVER_RESOLVED"),
      "dns-top": () => dns.lookup("SYNTHETIC_ARGUMENT_NEVER_RESOLVED", () => {}),
    };
    const operation = candidates[scenario];
    if (!operation) throw new Error(`Unknown DNS scenario ${scenario}`);
    await expect(Promise.resolve().then(operation)).rejects.toThrow("TEST_NETWORK_OR_PROCESS_BLOCKED");
    expect(probe.dns.calls).toEqual([]);
  } else {
    if (scenario === "policy-contract") {
      (await import("./retained-preload-policy-cases.js")).verifyRetainedRootPolicy();
    } else observation = await runRetainedSqliteScenario(scenario);
  }
  console.log(
    "RETAINED_GUARD_CASE_OK",
    JSON.stringify({
      scenario,
      observation,
      calls: probe.calls,
      dnsCalls: probe.dns.calls,
      dnsNamespaceFallbacks: "namespaceFallbacks" in probe.dns ? probe.dns.namespaceFallbacks : [],
    }),
  );
});
