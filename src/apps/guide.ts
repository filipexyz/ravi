import { getAppManifest } from "./service.js";
import type { RaviAppManifestRecord, RaviAppsGuidePrompt, RaviAppsGuideResult } from "./types.js";

export const RAVI_APPS_SKILL = "ravi-system-apps";

export function buildAppsGuide(id?: string): RaviAppsGuideResult {
  const app = id?.trim() ? getAppManifest(id) : null;
  const appPrompts = app ? buildAppSpecificPrompts(app) : [];

  return {
    appId: app?.id ?? null,
    app,
    skill: RAVI_APPS_SKILL,
    skillGate: {
      group: "apps",
      skill: RAVI_APPS_SKILL,
    },
    prompts: [...basePrompts(), ...appPrompts],
    nextCommands: buildNextCommands(app),
  };
}

function basePrompts(): RaviAppsGuidePrompt[] {
  return [
    {
      id: "discover",
      title: "Discover Ravi apps",
      prompt:
        "List apps before assuming an app exists. Use JSON output and inspect id, source, interfaces, permissions, validity, errors, and warnings.",
      commands: ["ravi apps list --json"],
    },
    {
      id: "inspect",
      title: "Inspect one app",
      prompt:
        "Use show to read the manifest. Treat the manifest as metadata only: it declares interfaces, operations, UI, permissions, storage, events, skills, health, and versioning.",
      commands: ["ravi apps show <app-id> --json"],
    },
    {
      id: "validate",
      title: "Validate manifests",
      prompt:
        "Run check before operating or editing an app. Manifest checks must not execute app code, health commands, or mutating operations.",
      commands: ["ravi apps check [app-id] --json"],
    },
    {
      id: "scaffold",
      title: "Scaffold a new app",
      prompt:
        "Create a conservative app skeleton with manifest, spec, skill, operations, and optional UI descriptor. Review the generated files before implementing domain logic.",
      commands: [
        'ravi apps scaffold <app-id> --name "App Name" --description "What this app does" --json',
        "ravi apps scaffold <app-id> --dry-run --json",
      ],
    },
    {
      id: "operate",
      title: "Operate through declared interfaces",
      prompt:
        "Never guess app commands. Read manifest.operations and use only declared operations. CLI-backed operations should support --json. Mutating operations require permission checks.",
      commands: ["ravi apps show <app-id> --json"],
    },
    {
      id: "ui",
      title: "Understand app UI",
      prompt:
        "Read interfaces.ui for routes, views, queries, actions, refreshOn, and design-system hints. The app declares semantic UI only; Web OS owns rendering and styling.",
      commands: ["ravi apps show <app-id> --json", "ravi specs get apps/ui --mode rules --json"],
    },
    {
      id: "storage-events",
      title: "Understand storage and events",
      prompt:
        "Read manifest.storage and manifest.events before assuming persistence or subscriptions. App domain data belongs to app-owned storage; events belong to the shared Ravi event plane.",
      commands: ["ravi apps show <app-id> --json", "ravi specs get apps/manifest --mode rules --json"],
    },
    {
      id: "skill-gate",
      title: "Skill gate",
      prompt:
        "The apps command group is gated by ravi-system-apps. If a tool call asks for that skill, load it and retry the original ravi apps command.",
      commands: ["ravi skill-gates show apps --json", "ravi skills show ravi-system-apps --json"],
    },
  ];
}

function buildAppSpecificPrompts(app: RaviAppManifestRecord): RaviAppsGuidePrompt[] {
  const manifest = app.manifest;
  const operations = isObject(manifest?.operations) ? Object.keys(manifest.operations).sort() : [];
  const skills = Array.isArray(manifest?.skills)
    ? manifest.skills.filter((skill): skill is string => typeof skill === "string")
    : [];

  return [
    {
      id: "selected-app",
      title: `Operate ${app.id}`,
      prompt: [
        `Selected app: ${app.id}.`,
        `Interfaces: ${app.interfaceNames.join(", ") || "none"}.`,
        `Operations: ${operations.join(", ") || "none"}.`,
        `Skills: ${skills.join(", ") || "none"}.`,
        "Check validity and warnings before using any operation.",
      ].join(" "),
      commands: [`ravi apps show ${app.id} --json`, `ravi apps check ${app.id} --json`],
    },
  ];
}

function buildNextCommands(app: RaviAppManifestRecord | null): string[] {
  if (!app) {
    return ["ravi apps list --json", "ravi apps scaffold <app-id> --dry-run --json"];
  }
  return [`ravi apps show ${app.id} --json`, `ravi apps check ${app.id} --json`, `ravi apps guide ${app.id} --json`];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
