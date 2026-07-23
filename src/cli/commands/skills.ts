/**
 * Skills Commands - install, inspect and sync Ravi skills.
 */

import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { syncCodexSkills } from "../../plugins/codex-skills.js";
import { discoverPlugins } from "../../plugins/index.js";
import {
  getAgent,
  getAllAgents,
  dbListAgentsForSkill,
  dbListSkillGrants,
  dbListSkillGrantsForAgent,
  dbUpsertSkillGrant,
  dbDeleteSkillGrant,
  type DbSkillGrant,
} from "../../router/index.js";
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
import { acceptSkillCreate } from "../../skills/skill-acceptance.js";
import { applySkillGuard, archiveAgentCreatedSkill, type SkillGuardOp } from "../../skills/skill-guard.js";
import { filterItemsByCanonicalTag } from "../../tags/helpers.js";
import { resolveAgentSkills } from "../../runtime/allowed-skills.js";
import { getTaskDetails } from "../../tasks/service.js";
import {
  skillGrantBatchReturnSchema,
  skillGrantMutationReturnSchema,
  skillGrantWhoReturnSchema,
  skillInspectReturnSchema,
  skillShowReturnSchema,
  skillsArchiveReturnSchema,
  skillsGuardReturnSchema,
  skillsInstallReturnSchema,
  skillsListReturnSchema,
  skillsSyncReturnSchema,
} from "./operational-return-schemas.js";

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

const SKILLS_LIST_HELP_AFTER = `
LEITURA — descobre skills. Três universos: catálogo (default), instaladas (--installed)
e uma fonte externa (--source GitHub/git/path). Paginado (default 50, máx 500).

USE
  ✓ descobrir o nome canônico de uma skill antes de grant/show/install
  ✓ auditar o que já está instalado (--installed) ou o que uma fonte oferece (--source)

NÃO USE
  ✗ ver a allowlist resolvida de um AGENTE → \`ravi skills inspect <agent>\`
  ✗ ver quem tem um grant → \`ravi skills who <skill>\`

EXAMPLES
  ravi skills list                              # catálogo (primeira página)
  ravi skills list --installed --json           # instaladas, JSON
  ravi skills list --tag da/gtm --limit 100     # filtra por tag canônica
  ravi skills list --source github:org/repo     # skills de uma fonte externa
  ravi skills list --json --limit 50 --offset 50  # próxima página

FORMATO
  Saída humana: "<nome> — <1ª linha da descrição>" + source/path. --json traz
  { total, pagination.nextCommand, items[] } — siga nextCommand pra paginar.

SEE ALSO
  ravi skills show <name>      (conteúdo completo de uma skill)
  ravi skills inspect <agent>  (allowlist resolvida de um agente)

FONTES
  src/cli/commands/skills.ts · src/skills/manager.ts · 2026-07-10
`;

const SKILLS_SHOW_HELP_AFTER = `
LEITURA — imprime o SKILL.md completo (frontmatter + corpo) de uma skill.

USE
  ✓ ler a skill inteira antes de patchar (guard) ou de decidir grantar
  ✓ inspecionar uma skill de fonte externa antes de instalar (--source)

NÃO USE
  ✗ só descobrir nomes → \`ravi skills list\` (não despeja o corpo inteiro)

EXAMPLES
  ravi skills show cli-creator
  ravi skills show emissao-nf-sde --installed --json
  ravi skills show minha-skill --source ./local/path

ON ERROR (reason → fix)
  Skill not found → nome errado ou universo errado. Rode \`ravi skills list\`
                    (+ --installed/--source conforme o caso) pra achar o nome canônico.

SEE ALSO
  ravi skills list · ravi skills guard (editar) · ravi skills inspect

FONTES
  src/cli/commands/skills.ts · 2026-07-10
`;

const SKILLS_INSTALL_HELP_AFTER = `
MUTA — instala skill(s) no bucket de plugin do operador e sincroniza Codex.
Destrutivo com --overwrite (substitui a instalada). Risco: high.

USE
  ✓ trazer skill do catálogo Ravi ou de uma fonte (GitHub/git/path) pro sistema
  ✓ instalar em massa de uma fonte com --all

NÃO USE
  ✗ criar skill nova via loop de curadoria → \`ravi skills guard --op create\`
  ✗ dar visibilidade a um agente → isso é grant, não install (\`skills grant\`)

REGRAS HARD (o comando bloqueia)
  • Exige um nome OU --all (senão fail "Pass a skill name or --all.").
  • --overwrite é a única forma de substituir uma já instalada (fail-safe).

EXAMPLES
  ravi skills install cli-creator                       # do catálogo
  ravi skills install --source github:org/repo --all    # tudo de uma fonte
  ravi skills install minha --source ./path --overwrite --json

ON ERROR (reason → fix)
  Pass a skill name or --all → passe o nome ou --all.
  já instalada (sem efeito)  → use --overwrite pra substituir.

SEE ALSO
  ravi skills list --source <src>  (ver antes de instalar)
  ravi skills sync                 (re-materializar Codex sem instalar)

FONTES
  src/cli/commands/skills.ts · src/skills/manager.ts · 2026-07-10
`;

