import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DELIVERY_CAPABILITIES, type DeliveryCapabilities, isDeliveryCapabilities } from "./delivery-protocol.js";
import { observeDeliveryProcess } from "./delivery-process.js";

export { observeDeliveryProcess } from "./delivery-process.js";

/** The controller obtains these expectations from its launch inventory, not directory discovery. */
export type DeliveryBootExpectation = Readonly<{
  processName: string;
  pid: number;
  bootId: string;
  processStartToken: string;
  executablePath: string;
  argv: readonly string[];
  bundlePath: string;
  bundleSha256: string;
  stateIdentity: string;
  consumerDomain: string;
}>;

export type DeliveryBootDeclaration = DeliveryBootExpectation &
  DeliveryCapabilities & { readonly bootFormatVersion: 1 };

export type DeliveryBootReadResult =
  | { relation: "known"; boot: DeliveryBootDeclaration }
  | { relation: "unknown"; reason: string };

type BootAddress = Pick<DeliveryBootExpectation, "processName" | "pid" | "bootId">;

function validAddress(address: BootAddress): boolean {
  return (
    typeof address.processName === "string" &&
    typeof address.bootId === "string" &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(address.processName) &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(address.bootId) &&
    Number.isSafeInteger(address.pid) &&
    address.pid > 0
  );
}

export function deliveryBootPath(stateDir: string, address: BootAddress): string {
  if (!validAddress(address)) throw new Error("Invalid delivery boot address");
  return join(
    resolve(stateDir),
    "runtime-processes",
    "delivery",
    `${address.processName}-${address.pid}-${address.bootId}.json`,
  );
}

function digestBundle(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validExpectation(value: DeliveryBootExpectation): boolean {
  return (
    validAddress(value) &&
    typeof value.processStartToken === "string" &&
    value.processStartToken.length > 0 &&
    typeof value.executablePath === "string" &&
    value.executablePath.startsWith("/") &&
    Array.isArray(value.argv) &&
    value.argv.length >= 2 &&
    value.argv.every((arg) => typeof arg === "string") &&
    typeof value.bundlePath === "string" &&
    value.bundlePath.startsWith("/") &&
    typeof value.bundleSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.bundleSha256) &&
    typeof value.stateIdentity === "string" &&
    value.stateIdentity.length > 0 &&
    typeof value.consumerDomain === "string" &&
    value.consumerDomain.length > 0
  );
}

function identityMatches(actual: DeliveryBootExpectation, expected: DeliveryBootExpectation): boolean {
  return (
    actual.processName === expected.processName &&
    actual.pid === expected.pid &&
    actual.bootId === expected.bootId &&
    actual.processStartToken === expected.processStartToken &&
    actual.executablePath === expected.executablePath &&
    JSON.stringify(actual.argv) === JSON.stringify(expected.argv) &&
    actual.bundlePath === expected.bundlePath &&
    actual.bundleSha256 === expected.bundleSha256 &&
    actual.stateIdentity === expected.stateIdentity &&
    actual.consumerDomain === expected.consumerDomain
  );
}

function observeExpectedProcess(expected: DeliveryBootExpectation): boolean {
  const observed = observeDeliveryProcess(expected.pid);
  if (
    !observed ||
    observed.processStartToken !== expected.processStartToken ||
    observed.executablePath !== expected.executablePath ||
    JSON.stringify(observed.argv) !== JSON.stringify(expected.argv)
  )
    return false;
  // Only direct Bun entrypoints are supported here. An ambiguous wrapper/flag layout is unknown.
  if (realpathSync(observed.argv[1] ?? "") !== expected.bundlePath) return false;
  return (
    realpathSync(expected.bundlePath) === expected.bundlePath &&
    digestBundle(expected.bundlePath) === expected.bundleSha256
  );
}

/** Self-only publisher. This module is not wired into production bootstrap by PR1. */
export function publishDeliveryBoot(input: {
  stateDir: string;
  processName: string;
  bootId: string;
  bundlePath: string;
  stateIdentity: string;
  consumerDomain: string;
}): DeliveryBootDeclaration {
  const observed = observeDeliveryProcess(process.pid);
  const bundlePath = realpathSync(input.bundlePath);
  if (
    !observed ||
    realpathSync(process.argv[1] ?? "") !== bundlePath ||
    realpathSync(observed.argv[1] ?? "") !== bundlePath
  ) {
    throw new Error("Delivery boot requires an observable direct process entrypoint");
  }
  const boot: DeliveryBootDeclaration = {
    bootFormatVersion: 1,
    ...observed,
    processName: input.processName,
    bootId: input.bootId,
    bundlePath,
    bundleSha256: digestBundle(bundlePath),
    stateIdentity: input.stateIdentity,
    consumerDomain: input.consumerDomain,
    ...DELIVERY_CAPABILITIES,
  };
  if (!validExpectation(boot) || !observeExpectedProcess(boot)) throw new Error("Delivery boot identity changed");
  const stateDir = realpathSync(input.stateDir);
  let directory = stateDir;
  for (const component of ["runtime-processes", "delivery"]) {
    directory = join(directory, component);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) {
      throw new Error("Delivery boot directory must not alias another state");
    }
  }
  const path = deliveryBootPath(stateDir, boot);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const body = JSON.stringify(boot);
  try {
    writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    // Atomic no-replace publication: a boot declaration is immutable, even on retry.
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(path, "utf8") !== body) throw error;
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* No temporary file after a failed create. */
    }
  }
  return boot;
}

export function readVerifiedDeliveryBoot(input: {
  stateDir: string;
  expected: DeliveryBootExpectation;
}): DeliveryBootReadResult {
  try {
    if (!validExpectation(input.expected)) return { relation: "unknown", reason: "invalid_expected_boot" };
    if (!observeExpectedProcess(input.expected)) return { relation: "unknown", reason: "process_identity_unverified" };
    const stateDir = realpathSync(input.stateDir);
    const path = deliveryBootPath(stateDir, input.expected);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || realpathSync(path) !== path) {
      return { relation: "unknown", reason: "invalid_boot_file" };
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { relation: "unknown", reason: "invalid_boot_declaration" };
    const boot = value as DeliveryBootDeclaration;
    if (boot.bootFormatVersion !== 1 || !validExpectation(boot) || !isDeliveryCapabilities(boot)) {
      return { relation: "unknown", reason: "invalid_boot_declaration" };
    }
    if (!identityMatches(boot, input.expected) || !observeExpectedProcess(input.expected)) {
      return { relation: "unknown", reason: "boot_identity_mismatch" };
    }
    return { relation: "known", boot };
  } catch {
    // An orphan, inaccessible process/file or malformed declaration is never a health fallback.
    return { relation: "unknown", reason: "boot_evidence_unavailable" };
  }
}
