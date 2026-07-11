/**
 * Skills Commands - install, inspect and sync Ravi skills.
 */

import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { syncCodexSkills } from "../../plugins/codex-skills.js";
import { discoverPlugins } from "../../plugins/index.js";
import {
  discoverSkills,
  findSkillByName,
  findInstalledSkill,
  installSkills,
  listCatalogSkills,
  listInstalledSkills,
  selectSkills,
  withResolvedSkillSource,
  type RaviSkill,
} from "../../skills/manager.js";
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";
import {
  skillShowReturnSchema,
  skillsGuardReturnSchema,
  skillsInstallReturnSchema,
  skillsArchiveReturnSchema,
  skillsListReturnSchema,
  skillsSyncReturnSchema,
} from "./operational-return-schemas.js";
import { existsSync, readFileSync } from "node:fs";
import { applySkillGuard, archiveAgentCreatedSkill, type SkillGuardOp } from "../../skills/skill-guard.js";
import { getTaskDetails } from "../../tasks/service.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function serializeSkill(skill: RaviSkill, options: { includeContent?: boolean } = {}): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description ?? null,
    path: skill.path,
    skillFilePath: skill.skillFilePath,
    source: skill.source,
    pluginName: skill.pluginName ?? null,
    ...(options.includeContent ? { content: skill.content } : {}),
  };
}

function syncCodex(): string[] {
  return syncCodexSkills(discoverPlugins());
}

const SKILLS_GUARD_HELP_AFTER = `
DETERMINÍSTICO — a provenance é carimbada pelo runtime, não por você. Data (relógio),
agente, sessão, cadence-turn e task-id são resolvidos do RAVI_TASK_ID + profileInput.
Passe APENAS a decisão: --skill, --op, --content-file (e --description no create).

CONTEÚDO VAI POR ARQUIVO — nunca --content inline
  Markdown tem crases, $(...), aspas e newlines. Passar isso como --content de shell
  faz o shell EXECUTAR o comando entre crases e injetar a saída no conteúdo (visto ao
  vivo: help do bun vazou pra dentro de um SKILL.md). Escreva o markdown num arquivo e
  passe --content-file.

USE
  ✓ curador-skills aprendeu uma correção/técnica e vai PATCH numa skill que criou
  ✓ nenhuma skill cobre a classe → CREATE uma umbrella class-level nova

NÃO USE
  ✗ editar SKILL.md com Write/Edit direto — sempre passe pelo guard
  ✗ patchar skill de catálogo/hub (cli-creator, agents-manager, …) → rejeitado 'protected'

REGRAS HARD (o guard bloqueia)
  • I10 allowlist: PATCH só em skill agent-created (marcador origin: agent-created).
    Catálogo/hub/hand-authored são read-only pro loop.
  • CREATE exige --description; rejeita se a skill já existe (use --op patch).
  • Escrita atômica (temp+rename); provenance sempre carimbada.

EXAMPLES
  # patch (escreva o tmp com a Write tool primeiro):
  ravi skills guard --skill minha-skill --op patch --content-file /tmp/skill-minha.md --json
  # create:
  ravi skills guard --skill nova-umbrella --op create --description "quando usar" --content-file /tmp/skill-nova.md --json
  # dry-run (não toca disco):
  ravi skills guard --skill minha-skill --op patch --content-file /tmp/x.md --dry-run --json

ON ERROR (reason → fix)
  not-found          → skill não existe no dir editável. É CREATE (nome novo) ou pule.
  protected          → skill não é agent-created (catálogo/hub). Não force; use CREATE p/ classe nova.
  exists             → CREATE num nome já existente → troque p/ --op patch.
  missing-description→ CREATE sem --description → adicione.
  invalid-name       → --skill vazio/whitespace.

PIPELINE
  runtime skill-nudge → dispatch curador-skills → [ravi skills guard] → SKILL.md (agent-editable)

SEE ALSO
  ravi skills list / show   (descobrir a lib antes de escrever)
  ravi memory guard         (o gêmeo determinístico pra memória)

FONTES
  learning-loop/skill-curation SPEC (I10/I11) · src/skills/skill-guard.ts · 2026-07-10
`;

