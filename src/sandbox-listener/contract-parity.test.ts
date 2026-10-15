// Parity guard for the shared contract constants. Every
// `// shared-constants:begin` … `// shared-constants:end` block in
// `contract.ts` is the daemon's byte-equal copy of Console's
// `src/shared/sandbox/contract.ts`; their concatenation is hashed and the
// hash is recorded in `.ravi/specs/sandbox/grant-verify/CHECKS.md`. A change
// to any constant therefore has to touch CHECKS.md in the same pull request,
// after the Console side changed (RUNBOOK §Before Editing).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTRACT_PATH = join(import.meta.dir, "contract.ts");
const CHECKS_PATH = join(import.meta.dir, "..", "..", ".ravi", "specs", "sandbox", "grant-verify", "CHECKS.md");
const BEGIN = "// shared-constants:begin";
const END = "// shared-constants:end";

export function sharedConstantsBlocks(source: string): string[] {
  const lines = source.split("\n");
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.trim() === BEGIN) {
      if (current) throw new Error("nested shared-constants:begin");
      current = [];
    } else if (line.trim() === END) {
      if (!current) throw new Error("shared-constants:end without begin");
      blocks.push(current.join("\n"));
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) throw new Error("unterminated shared-constants block");
  return blocks;
}

export function sharedConstantsHash(source: string): string {
  const blocks = sharedConstantsBlocks(source);
  if (blocks.length === 0) throw new Error("contract.ts has no shared-constants block");
  return createHash("sha256").update(blocks.join("\n")).digest("hex");
}

describe("contract.ts shared constants", () => {
  test("hash equals the value recorded in CHECKS.md (bump both in lockstep with Console)", () => {
    const actual = sharedConstantsHash(readFileSync(CONTRACT_PATH, "utf8"));
    const checks = readFileSync(CHECKS_PATH, "utf8");
    const recorded = /shared-constants sha256:\s*`([0-9a-f]{64})`/.exec(checks)?.[1];
    expect(recorded).toBeDefined();
    expect(actual).toBe(recorded as string);
  });

  test("the blocks cover every constant that mirrors Console", () => {
    const blocks = sharedConstantsBlocks(readFileSync(CONTRACT_PATH, "utf8")).join("\n");
    for (const name of [
      "SANDBOX_GRANT_ALG",
      "SANDBOX_GRANT_TYP",
      "SANDBOX_GRANT_KID_RE",
      "SANDBOX_GATE_KID_RE",
      "SANDBOX_GATE_JWKS_PATH",
      "SANDBOX_GATE_ISSUER",
      "SANDBOX_GATE_ASSERTION_MAX_LIFETIME_SECONDS",
      "SANDBOX_GRANT_MAX_LIFETIME_SECONDS",
      "SANDBOX_GRANT_CLOCK_SKEW_SECONDS",
      "SANDBOX_RUN_ID_RE",
      "SANDBOX_GRANT_JTI_RE",
      "SANDBOX_COMMAND_ID_RE",
      "SANDBOX_COMMAND_ALLOWLIST",
      "SANDBOX_CAP_RE",
    ]) {
      expect(blocks).toContain(`export const ${name} `);
    }
  });
});