const SKILLS_SYNC_HELP_AFTER = `
MUTA (idempotente) — materializa as skills dos plugins Ravi no diretório de skills
do Codex. Não instala nada novo; só re-sincroniza o que já existe. Risco: high.

USE
  ✓ reconciliar o diretório Codex depois de instalar/editar skills manualmente
  ✓ garantir que uma skill recém-editada apareça pro runtime Codex

NÃO USE
  ✗ trazer skill de fora → \`ravi skills install --source ...\`

EXAMPLES
  ravi skills sync
  ravi skills sync --json     # { synced: N }

SEE ALSO
  ravi skills install (instala + sincroniza) · ravi skills list --codex

FONTES
  src/cli/commands/skills.ts · src/plugins/codex-skills.ts · 2026-07-10
`;

const SKILLS_GRANT_HELP_AFTER = `
MUTA (idempotente/upsert) — dá visibilidade de UMA skill a UM agente (per-agent
visibility). A allowlist do agente = baseline ∪ derivadas-de-capability ∪ grants.
Efeito é AO VIVO: \`resolveAgentSkills\` lê o grant do DB por chamada — sem restart.

USE
  ✓ liberar uma skill específica pra um agente específico
  ✓ cobrir gap: skill de plugin que a derivação por-capability não pega (ex: cli-creator)

NÃO USE
  ✗ abrir várias skills / vários agentes → \`ravi skills grant-batch\` (lote)
  ✗ instalar a skill no sistema → isso é \`skills install\` (grant ≠ install)

REGRAS HARD (o comando bloqueia)
  • Agente precisa existir (fail "Agent not found").
  • Skill precisa existir no catálogo/instaladas (fail "Skill not found") — instale antes.
  • Grava o nome CANÔNICO (SKILL.md name), não o input cru.

EXAMPLES
  ravi skills grant ravi-dev cli-creator --note "core dev skill"
  ravi skills grant jarvis-fiscal emissao-nf-sde --json

ON ERROR (reason → fix)
  Agent not found → confira \`ravi agents list\`.
  Skill not found → confira \`ravi skills list\`; instale/publique antes de grantar.

PIPELINE
  skills list (achar nome) → [skills grant] → skills inspect <agent> (verificar allowlist)

SEE ALSO
  ravi skills grant-batch (lote) · ravi skills revoke (reverter) · ravi skills who <skill>

FONTES
  src/cli/commands/skills.ts · src/runtime/allowed-skills.ts · 2026-07-10
`;

const SKILLS_REVOKE_HELP_AFTER = `
MUTA — remove UM grant de UM agente. Contrapartida de \`grant\`. Efeito ao vivo
(DB lido por chamada). Só afeta grants explícitos — NÃO remove skills que o agente
recebe por baseline ou capability (essas vêm de permissions, não de grant).

USE
  ✓ tirar a visibilidade de uma skill que foi grantada explicitamente

NÃO USE
  ✗ tirar em massa → \`ravi skills revoke-batch\`
  ✗ tirar uma skill que vem de capability → ajuste a permission/capability, não o grant

EXAMPLES
  ravi skills revoke ravi-dev cli-creator
  ravi skills revoke jarvis-fiscal emissao-nf-sde --json

ON ERROR / RESULTADO
  success:false → não havia grant explícito com esse nome (idempotente, não é erro).
                  Se a skill ainda aparece em \`inspect\`, ela vem de baseline/capability.

SEE ALSO
  ravi skills grant (o inverso) · ravi skills inspect <agent> (conferir depois)

FONTES
  src/cli/commands/skills.ts · src/runtime/allowed-skills.ts · 2026-07-10
`;

