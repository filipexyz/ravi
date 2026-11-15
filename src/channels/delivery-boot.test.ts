import { afterEach, describe, expect, test } from "bun:test";
import { type Subprocess, spawn } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function startBoot(): Promise<{
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
  const bundleSha256 = createHash("sha256").update(source).digest("hex");
  const child = spawn({
    cmd: [process.execPath, bundlePath, stateDir, bootId],
    cwd: stateDir,
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

  test("rejects stale start identity, different argv and bundle digest", async () => {
    const { stateDir, expected } = await startBoot();
    for (const mismatch of [
      { processStartToken: `${expected.processStartToken}:old` },
      { argv: [...expected.argv, "unexpected"] },
      { bundleSha256: "0".repeat(64) },
      { stateIdentity: "another-state" },
      { consumerDomain: "another-domain" },
    ]) {
      expect(readVerifiedDeliveryBoot({ stateDir, expected: { ...expected, ...mismatch } }).relation).toBe("unknown");
    }
  });

  test("a replaced bundle is unknown, not silently identified by its new bytes", async () => {
    const { stateDir, expected } = await startBoot();
    writeFileSync(expected.bundlePath, `${readFileSync(expected.bundlePath, "utf8")}\n// replaced after boot\n`);
    expect(readVerifiedDeliveryBoot({ stateDir, expected }).relation).toBe("unknown");
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
