import { describe, expect, test } from "bun:test";

import {
  bugDossierHasContent,
  bugDossierHasKnownSections,
  projectBugDossierView,
  unwrapBugDossierRecord,
} from "./bug-dossier";

const v1Dossier = {
  schemaVersion: "ravi.bug_report/v1",
  title: "CLI inbox never updates",
  summary: "A CLI inbox poll returns 200 but no new items appear after a known watch event.",
  severity: "high",
  surface: "cli",
  reproduction: {
    steps: ["ravi login", "ravi inbox", "trigger a watch event", "poll again"],
    expected: "new inbox item for the watch event",
    actual: "empty inbox, HTTP 200",
    frequency: "always",
  },
  environment: {
    raviVersion: "0.9.2",
    os: "darwin 24.3",
    runtime: "bun 1.2.8",
    agentNames: ["main", "triage"],
  },
  evidence: {
    logs: ["watch armed", "poll returned 200 with items=[]"],
    notes: ["reproduced on a clean install"],
    redactions: ["Authorization", "cloud-auth token"],
  },
  context: {
    organizationRef: "filipexyz",
    projectRef: "rbbt",
    sessionHints: "agent:main:main",
  },
  sanitization: {
    rulesApplied: ["secret_keys", "bearer_tokens"],
  },
  source: "cli",
};