const SKILLS_ARCHIVE_HELP_AFTER = `
RECUPERÁVEL — move a skill para \`<plugin>/.archive/<slug>/\` (I14: o loop arquiva,
nunca deleta duro). Sai do path de discovery mas continua no disco. Default é
DRY-RUN (preview); só arquiva de verdade com --force.

USE
  ✓ retirar skill agent-created que virou lixo (artefato de teste, superseded)
  ✓ contrapartida de \`skills guard\` para aposentar o que o loop criou

NÃO USE
  ✗ arquivar skill de catálogo/hub/hand-authored → rejeitado 'protected' (I10)
  ✗ delete irreversível — isto NÃO apaga; o dir fica em .archive/ pra restaurar

REGRAS HARD (o comando bloqueia)
  • I10 allowlist: só arquiva skill com 'origin: agent-created' no frontmatter.
  • Sem --force = dry-run (não toca no disco).

EXAMPLES
  ravi skills archive loop-e2e-cleanfix              # dry-run: mostra o que faria
  ravi skills archive loop-e2e-cleanfix --force      # arquiva (recuperável)
  ravi skills archive cli-creator --force --json     # → rejected protected (catálogo)

ON ERROR (reason → fix)
  not-found     → skill não existe no dir editável.
  protected     → não é agent-created (catálogo/hub) — não arquivável pelo loop.
  invalid-name  → nome vazio.

SEE ALSO
  ravi skills guard   (a escrita — create/patch)
  ravi skills list     (o que existe)

FONTES
  learning-loop/skill-curation (I10/I14) · src/skills/skill-guard.ts · 2026-07-10
`;

