import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseBugReportCreateBody,
  parseBugTriageV1,
  sanitizeJsonRecord,
} from "../src/server/console/bug-reports";
import {
  assertSecretsRedacted,
  BugHarnessError,
  createSkipReason,
  fixtureFileName,
  helpPayload,
  parseHarnessArgs,
  publicReportFields,
  resolveCreateAuth,
  resolveCreateFixtureName,
  resolveFixturePath,
} from "./bug-harness";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "bug-reports");

function readFixture(name: string) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown;
}

describe("bug harness fixtures", () => {
  test("minimal and duplicate are valid create bodies with harness/e2e markers", () => {
    for (const name of ["minimal.json", "duplicate.json"] as const) {
      const parsed = parseBugReportCreateBody(readFixture(name));
      expect(parsed.surface).toBe("harness");
      expect(parsed.payload.tag).toBe("e2e");
      expect(parsed.payload.note).toBe("e2e");
    }
  });

  test("with-secrets redacts secret-like fields and inline tokens", () => {
    const raw = readFixture("with-secrets.json") as { payload: Record<string, unknown> };
    expect(raw.payload.tag).toBe("e2e");
    const parsed = parseBugReportCreateBody(raw);
    expect(parsed.surface).toBe("harness");
    const sanitized = sanitizeJsonRecord(raw.payload);
    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.token).toBe("[REDACTED]");
    expect(String(sanitized.steps)).toContain("sk-[REDACTED]");
    expect(JSON.stringify(sanitized)).not.toContain("super-secret-value");
  });

  test("triage-sample is a valid ravi.bug_triage/v1 document", () => {
    const parsed = parseBugTriageV1(readFixture("triage-sample.json"));
    expect(parsed.schemaVersion).toBe("ravi.bug_triage/v1");
    expect(parsed.suggestedPriority).toBe("p2");
    expect(parsed.surfaceNormalized).toBe("harness");
    expect(parsed.similarBugIds).toEqual([]);
  });
});

describe("bug harness args", () => {
  test("defaults to smoke and parses --json plus valued flags", () => {
    expect(parseHarnessArgs([]).command).toBe("smoke");
    const parsed = parseHarnessArgs([
      "status",
      "--id",
      "11111111-1111-4111-8111-111111111111",
      "--status",
      "triaging",
      "--json",
    ]);
    expect(parsed.command).toBe("status");
    expect(parsed.json).toBe(true);
    expect(parsed.options.get("id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.options.get("status")).toBe("triaging");
  });

  test("rejects unknown options and missing values", () => {
    expect(() => parseHarnessArgs(["get", "--nope"])).toThrow(BugHarnessError);
    expect(() => parseHarnessArgs(["get", "--id"])).toThrow(BugHarnessError);
  });

  test("parses delete --id", () => {
    const parsed = parseHarnessArgs(["delete", "--id", "11111111-1111-4111-8111-111111111111"]);
    expect(parsed.command).toBe("delete");
    expect(parsed.options.get("id")).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("resolves known create fixtures only", () => {
    expect(resolveCreateFixtureName(undefined)).toBe("minimal");
    expect(resolveCreateFixtureName("with-secrets.json")).toBe("with-secrets");
    expect(() => resolveCreateFixtureName("missing")).toThrow(BugHarnessError);
    expect(fixtureFileName("minimal")).toBe("minimal.json");
    expect(resolveFixturePath("minimal").endsWith("scripts/fixtures/bug-reports/minimal.json")).toBe(true);
  });
});

describe("bug harness public output", () => {
  test("publicReportFields keeps ids/urls and drops payload", () => {
    const fields = publicReportFields({
      status: "ok",
      result: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Harness smoke",
        status: "triaging",
        priority: "p2",
        consoleUrl: "https://console.ravi.bot/bugs/11111111-1111-4111-8111-111111111111",
        payload: { password: "super-secret-value", tag: "e2e" },
      },
    });
    expect(fields.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(fields.consoleUrl).toContain("/bugs/11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(fields)).not.toContain("super-secret-value");
    expect(JSON.stringify(fields)).not.toContain("password");
  });

  test("assertSecretsRedacted fails when fixture secrets survive", () => {
    expect(() =>
      assertSecretsRedacted({
        result: { payload: { password: "super-secret-value", token: "abcd1234secret" } },
      }),
    ).toThrow(BugHarnessError);
    expect(() =>
      assertSecretsRedacted({
        result: { payload: { password: "[REDACTED]", token: "[REDACTED]" } },
      }),
    ).not.toThrow();
  });

  test("help and skip reason never mention a live token value", () => {
    const help = JSON.stringify(helpPayload());
    expect(help).toContain("RAVI_ADMIN_TOKEN");
    expect(help).toContain("delete --id");
    expect(help).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    expect(createSkipReason()).toContain("--id");
    expect(createSkipReason()).not.toMatch(/Bearer\s+/);
  });

  test("resolveCreateAuth prefers env then credentials file", () => {
    expect(resolveCreateAuth({}, "/tmp/does-not-exist-ravi-home")).toBeNull();
    const fromEnv = resolveCreateAuth(
      { RAVI_CONSOLE_ACCESS_TOKEN: "  not-printed-in-tests  " },
      "/tmp/does-not-exist-ravi-home",
    );
    expect(fromEnv?.source).toBe("env");
    expect(fromEnv?.accessToken).toBe("not-printed-in-tests");
  });
});
