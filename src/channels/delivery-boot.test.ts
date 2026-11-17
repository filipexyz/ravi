import { afterEach, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
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
import { basename, join, resolve } from "node:path";
import {
  type DeliveryBootDeclaration,
  type DeliveryBootExpectation,
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
  consumerCwd: string;
  child: Subprocess<"ignore", "pipe", "pipe">;
  expected: DeliveryBootExpectation;
  declaration: DeliveryBootDeclaration;
}> {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ravi-delivery-boot-")));
  directories.push(stateDir);
  const bootId = randomUUID();
  const bundlePath = join(stateDir, `consumer-${bootId}.ts`);
  const aliasPath = join(stateDir, `consumer-alias-${bootId}.ts`);
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
  if (entrypoint === "alias") symlinkSync(bundlePath, aliasPath);
  const bundleSha256 = createHash("sha256").update(source).digest("hex");
  const consumerCwd = separateCwd ? mkdtempSync(join(stateDir, "empty-cwd-")) : stateDir;
  const child = spawn({
    cmd: [
      process.execPath,
      entrypoint === "relative"
        ? `./${basename(bundlePath)}`
        : entrypoint === "alias"
          ? `./${basename(aliasPath)}`
          : bundlePath,
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
    argv1Raw: observed.argv[1]!,
    processName: "test-consumer",
    bootId,
    bundlePath,
    bundleSha256,
    stateIdentity: "test-state",
    consumerDomain: "test-domain",
  };
  return { stateDir, consumerCwd, child, expected, declaration: JSON.parse(line) as DeliveryBootDeclaration };
}

describe("delivery boot oracle (real processes)", () => {
  test("observes PID, kernel start, exact argv and bundle; declaration is private and immutable", async () => {
    const { stateDir, expected, declaration } = await startBoot();
    const result = readVerifiedDeliveryBoot({ stateDir, expected });
    expect(result.relation).toBe("known");
    expect(declaration.pid).toBe(expected.pid);
    expect(declaration.processStartToken).toBe(expected.processStartToken);
    expect(declaration.argv).toEqual(expected.argv);
    expect(declaration.argv1Raw).toBe(expected.argv[1]!);
    expect(declaration.bundlePath).toBe(realpathSync(expected.bundlePath));
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
    expect(expected.argv[1]).toBe(`./${basename(expected.bundlePath)}`);
    expect(expected.argv1Raw).toBe(expected.argv[1]!);
    expect(declaration.argv1Raw).toBe(expected.argv1Raw);
    // The raw path intentionally cannot be resolved in the controller's cwd.
    expect(existsSync(resolve(expected.argv1Raw))).toBe(false);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("known");
  });

  test("a different raw entrypoint is rejected even when it resolves to the same bundle", async () => {
    const { stateDir, expected } = await startBoot("relative");
    const argv = [...expected.argv];
    argv[1] = expected.bundlePath;
    expect(
      readVerifiedDeliveryBoot({ stateDir, expected: { ...expected, argv, argv1Raw: expected.bundlePath } }).relation,
    ).toBe("unsupported");
  });

  test("publisher binds the raw script symlink to the absolute canonical bundle", async () => {
    const { stateDir, expected, declaration } = await startBoot("alias");
    expect(expected.argv1Raw).toStartWith("./consumer-alias-");
    expect(declaration.argv1Raw).toBe(expected.argv1Raw);
    expect(declaration.bundlePath).toBe(expected.bundlePath);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("known");
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

  test("an argv[1] file that no longer exists returns unknown with an explicit error and never throws", async () => {
    const { stateDir, expected } = await startBoot("absolute");
    expect(expected.argv1Raw).toBe(expected.bundlePath);
    rmSync(expected.bundlePath);
    expect(existsSync(expected.argv1Raw)).toBe(false);
    expect(observeDeliveryProcess(expected.pid)).not.toBeNull();
    expect(() => readVerifiedDeliveryBoot({ stateDir, expected })).not.toThrow();
    expect(readVerifiedDeliveryBoot({ stateDir, expected })).toMatchObject({
      relation: "unknown",
      error: { code: "DELIVERY_BOOT_OBSERVATION_FAILED", cause: { code: "ENOENT" } },
    });
  });

  test("removing an empty consumer cwd does not invalidate a boot with its absolute bundle intact", async () => {
    const { stateDir, consumerCwd, child, expected } = await startBoot("absolute", true);
    expect(consumerCwd).not.toBe(stateDir);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("known");
    // Only remove the fixture's empty cwd, preserving its absolute entrypoint and declaration.
    rmdirSync(consumerCwd);
    expect(child.exitCode).toBeNull();
    expect(observeDeliveryProcess(expected.pid)?.argv).toEqual(expected.argv);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("known");
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

  test("a bundle replaced after boot by a symlink to another existing script is unsupported", async () => {
    const { stateDir, expected } = await startBoot();
    const differentBundle = join(stateDir, "different-bundle.ts");
    writeFileSync(differentBundle, readFileSync(expected.bundlePath));
    rmSync(expected.bundlePath);
    symlinkSync(differentBundle, expected.bundlePath);
    expect(readVerifiedDeliveryBoot({ stateDir, expected })).toEqual({
      relation: "unsupported",
      reason: "entrypoint_bundle_mismatch",
    });
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