const SKILLS_GRANT_BATCH_HELP_AFTER = `
MUTA EM LOTE (idempotente/upsert) — aplica grants sobre MUITOS pares (agente × skill)
numa chamada só. Reusa o mesmo mecanismo do \`grant\`. Efeito ao vivo: os grants valem
na próxima interação de cada agente SEM restart do daemon. Risco: high.

EIXOS (obrigatório escolher um de cada)
  agente: --agent <id>  XOR  --all-agents
  skill:  --skill <name> XOR  --all-skills

USE
  ✓ "tudo pra todos" (--all-agents --all-skills) e depois curar
  ✓ abrir uma skill pra toda a frota (--all-agents --skill X)
  ✓ abrir todas as skills pra um agente (--agent A --all-skills)

NÃO USE
  ✗ um par só → \`ravi skills grant <agent> <skill>\` (mais simples)
  ✗ sem saber o volume → rode com --dry-run PRIMEIRO

REGRAS HARD (o comando bloqueia)
  • --agent e --all-agents juntos → erro "not both". Idem --skill/--all-skills.
  • Falta de eixo → erro "Specify an agent/skill axis".
  • Agente inexistente / skill inexistente → fail antes de qualquer escrita.

CUSTO / SEGURANÇA
  • --all-agents --all-skills escreve (nº de agentes × nº de skills) grants — costuma
    ser MUITA linha. O total exato é sempre o que o --dry-run reporta AGORA (fonte viva).
  • Sempre --dry-run antes do write real (mostra a contagem atual, não toca no DB).
  • Reversível: \`ravi skills revoke-batch\` com os MESMOS eixos.

EXAMPLES
  ravi skills grant-batch --all-agents --all-skills --dry-run          # preview a contagem atual
  ravi skills grant-batch --all-agents --all-skills --note "open" --json
  ravi skills grant-batch --agent ravi-dev --all-skills                # tudo p/ 1 agente
  ravi skills grant-batch --all-agents --skill cli-creator             # 1 skill p/ todos

ON ERROR (reason → fix)
  Specify an agent axis → passe --agent <id> OU --all-agents.
  Specify a skill axis  → passe --skill <name> OU --all-skills.
  not both              → escolha só um lado de cada eixo.
  Agent not found       → confira \`ravi agents list\`.
  Skill not found       → confira \`ravi skills list\`.

PIPELINE
  grant-batch (abrir amplo) → curadoria → revoke-batch + grant seletivo (estreitar)

SEE ALSO
  ravi skills revoke-batch (o inverso) · ravi skills grant (par único) · ravi skills inspect

FONTES
  src/cli/commands/skills.ts · src/runtime/allowed-skills.ts · 2026-07-10
`;

const SKILLS_REVOKE_BATCH_HELP_AFTER = `
MUTA EM LOTE — remove grants sobre MUITOS pares (agente × skill) numa chamada.
Contrapartida de \`grant-batch\`, MESMOS eixos. Efeito ao vivo (sem restart).
Só remove grants explícitos; skills de baseline/capability continuam. Risco: high.

EIXOS (obrigatório escolher um de cada)
  agente: --agent <id>  XOR  --all-agents
  skill:  --skill <name> XOR  --all-skills

USE
  ✓ desfazer um "tudo pra todos" antes de curar per-agente
  ✓ fechar uma skill em toda a frota (--all-agents --skill X)

NÃO USE
  ✗ um par só → \`ravi skills revoke <agent> <skill>\`
  ✗ esperar que remova skill vinda de capability → ajuste a permission, não o grant

REGRAS HARD (o comando bloqueia)
  • Eixos exclusivos (não passar os dois lados); falta de eixo → fail.

CUSTO / SEGURANÇA
  • --all-agents --all-skills zera TODOS os grants explícitos da frota. --dry-run antes.
  • Não destrói skills nem permissions — só os grants explícitos.

EXAMPLES
  ravi skills revoke-batch --all-agents --all-skills --dry-run     # preview
  ravi skills revoke-batch --all-agents --all-skills --json        # fecha tudo
  ravi skills revoke-batch --all-agents --skill emissao-nf-sde     # fecha 1 skill p/ todos

ON ERROR (reason → fix)
  Specify an agent/skill axis → passe o eixo faltante.
  not both                    → só um lado de cada eixo.

SEE ALSO
  ravi skills grant-batch (o inverso) · ravi skills revoke (par único) · ravi skills inspect

FONTES
  src/cli/commands/skills.ts · src/runtime/allowed-skills.ts · 2026-07-10
`;

