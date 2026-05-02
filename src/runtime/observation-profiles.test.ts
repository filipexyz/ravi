import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  buildObserverProfileSnapshotMarkdown,
  previewObserverProfile,
  renderObservationPromptForProfile,
  resolveObserverProfile,
  resolveObserverProfileFromSnapshotMarkdown,
  validateObserverProfiles,
} from "./observation-profiles.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("observer-profiles-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function writeProfile(profileId: string, files: Record<string, string>): string {
  if (!stateDir) throw new Error("missing isolated state");
  const profileDir = join(stateDir, "observers", "profiles", profileId);
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(profileDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return profileDir;
}

function customProfileMarkdown(profileId: string): string {
  return `---
id: ${profileId}
version: "1"
label: Custom Observer
description: Custom profile for tests.
defaults:
  eventTypes:
    - message.user
    - turn.complete
  deliveryPolicy: end_of_turn
  mode: summarize
templates:
  delivery:
    end_of_turn: ./delivery/end.md
    realtime: ./delivery/realtime.md
    debounce: ./delivery/debounce.md
  events:
    default: ./events/default.md
    message.user: ./events/user.md
    turn.complete: ./events/complete.md
rendererHints:
  label: Custom observer
---

# Custom Observer
`;
}

describe("Observer Profiles", () => {
  it("loads Markdown profile bundles and renders readable prompts", () => {
    writeProfile("custom", {
      "PROFILE.md": customProfileMarkdown("custom"),
      "delivery/end.md": "## Custom Delivery\n\n{{events.rendered}}\n\nRole: {{binding.observerRole}}",
      "delivery/realtime.md": "## Realtime\n\n{{events.rendered}}",
      "delivery/debounce.md": "## Debounce\n\n{{events.rendered}}",
      "events/default.md": "### Default Event\n\n{{event.type}} :: {{event.preview}}",
      "events/user.md": "### Human Said\n\n{{event.preview}}\n\n{{event.payloadSummary}}",
      "events/complete.md": "### Done\n\n{{event.payloadSummary}}",
    });

    const profile = resolveObserverProfile("custom");
    const prompt = renderObservationPromptForProfile({
      profile,
      source: {
        sessionKey: "source",
        sessionName: "source",
        agentId: "worker",
        tags: [],
      },
      binding: {
        id: "binding",
        observerSessionName: "obs:source:custom",
        observerAgentId: "observer",
        observerRole: "custom",
        observerMode: "summarize",
        ruleId: "rule",
        deliveryPolicy: "end_of_turn",
      },
      events: [
        {
          id: "event-1",
          type: "message.user",
          timestamp: 1_700_000_000_000,
          preview: "ship the observer profile renderer",
          payload: { chars: 34 },
        },
      ],
    });

    expect(prompt).toContain("## Custom Delivery");
    expect(prompt).toContain("### Human Said");
    expect(prompt).toContain("ship the observer profile renderer");
    expect(prompt).not.toContain('{"id"');
  });

  it("renders from a binding snapshot after the source files change", () => {
    writeProfile("snapshot", {
      "PROFILE.md": customProfileMarkdown("snapshot"),
      "delivery/end.md": "## Original Delivery\n\n{{events.rendered}}",
      "delivery/realtime.md": "## Realtime\n\n{{events.rendered}}",
      "delivery/debounce.md": "## Debounce\n\n{{events.rendered}}",
      "events/default.md": "### Original Default\n\n{{event.preview}}",
      "events/user.md": "### Original User\n\n{{event.preview}}",
      "events/complete.md": "### Original Complete\n\n{{event.payloadSummary}}",
    });
    const original = resolveObserverProfile("snapshot");
    const snapshotMarkdown = buildObserverProfileSnapshotMarkdown(original);

    writeProfile("snapshot", {
      "PROFILE.md": customProfileMarkdown("snapshot"),
      "delivery/end.md": "## Changed Delivery\n\n{{events.rendered}}",
      "delivery/realtime.md": "## Realtime\n\n{{events.rendered}}",
      "delivery/debounce.md": "## Debounce\n\n{{events.rendered}}",
      "events/default.md": "### Changed Default\n\n{{event.preview}}",
      "events/user.md": "### Changed User\n\n{{event.preview}}",
      "events/complete.md": "### Changed Complete\n\n{{event.payloadSummary}}",
    });

    const fromSnapshot = resolveObserverProfileFromSnapshotMarkdown(snapshotMarkdown);
    const prompt = renderObservationPromptForProfile({
      profile: fromSnapshot,
      source: {
        sessionKey: "source",
        sessionName: "source",
        agentId: "worker",
        tags: [],
      },
      binding: {
        id: "binding",
        observerSessionName: "obs:source:snapshot",
        observerAgentId: "observer",
        observerRole: "snapshot",
        observerMode: "summarize",
        ruleId: "rule",
        deliveryPolicy: "end_of_turn",
      },
      events: [
        {
          id: "event-1",
          type: "message.user",
          timestamp: 1_700_000_000_000,
          preview: "snapshot event",
        },
      ],
    });

    expect(prompt).toContain("## Original Delivery");
    expect(prompt).toContain("### Original User");
    expect(prompt).not.toContain("Changed");
  });

  it("validates unknown placeholders and non-Markdown manifests", () => {
    writeProfile("bad-placeholder", {
      "PROFILE.md": customProfileMarkdown("bad-placeholder"),
      "delivery/end.md": "## Bad\n\n{{unknown.value}}",
      "delivery/realtime.md": "## Realtime\n\n{{events.rendered}}",
      "delivery/debounce.md": "## Debounce\n\n{{events.rendered}}",
      "events/default.md": "### Default\n\n{{event.preview}}",
      "events/user.md": "### User\n\n{{event.preview}}",
      "events/complete.md": "### Complete\n\n{{event.payloadSummary}}",
    });
    writeProfile("bad-manifest", {
      "PROFILE.md": customProfileMarkdown("bad-manifest"),
      "profile.json": "{}",
      "delivery/end.md": "## Good\n\n{{events.rendered}}",
      "delivery/realtime.md": "## Realtime\n\n{{events.rendered}}",
      "delivery/debounce.md": "## Debounce\n\n{{events.rendered}}",
      "events/default.md": "### Default\n\n{{event.preview}}",
      "events/user.md": "### User\n\n{{event.preview}}",
      "events/complete.md": "### Complete\n\n{{event.payloadSummary}}",
    });

    expect(validateObserverProfiles("bad-placeholder").ok).toBe(false);
    const manifestResult = validateObserverProfiles("bad-manifest");
    expect(manifestResult.ok).toBe(false);
    expect(manifestResult.errors[0]?.message).toContain("non-Markdown manifest");
  });

  it("previews the system default profile", () => {
    const result = previewObserverProfile("default", "turn.complete");
    expect(result.prompt).toContain("## Ravi Observation");
    expect(result.prompt).toContain("### Turn Completed");
  });
});
