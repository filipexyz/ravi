import { afterEach, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeliveryBootDeclaration,
  type DeliveryBootExpectation,
  DeliveryProcessObservationError,
  deliveryBootPath,
  observeDeliveryProcess,
  readVerifiedDeliveryBoot,
} from "./delivery-boot.js";

const directories: string[] = [];
const children: Subprocess<"ignore", "pipe", "pipe">[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startBoot(
  entrypoint: "absolute" | "relative" | "alias" = "absolute",
  separateCwd = false,
): Promise<{
  stateDir: string;
  child: Subprocess<"ignore", "pipe", "pipe">;
  expected: DeliveryBootExpectation;
  declaration: DeliveryBootDeclaration;
}> {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-delivery-boot-")));
  directories.push(stateDir);
  const bundlePath = join(stateDir, "consumer.ts");
  const bootId = randomUUID();
  const source = `
import { publishDeliveryBoot } from ${JSON.stringify(join(import.meta.dir, "delivery-boot.ts"))};
const input = {stateDir:process.argv[2],processName:"test-consumer",bootId:process.argv[3],
 bundlePath:import.meta.path,stateIdentity:"test-state",consumerDomain:"test-domain"};
const boot = publishDeliveryBoot(input);
publishDeliveryBoot(input);
console.log(JSON.stringify(boot));
setInterval(() => {}, 1000);
`;
  writeFileSync(bundlePath, source);
  if (entrypoint === "alias") symlinkSync(bundlePath, join(stateDir, "consumer-alias.ts"));
  const bundleSha256 = createHash("sha256").update(source).digest("hex");
  const consumerCwd = separateCwd ? mkdtempSync(join(stateDir, "empty-cwd-")) : stateDir;
  const child = spawn({
    cmd: [
      process.execPath,
      entrypoint === "relative" ? "./consumer.ts" : entrypoint === "alias" ? "./consumer-alias.ts" : bundlePath,
      stateDir,
      bootId,
    ],
    cwd: consumerCwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", RAVI_STATE_DIR: stateDir },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const line = await Promise.race([
    (async () => {
      let text = "";
      while (!text.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Consumer exited before boot: ${await new Response(child.stderr).text()}`);
        text += new TextDecoder().decode(chunk.value);
      }
      return text.slice(0, text.indexOf("\n"));
    })(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Consumer boot timed out")), 5000);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    reader.releaseLock();
  });
  const observed = observeDeliveryProcess(child.pid);
  if (!observed) throw new Error("Real child process identity was not observable");
  // Independent launcher expectations: identity comes from the kernel, not child's declaration.
  const expected: DeliveryBootExpectation = {
    ...observed,
    processName: "test-consumer",
    bootId,
    bundlePath,
    bundleSha256,
    stateIdentity: "test-state",
    consumerDomain: "test-domain",
  };
  return { stateDir, child, expected, declaration: JSON.parse(line) as DeliveryBootDeclaration };
}

describe("delivery boot oracle (real processes)", () => {
  test("observes PID, kernel start, exact argv and bundle; declaration is private and immutable", async () => {
    const { stateDir, expected, declaration } = await startBoot();
    const result = readVerifiedDeliveryBoot({ stateDir, expected });
    expect(result.relation).toBe("known");
    expect(declaration.pid).toBe(expected.pid);
    expect(declaration.processStartToken).toBe(expected.processStartToken);
    expect(declaration.argv).toEqual(expected.argv);
    expect(declaration.bundleSha256).toBe(expected.bundleSha256);
    expect(declaration.deliveryProtocolVersions).toEqual([2]);
    const path = deliveryBootPath(stateDir, expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir, "runtime-processes", "delivery")).mode & 0o777).toBe(0o700);
    expect(statSync(path).nlink).toBe(1);
  });

  test("an orphaned boot file is unknown even when the declaration is valid", async () => {
    const { stateDir, child, expected } = await startBoot();
    child.kill();
    await child.exited;
    expect(readFileSync(deliveryBootPath(stateDir, expected), "utf8")).toContain(expected.bootId);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("unknown");
  });

  test("a consumer launched with a relative script from another cwd has a verified boot", async () => {
    const { stateDir, expected, declaration } = await startBoot("relative");
    expect(stateDir).not.toBe(realpathSync(process.cwd()));
    expect(expected.argv[1]).toBe("./consumer.ts");
    expect(expected.cwd).toBe(stateDir);
    expect(declaration.cwd).toBe(stateDir);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("known");
  });

  test("relative and absolute script arguments resolving to the same bundle are equivalent", async () => {
    const { stateDir, expected } = await startBoot("relative");
    const argv = [...expected.argv];
    argv[1] = expected.bundlePath;
    expect(readVerifiedDeliveryBoot({ stateDir, expected: { ...expected, argv } }).relation).toBe("known");
  });

  test("an observed script symlink is canonicalized before comparison with the bundle", async () => {
    const { stateDir, expected } = await startBoot("alias");
    expect(expected.argv[1]).toBe("./consumer-alias.ts");
    const argv = [...expected.argv];
    argv[1] = expected.bundlePath;
    expect(readVerifiedDeliveryBoot({ stateDir, expected: { ...expected, argv } }).relation).toBe("known");
  });

  test("a live script that really differs from the expected bundle is unsupported", async () => {
    const { stateDir, expected } = await startBoot("relative");
    const differentBundle = join(stateDir, "different-consumer.ts");
    // Equal bytes do not make a different script path the expected entrypoint.
    writeFileSync(differentBundle, readFileSync(expected.bundlePath));
    expect(readVerifiedDeliveryBoot({ stateDir, expected: { ...expected, bundlePath: differentBundle } })).toEqual({
      relation: "unsupported",
      reason: "entrypoint_bundle_mismatch",
    });
  });

  test("a script that cannot be resolved raises an explicit observer error with its cause", async () => {
    const { stateDir, expected } = await startBoot("relative");
    rmSync(expected.bundlePath);
    expect(observeDeliveryProcess(expected.pid)).not.toBeNull();
    let failure: unknown;
    try {
      readVerifiedDeliveryBoot({ stateDir, expected });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeliveryProcessObservationError);
    expect(failure).toMatchObject({ code: "ENTRYPOINT_RESOLUTION_FAILED", cause: { code: "ENOENT" } });
  });

  test("removing a live consumer cwd raises an explicit observation error through the boot reader", async () => {
    const { stateDir, child, expected } = await startBoot("absolute", true);
    expect(expected.cwd).not.toBe(stateDir);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("known");
    // Only remove the fixture's empty cwd, preserving its absolute entrypoint and declaration.
    rmdirSync(expected.cwd);
    expect(child.exitCode).toBeNull();
    for (const observe of [
      () => observeDeliveryProcess(expected.pid),
      () => readVerifiedDeliveryBoot({ stateDir, expected }),
    ]) {
      let failure: unknown;
      try {
        observe();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DeliveryProcessObservationError);
      expect(failure).toMatchObject({ code: "PROCESS_CWD_UNAVAILABLE" });
      expect((failure as Error).cause).toBeInstanceOf(Error);
    }
  });

  test("rejects stale start identity, different argv and scope", async () => {
    const { stateDir, expected } = await startBoot();
    for (const mismatch of [
      { processStartToken: `${expected.processStartToken}:old` },
      { argv: [...expected.argv, "unexpected"] },
      { stateIdentity: "another-state" },
      { consumerDomain: "another-domain" },
    ]) {
      expect(readVerifiedDeliveryBoot({ stateDir, expected: { ...expected, ...mismatch } }).relation).toBe("unknown");
    }
  });

  test("a mismatching bundle digest is unsupported", async () => {
    const { stateDir, expected } = await startBoot();
    expect(readVerifiedDeliveryBoot({ stateDir, expected: { ...expected, bundleSha256: "0".repeat(64) } })).toEqual({
      relation: "unsupported",
      reason: "bundle_digest_mismatch",
    });
  });

  test("a replaced bundle is unsupported, not silently identified by its new bytes", async () => {
    const { stateDir, expected } = await startBoot();
    writeFileSync(expected.bundlePath, `${readFileSync(expected.bundlePath, "utf8")}\n// replaced after boot\n`);
    expect(readVerifiedDeliveryBoot({ stateDir, expected })).toEqual({
      relation: "unsupported",
      reason: "bundle_digest_mismatch",
    });
  });

  test("missing or malformed evidence cannot fall back to process health", async () => {
    const { stateDir, expected } = await startBoot();
    const path = deliveryBootPath(stateDir, expected);
    writeFileSync(path, "{broken");
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("unknown");
    rmSync(path);
    expect(observeDeliveryProcess(expected.pid)).not.toBeNull();
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("unknown");
  });

  test("unsafe boot addresses and non-process identities fail closed", () => {
    expect(() => deliveryBootPath("/tmp", { processName: "../escape", pid: 1, bootId: "boot" })).toThrow();
    expect(observeDeliveryProcess(-1)).toBeNull();
    expect(observeDeliveryProcess(2147483647)).toBeNull();
  });
});
