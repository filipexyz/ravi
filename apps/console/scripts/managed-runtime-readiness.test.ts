import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  assertEvidenceSafe,
  digest,
  projectVm,
  safeFailureCode,
} from "./managed-runtime-readiness";

describe("managed runtime readiness evidence", () => {
  test("accepts bounded operational evidence", () => {
    expect(() =>
      assertEvidenceSafe({
        instanceId: "62c491ef-1e0f-42a8-9f20-c719dcb3a84a",
        state: "ready",
        count: 1,
        digest: digest("opaque-value"),
      }),
    ).not.toThrow();
  });

  test.each([
    { controllerToken: "opaque" },
    { value: "Bearer should-never-appear" },
    { value: "rctx_should-never-appear" },
    { value: "10.8.0.2" },
    { value: "/var/lib/private-state" },
  ])("rejects sensitive evidence %#", (value) => {
    expect(() => assertEvidenceSafe(value)).toThrow(
      /^managed_runtime_evidence_sensitive_/,
    );
  });

  test("projects Deck state without private endpoint or jail identifiers", () => {
    const projection = projectVm({
      id: "vm_01",
      instanceRef: "managed-instance",
      controlEndpoint: "http://10.0.0.2:4010",
      jailId: "private-jail-id",
      generation: 2,
      imageDigest: `sha256:${"a".repeat(64)}`,
      state: "running",
      replacedVmId: "vm_00",
      restoredFromBackupRef: `mbk_${"b".repeat(32)}`,
      facts: {
        processAlive: true,
        firecrackerPid: 1234,
        stateMounted: true,
      },
    });

    expect(projection).toMatchObject({
      id: "vm_01",
      generation: 2,
      replacedVmId: "vm_00",
      facts: { processAlive: true, stateMounted: true },
    });
    expect(JSON.stringify(projection)).not.toContain("10.0.0.2");
    expect(JSON.stringify(projection)).not.toContain("private-jail-id");
  });

  test("normalizes unexpected failures to a safe code", () => {
    expect(safeFailureCode(new Error("provider body"))).toBe(
      "managed_runtime_readiness_unexpected",
    );
  });

  test("uses canonical Ravi Control chat routes instead of legacy command writes", async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, "managed-runtime-readiness.ts"),
    ).text();

    expect(source).toContain("/ravi-control/instances");
    expect(source).toContain("/chat/messages");
    expect(source).toContain("/chat/sync");
    expect(source).toContain("/chat/interrupt");
    expect(source).not.toContain("/sessions/current/commands");
    expect(source).not.toContain('"prompt_send"');
  });
});