describe("bug dossier projection", () => {
  test("unwraps stored payload_json and maps known v1 sections", () => {
    const view = projectBugDossierView(
      {
        schemaVersion: "ravi.bug_report/v1",
        title: v1Dossier.title,
        summary: v1Dossier.summary,
        severity: "high",
        surface: "cli",
        organizationId: null,
        projectId: null,
        payload: v1Dossier,
      },
      { headerSummary: v1Dossier.summary },
    );

    expect(view.problem).toBeNull();
    expect(view.source).toBe("cli");
    expect(view.environment).toEqual([
      { key: "os", label: "OS", value: "darwin 24.3" },
      { key: "runtime", label: "Runtime", value: "bun 1.2.8" },
      { key: "raviVersion", label: "Ravi", value: "0.9.2" },
      { key: "agentNames.0", label: "Agent", value: "main" },
      { key: "agentNames.1", label: "Agent", value: "triage" },
    ]);
    expect(view.reproduction).toEqual({
      steps: ["ravi login", "ravi inbox", "trigger a watch event", "poll again"],
      expected: "new inbox item for the watch event",
      actual: "empty inbox, HTTP 200",
      frequency: "always",
    });
    expect(view.evidence).toEqual({
      logs: ["watch armed", "poll returned 200 with items=[]"],
      notes: ["reproduced on a clean install"],
      redactions: ["Authorization", "cloud-auth token"],
    });
    expect(view.context).toEqual({
      organizationRef: "filipexyz",
      projectRef: "rbbt",
      sessionHints: "agent:main:main",
    });
    expect(view.sanitization).toEqual(["secret_keys", "bearer_tokens"]);
    expect(view.extras).toEqual([]);
    expect(bugDossierHasKnownSections(view)).toBe(true);
  });

  test("hides empty objects, arrays, and blank strings", () => {
    const view = projectBugDossierView({
      reproduction: { steps: [], expected: "  ", actual: "", frequency: null },
      environment: {},
      evidence: { logs: [], notes: [], redactions: [] },
      context: { sessionHints: "" },
      sanitization: { rulesApplied: [] },
      extraEmpty: {},
      extraEmptyList: [],
    });

    expect(view.reproduction).toBeNull();
    expect(view.environment).toEqual([]);
    expect(view.evidence).toBeNull();
    expect(view.context).toBeNull();
    expect(view.sanitization).toEqual([]);
    expect(view.extras).toEqual([]);
    expect(bugDossierHasContent(view)).toBe(false);
  });

  test("maps harness-style flat fields into reproduction and evidence", () => {
    const view = projectBugDossierView({
      tag: "e2e",
      note: "e2e",
      steps: "1. ravi login 2. ravi inbox 3. trigger a watch event 4. poll again",
      expected: "new inbox item for the watch event",
      actual: "empty inbox, HTTP 200",
    });

    expect(view.tags).toEqual(["e2e"]);
    expect(view.evidence).toEqual({
      logs: [],
      notes: ["e2e"],
      redactions: [],
    });
    expect(view.reproduction).toEqual({
      steps: ["ravi login", "ravi inbox", "trigger a watch event", "poll again"],
      expected: "new inbox item for the watch event",
      actual: "empty inbox, HTTP 200",
      frequency: null,
    });
  });

  test("keeps leftover environment scalars as chips and objects as extras", () => {
    const view = projectBugDossierView({
      environment: {
        os: "linux",
        secret: "[REDACTED]",
        nested: { region: "iad" },
      },
    });

    expect(view.environment).toEqual([
      { key: "os", label: "OS", value: "linux" },
      { key: "secret", label: "Secret", value: "[REDACTED]" },
    ]);
    expect(view.extras).toEqual([
      {
        key: "environment.nested",
        label: "Environment · Nested",
        kind: "json",
        json: '{\n  "region": "iad"\n}',
      },
    ]);
  });

  test("sends unknown keys to extras and skips identity fields", () => {
    const view = projectBugDossierView(
      {
        schemaVersion: "ravi.bug_report/v1",
        title: "Identity should not render",
        summary: "Header summary",
        severity: "low",
        surface: "harness",
        customFlag: true,
        attachments: ["trace.log"],
      },
      { headerSummary: "Header summary" },
    );

    expect(view.problem).toBeNull();
    expect(view.extras).toEqual([
      { key: "customFlag", label: "Custom Flag", kind: "json", json: "true" },
      { key: "attachments", label: "Attachments", kind: "list", items: ["trace.log"] },
    ]);
    expect(bugDossierHasKnownSections(view)).toBe(false);
  });

  test("shows nested summary only when it differs from the header", () => {
    const same = projectBugDossierView(
      { summary: "Same writeup" },
      { headerSummary: "Same writeup" },
    );
    const richer = projectBugDossierView(
      { summary: "Longer dossier writeup with more detail." },
      { headerSummary: "Short header" },
    );
    const problemField = projectBugDossierView({ problem: "The worker drops the ack." });

    expect(same.problem).toBeNull();
    expect(richer.problem).toBe("Longer dossier writeup with more detail.");
    expect(problemField.problem).toBe("The worker drops the ack.");
  });

  test("preserves duplicate reproduction steps and log lines", () => {
    const view = projectBugDossierView({
      reproduction: { steps: ["retry", "retry"] },
      evidence: { logs: ["poll 200", "poll 200"] },
    });

    expect(view.reproduction?.steps).toEqual(["retry", "retry"]);
    expect(view.evidence?.logs).toEqual(["poll 200", "poll 200"]);
  });

  test("does not invent missing section fields", () => {
    const view = projectBugDossierView({
      reproduction: { steps: ["only this"] },
    });

    expect(view.reproduction).toEqual({
      steps: ["only this"],
      expected: null,
      actual: null,
      frequency: null,
    });
    expect(view.environment).toEqual([]);
    expect(view.evidence).toBeNull();
    expect(view.context).toBeNull();
    expect(view.sanitization).toEqual([]);
    expect(view.source).toBeNull();
  });

  test("unwraps only stored wrappers, not arbitrary payload objects", () => {
    expect(
      unwrapBugDossierRecord({
        schemaVersion: "ravi.bug_report/v1",
        title: "Wrapped",
        payload: { steps: "do the thing" },
      }),
    ).toEqual({ steps: "do the thing" });
    expect(unwrapBugDossierRecord({ tag: "e2e", payload: { note: "keep parent" } })).toEqual({
      tag: "e2e",
      payload: { note: "keep parent" },
    });
  });
});
