import { buildRaviAppBuilderGuidance, RAVI_APP_BUILDER_SKILL } from "./builder.js";
import { getAppManifest } from "./service.js";
import type { RaviAppManifestRecord, RaviAppsGuidePrompt, RaviAppsGuideResult } from "./types.js";

export const RAVI_APPS_SKILL = "ravi-system-apps";

export const RAVI_APPS_COMMAND_GUIDANCE = [
  { command: "list", promptId: "discover", audience: "public" },
  { command: "show", promptId: "inspect", audience: "public" },
  { command: "check", promptId: "validate", audience: "public" },
  { command: "run", promptId: "operate", audience: "debug" },
  { command: "scaffold", promptId: "build", audience: "public" },
  { command: "delete", promptId: "lifecycle", audience: "public" },
  { command: "import-cli", promptId: "import-cli", audience: "public" },
  { command: "guide", promptId: "guidance", audience: "public" },
  { command: "prompts", promptId: "guidance", audience: "public" },
] as const;

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
    builder: buildRaviAppBuilderGuidance(),
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
        "List apps before assuming one exists. Inspect source, interfaces, permissions, validity, errors, and warnings.",
      commands: ["ravi apps list --json"],
    },
    {
      id: "inspect",
      title: "Inspect one app",
      prompt:
        "Use show to read the declarative contract. The manifest describes operations and requirements; it is neither executable code nor a permission grant.",
      commands: ["ravi apps show <app-id> --json"],
    },
    {
      id: "validate",
      title: "Validate manifests",
      prompt:
        "Run check before operating or editing an app. Manifest validation must not execute app code, external health calls, or mutations.",
      commands: ["ravi apps check [app-id] --json"],
    },
    {
      id: "build",
      title: "Build a new app",
      prompt: `Load ${RAVI_APP_BUILDER_SKILL} before turning API documentation into an app. Start with a dry-run scaffold, then follow its auth, permissions, skill-grant, functional-test, and release checklist.`,
      commands: [
        `ravi skills show ${RAVI_APP_BUILDER_SKILL} --json`,
        "ravi specs get apps/builder --mode full --json",
        "ravi apps scaffold <app-id> --dry-run --json",
        'ravi apps scaffold <app-id> --name "App Name" --description "What this app does" --json',
      ],
    },
    {
      id: "import-cli",
      title: "Import an existing CLI as a draft",
      prompt:
        "import-cli is a draft generator. Review every candidate, remove debug/interactive commands, verify JSON and error contracts, then complete auth, permissions, context, storage, events, UI, skill, and functional tests before calling the app ready.",
      commands: [
        "ravi apps import-cli <cli-command> --id <app-id> --dry-run --json",
        "ravi apps import-cli <cli-command> --id <app-id> --json",
      ],
    },
    {
      id: "operate",
      title: "Operate through the app alias",
      prompt:
        "For normal use, read manifest.operations and call ravi <app-id> <operation> --json. ravi apps run is an internal/debug router surface for diagnostics or static command collisions, not the normal product path.",
      commands: [
        "ravi <app-id> <operation> --json",
        "ravi apps run <app-id> <operation> --json  # internal/debug only",
      ],
    },
    {
      id: "lifecycle",
      title: "Delete only scaffold-owned contracts",
      prompt:
        "Preview deletion first. The delete command owns generated manifest/spec/skill artifacts; it must preserve authored implementation code, app state, credentials, and unrelated files.",
      commands: ["ravi apps delete <app-id> --dry-run --json", "ravi apps delete <app-id> --json"],
    },
    {
      id: "guidance",
      title: "Read embedded guidance",
      prompt:
        "guide returns the full operational result and prompts is its compatibility alias. Both must stay aligned with the Apps registry and the dedicated builder skill.",
      commands: ["ravi apps guide [app-id] --json", "ravi apps prompts [app-id] --json"],
    },
    {
      id: "auth-readiness",
      title: "Prove auth and functional readiness",
      prompt:
        "Keep provider secrets behind the Ravi credential broker or a managed connector. A ready app proves missing auth fails before fetch, permissions fail closed, provider errors are sanitized, the app skill is visible or granted, and at least one public alias operation succeeds against a deterministic fake provider.",
      commands: [
        "ravi apps show <app-id> --json",
        "ravi permissions status --json",
        "ravi skills inspect <agent-id> --json",
        "ravi <app-id> <health-or-read-operation> --json",
      ],
    },
    {
      id: "ui-storage-events",
      title: "Decide optional product surfaces",
      prompt:
        "Make explicit yes/no decisions for semantic UI, app-owned storage, events, and artifacts. Add them only when they create operator value, reuse, lineage, audit, recovery, or durable outputs.",
      commands: [
        "ravi apps show <app-id> --json",
        "ravi specs get apps/manifest --mode rules --json",
        "ravi specs get apps/ui --mode rules --json",
      ],
    },
    {
      id: "skill-gate",
      title: "Load the operational skill",
      prompt:
        "The apps command group is gated by ravi-system-apps. Load it when the gate asks. Use the separate app creator skill for implementation work and the generated app skill for domain operation.",
      commands: [
        "ravi skill-gates show apps --json",
        "ravi skills show ravi-system-apps --json",
        `ravi skills show ${RAVI_APP_BUILDER_SKILL} --json`,
      ],
    },
  ];
}

function buildAppSpecificPrompts(app: RaviAppManifestRecord): RaviAppsGuidePrompt[] {
  const manifest = app.manifest;
  const operations = isObject(manifest?.operations) ? Object.keys(manifest.operations).sort() : [];
  const appCommand = `ravi ${app.id.split("/").join(" ")}`;
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
        `Check validity and warnings before use. Operate through ${appCommand} <operation>.`,
      ].join(" "),
      commands: [`ravi apps show ${app.id} --json`, `ravi apps check ${app.id} --json`, `${appCommand} check --json`],
    },
  ];
}

function buildNextCommands(app: RaviAppManifestRecord | null): string[] {
  if (!app) {
    return [
      `ravi skills show ${RAVI_APP_BUILDER_SKILL} --json`,
      "ravi apps list --json",
      "ravi apps scaffold <app-id> --dry-run --json",
    ];
  }
  const appCommand = `ravi ${app.id.split("/").join(" ")}`;
  return [
    `ravi skills show ${RAVI_APP_BUILDER_SKILL} --json`,
    `ravi apps show ${app.id} --json`,
    `ravi apps check ${app.id} --json`,
    `${appCommand} check --json`,
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
