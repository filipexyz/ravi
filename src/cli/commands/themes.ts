/**
 * Themes Commands - org and project themes in the Console Library.
 *
 * spec: skills/library (kinds), cli
 */

import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractDryRun } from "../agent-contract.js";
import { resolveCallerPath } from "../caller-cwd.js";
import {
  failLibraryUsage,
  formatBytes,
  LIBRARY_AGENT_CANNOT_SET_THEME,
  presentationInitReturnSchema,
  presentationProfile,
  presentationProposalReturnSchema,
  presentationProposalsReturnSchema,
  presentationProposeReturnSchema,
  presentationPublishReturnSchema,
  presentationSearchReturnSchema,
  presentationShowReturnSchema,
  printDiagnostics,
  refuseAgentWrite,
  runPresentationProposal,
  runPresentationProposals,
  runPresentationPropose,
  runPresentationPublish,
  runPresentationSearch,
  runPresentationShow,
  runtimeLibraryCaller,
  themeActiveReturnSchema,
  themeCheckReturnSchema,
  themeUseReturnSchema,
  withPresentationContract,
} from "../library-contract.js";
import {
  checkPresentationFolder,
  executeThemeUse,
  initTheme,
  prepareThemeUse,
  themeActive,
} from "../../library/presentation.js";
import type { LibraryThemePointer, LibraryThemeUsePlan } from "../../library/types.js";
import { quoteCommandToken } from "../../utils/pagination.js";

const THEME = presentationProfile("theme");

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function pointerLabel(pointer: LibraryThemePointer | null): string {
  return pointer ? `${pointer.ref} (${pointer.name})` : "none";
}

function projectLabel(project: LibraryThemeUsePlan["project"]): string {
  if (!project) return "?";
  return project.name && project.name !== project.slug ? `${project.slug} (${project.name})` : project.slug;
}

function planLines(plan: LibraryThemeUsePlan): string[] {
  const target = plan.scope === "org" ? "org" : `project ${projectLabel(plan.project)}`;
  const lines = [`Active theme for ${target}: ${pointerLabel(plan.from)} → ${pointerLabel(plan.to)}`];
  if (plan.affectedHosts.length === 0) {
    lines.push("No Pages host uses it yet.");
  } else {
    lines.push(`Pages hosts it reaches (${plan.affectedHosts.length}):`);
    for (const host of plan.affectedHosts) {
      lines.push(`  ${host.hostname} (${host.routes} route${host.routes === 1 ? "" : "s"})`);
    }
  }
  return lines;
}

const THEMES_SEARCH_HELP_AFTER = `
LEITURA — busca temas da Biblioteca do Console (da organização e do projeto do
agente) por palavras. Sem palavras, lista os temas que você vê.

EXAMPLES
  ravi themes search
  ravi themes search acme --json
  ravi themes search escuro --project clinica

FORMATO
  --json: { query, project, total, items[{ ref, scope, project, name, description, version, next }] }.
  Use sempre o ref completo (org/<slug> ou <projeto>/<slug>).

FONTES
  src/cli/commands/themes.ts · src/library/presentation.ts · 2026-10-16
`;

const THEMES_SHOW_HELP_AFTER = `
LEITURA — mostra um tema: versão, descrição e os arquivos (theme.json,
fields.json, README.md; logo.svg só é listado). Ref org/<slug> ou
<projeto>/<slug>; um slug sem barra resolve no projeto e depois na org.
Palavras reservadas (active, default, none, check, proposals) não são temas:
saem com USAGE_ERROR (exit 2) e o comando certo (ravi themes active...).

EXAMPLES
  ravi themes show org/acme
  ravi themes show org/acme --version 2 --json
  ravi themes show acme --project clinica

FORMATO
  --json: { ref, kind, version, note, contentHash, publishedAt, item, files[{ path, bytes, sha256, content }] }.

FONTES
  src/cli/commands/themes.ts · src/library/presentation.ts · 2026-10-16
`;

const THEMES_INIT_HELP_AFTER = `
ESCREVE ARQUIVOS LOCAIS — cria uma pasta de tema a partir do tema padrão do
Console (theme.json e fields.json). Edite os tokens, confira com
\`ravi themes check\` e publique. Não sobrescreve arquivos sem --force (exit 3).

EXAMPLES
  ravi themes init ./tema-acme
  ravi themes init ./tema-acme --force --json

ON ERROR (reason → fix)
  exit 3 LIBRARY_FILES_EXIST → a pasta já tem os arquivos: --force ou outra pasta.
  AUTH_REQUIRED              → rode \`ravi login\`.

FONTES
  src/cli/commands/themes.ts · src/library/presentation.ts · 2026-10-16
`;

