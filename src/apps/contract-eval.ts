import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RAVI_APP_BUILDER_SKILL, RAVI_APP_BUILDER_SPEC } from "./builder.js";
import { buildAppsGuide, RAVI_APPS_COMMAND_GUIDANCE } from "./guide.js";

export type RaviAppsContractSurface =
  | "registry"
  | "guide"
  | "system-skill"
  | "builder-skill"
  | "apps-spec"
  | "builder-spec"
  | "acceptance-cases";

export interface RaviAppsContractDrift {
  surface: RaviAppsContractSurface;
  code: string;
  detail: string;
}

export interface RaviAppsContractEvalResult {
  ok: boolean;
  registryCommands: string[];
  documentedCommands: string[];
  drift: RaviAppsContractDrift[];
}

export interface RaviAppsContractEvalOptions {
  cwd?: string;
  guidance?: readonly {
    command: string;
    promptId: string;
    audience: "public" | "debug";
  }[];
}

const CONTRACT_PATHS = {
  systemSkill: "src/plugins/internal/ravi-system/skills/apps/SKILL.md",
  builderSkill: "src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md",
  appsSpec: ".ravi/specs/apps/SPEC.md",
  builderSpec: ".ravi/specs/apps/builder/SPEC.md",
  acceptanceCases: "src/plugins/internal/ravi-dev/skills/app-creator/references/acceptance-cases.md",
} as const;

export function evaluateRaviAppsContract(
  registryCommands: readonly string[],
  options: RaviAppsContractEvalOptions = {},
): RaviAppsContractEvalResult {
  const cwd = options.cwd ?? process.cwd();
  const guidance = options.guidance ?? RAVI_APPS_COMMAND_GUIDANCE;
  const registry = sortedUnique(registryCommands);
  const documented = sortedUnique(guidance.map((entry) => entry.command));
  const drift: RaviAppsContractDrift[] = [];
  const guidePromptIds = new Set(buildAppsGuide().prompts.map((prompt) => prompt.id));
  const contents = {
    systemSkill: readContractFile(cwd, CONTRACT_PATHS.systemSkill, "system-skill", drift),
    builderSkill: readContractFile(cwd, CONTRACT_PATHS.builderSkill, "builder-skill", drift),
    appsSpec: readContractFile(cwd, CONTRACT_PATHS.appsSpec, "apps-spec", drift),
    builderSpec: readContractFile(cwd, CONTRACT_PATHS.builderSpec, "builder-spec", drift),
    acceptanceCases: readContractFile(cwd, CONTRACT_PATHS.acceptanceCases, "acceptance-cases", drift),
  };

  for (const command of registry) {
    const entry = guidance.find((candidate) => candidate.command === command);
    if (!entry) {
      drift.push({
        surface: "guide",
        code: "registry_command_missing_guidance",
        detail: `ravi apps ${command} is registered but absent from RAVI_APPS_COMMAND_GUIDANCE`,
      });
      continue;
    }
    if (!guidePromptIds.has(entry.promptId)) {
      drift.push({
        surface: "guide",
        code: "guidance_prompt_missing",
        detail: `ravi apps ${command} points to missing guide prompt ${entry.promptId}`,
      });
    }
    requireText(contents.systemSkill, `ravi apps ${command}`, "system-skill", "command_missing", drift);
    requireText(contents.appsSpec, `ravi apps ${command}`, "apps-spec", "command_missing", drift);
  }

  for (const command of documented) {
    if (!registry.includes(command)) {
      drift.push({
        surface: "registry",
        code: "guidance_command_not_registered",
        detail: `RAVI_APPS_COMMAND_GUIDANCE documents ravi apps ${command}, but the command is not registered`,
      });
    }
  }

  const runGuidance = guidance.find((entry) => entry.command === "run");
  if (runGuidance?.audience !== "debug") {
    drift.push({
      surface: "guide",
      code: "run_audience_drift",
      detail: "ravi apps run must remain explicitly classified as internal/debug",
    });
  }

  for (const command of registry.filter((entry) => entry !== "run")) {
    const entry = guidance.find((candidate) => candidate.command === command);
    if (entry && entry.audience !== "public") {
      drift.push({
        surface: "guide",
        code: "public_audience_drift",
        detail: `ravi apps ${command} must remain classified as public`,
      });
    }
  }

  for (const [surface, content] of [
    ["system-skill", contents.systemSkill],
    ["builder-spec", contents.builderSpec],
  ] as const) {
    requireText(content, RAVI_APP_BUILDER_SKILL, surface, "builder_skill_link_missing", drift);
    requireText(content, RAVI_APP_BUILDER_SPEC, surface, "builder_spec_link_missing", drift);
  }
  requireText(contents.builderSkill, "name: app-creator", "builder-skill", "builder_frontmatter_missing", drift);
  requireText(contents.builderSkill, "## Gate De Prontidão", "builder-skill", "readiness_gate_missing", drift);
  requireText(
    contents.acceptanceCases,
    "Google Search Console",
    "acceptance-cases",
    "google_reference_case_missing",
    drift,
  );
  requireText(
    contents.acceptanceCases,
    "Open-Meteo Forecast",
    "acceptance-cases",
    "second_reference_case_missing",
    drift,
  );

  return {
    ok: drift.length === 0,
    registryCommands: registry,
    documentedCommands: documented,
    drift,
  };
}

function readContractFile(
  cwd: string,
  path: string,
  surface: RaviAppsContractSurface,
  drift: RaviAppsContractDrift[],
): string {
  try {
    return readFileSync(join(cwd, path), "utf8");
  } catch (error) {
    drift.push({
      surface,
      code: "contract_file_missing",
      detail: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return "";
  }
}

function requireText(
  content: string,
  needle: string,
  surface: RaviAppsContractSurface,
  code: string,
  drift: RaviAppsContractDrift[],
): void {
  if (content.includes(needle)) {
    return;
  }
  drift.push({
    surface,
    code,
    detail: `missing ${JSON.stringify(needle)}`,
  });
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
