import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildRaviAppBuilderGuidance } from "./builder.js";
import { normalizeAppId, RAVI_APP_MANIFEST_FILE, RAVI_APP_MANIFEST_SCHEMA } from "./service.js";
import {
  RaviAppError,
  type RaviAppDeleteFileResult,
  type RaviAppDeleteOptions,
  type RaviAppDeleteResult,
  type RaviAppManifest,
  type RaviAppScaffoldFileKind,
  type RaviAppScaffoldFileResult,
  type RaviAppScaffoldOptions,
  type RaviAppScaffoldResult,
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
  const generateCli = options.manifest === undefined && !options.command?.trim();
  const command = options.command?.trim() || "bun cli.ts";
  const includeUi = options.includeUi !== false;
  const includeSkill = options.includeSkill !== false;
  const includeSpec = options.includeSpec !== false;
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const skill = includeSkill ? `ravi-system-${appSlug}` : null;

  const appDir = join(repoRoot, "src", "apps", ...id.split("/"));
  const cliPath = generateCli ? join(appDir, "cli.ts") : null;
  const manifestPath = join(appDir, RAVI_APP_MANIFEST_FILE);
  const specPath = includeSpec ? join(repoRoot, ".ravi", "specs", "apps", ...id.split("/"), "SPEC.md") : null;
  const skillSourcePath = join(repoRoot, "src", "plugins", "internal", "ravi-system");
  const skillPath = includeSkill ? join(skillSourcePath, "skills", appSlug, "SKILL.md") : null;
  const manifest =
    options.manifest ??
    buildScaffoldManifest({
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
  if (cliPath) {
    targets.push({
      kind: "cli",
      path: cliPath,
      content: buildCliSkeleton({ id, name, description, command }),
    });
  }
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
    throw new RaviAppError(
      "already_exists",
      `Scaffold target already exists for app "${id}". Use --force to overwrite or --dry-run to inspect.`,
      existing.map((target) => ({ kind: target.kind, detail: target.path })),
    );
  }

  const files = targets.map((target): RaviAppScaffoldFileResult => {
    const existed = existsSync(target.path);
    const preserveImplementation = target.kind === "cli" && existed;
    if (!dryRun) {
      mkdirSync(dirname(target.path), { recursive: true });
      if (!preserveImplementation) {
        writeFileSync(target.path, target.content, "utf8");
      }
    }
    return {
      kind: target.kind,
      path: target.path,
      action: dryRun ? "planned" : preserveImplementation ? "preserved" : existed ? "overwritten" : "created",
    };
  });

  return {
    id,
    name,
    description,
    command,
    dryRun,
    force,
    cliPath,
    manifestPath,
    specPath,
    skillPath,
    skill,
    files,
    manifest,
    builder: buildRaviAppBuilderGuidance(),
    nextCommands: buildNextCommands({
      id,
      appSlug,
      command,
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
    context: {
      allow: [],
    },
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
        interface: "cli",
        command: `${input.command} list {args} --json`,
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

function buildCliSkeleton(input: { id: string; name: string; description: string; command: string }): string {
  return `#!/usr/bin/env bun

const APP = {
  id: ${JSON.stringify(input.id)},
  name: ${JSON.stringify(input.name)},
  version: "0.1.0",
  description: ${JSON.stringify(input.description)},
  command: ${JSON.stringify(input.command)},
};

const rawArgs = process.argv.slice(2);
const wantsJson = rawArgs.includes("--json");
const args = rawArgs.filter((arg) => arg !== "--json");
const operation = args.shift() ?? "help";

function printJson(value: unknown): void {
  process.stdout.write(\`\${JSON.stringify(value)}\\n\`);
}

function print(value: unknown): void {
  if (wantsJson) {
    printJson(value);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(\`\${value}\\n\`);
    return;
  }
  process.stdout.write(\`\${JSON.stringify(value, null, 2)}\\n\`);
}

switch (operation) {
  case "manifest":
    printJson({
      ...APP,
      commands: [
        {
          id: "list",
          name: "List",
          description: "List app-owned records.",
          command: \`\${APP.command} list {args} --json\`,
          json: true,
          mutating: false,
        },
      ],
    });
    break;
  case "list":
    print({ items: [], total: 0, args });
    break;
  case "help":
    print({
      app: APP.id,
      usage: \`\${APP.command} <operation> [args] [--json]\`,
      operations: ["list"],
    });
    break;
  default:
    printJson({ ok: false, error: \`Unknown operation: \${operation}\` });
    process.exitCode = 1;
}

/*
 * When Ravi launches this CLI, RAVI_CONTEXT_KEY identifies a least-privilege
 * child context. To call Ravi, spawn ["ravi", "<group>", ..., "--json"] with
 * process.env unchanged and declare execute:group:<group> in context.allow.
 */
`;
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
- \`interfaces.cli.command\` MUST name the real implementation CLI, never the public \`ravi ${input.id.split("/").join(" ")}\` alias.
- \`context.allow\` MUST list only the Ravi capabilities delegated to that CLI process; an empty list is valid.
- CLI operations SHOULD support \`--json\`.
- UI actions MUST reference declared operations.
- Mutating operations MUST declare permissions in \`permissions.mutating\`.
- App state SHOULD use app-owned storage when persistence adds reuse, lineage, audit, or recovery.
- Router-owned discovery/check operations MAY use builtin handlers; domain operations MUST execute the implementation CLI.

## Interfaces

- Public CLI: \`ravi ${input.id.split("/").join(" ")} <operation>\`
- Implementation CLI: \`${input.command}\`
- Manifest: \`src/apps/${input.id}/ravi.app.json\`

## Validation

- \`ravi apps check ${input.id} --json\`
- \`ravi apps show ${input.id} --json\`
- \`ravi ${input.id.split("/").join(" ")} check --json\`
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
  - Operar o app pelo alias ravi ${input.id.split("/").join(" ")}
  - Revisar CLI, context.allow, UI, operations, storage, events e permissoes do app
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
ravi ${input.id.split("/").join(" ")} check --json
\`\`\`

3. Leia \`manifest.interfaces.cli\`, \`manifest.context.allow\`, \`manifest.operations\`, \`manifest.permissions\`, \`manifest.storage\` e \`manifest.events\`.

4. Use apenas operations declaradas. Para operar o app, use o alias \`ravi ${input.id.split("/").join(" ")} <operation>\`. \`${input.command}\` e o CLI de implementacao e nao deve chamar o alias de volta.

5. Dentro do CLI, chame outras superficies com o comando publico \`ravi <group> ... --json\`, preservando \`process.env\`. Declare antes \`execute:group:<group>\` em \`context.allow\`; o router fornece somente o \`RAVI_CONTEXT_KEY\` do contexto-filho.

## Comandos Iniciais

\`\`\`bash
ravi ${input.id.split("/").join(" ")} list --json
ravi ${input.id.split("/").join(" ")} check --json
\`\`\`

## Regras

- Nao execute comandos mutating sem checar permissoes.
- Nao adicione capacidades implicitas: o processo recebe apenas o contexto-filho derivado de \`context.allow\`.
- Nao use shell, pipes, redirecionamento ou substituicao de comando nas declarations de CLI.
- Nao raspe stdout se houver JSON ou eventos declarados.
- Nao invente rotas UI fora de \`interfaces.ui\`.
- Se o manifesto estiver incompleto, corrija o app/manifest antes de compensar no agente.
`;
}

function buildNextCommands(input: {
  id: string;
  appSlug: string;
  command: string;
  includeSpec: boolean;
  skill: string | null;
  skillSourcePath: string;
}): string[] {
  const { id, appSlug, includeSpec, skill, skillSourcePath } = input;
  const publicCommand = `ravi ${id.split("/").join(" ")}`;
  const commands = [
    "ravi skills show ravi-dev-app-creator --json",
    `ravi apps show ${id} --json`,
    `ravi apps check ${id} --json`,
    `${publicCommand} check --json`,
    `${publicCommand} list --json`,
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

export function deleteApp(options: RaviAppDeleteOptions): RaviAppDeleteResult {
  const id = normalizeAppId(options.id);
  const repoRoot = findRepoRoot(resolve(options.cwd ?? process.cwd()));
  const appSlug = slugFromAppId(id);
  const dryRun = options.dryRun === true;

  const candidates: { kind: RaviAppScaffoldFileKind; path: string }[] = [
    { kind: "manifest", path: join(repoRoot, "src", "apps", ...id.split("/"), RAVI_APP_MANIFEST_FILE) },
    { kind: "spec", path: join(repoRoot, ".ravi", "specs", "apps", ...id.split("/"), "SPEC.md") },
    { kind: "skill", path: join(repoRoot, "src", "plugins", "internal", "ravi-system", "skills", appSlug, "SKILL.md") },
  ];

  const anyExists = candidates.some((c) => existsSync(c.path));
  if (!anyExists) {
    throw new RaviAppError("not_found", `App not found: ${id}. No scaffold-owned artifacts exist.`, [
      { kind: "app", detail: id },
    ]);
  }

  const files: RaviAppDeleteFileResult[] = candidates.map((c) => {
    const exists = existsSync(c.path);
    if (!exists) return { kind: c.kind, path: c.path, action: "not_found" as const };
    if (!dryRun) rmSync(c.path, { force: true });
    return { kind: c.kind, path: c.path, action: dryRun ? ("planned" as const) : ("deleted" as const) };
  });

  const removedDirs: string[] = [];
  if (!dryRun) {
    const scaffoldDirs = [
      join(repoRoot, "src", "apps", ...id.split("/")),
      join(repoRoot, ".ravi", "specs", "apps", ...id.split("/")),
      join(repoRoot, "src", "plugins", "internal", "ravi-system", "skills", appSlug),
    ];
    for (const dir of scaffoldDirs) {
      if (existsSync(dir) && isEmptyDir(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removedDirs.push(dir);
      }
    }
  }

  return {
    id,
    dryRun,
    files,
    removedDirs,
    nextCommands: ["ravi apps list --json", "ravi apps check --json"],
  };
}

function isEmptyDir(dirPath: string): boolean {
  try {
    return readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