const THEMES_CHECK_HELP_AFTER = `
LEITURA — o Console compila a pasta do tema (theme.json, fields.json, logo.svg)
e mede o contraste WCAG no claro e no escuro. Não grava nada. Cada problema sai
como \`arquivo:linha:coluna severidade código mensagem\`; com erro, exit 2.

EXAMPLES
  ravi themes check ./tema-acme
  ravi themes check ./tema-acme --json

FORMATO
  --json: { kind, ok, files[], diagnostics[], contrast{ ok, checks[] }, css }.
  Com erro: envelope THEME_INVALID (exit 2) com issues[] e os pares de contraste que falharam.

FONTES
  src/cli/commands/themes.ts · src/library/presentation.ts · 2026-10-16
`;

const THEMES_PUBLISH_HELP_AFTER = `
MUTA (FREIO) — publica uma pasta de tema na Biblioteca do Console: --scope org
(toda a organização) ou --scope <projeto>. Sem --scope, vale o projeto do Console
conhecido aqui. Sem --execute: valida a pasta, o Console a confere (erros saem
com exit 2) e o plano sai com exit 3. Com --execute: publica a versão nova.

ARQUIVOS
  theme.json (obrigatório, com $description; nome em $extensions.ravi.name),
  fields.json, logo.svg, README.md. Outros arquivos da pasta ficam fora.
  Slug = --slug, senão o nome da pasta. active, default, none, check e proposals são reservados.

EXAMPLES
  ravi themes publish ./acme --scope org                 # plano (exit 3)
  ravi themes publish ./acme --scope org --execute
  ravi themes publish ./acme --scope clinica --note "contraste maior" --execute --json

AGENTES NÃO PUBLICAM
  Dentro de um agente o comando recusa antes de qualquer request
  (LIBRARY_AGENT_CANNOT_PUBLISH, exit 3): o agente propõe com
  \`ravi themes propose\` e uma pessoa revisa e publica no Console.

ON ERROR (reason → fix)
  exit 3 WRITE_REQUIRES_EXECUTE → revise o plano e repita com --execute.
  THEME_INVALID (2)            → corrija as linhas indicadas (ravi themes check).
  LIBRARY_PACKAGE_INVALID (2)  → falta theme.json ou $description.
  CONFLICT reason=stale_base   → alguém publicou antes: rode sem --execute de novo.
  AUTH_REQUIRED                → rode \`ravi login\`.

FONTES
  src/cli/commands/themes.ts · src/library/service.ts · 2026-10-16
`;

const THEMES_PROPOSE_HELP_AFTER = `
MUTA (FREIO) — propõe uma versão nova de um tema para revisão, sem publicar
(é assim que um agente muda um tema). A pasta é lida e conferida como no
publish. Sem --execute devolve o plano (exit 3); com --execute cria a proposta
(ou o rascunho, com --draft). --update <n> troca o conteúdo da sua proposta n.

EXAMPLES
  ravi themes propose ./acme --scope org                       # plano (exit 3)
  ravi themes propose ./acme --scope org --note "cores novas" --execute
  ravi themes propose ./acme --scope org --update 2 --execute
  ravi themes propose ./acme --scope org --update 2 --rebase --execute

ON ERROR (reason → fix)
  exit 3 WRITE_REQUIRES_EXECUTE     → revise o plano e repita com --execute.
  exit 3 LIBRARY_PROPOSAL_NOT_YOURS → só o autor atualiza: comente no Console ou abra outra.
  THEME_INVALID (2)                 → corrija as linhas indicadas.
  CONFLICT reason=unchanged         → igual à versão publicada: nada a propor.

FONTES
  src/cli/commands/themes.ts · src/library/service.ts · 2026-10-16
`;

const THEMES_PROPOSALS_HELP_AFTER = `
LEITURA — lista propostas de temas: as de um item (<ref>) ou todas as que você vê.

EXAMPLES
  ravi themes proposals
  ravi themes proposals org/acme --state all
  ravi themes proposals --mine --json

FONTES
  src/cli/commands/themes.ts · src/library/service.ts · 2026-10-16
`;