const SKILLS_INSPECT_HELP_AFTER = `
LEITURA — resolve e mostra a allowlist EFETIVA de um agente:
baseline ∪ derivadas-de-capability ∪ grants. É a verdade do que o agente enxerga.

USE
  ✓ conferir o efeito de um grant/revoke (antes/depois)
  ✓ auditar por que um agente vê (ou não vê) uma skill

NÃO USE
  ✗ listar o catálogo global → \`ravi skills list\`
  ✗ ver quem tem UM grant → \`ravi skills who <skill>\`

FORMATO
  --json: { agentId, hasConfiguration, allowlist[], provenance{ baseline, fromCapabilities,
  fromGrants } }. hasConfiguration=false → agente é grandfathered (vê tudo, sem filtro).

EXAMPLES
  ravi skills inspect ravi-dev
  ravi skills inspect jarvis-fiscal --json | jq '.provenance'

ON ERROR (reason → fix)
  Agent not found → confira \`ravi agents list\`.

SEE ALSO
  ravi skills grant/revoke (mudar) · ravi skills who (por skill) · ravi agents list

FONTES
  src/cli/commands/skills.ts · src/runtime/allowed-skills.ts · 2026-07-10
`;

const SKILLS_WHO_HELP_AFTER = `
LEITURA — lista grants. Por SKILL (posicional): quais agentes têm o grant.
Por AGENTE (--agent): quais grants aquele agente tem. Sem argumento: todos os grants.

⚠️ O posicional é NOME DE SKILL, não agente. Pra grants de um agente use --agent.

USE
  ✓ auditar quem recebeu uma skill (\`who <skill>\`)
  ✓ listar os grants explícitos de um agente (\`who --agent <id>\`)

NÃO USE
  ✗ ver a allowlist RESOLVIDA (com baseline/capability) → \`ravi skills inspect <agent>\`
    (who só mostra grants explícitos, não o que vem de permission)

EXAMPLES
  ravi skills who cli-creator            # agentes com esse grant
  ravi skills who --agent ravi-dev       # grants do ravi-dev
  ravi skills who --json                 # todos os grants do sistema

FORMATO
  --json: { skillName?, total, grants[] }. skillName omitido quando o escopo é por-agente.

SEE ALSO
  ravi skills inspect <agent> (allowlist completa) · ravi skills grant/revoke

FONTES
  src/cli/commands/skills.ts · 2026-07-10
`;

const SKILLS_GUARD_HELP_AFTER = `
DETERMINISTIC WRITE GATE — routes skill create/patch through the enforcement layer.
The curator decides skill, op and markdown content; runtime facts stamp provenance.

USE
  ✓ curador-skills learned a durable technique and will patch an agent-created skill
  ✓ no skill covers the class yet and the loop needs a new agent-created umbrella

NÃO USE
  ✗ edit SKILL.md directly from the curator
  ✗ patch catalog, hub-installed or hand-authored skills — rejected as protected

REGRAS HARD
  • Content must come from --content-file; inline shell content is intentionally unsupported.
  • PATCH requires origin: agent-created in SKILL.md frontmatter.
  • CREATE requires --description and fails if the skill already exists.
  • Writes are atomic and stamp date/session/cadence/task provenance when available.

EXAMPLES
  ravi skills guard --skill minha-skill --op patch --content-file /tmp/learned.md --dry-run --json
  ravi skills guard --skill nova-umbrella --op create --description "quando usar" --content-file /tmp/body.md --json

ON ERROR
  not-found → patch target is absent; create a new skill or skip.
  protected → target was not created by this loop; create a new umbrella instead.
  exists → create target already exists; use patch.

SEE ALSO
  ravi skills show · ravi skills list · ravi memory guard

FONTES
  src/cli/commands/skills.ts · src/skills/skill-guard.ts · 2026-07-22
`;

