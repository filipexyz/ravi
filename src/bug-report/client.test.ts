import { describe, expect, it } from "bun:test";
import { asUuid, toConsoleBugCreateBody } from "./client.js";
import { BUG_REPORT_SCHEMA_ID, type BugReportDossier } from "./schema.js";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_UUID = "22222222-2222-4222-8222-222222222222";

const dossier: BugReportDossier = {
  schemaVersion: BUG_REPORT_SCHEMA_ID,
  title: "Crash on report",
  summary: "Submit fails without payload.",
  severity: "high",
  surface: "cli",
  context: {
    organizationRef: "acme",
    projectRef: "rbbt",
    sessionHints: "agent:main:main",
  },
  evidence: { notes: ["slug refs must stay inside payload"] },
};

describe("toConsoleBugCreateBody", () => {
  it("maps the dossier onto createBodySchema and keeps the full dossier in payload", () => {
    const body = toConsoleBugCreateBody(dossier, "cli");
    expect(body).toEqual({
      schemaVersion: BUG_REPORT_SCHEMA_ID,
      title: dossier.title,
      summary: dossier.summary,
      severity: "high",
      surface: "cli",
      payload: { ...dossier, source: "cli" },
    });
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("organizationId");
    expect(body).not.toHaveProperty("projectId");
    expect(body).not.toHaveProperty("reproduction");
    expect(body).not.toHaveProperty("context");
  });

  it("omits blank surface and defaults source inside payload", () => {
    const body = toConsoleBugCreateBody({ ...dossier, surface: "   " });
    expect(body).not.toHaveProperty("surface");
    expect((body.payload as { source?: string }).source).toBe("cli");
  });

  it("promotes UUID organization/project refs and omits slugs", () => {
    const body = toConsoleBugCreateBody({
      ...dossier,
      context: {
        organizationRef: ORG_UUID,
        projectRef: PROJECT_UUID,
      },
    });
    expect(body.organizationId).toBe(ORG_UUID);
    expect(body.projectId).toBe(PROJECT_UUID);
    expect((body.payload as BugReportDossier).context).toEqual({
      organizationRef: ORG_UUID,
      projectRef: PROJECT_UUID,
    });
  });
});

describe("asUuid", () => {
  it("accepts RFC UUID strings and rejects slugs", () => {
    expect(asUuid(ORG_UUID)).toBe(ORG_UUID);
    expect(asUuid(` ${ORG_UUID.toUpperCase()} `)).toBe(ORG_UUID);
    expect(asUuid("acme")).toBeUndefined();
    expect(asUuid("org_1")).toBeUndefined();
    expect(asUuid(undefined)).toBeUndefined();
  });
});