const THEMES_PROPOSAL_HELP_AFTER = `
LEITURA — mostra uma proposta de tema: status, base, arquivos e comentários da
revisão. O autor responde atualizando com
\`ravi themes propose <dir> --scope ... --update <n> --execute\`.

EXAMPLES
  ravi themes proposal org/acme 2
  ravi themes proposal clinica/acme 1 --json

FONTES
  src/cli/commands/themes.ts · src/library/service.ts · 2026-10-16
`;

const THEMES_ACTIVE_HELP_AFTER = `
LEITURA — mostra o tema ativo da organização, o do projeto e o efetivo (o do
projeto; sem ele, o da organização), com a versão e o hash que um ship usaria.

EXAMPLES
  ravi themes active
  ravi themes active --project clinica --json

FORMATO
  --json: { projectRef, org, project, effective{ ref, version, hash, source }, warnings[] }.

FONTES
  src/cli/commands/themes.ts · src/library/presentation.ts · 2026-10-16
`;

const THEMES_USE_HELP_AFTER = `
MUTA (FREIO) — define o tema ativo da organização ou de um projeto (none tira).
Sem --project: o da organização; um ref <projeto>/<slug> vale para o próprio
projeto. Sem --execute o Console devolve o plano: de qual tema para qual e os
hosts do Pages afetados (exit 3). Com --execute grava o ponteiro. Páginas
privadas seguem o tema novo ao abrir; as outras ficam com o tema do último ship.

EXAMPLES
  ravi themes use org/acme                          # plano (exit 3)
  ravi themes use org/acme --execute
  ravi themes use org/acme --project clinica --execute
  ravi themes use none --project clinica --execute

FORMATO
  --json: { success, applied, unchanged, plan{ scope, project{ id, slug, name }, from, to, affectedHosts[] } }.
  Se o tema já era o ativo: applied false, unchanged true, nada gravado.

AGENTES NÃO DEFINEM O TEMA
  Dentro de um agente o comando recusa antes de qualquer request
  (LIBRARY_AGENT_CANNOT_SET_THEME, exit 3).

ON ERROR (reason → fix)
  exit 3 WRITE_REQUIRES_EXECUTE → revise o plano e repita com --execute.
  LIBRARY_REF_INVALID (2)       → use org/<slug>, <projeto>/<slug>, um slug ou none.
  THEME_NOT_FOUND (1)           → ache o ref com ravi themes search.

FONTES
  src/cli/commands/themes.ts · src/library/presentation.ts · 2026-10-16
`;

