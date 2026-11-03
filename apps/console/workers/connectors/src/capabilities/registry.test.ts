import { describe, expect, test } from "bun:test";

import { requireActionDefinition } from "../../../../src/shared/integrations/provider-registry";
import {
  CAPABILITY_LABELS,
  CapabilityNotFoundError,
  capabilityLabel,
  capabilityRegistry,
  getCapability,
  listProviderCapabilities,
} from "./registry";

describe("capability registry", () => {
  test("returns a capability by id", () => {
    const def = getCapability("gmail.message.send");
    expect(def.providerId).toBe("google");
    expect(def.class).toBe("destructive");
    expect(def.requiresStepUp).toBe(false);
  });

  test("step-up is disabled for v1 until WorkOS factor challenge is wired", () => {
    for (const cap of Object.values(capabilityRegistry)) {
      expect(cap.requiresStepUp).toBe(false);
    }
  });

  test("validates gmail.message.send input shape", () => {
    const cap = getCapability("gmail.message.send");
    const ok = cap.input.parse({
      to: ["x@example.com"],
      subject: "hi",
      body: "hello",
    });
    expect(ok).toMatchObject({ to: ["x@example.com"] });
    expect(() => cap.input.parse({ to: [], subject: "x", body: "y" })).toThrow();
    expect(() => cap.input.parse({ to: ["bad"], subject: "x", body: "y" })).toThrow();
  });

  test("projects gmail.message.send output by dropping unknown fields", () => {
    const cap = getCapability("gmail.message.send");
    const projected = cap.output.parse({
      messageId: "msg-1",
      threadId: "thr-1",
      shouldNotLeak: "definitely-not",
    });
    expect(projected).toEqual({ messageId: "msg-1", threadId: "thr-1" });
    expect((projected as Record<string, unknown>).shouldNotLeak).toBeUndefined();
  });

  test("gcal.event.list defaults calendarId to primary", () => {
    const cap = getCapability("gcal.event.list");
    const parsed = cap.input.parse({});
    expect(parsed).toMatchObject({ calendarId: "primary" });
  });

  test("read capabilities require readonly provider scopes", () => {
    expect(getCapability("gmail.message.read").requiredProviderScopes)
      .toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(getCapability("gcal.event.list").requiredProviderScopes)
      .toEqual(["https://www.googleapis.com/auth/calendar.readonly"]);
  });

  test("free/busy comes from the shared provider registry like the other tools", () => {
    const action = requireActionDefinition("gcal.freebusy.query");
    const def = getCapability("gcal.freebusy.query");
    expect(action.status).toBe("implemented");
    expect(def).toMatchObject({
      providerId: "google",
      class: action.class,
      requiredProviderScopes: action.requiredProviderScopes,
      summary: action.title,
    });
    expect(def.class).toBe("read");
    expect(def.requiredProviderScopes).toEqual(["https://www.googleapis.com/auth/calendar.readonly"]);
  });

  test("getCapability throws CapabilityNotFoundError for unknown ids", () => {
    expect(() => getCapability("not-a-capability")).toThrow(CapabilityNotFoundError);
  });

  test("gcal.freebusy.query is a calendar read with a bounded window", () => {
    const cap = getCapability("gcal.freebusy.query");
    expect(cap.class).toBe("read");
    expect(cap.requiredProviderScopes).toEqual(["https://www.googleapis.com/auth/calendar.readonly"]);
    expect(cap.input.parse({ timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-13T00:00:00-03:00" })).toEqual({
      timeMin: "2026-10-12T00:00:00Z",
      timeMax: "2026-10-13T00:00:00-03:00",
      calendarIds: ["primary"],
    });
    expect(() => cap.input.parse({ timeMin: "tomorrow", timeMax: "2026-10-13T00:00:00Z" })).toThrow();
    expect(() => cap.input.parse({ timeMin: "2026-10-12T00:00:00Z" })).toThrow();
    expect(() =>
      cap.input.parse({ timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-13T00:00:00Z", calendarIds: [] }),
    ).toThrow();
  });

  test("every capability has one shared label and Google lists them in registry order", () => {
    for (const id of Object.keys(capabilityRegistry)) {
      expect(CAPABILITY_LABELS[id]).toBeString();
      expect(capabilityLabel(id)).toBe(CAPABILITY_LABELS[id]!);
    }
    expect(capabilityLabel("unknown.tool")).toBe("unknown.tool");
    expect(listProviderCapabilities("google").map((cap) => cap.id)).toEqual([
      "gmail.message.send",
      "gmail.message.list",
      "gmail.message.read",
      "gcal.event.list",
      "gcal.freebusy.query",
    ]);
    expect(listProviderCapabilities("github")).toEqual([]);
  });
});
