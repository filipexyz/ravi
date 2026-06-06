import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeAppId, RAVI_APP_MANIFEST_FILE, RAVI_APP_MANIFEST_SCHEMA } from "./service.js";
import type {
  RaviAppManifest,
  RaviAppScaffoldFileKind,
  RaviAppScaffoldFileResult,
  RaviAppScaffoldOptions,
  RaviAppScaffoldResult,
} from "./types.js";

interface ScaffoldTarget {
  kind: RaviAppScaffoldFileKind;
  path: string;
  content: string;
}

export function scaffoldApp(options: RaviAppScaffoldOptions): RaviAppScaffoldResult {
  const id = normalizeAppId(options.id);
  const repoRoot = findRepoRoot(resolve(options.cwd ?? process.cwd()));
  const appSlug = slugFromAppId(id);
  const operationPrefix = operationPrefixForAppId(id);
  const name = options.name?.trim() || titleFromAppId(id);
  const description = options.description?.trim() || `Operate the ${name} Ravi app.`;
  const command = options.command?.trim() || `ravi ${id.split("/").join(" ")}`;
  const includeUi = options.includeUi !== false;
  const includeSkill = options.includeSkill !== false;
  const includeSpec = options.includeSpec !== false;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const skill = includeSkill ? `ravi-system-${appSlug}` : null;

  const appDir = join(repoRoot, "src", "apps", ...id.split("/"));
  const manifestPath = join(appDir, RAVI_APP_MANIFEST_FILE);
  const specPath = includeSpec ? join(repoRoot, ".ravi", "specs", "apps", ...id.split("/"), "SPEC.md") : null;
  const skillSourcePath = join(repoRoot, "src", "plugins", "internal", "ravi-system");
  const skillPath = includeSkill ? join(skillSourcePath, "skills", appSlug, "SKILL.md") : null;
  const manifest = buildScaffoldManifest({
    id,
    appSlug,
    operationPrefix,
    name,
    description,
    command,
    includeUi,
    skill,
  });

  const targets: ScaffoldTarget[] = [
    {
      kind: "manifest",
      path: manifestPath,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
  if (specPath) {
    targets.push({
      kind: "spec",
      path: specPath,
      content: buildSpecSkeleton({ id, appSlug, name, description, command }),
    });
  }
  if (skillPath) {
    targets.push({
      kind: "skill",
      path: skillPath,
      content: buildSkillSkeleton({ id, appSlug, name, description, command }),
    });
  }

  const existing = targets.filter((target) => existsSync(target.path));
  if (existing.length > 0 && !dryRun && !force) {
    throw new Error(
      `Scaffold target already exists: ${existing.map((target) => target.path).join(", ")}. Use --force to overwrite or --dry-run to inspect.`,
    );
  }

  const files = targets.map((target): RaviAppScaffoldFileResult => {
    const existed = existsSync(target.path);
    if (!dryRun) {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, target.content, "utf8");
    }
    return {
      kind: target.kind,
      path: target.path,
      action: dryRun ? "planned" : existed ? "overwritten" : "created",
    };
  });

  return {
    id,
    name,
    description,
    command,
    dryRun,
    force,
    manifestPath,
    specPath,
    skillPath,
    skill,
    files,
    manifest,
    nextCommands: buildNextCommands({
      id,
      appSlug,
      includeSpec,
      skill,
      skillSourcePath,
    }),
  };
}

function buildScaffoldManifest(input: {
  id: string;
  appSlug: string;
  operationPrefix: string;
  name: string;
  description: string;
  command: string;
  includeUi: boolean;
  skill: string | null;
}): RaviAppManifest {
  const changeTopic = `ravi.apps.${input.operationPrefix}.changed`;
  const interfaces: Record<string, unknown> = {
    cli: {
      command: input.command,
      json: true,
      health: `ravi apps run ${input.id} check --json`,
    },
  };

  if (input.includeUi) {
    interfaces.ui = {
      routes: [
        {
          id: "main",
          path: `/apps/${input.id}`,
          label: input.name,
          icon: "app-window",
          view: "main",
        },
      ],
      views: [
        {
          id: "main",
          type: "dashboard",
          title: input.name,
          density: "compact",
          query: {
            operation: `${input.operationPrefix}.list`,
          },
          refreshOn: [changeTopic],
          actions: [
            {
              id: "check",
              label: "Check",
              icon: "shield-check",
              operation: `${input.operationPrefix}.check`,
              placement: "toolbar",
            },
          ],
        },
      ],
    };
  }

  return {
    schema: RAVI_APP_MANIFEST_SCHEMA,
    id: input.id,
    name: input.name,
    version: "0.1.0",
    description: input.description,
    interfaces,
    operations: {
      [`${input.operationPrefix}.help`]: {
        interface: "builtin",
        handler: "apps.help",
        mutating: false,
      },
      [`${input.operationPrefix}.show`]: {
        interface: "builtin",
        handler: "apps.manifest.show",
        mutating: false,
      },
      [`${input.operationPrefix}.list`]: {
        interface: "builtin",
        handler: "apps.stub.list",
        mutating: false,
        outputSchema: `schemas/${input.appSlug}-list.v1.json`,
      },
      [`${input.operationPrefix}.check`]: {
        interface: "builtin",
        handler: "apps.manifest.check",
        mutating: false,
        outputSchema: `schemas/${input.appSlug}-check.v1.json`,
      },
    },
    permissions: {
      required: [],
      optional: [],
      mutating: [],
    },
    storage: {
      sqlite: [],
      files: [],
    },
    artifacts: [],
    events: {
      emits: [
        {
          topic: changeTopic,
          when: "app state changes",
          durability: "logged",
          schema: `events/${input.appSlug}-changed.v1.json`,
        },
      ],
      consumes: [],
    },
    skills: input.skill ? [input.skill] : [],
    health: {
      checks: [
        {
          type: "builtin",
          handler: "apps.manifest.check",
        },
      ],
    },
    versioning: {
      compatibility: "semver",
      migrations: [],
    },
  };
}

function buildSpecSkeleton(input: {
  id: string;
  appSlug: string;
  name: string;
  description: string;
  command: string;
}): string {
  return `---
id: apps/${input.id}
title: ${quoteYaml(input.name)}
kind: capability
domain: apps
capability: ${input.appSlug}
capabilities:
  - manifest
  - cli
  - ui
  - operations
tags:
  - apps
  - ${input.appSlug}
applies_to:
  - src/apps/${input.id}/ravi.app.json
owners:
  - ravi-dev
status: draft
normative: true
---

# ${input.name}

## Intent

${input.description}

## Invariants

- This app MUST keep a valid \`ravi.app.json\`.
- CLI operations SHOULD support \`--json\`.
- UI actions MUST reference declared operations.
- Mutating operations SHOULD declare required permissions.
- App state SHOULD use app-owned storage when persistence adds reuse, lineage, audit, or recovery.
- Router-owned scaffold operations MUST use builtin handlers until real domain implementation exists.

## Interfaces

- CLI: \`${input.command}\`
- Manifest: \`src/apps/${input.id}/ravi.app.json\`

## Validation

- \`ravi apps check ${input.id} --json\`
- \`ravi apps show ${input.id} --json\`
- \`ravi apps run ${input.id} check --json\`
`;
}

function buildSkillSkeleton(input: {
  id: string;
  appSlug: string;
  name: string;
  description: string;
  command: string;
}): string {
  return `---
name: ${input.appSlug}
description: |
  Opera o Ravi App ${input.name}. Use quando precisar:
  - Entender o manifesto e as interfaces do app ${input.id}
  - Validar se o app esta descoberto pelo Ravi
  - Operar os comandos CLI declarados em ${input.command}
  - Revisar UI, operations, storage, events e permissoes do app
---

# ${input.name}

${input.description}

## Fluxo Canonico

1. Comece pelo manifesto:

\`\`\`bash
ravi apps show ${input.id} --json
\`\`\`

2. Valide o contrato antes de operar:

\`\`\`bash
ravi apps check ${input.id} --json
ravi apps run ${input.id} check --json
\`\`\`

3. Leia \`manifest.interfaces\`, \`manifest.operations\`, \`manifest.permissions\`, \`manifest.storage\` e \`manifest.events\`.

4. Use apenas operations declaradas. Para CLI, prefira comandos com \`--json\`.

## Comandos Iniciais

\`\`\`bash
ravi apps run ${input.id} list --json
ravi apps run ${input.id} check --json
${input.command} list --json
${input.command} check --json
\`\`\`

## Regras

- Nao execute comandos mutating sem checar permissoes.
- Nao raspe stdout se houver JSON ou eventos declarados.
- Nao invente rotas UI fora de \`interfaces.ui\`.
- Se o manifesto estiver incompleto, corrija o app/manifest antes de compensar no agente.
`;
}

function buildNextCommands(input: {
  id: string;
  appSlug: string;
  includeSpec: boolean;
  skill: string | null;
  skillSourcePath: string;
}): string[] {
  const { id, appSlug, includeSpec, skill, skillSourcePath } = input;
  const commands = [
    `ravi apps show ${id} --json`,
    `ravi apps check ${id} --json`,
    `ravi apps run ${id} check --json`,
    `ravi apps run ${id} list --json`,
    `ravi apps guide ${id} --json`,
  ];
  if (includeSpec) commands.push(`ravi specs get apps/${id} --mode rules --json`);
  if (skill) commands.push(`ravi skills show ${appSlug} --source ${quoteShellArg(skillSourcePath)} --json`);
  return commands;
}

function findRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function titleFromAppId(id: string): string {
  return id
    .split(/[/-]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugFromAppId(id: string): string {
  return id.replace(/\//g, "-");
}

function operationPrefixForAppId(id: string): string {
  return id.replace(/\//g, ".");
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