@Group({
  name: "themes",
  description: "Org and project themes in the Console Library: check, publish, propose and set the active theme",
  scope: "open",
})
export class ThemesCommands {
  @Command({
    name: "search",
    description: "Search the Library's themes (org and the caller's project) by words",
    helpAfter: THEMES_SEARCH_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "themes", action: "search", risk: "low" })
  @Returns(presentationSearchReturnSchema)
  search(
    @Arg("query", { required: false, description: "Words to look for (empty lists every theme you can see)" })
    query?: string,
    @Option({ flags: "--project <ref>", description: "Console project whose themes to include" }) project?: string,
    @Option({ flags: "--limit <n>", description: "Maximum results (default: 10, max: 50)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPresentationSearch(THEME, { query, limit, project, asJson });
  }

  @Command({
    name: "show",
    description: "Show a Library theme (org/<slug>, <project>/<slug> or a slug): version and files",
    helpAfter: THEMES_SHOW_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "themes", action: "show", risk: "low" })
  @Returns(presentationShowReturnSchema)
  show(
    @Arg("ref", { description: "Library ref (org/<slug>, <project>/<slug>) or slug" }) ref: string,
    @Option({ flags: "--version <n>", description: "A published version (default: the current one)" })
    version?: string,
    @Option({ flags: "--project <ref>", description: "Console project a bare slug resolves in" }) project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPresentationShow(THEME, { ref, version, project, asJson });
  }

  @Command({
    name: "init",
    description: "Write the Console's default theme files into a folder to start a theme",
    helpAfter: THEMES_INIT_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "themes", action: "init", risk: "low" })
  @Returns(presentationInitReturnSchema)
  init(
    @Arg("dir", { description: "Folder to write theme.json and fields.json into (created when missing)" })
    dir: string,
    @Option({ flags: "--force", description: "Overwrite files the folder already has" }) force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withPresentationContract("themes init", THEME, asJson, async () => {
      const outcome = await initTheme({ dir: resolveCallerPath(dir ?? ""), force: force === true });
      const payload = {
        success: true as const,
        kind: "theme" as const,
        dir: outcome.dir,
        slug: outcome.slug,
        files: outcome.files,
        diagnostics: outcome.diagnostics,
        next: `ravi themes check ${quoteCommandToken(dir ?? "")}`,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      printDiagnostics(payload.diagnostics);
      console.log(`✓ Wrote ${payload.files.map((file) => file.file).join(", ")} to ${payload.dir}`);
      console.log(`  Edit theme.json, then check it with: ${payload.next}`);
      return payload;
    });
  }

  @Command({
    name: "check",
    description: "Check a theme folder with the Console: compile errors and WCAG contrast (exit 2 on errors)",
    helpAfter: THEMES_CHECK_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "themes", action: "check", risk: "low" })
  @Returns(themeCheckReturnSchema)
  check(
    @Arg("dir", { description: "Theme folder holding theme.json (relative to your current directory)" }) dir: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withPresentationContract("themes check", THEME, asJson, async () => {
      const outcome = await checkPresentationFolder({ kind: "theme", dir: resolveCallerPath(dir ?? "") });
      const payload = {
        kind: outcome.kind,
        ok: outcome.ok,
        files: outcome.files,
        diagnostics: outcome.diagnostics,
        contrast: outcome.contrast,
        css: outcome.css,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      printDiagnostics(payload.diagnostics);
      const checks = payload.contrast?.checks ?? [];
      console.log(
        `✓ The theme compiles${checks.length > 0 ? `; ${checks.length} contrast checks pass in light and dark` : ""}`,
      );
      if (payload.css) console.log(`  CSS: ${formatBytes(Buffer.byteLength(payload.css, "utf8"))}`);
      return payload;
    });
  }

  @Command({
    name: "publish",
    description:
      "Publish a theme folder to the Console Library for the organization (--scope org) or one project. Requires --execute.",
    helpAfter: THEMES_PUBLISH_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "themes", action: "publish", risk: "high", requiresConfirmation: true })
  @Returns(presentationPublishReturnSchema)
  publish(
    @Arg("dir", { description: "Theme folder holding theme.json (relative to your current directory)" }) dir: string,
    @Option({ flags: "--scope <scope>", description: "org, or a Console project slug (default: the known project)" })
    scope?: string,
    @Option({ flags: "--slug <slug>", description: "Library slug (default: the folder name)" }) slug?: string,
    @Option({ flags: "--name <name>", description: "Display name (default: $extensions.ravi.name, else the slug)" })
    name?: string,
    @Option({ flags: "--note <text>", description: "Version note, at most 500 characters" }) note?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Confirm the publish (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    return runPresentationPublish(THEME, { dir, scope, slug, name, note, asJson, execute: execute === true });
  }

  @Command({
    name: "propose",
    description:
      "Propose a new version of a Library theme for review instead of publishing it (agents use this). Requires --execute.",
    helpAfter: THEMES_PROPOSE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "themes", action: "propose", risk: "medium", requiresConfirmation: true })
  @Returns(presentationProposeReturnSchema)
  propose(
    @Arg("dir", { description: "Theme folder holding theme.json (relative to your current directory)" }) dir: string,
    @Option({ flags: "--scope <scope>", description: "org, or a Console project slug (default: the known project)" })
    scope?: string,
    @Option({ flags: "--slug <slug>", description: "Library slug (default: the folder name)" }) slug?: string,
    @Option({ flags: "--name <name>", description: "Display name (default: $extensions.ravi.name, else the slug)" })
    name?: string,
    @Option({ flags: "--note <text>", description: "Note for the reviewers, at most 500 characters" }) note?: string,
    @Option({ flags: "--draft", description: "Save a draft only you and the scope's reviewers see; do not submit" })
    draft?: boolean,
    @Option({ flags: "--update <number>", description: "Replace the content of your open proposal with this number" })
    update?: string,
    @Option({
      flags: "--rebase",
      description: "With --update: move the proposal onto the version published now (read it first)",
    })
    rebase?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Confirm the proposal (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    return runPresentationPropose(THEME, {
      dir,
      scope,
      slug,
      name,
      note,
      draft,
      update,
      rebase,
      asJson,
      execute: execute === true,
    });
  }

  @Command({
    name: "proposals",
    description: "List proposals of Library themes: one item's (<ref>) or every one you can see",
    helpAfter: THEMES_PROPOSALS_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "themes", action: "proposals", risk: "low" })
  @Returns(presentationProposalsReturnSchema)
  proposals(
    @Arg("ref", { required: false, description: "Library ref (org/<slug> or <project>/<slug>) to list one item's" })
    ref?: string,
    @Option({ flags: "--project <ref>", description: "Only this Console project's proposals (and the org's)" })
    project?: string,
    @Option({ flags: "--state <state>", description: "open (drafts and proposed, default), closed or all" })
    state?: string,
    @Option({ flags: "--mine", description: "Only your proposals (inside an agent: the ones this agent wrote)" })
    mine?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPresentationProposals(THEME, { ref, project, state, mine, asJson });
  }

  @Command({
    name: "proposal",
    description: "Show one proposal of a Library theme: status, files and review comments",
    helpAfter: THEMES_PROPOSAL_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "themes", action: "proposal", risk: "low" })
  @Returns(presentationProposalReturnSchema)
  proposal(
    @Arg("ref", { description: "Library ref (org/<slug> or <project>/<slug>)" }) ref: string,
    @Arg("number", { description: "Proposal number" }) number: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPresentationProposal(THEME, { ref, number, asJson });
  }

  @Command({
    name: "active",
    description: "Show the org's and the project's active theme and the effective one",
    helpAfter: THEMES_ACTIVE_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "themes", action: "active", risk: "low" })
  @Returns(themeActiveReturnSchema)
  active(
    @Option({ flags: "--project <ref>", description: "Console project (default: the known project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withPresentationContract("themes active", THEME, asJson, async () => {
      const outcome = await themeActive({ project: project?.trim() || null, caller: runtimeLibraryCaller() });
      const payload = {
        projectRef: outcome.projectRef,
        org: outcome.org,
        project: outcome.project,
        effective: outcome.effective,
        warnings: outcome.warnings,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      console.log(`Org theme: ${pointerLabel(payload.org)}`);
      if (payload.projectRef) console.log(`Project theme (${payload.projectRef}): ${pointerLabel(payload.project)}`);
      console.log(
        payload.effective
          ? `Effective: ${payload.effective.ref} v${payload.effective.version} (from the ${payload.effective.source})`
          : "Effective: none (pages use the default theme)",
      );
      for (const warning of payload.warnings) console.log(`Warning: ${warning}`);
      return payload;
    });
  }

  @Command({
    name: "use",
    description:
      "Set the active theme of the organization or a project (none clears it); the plan lists the Pages hosts it reaches. Requires --execute.",
    helpAfter: THEMES_USE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "themes", action: "use", risk: "high", requiresConfirmation: true })
  @Returns(themeUseReturnSchema)
  use(
    @Arg("ref", { description: "Theme ref (org/<slug>, <project>/<slug>), a slug, or none" }) ref: string,
    @Option({ flags: "--project <ref>", description: "Set this project's theme instead of the organization's" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Confirm the change (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "themes use";
    refuseAgentWrite(
      op,
      LIBRARY_AGENT_CANNOT_SET_THEME,
      "Agents do not change the active theme: a person sets it from their terminal.",
      `Ask the operator to run: ravi themes use ${ref?.trim() || "<ref>"} --execute`,
      asJson,
    );
    if (!ref?.trim()) failLibraryUsage(op, "Pass a theme ref or none.", "ravi themes search <words>", asJson, ["ref"]);
    return withPresentationContract(op, THEME, asJson, async () => {
      const prepared = await prepareThemeUse({ ref, project: project?.trim() || null });
      if (!execute) {
        if (!asJson) {
          for (const line of planLines(prepared.plan)) console.log(line);
          if (prepared.unchanged) console.log("That is already the active theme: --execute would change nothing.");
        }
        contractDryRun(op, { ref: prepared.body.ref, ...prepared.plan, unchanged: prepared.unchanged }, { asJson });
      }
      const result = await executeThemeUse(prepared);
      // The Console answers `applied: true, unchanged: true` when the pointer
      // already named the target: nothing was written, so nothing is reported saved.
      const unchanged = result.unchanged || !result.applied;
      const payload = { success: true as const, applied: !unchanged, unchanged, plan: result.plan };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      for (const line of planLines(payload.plan)) console.log(line);
      console.log(
        payload.applied
          ? "✓ Saved. Private pages follow it on their next load; other pages keep their theme until shipped again."
          : "= Nothing changed: that is already the active theme.",
      );
      return payload;
    });
  }
}