@Group({
  name: "skills",
  description: "Skill discovery, install and inspection tools",
  scope: "open",
})
export class SkillsCommands {
  @Command({
    name: "list",
    description: "List Ravi catalog skills, installed skills or source skills",
    aliases: ["ls"],
  })
  @CommandAccess({ kind: "read", resource: "skills", action: "list", risk: "low" })
  @Returns(skillsListReturnSchema)
  list(
    @Option({ flags: "--source <source>", description: "List skills available in a GitHub URL, git URL or local path" })
    source?: string,
    @Option({ flags: "--installed", description: "List operator-installed skills instead of the Ravi catalog" })
    installed?: boolean,
    @Option({ flags: "--codex", description: "Include materialized Codex skills" }) includeCodex?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <slug>", description: "Filter by canonical skill tag" }) tagSlug?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching skills to skip (default: 0)" }) offset?: string,
  ) {
    const discovered = source
      ? withResolvedSkillSource(source, (resolved) => discoverSkills(resolved))
      : installed === true || includeCodex === true
        ? listInstalledSkills({ includeCodex: includeCodex === true })
        : listCatalogSkills();
    const tagFilter = tagSlug?.trim() || null;
    const skills = filterItemsByCanonicalTag(discovered, "skill", tagFilter ?? undefined, (skill) => skill.name);
    const page = paginateCliItems(skills, { limit, offset });
    const pageSkills = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "skills", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageSkills.length,
      total: page.total,
      options: [
        "--source",
        source,
        installed ? "--installed" : null,
        includeCodex ? "--codex" : null,
        "--tag",
        tagFilter,
      ],
    });

    const sourceLabel = source ?? (installed === true || includeCodex === true ? "installed" : "catalog");

    const payload = {
      total: page.total,
      pagination,
      source: sourceLabel,
      ...(tagFilter ? { filters: { tag: tagFilter } } : {}),
      items: pageSkills.map((skill) => serializeSkill(skill)),
      skills: pageSkills.map((skill) => serializeSkill(skill)),
    };

    if (asJson) {
      printJson(payload);
    } else if (pageSkills.length === 0) {
      console.log(source ? "No skills found in source." : "No skills found.");
    } else {
      for (const skill of pageSkills) {
        const description = skill.description ? ` — ${skill.description.split("\n")[0]}` : "";
        console.log(`${skill.name}${description}`);
        console.log(`  ${skill.source} ${skill.path}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }

    return payload;
  }

  @Command({ name: "show", description: "Show a Ravi catalog skill, installed skill or source skill" })
  @CommandAccess({ kind: "read", resource: "skills", action: "show", risk: "low" })
  @Returns(skillShowReturnSchema)
  show(
    @Arg("name", { description: "Catalog skill name, installed skill name, or source skill name" }) name: string,
    @Option({ flags: "--source <source>", description: "Inspect skill from a GitHub URL, git URL or local path" })
    source?: string,
    @Option({ flags: "--installed", description: "Inspect only operator-installed/materialized skills" })
    installed?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const skill = source
      ? withResolvedSkillSource(source, (resolved) => {
          const skills = discoverSkills(resolved);
          return selectSkills(skills, { skill: name })[0] ?? null;
        })
      : installed === true
        ? findInstalledSkill(name)
        : (findSkillByName(listCatalogSkills(), name) ?? findInstalledSkill(name));

    if (!skill) {
      fail(`Skill not found: ${name}`);
    }

    const payload = { skill: serializeSkill(skill, { includeContent: true }) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`# ${skill.name}`);
      if (skill.description) console.log(`\n${skill.description}\n`);
      console.log(`Path: ${skill.path}`);
      console.log("");
      console.log(skill.content);
    }
    return payload;
  }

  @Command({ name: "install", description: "Install Ravi catalog skills or skills from an explicit source" })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "install", risk: "high" })
  @Returns(skillsInstallReturnSchema)
  install(
    @Arg("name", {
      required: false,
      description: "Skill name. Defaults to the Ravi catalog unless --source is passed",
    })
    name?: string,
    @Option({ flags: "--source <source>", description: "Install from a GitHub URL, git URL or local path" })
    source?: string,
    @Option({ flags: "--skill <name>", description: "Legacy alias for the skill name" }) skillName?: string,
    @Option({ flags: "--all", description: "Install all skills found in source" }) all?: boolean,
    @Option({ flags: "--plugin <name>", description: "User plugin bucket (default: ravi-user-skills)" })
    plugin?: string,
    @Option({ flags: "--overwrite", description: "Replace existing installed skill" }) overwrite?: boolean,
    @Option({ flags: "--skip-codex-sync", description: "Do not immediately sync materialized Codex skills" })
    skipCodexSync?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const requestedSkill = normalizeRequestedSkillName(name, skillName);
    if (!requestedSkill && all !== true) {
      fail("Pass a skill name or --all.");
    }

    const installSelected = (available: RaviSkill[]) => {
      const selected = selectSkills(available, {
        ...(requestedSkill ? { skill: requestedSkill } : {}),
        all: all === true,
      });
      return installSkills(selected, {
        ...(plugin ? { pluginName: plugin } : {}),
        overwrite: overwrite === true,
      });
    };

    const installed = source
      ? withResolvedSkillSource(source, (resolved) => installSelected(discoverSkills(resolved)))
      : installSelected(listCatalogSkills());

    const codexSynced = skipCodexSync === true ? [] : syncCodex();
    const payload = {
      success: true,
      source: source ?? "catalog",
      installed: installed.map((skill) => ({
        ...serializeSkill(skill),
        installPath: skill.installPath,
      })),
      codexSynced,
    };

    if (asJson) {
      printJson(payload);
    } else {
      for (const skill of installed) {
        console.log(`✓ Installed skill: ${skill.name}`);
        console.log(`  ${skill.installPath}`);
      }
      if (skipCodexSync !== true) {
        console.log(`Synced Codex skills: ${codexSynced.length}`);
      }
    }
    return payload;
  }

  @Command({ name: "sync", description: "Sync Ravi plugin skills into the Codex skills directory" })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "sync", risk: "high" })
  @Returns(skillsSyncReturnSchema)
  sync(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const codexSynced = syncCodex();
    const payload = {
      success: true,
      codexSynced,
      total: codexSynced.length,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Synced Codex skills: ${codexSynced.length}`);
    }
    return payload;
  }

  @Command({
    name: "guard",
    description:
      "Route a skill write (patch/create) through the enforcement layer — the curador-skills agent MUST call this instead of editing SKILL.md directly. Enforces protected-skill (I10), provenance, and atomic write. Writes only under the agent-editable user skills plugin dir.",
    helpAfter: SKILLS_GUARD_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "guard", risk: "medium" })
  @Returns(skillsGuardReturnSchema)
  guard(
    @Option({ flags: "--skill <name>", description: "Skill name to patch/create (agent-editable user skills only)" })
    skill?: string,
    @Option({ flags: "--op <op>", description: "'patch' (append a learned section) | 'create' (new umbrella skill)" })
    op?: string,
    @Option({
      flags: "--content <text>",
      description: "Inline content — patch: the learned pitfall/correction; create: the SKILL.md body",
    })
    content?: string,
    @Option({ flags: "--content-file <path>", description: "File with the content (alternative to --content)" })
    contentFile?: string,
    @Option({ flags: "--description <text>", description: "Skill description (required for create)" })
    description?: string,
    @Option({ flags: "--agent <id>", description: "Agent id whose skill this is (provenance)" })
    agentId?: string,
    @Option({ flags: "--session-key <key>", description: "Originating session (provenance)" })
    sessionKey?: string,
    @Option({ flags: "--cadence-turn <n>", description: "Cadence turn (provenance)" })
    cadenceTurn?: string,
    @Option({ flags: "--task-id <id>", description: "Curador task id (provenance)" })
    taskId?: string,
    @Option({ flags: "--date <iso>", description: "Absolute ISO date for 'today' (provenance)" })
    date?: string,
    @Option({ flags: "--dry-run", description: "Compute the write outcome without touching disk" })
    dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const skillName = skill?.trim();
    if (!skillName) {
      fail("--skill is required");
    }
    const normalizedOp = op?.trim();
    if (normalizedOp !== "patch" && normalizedOp !== "create") {
      fail("--op must be 'patch' or 'create'");
    }
    if (contentFile?.trim() && content?.trim()) {
      fail("--content and --content-file are mutually exclusive");
    }
    let resolvedContent = content ?? "";
    if (contentFile?.trim()) {
      if (!existsSync(contentFile.trim())) {
        fail(`--content-file not found: ${contentFile}`);
      }
      resolvedContent = readFileSync(contentFile.trim(), "utf-8");
    }
    if (!resolvedContent.trim()) {
      fail("provide --content or --content-file");
    }

    // Provenance is DETERMINISTIC — resolved from the system clock + the runtime
    // context (the running curador task), NOT typed by the LLM. The curador only
    // decides content/skill/op; date, agent, session, cadence and task-id are
    // facts the runtime already owns. Flags remain as optional overrides (tests /
    // manual dispatch); when absent they are resolved deterministically.
    const prov = resolveDeterministicProvenance({
      agentId,
      sessionKey,
      cadenceTurn,
      taskId,
      date,
    });
    const decision = applySkillGuard({
      skillName: skillName!,
      op: normalizedOp as SkillGuardOp,
      content: resolvedContent,
      agentId: prov.agentId,
      ...(description?.trim() ? { description: description.trim() } : {}),
      provenance: {
        ...(prov.sessionKey ? { sessionKey: prov.sessionKey } : {}),
        ...(prov.cadenceTurn ? { cadenceTurn: prov.cadenceTurn } : {}),
        ...(prov.taskId ? { taskId: prov.taskId } : {}),
        date: prov.date,
      },
      ...(dryRun ? { dryRun: true } : {}),
    });

    const payload = {
      outcome: decision.outcome,
      op: normalizedOp as SkillGuardOp,
      skill: skillName!,
      ...("reason" in decision ? { reason: decision.reason } : {}),
      ...("detail" in decision ? { detail: decision.detail } : {}),
      ...("path" in decision ? { path: decision.path } : {}),
      ...("finalChars" in decision ? { finalChars: decision.finalChars } : {}),
      dryRun: Boolean(dryRun),
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(
        `skills guard ${payload.dryRun ? "(dry-run) " : ""}→ ${payload.outcome.toUpperCase()} (${payload.op})`,
      );
      if (payload.reason) console.log(`  reason: ${payload.reason}`);
      if (payload.detail) console.log(`  detail: ${payload.detail}`);
      if (payload.path) console.log(`  path:   ${payload.path}`);
    }
    return payload;
  }

  @Command({
    name: "archive",
    description:
      "Archive an agent-created skill — move it to `<plugin>/.archive/` (RECOVERABLE; the loop archives, never hard-deletes, per I14). Retirement counterpart of `guard` — same I10 allowlist: only skills carrying `origin: agent-created` in frontmatter can be archived; catalog/hub/hand-authored skills are protected. Pass --force to actually archive (default is a dry-run preview).",
    helpAfter: SKILLS_ARCHIVE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "archive", risk: "medium" })
  @Returns(skillsArchiveReturnSchema)
  archive(
    @Arg("name", { description: "Skill name to archive (agent-created only)" }) name?: string,
    @Option({ flags: "--skill <name>", description: "Skill name (alternative to positional)" }) skillFlag?: string,
    @Option({ flags: "--force", description: "Actually archive (without it, dry-run preview only)" }) force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const skillName = normalizeRequestedSkillName(name, skillFlag);
    if (!skillName) {
      fail("skill name is required (positional or --skill)");
    }
    const decision = archiveAgentCreatedSkill(skillName!, undefined, !force);
    const payload = {
      outcome: decision.outcome,
      skill: "skill" in decision ? decision.skill : skillName!,
      ...("reason" in decision ? { reason: decision.reason } : {}),
      ...("detail" in decision ? { detail: decision.detail } : {}),
      ...("path" in decision ? { path: decision.path } : {}),
      ...("archivedTo" in decision ? { archivedTo: decision.archivedTo } : {}),
      dryRun: !force,
    };
    if (asJson) {
      printJson(payload);
    } else {
      const verb = payload.dryRun ? "(dry-run) would archive" : "archived";
      console.log(
        payload.outcome === "archived"
          ? `skills archive → ${verb} "${payload.skill}"${payload.archivedTo ? ` → ${payload.archivedTo}` : ""}`
          : `skills archive → REJECTED (${payload.reason}): ${payload.detail}`,
      );
      if (payload.dryRun && payload.outcome === "archived") console.log("  (pass --force to actually archive)");
    }
    return payload;
  }
}

/**
 * Resolve skill-write provenance DETERMINISTICALLY — the Hermes "keep the LLM
 * out of deterministic paths" principle. The date comes from the system clock;
 * agent/session/cadence/task come from the running curador task, resolved via
 * the `RAVI_TASK_ID` env var the runtime injects into every task tool-exec
 * (buildTaskRuntimeEnv) → the task's profileInput (which the nudge stamped at
 * dispatch with agent_id / cadence_turn / originator_session). Explicit flags
 * win (they exist for unit tests and manual dispatch); everything else is a fact
 * the runtime already owns, never something the curador should hand-type.
 *
 * NB: the CLI's RAVI_CONTEXT_KEY resolves an IDENTITY-LESS capability context
 * (no sessionName), so it cannot source provenance — RAVI_TASK_ID is the
 * reliable, runtime-injected signal.
 */
export function resolveDeterministicProvenance(
  overrides: {
    agentId?: string;
    sessionKey?: string;
    cadenceTurn?: string;
    taskId?: string;
    date?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): { agentId: string; sessionKey?: string; cadenceTurn?: string; taskId?: string; date: string } {
  // Date is always the system date unless a test/manual override is supplied —
  // never resolved by the LLM (a relative expression persisted = corruption).
  const date = overrides.date?.trim() || new Date().toISOString().slice(0, 10);

  const taskId = overrides.taskId?.trim() || env.RAVI_TASK_ID?.trim();
  let sessionKey = overrides.sessionKey?.trim();
  let cadenceTurn = overrides.cadenceTurn?.trim();
  let agentId = overrides.agentId?.trim();

  if (taskId) {
    try {
      const pin = getTaskDetails(taskId).task?.profileInput as Record<string, string> | undefined;
      if (pin) {
        cadenceTurn = cadenceTurn || pin.cadence_turn;
        sessionKey = sessionKey || pin.originator_session;
        agentId = agentId || pin.agent_id;
      }
    } catch {
      // Best-effort: a missing/unreadable task falls back to flags + env.
    }
  }

  agentId = agentId || env.RAVI_AGENT_ID?.trim() || "unknown";
  return {
    agentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(cadenceTurn ? { cadenceTurn } : {}),
    ...(taskId ? { taskId } : {}),
    date,
  };
}

function normalizeRequestedSkillName(name?: string, skillName?: string): string | undefined {
  const positional = name?.trim();
  const flag = skillName?.trim();
  if (positional && flag && positional !== flag) {
    fail(`Conflicting skill names: ${positional} and ${flag}`);
  }
  return positional || flag || undefined;
}