const SKILLS_ARCHIVE_HELP_AFTER = `
RECOVERABLE ARCHIVE — moves an agent-created skill to the user skills archive.
Default is dry-run; pass --force to actually move the directory.

USE
  ✓ retire a skill created by the learning loop that became obsolete

NÃO USE
  ✗ archive catalog, hub-installed or hand-authored skills — rejected as protected
  ✗ irreversible deletion — this command never hard-deletes a skill

REGRAS HARD
  • Only origin: agent-created skills can be archived.
  • Without --force, no filesystem mutation is performed.

EXAMPLES
  ravi skills archive loop-example --json
  ravi skills archive loop-example --force --json

ON ERROR
  not-found → no editable skill with that name exists.
  protected → skill is not agent-created.

SEE ALSO
  ravi skills guard · ravi skills list

FONTES
  src/cli/commands/skills.ts · src/skills/skill-guard.ts · 2026-07-22
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
    helpAfter: SKILLS_LIST_HELP_AFTER,
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

  @Command({
    name: "show",
    description: "Show a Ravi catalog skill, installed skill or source skill",
    helpAfter: SKILLS_SHOW_HELP_AFTER,
  })
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

  @Command({
    name: "install",
    description: "Install Ravi catalog skills or skills from an explicit source",
    helpAfter: SKILLS_INSTALL_HELP_AFTER,
  })
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

  @Command({
    name: "sync",
    description: "Sync Ravi plugin skills into the Codex skills directory",
    helpAfter: SKILLS_SYNC_HELP_AFTER,
  })
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
      "Route an agent-created skill write through the deterministic guard. Supports patch/create, enforces protected-skill allowlist and writes atomically.",
    helpAfter: SKILLS_GUARD_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "guard", risk: "medium" })
  @Returns(skillsGuardReturnSchema)
  guard(
    @Option({ flags: "--skill <name>", description: "Skill name to patch/create" }) skill?: string,
    @Option({ flags: "--op <op>", description: "patch|create" }) op?: string,
    @Option({ flags: "--content-file <path>", description: "Markdown file with patch/create content" })
    contentFile?: string,
    @Option({ flags: "--description <text>", description: "Skill description; required for create" })
    description?: string,
    @Option({ flags: "--agent <id>", description: "Override provenance agent id" }) agentId?: string,
    @Option({ flags: "--session-key <key>", description: "Override provenance session key" }) sessionKey?: string,
    @Option({ flags: "--cadence-turn <n>", description: "Override provenance cadence turn" }) cadenceTurn?: string,
    @Option({ flags: "--task-id <id>", description: "Override provenance curator task id" }) taskId?: string,
    @Option({ flags: "--date <iso>", description: "Override provenance date (YYYY-MM-DD)" }) date?: string,
    @Option({ flags: "--dry-run", description: "Compute result without writing" }) dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const skillName = skill?.trim();
    if (!skillName) fail("--skill is required");
    const normalizedOp = op?.trim();
    if (normalizedOp !== "patch" && normalizedOp !== "create") {
      fail("--op must be 'patch' or 'create'");
    }
    const file = contentFile?.trim();
    if (!file) fail("--content-file is required");
    if (!existsSync(file)) fail(`--content-file not found: ${file}`);
    const content = readFileSync(file, "utf-8");
    if (!content.trim()) fail("--content-file is empty");

    const provenance = resolveDeterministicProvenance({ agentId, sessionKey, cadenceTurn, taskId, date });
    const guardInput = {
      skillName,
      op: normalizedOp as SkillGuardOp,
      content,
      agentId: provenance.agentId,
      ...(description?.trim() ? { description: description.trim() } : {}),
      provenance: {
        ...(provenance.sessionKey ? { sessionKey: provenance.sessionKey } : {}),
        ...(provenance.cadenceTurn ? { cadenceTurn: provenance.cadenceTurn } : {}),
        ...(provenance.taskId ? { taskId: provenance.taskId } : {}),
        date: provenance.date,
      },
      dryRun: dryRun === true,
    };
    const decision =
      normalizedOp === "create"
        ? acceptSkillCreate({ ...guardInput, op: "create" })
        : applySkillGuard({ ...guardInput, op: "patch" });
    const payload = {
      outcome: decision.outcome,
      op: normalizedOp as SkillGuardOp,
      skill: skillName,
      ...("reason" in decision ? { reason: decision.reason } : {}),
      ...("detail" in decision ? { detail: decision.detail } : {}),
      ...("path" in decision ? { path: decision.path } : {}),
      ...("finalChars" in decision ? { finalChars: decision.finalChars } : {}),
      ...("grant" in decision ? { grant: decision.grant } : {}),
      ...("visibleToAgent" in decision ? { visibleToAgent: decision.visibleToAgent } : {}),
      ...("idempotent" in decision ? { idempotent: decision.idempotent } : {}),
      dryRun: dryRun === true,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`skills guard${payload.dryRun ? " (dry-run)" : ""}: ${payload.outcome} (${payload.op})`);
      if (payload.reason) console.log(`  reason: ${payload.reason}`);
      if (payload.detail) console.log(`  detail: ${payload.detail}`);
      if (payload.path) console.log(`  path: ${payload.path}`);
    }
    return payload;
  }

  @Command({
    name: "archive",
    description: "Archive an agent-created skill recoverably; default is dry-run unless --force is passed.",
    helpAfter: SKILLS_ARCHIVE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "archive", risk: "medium" })
  @Returns(skillsArchiveReturnSchema)
  archive(
    @Arg("name", { required: false, description: "Skill name to archive" }) name?: string,
    @Option({ flags: "--skill <name>", description: "Skill name; alternative to positional" }) skillFlag?: string,
    @Option({ flags: "--force", description: "Actually archive; without this, dry-run only" }) force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const skillName = normalizeRequestedSkillName(name, skillFlag);
    if (!skillName) fail("skill name is required");
    const decision = archiveAgentCreatedSkill(skillName, undefined, force !== true);
    const payload = {
      outcome: decision.outcome,
      skill: "skill" in decision ? decision.skill : skillName,
      ...("reason" in decision ? { reason: decision.reason } : {}),
      ...("detail" in decision ? { detail: decision.detail } : {}),
      ...("path" in decision ? { path: decision.path } : {}),
      ...("archivedTo" in decision ? { archivedTo: decision.archivedTo } : {}),
      dryRun: force !== true,
    };
    if (asJson) {
      printJson(payload);
    } else if (payload.outcome === "archived") {
      console.log(
        `skills archive${payload.dryRun ? " (dry-run)" : ""}: ${payload.skill}${payload.archivedTo ? ` -> ${payload.archivedTo}` : ""}`,
      );
    } else {
      console.log(`skills archive: rejected (${payload.reason})`);
      if (payload.detail) console.log(`  detail: ${payload.detail}`);
    }
    return payload;
  }

  @Command({
    name: "grant",
    description: "Grant a custom skill to an agent (per-agent visibility). System skills follow permissions.",
    helpAfter: SKILLS_GRANT_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "grant", risk: "medium" })
  @Returns(skillGrantMutationReturnSchema)
  grant(
    @Arg("agent", { description: "Agent id (immutable)" }) agent: string,
    @Arg("skill", { description: "Skill name (matches SKILL.md name)" }) skill: string,
    @Option({ flags: "--note <text>", description: "Optional operator note" }) note?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agent?.trim();
    const skillName = skill?.trim();
    if (!agentId) fail("Agent id is required.");
    if (!skillName) fail("Skill name is required.");
    if (!getAgent(agentId)) {
      fail(`Agent not found: ${agentId}`);
    }
    const resolved =
      findSkillByName(listCatalogSkills(), skillName) ??
      findSkillByName(listInstalledSkills({ includeCodex: false }), skillName);
    if (!resolved) {
      fail(`Skill not found: ${skillName}. Install or publish it before granting.`);
    }

    const canonicalSkillName = resolved.name;
    const grant = dbUpsertSkillGrant({
      agentId,
      skillName: canonicalSkillName,
      ...(note?.trim() ? { note: note.trim() } : {}),
    });
    const payload = {
      success: true,
      agentId,
      skillName: canonicalSkillName,
      grant,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Granted ${canonicalSkillName} to ${agentId}`);
      if (grant.note) console.log(`  note: ${grant.note}`);
    }
    return payload;
  }

  @Command({
    name: "revoke",
    description: "Revoke a skill grant from an agent",
    helpAfter: SKILLS_REVOKE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "revoke", risk: "medium" })
  @Returns(skillGrantMutationReturnSchema)
  revoke(
    @Arg("agent", { description: "Agent id (immutable)" }) agent: string,
    @Arg("skill", { description: "Skill name" }) skill: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agent?.trim();
    const skillName = skill?.trim();
    if (!agentId) fail("Agent id is required.");
    if (!skillName) fail("Skill name is required.");
    const removed = dbDeleteSkillGrant(agentId, skillName);
    const payload = {
      success: removed,
      agentId,
      skillName,
    };
    if (asJson) {
      printJson(payload);
    } else if (removed) {
      console.log(`✓ Revoked ${skillName} from ${agentId}`);
    } else {
      console.log(`No grant found for ${skillName} on ${agentId}.`);
    }
    return payload;
  }

  @Command({
    name: "grant-batch",
    description:
      "Grant skills to agents in bulk. Reuses the per-agent grant mechanism across many (agent, skill) pairs in one call. Idempotent (upsert). Use --dry-run to preview.",
    helpAfter: SKILLS_GRANT_BATCH_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "grant", risk: "high" })
  @Returns(skillGrantBatchReturnSchema)
  grantBatch(
    @Option({ flags: "--agent <id>", description: "Target a single agent (mutually exclusive with --all-agents)" })
    agent?: string,
    @Option({ flags: "--all-agents", description: "Target every agent in the fleet" }) allAgents?: boolean,
    @Option({ flags: "--skill <name>", description: "Target a single skill (mutually exclusive with --all-skills)" })
    skill?: string,
    @Option({ flags: "--all-skills", description: "Target every catalog + installed skill" }) allSkills?: boolean,
    @Option({ flags: "--note <text>", description: "Optional operator note stamped on every grant" }) note?: string,
    @Option({ flags: "--dry-run", description: "Preview counts without writing any grant" }) dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentIds = this.resolveAgentAxis(agent, allAgents);
    const skillNames = this.resolveSkillAxis(skill, allSkills);
    const trimmedNote = note?.trim();

    const errors: Array<{ agentId: string; skillName: string; error: string }> = [];
    let affected = 0;
    for (const agentId of agentIds) {
      for (const skillName of skillNames) {
        if (dryRun) {
          affected++;
          continue;
        }
        try {
          dbUpsertSkillGrant({ agentId, skillName, ...(trimmedNote ? { note: trimmedNote } : {}) });
          affected++;
        } catch (err) {
          errors.push({ agentId, skillName, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    const payload = {
      op: "grant" as const,
      dryRun: Boolean(dryRun),
      agentsTargeted: agentIds.length,
      skillsTargeted: skillNames.length,
      pairsAffected: affected,
      pairsSkipped: agentIds.length * skillNames.length - affected - errors.length,
      errors,
      sampleAgents: agentIds.slice(0, 10),
      sampleSkills: skillNames.slice(0, 10),
    };
    if (asJson) printJson(payload);
    else this.printBatchSummary(payload);
    return payload;
  }

  @Command({
    name: "revoke-batch",
    description:
      "Revoke skill grants from agents in bulk — the retirement counterpart of grant-batch. Same axes (--agent/--all-agents × --skill/--all-skills). Use --dry-run to preview.",
    helpAfter: SKILLS_REVOKE_BATCH_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "skills", action: "revoke", risk: "high" })
  @Returns(skillGrantBatchReturnSchema)
  revokeBatch(
    @Option({ flags: "--agent <id>", description: "Target a single agent (mutually exclusive with --all-agents)" })
    agent?: string,
    @Option({ flags: "--all-agents", description: "Target every agent in the fleet" }) allAgents?: boolean,
    @Option({ flags: "--skill <name>", description: "Target a single skill (mutually exclusive with --all-skills)" })
    skill?: string,
    @Option({ flags: "--all-skills", description: "Target every catalog + installed skill" }) allSkills?: boolean,
    @Option({ flags: "--dry-run", description: "Preview counts without removing any grant" }) dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentIds = this.resolveAgentAxis(agent, allAgents);
    const skillNames = this.resolveSkillAxis(skill, allSkills);

    const errors: Array<{ agentId: string; skillName: string; error: string }> = [];
    let removed = 0;
    let notFound = 0;
    for (const agentId of agentIds) {
      for (const skillName of skillNames) {
        if (dryRun) {
          removed++;
          continue;
        }
        try {
          if (dbDeleteSkillGrant(agentId, skillName)) removed++;
          else notFound++;
        } catch (err) {
          errors.push({ agentId, skillName, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    const payload = {
      op: "revoke" as const,
      dryRun: Boolean(dryRun),
      agentsTargeted: agentIds.length,
      skillsTargeted: skillNames.length,
      pairsAffected: removed,
      pairsSkipped: notFound,
      errors,
      sampleAgents: agentIds.slice(0, 10),
      sampleSkills: skillNames.slice(0, 10),
    };
    if (asJson) printJson(payload);
    else this.printBatchSummary(payload);
    return payload;
  }

  /** Resolve the agent axis: exactly one of --agent / --all-agents. */
  private resolveAgentAxis(agent: string | undefined, allAgents: boolean | undefined): string[] {
    const single = agent?.trim();
    if (single && allAgents) fail("Use either --agent <id> or --all-agents, not both.");
    if (allAgents) {
      const ids = getAllAgents().map((a) => a.id);
      if (ids.length === 0) fail("No agents found.");
      return ids;
    }
    if (single) {
      if (!getAgent(single)) fail(`Agent not found: ${single}`);
      return [single];
    }
    fail("Specify an agent axis: --agent <id> or --all-agents.");
    return [];
  }

  /** Resolve the skill axis: exactly one of --skill / --all-skills. Returns canonical names. */
  private resolveSkillAxis(skill: string | undefined, allSkills: boolean | undefined): string[] {
    const single = skill?.trim();
    if (single && allSkills) fail("Use either --skill <name> or --all-skills, not both.");
    if (allSkills) {
      const names = new Set<string>();
      for (const s of listCatalogSkills()) names.add(s.name);
      for (const s of listInstalledSkills({ includeCodex: false })) names.add(s.name);
      if (names.size === 0) fail("No skills found in catalog or installed set.");
      return [...names].sort();
    }
    if (single) {
      const resolved =
        findSkillByName(listCatalogSkills(), single) ??
        findSkillByName(listInstalledSkills({ includeCodex: false }), single);
      if (!resolved) fail(`Skill not found: ${single}. Install or publish it before granting.`);
      return [resolved.name];
    }
    fail("Specify a skill axis: --skill <name> or --all-skills.");
    return [];
  }

  private printBatchSummary(payload: {
    op: "grant" | "revoke";
    dryRun: boolean;
    agentsTargeted: number;
    skillsTargeted: number;
    pairsAffected: number;
    pairsSkipped: number;
    errors: Array<{ agentId: string; skillName: string; error: string }>;
  }) {
    const verb = payload.op === "grant" ? "granted" : "revoked";
    const tag = payload.dryRun ? " [dry-run: nothing written]" : "";
    console.log(
      `✓ ${payload.op}-batch: ${payload.pairsAffected} ${verb} (${payload.agentsTargeted} agents × ${payload.skillsTargeted} skills)${tag}`,
    );
    if (payload.pairsSkipped > 0) console.log(`  skipped: ${payload.pairsSkipped}`);
    if (payload.errors.length > 0) {
      console.log(`  errors: ${payload.errors.length}`);
      for (const e of payload.errors.slice(0, 5)) console.log(`    - ${e.agentId}/${e.skillName}: ${e.error}`);
    }
  }

  @Command({
    name: "inspect",
    description: "Show the resolved per-agent skill allowlist (baseline ∪ permission-derived ∪ grants)",
    helpAfter: SKILLS_INSPECT_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "skills", action: "inspect", risk: "low" })
  @Returns(skillInspectReturnSchema)
  inspect(
    @Arg("agent", { description: "Agent id (immutable)" }) agent: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agent?.trim();
    if (!agentId) fail("Agent id is required.");
    if (!getAgent(agentId)) fail(`Agent not found: ${agentId}`);
    const resolved = resolveAgentSkills(agentId);
    const payload = {
      agentId,
      hasConfiguration: resolved.hasConfiguration,
      allowlist: resolved.allowlist,
      provenance: resolved.provenance,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`# skills.inspect ${agentId}`);
      console.log(`hasConfiguration=${resolved.hasConfiguration}`);
      console.log(`allowlist (${resolved.allowlist.length}):`);
      for (const skill of resolved.allowlist) console.log(`  - ${skill}`);
      console.log(`from baseline (${resolved.provenance.baseline.length})`);
      console.log(`from capabilities (${resolved.provenance.fromCapabilities.length})`);
      console.log(`from grants (${resolved.provenance.fromGrants.length})`);
    }
    return payload;
  }

  @Command({
    name: "who",
    description: "List agents currently granted a skill (or list all grants for an agent with --agent)",
    helpAfter: SKILLS_WHO_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "skills", action: "who", risk: "low" })
  @Returns(skillGrantWhoReturnSchema)
  who(
    @Arg("skill", { required: false, description: "Skill name to look up" }) skill?: string,
    @Option({ flags: "--agent <id>", description: "List grants for a specific agent instead" }) agentFilter?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agentId = agentFilter?.trim();
    const skillName = skill?.trim();
    let grants: DbSkillGrant[] = [];
    let scopeLabel = "";
    if (agentId) {
      grants = dbListSkillGrantsForAgent(agentId);
      scopeLabel = `agent ${agentId}`;
    } else if (skillName) {
      grants = dbListAgentsForSkill(skillName);
      scopeLabel = `skill ${skillName}`;
    } else {
      grants = dbListSkillGrants();
      scopeLabel = "all grants";
    }
    const payload = {
      ...(skillName ? { skillName } : {}),
      total: grants.length,
      grants,
    };
    if (asJson) {
      printJson(payload);
    } else if (grants.length === 0) {
      console.log(`No grants for ${scopeLabel}.`);
    } else {
      for (const grant of grants) {
        console.log(`- agent=${grant.agentId} skill=${grant.skillName}${grant.note ? ` note="${grant.note}"` : ""}`);
      }
    }
    return payload;
  }
}

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
  const date = overrides.date?.trim() || new Date().toISOString().slice(0, 10);
  const taskId = overrides.taskId?.trim() || env.RAVI_TASK_ID?.trim();
  let sessionKey = overrides.sessionKey?.trim();
  let cadenceTurn = overrides.cadenceTurn?.trim();
  let agentId = overrides.agentId?.trim();

  if (taskId) {
    try {
      const details = getTaskDetails(taskId);
      const profileInput = details?.task?.profileInput as Record<string, string> | undefined;
      sessionKey = sessionKey || profileInput?.originator_session_key || profileInput?.originator_session;
      cadenceTurn = cadenceTurn || profileInput?.cadence_turn;
      agentId = agentId || profileInput?.agent_id;
    } catch {
      // Provenance is best-effort for manual/test invocations.
    }
  }

  return {
    agentId: agentId || env.RAVI_AGENT_ID?.trim() || "unknown",
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
