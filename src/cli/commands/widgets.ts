/**
 * Widgets Commands - widget templates in the Console Library.
 *
 * spec: skills/library (kinds), cli
 */

import "reflect-metadata";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { CONTRACT_EXIT_USAGE, contractFail } from "../agent-contract.js";
import { resolveCallerPath } from "../caller-cwd.js";
import {
  failLibraryUsage,
  formatBytes,
  libraryContractIssues,
  parseItemSelector,
  presentationInitReturnSchema,
  presentationProfile,
  presentationProposalReturnSchema,
  presentationProposalsReturnSchema,
  presentationProposeReturnSchema,
  presentationPublishReturnSchema,
  presentationSearchReturnSchema,
  presentationShowReturnSchema,
  printDiagnostics,
  runPresentationProposal,
  runPresentationProposals,
  runPresentationPropose,
  runPresentationPublish,
  runPresentationSearch,
  runPresentationShow,
  runtimeLibraryCaller,
  widgetCatalogReturnSchema,
  widgetCheckReturnSchema,
  widgetPreviewReturnSchema,
  withLibraryContract,
} from "../library-contract.js";
import { isReservedPresentationSlug } from "../../library/kinds.js";
import { LIBRARY_LIMITS } from "../../library/package.js";
import { checkPresentationFolder, initWidget, previewWidget, widgetCatalog } from "../../library/presentation.js";
import { isLibrarySlug } from "../../library/refs.js";
import { quoteCommandToken } from "../../utils/pagination.js";

const WIDGET = presentationProfile("widget");
const VIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function fieldSummary(fields: Record<string, { type: string; role: string | null; required: boolean }>): string {
  return Object.entries(fields)
    .map(([key, field]) => `${key}:${field.type}${field.role ? `/${field.role}` : ""}${field.required ? "!" : ""}`)
    .join(", ");
}

/** `--data <file>`: one record or `{ records: [...] }` as JSON. */
function readPreviewData(op: string, file: string, asJson: boolean | undefined): unknown {
  const path = resolveCallerPath(file);
  let text: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error("not a file");
    const buffer = readFileSync(path);
    if (buffer.byteLength > LIBRARY_LIMITS.maxFileBytes) throw new Error("too large");
    text = buffer.toString("utf8");
  } catch {
    failLibraryUsage(
      op,
      `--data must name a JSON file of at most ${LIBRARY_LIMITS.maxFileBytes / 1024} KiB.`,
      "Pass --data <file.json> relative to your current directory",
      asJson,
      ["data"],
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failLibraryUsage(op, "--data is not valid JSON.", 'Write one record, or { "records": [...] }', asJson, ["data"]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failLibraryUsage(op, "--data must be a JSON object.", 'Write one record, or { "records": [...] }', asJson, [
      "data",
    ]);
  }
  return parsed;
}

const WIDGETS_SEARCH_HELP_AFTER = `
LEITURA — busca widgets da Biblioteca do Console (da organização e do projeto do
agente) por palavras: nome, descrição e os campos do widget.json (chave,
rótulo e tipo). Sem palavras, lista os widgets que você vê.

EXAMPLES
  ravi widgets search
  ravi widgets search "pedido status valor" --json
  ravi widgets search cartao --project clinica

SEE ALSO
  ravi widgets catalog (peças, filtros e os widgets da org, escrito para agentes)

FONTES
  src/cli/commands/widgets.ts · src/library/presentation.ts · 2026-10-16
`;

const WIDGETS_SHOW_HELP_AFTER = `
LEITURA — mostra um widget: versão, descrição e os arquivos (widget.html,
widget.json, example.json, README.md). Ref org/<slug> ou <projeto>/<slug>; um
slug sem barra resolve no projeto e depois na org.

EXAMPLES
  ravi widgets show org/pedido-card
  ravi widgets show org/pedido-card --version 2 --json

FONTES
  src/cli/commands/widgets.ts · src/library/presentation.ts · 2026-10-16
`;

const WIDGETS_CATALOG_HELP_AFTER = `
LEITURA — o catálogo que o Console gera para agentes: as peças ravi-* com seus
atributos, filtros, tipos e papéis de campo, regras de acessibilidade, os
widgets da organização com seus campos e um exemplo completo. Leia antes de
escrever um widget.html ou uma página com <ravi-view>/<ravi-widget>.

EXAMPLES
  ravi widgets catalog
  ravi widgets catalog --project clinica --json

FONTES
  src/cli/commands/widgets.ts · src/library/presentation.ts · 2026-10-16
`;

const WIDGETS_INIT_HELP_AFTER = `
ESCREVE ARQUIVOS LOCAIS — cria uma pasta de widget com widget.html, widget.json
e example.json gerados pelo Console. Com --from-view <uuid> os campos vêm das
colunas da view (só o esquema; nunca linhas). Não sobrescreve sem --force (exit 3).

EXAMPLES
  ravi widgets init ./pedido-card
  ravi widgets init ./pedido-card --from-view 0b7c3a52-2f0e-4c1e-9a4b-3f1d2c5e6a7b
  ravi widgets init ./cartao --slug pedido-card --force --json

ON ERROR (reason → fix)
  exit 3 LIBRARY_FILES_EXIST → a pasta já tem os arquivos: --force ou outra pasta.
  USAGE_ERROR (2)            → slug ou uuid da view inválido.
  WIDGET_INVALID (2)         → o Console não conseguiu gerar: veja as linhas.

FONTES
  src/cli/commands/widgets.ts · src/library/presentation.ts · 2026-10-16
`;

const WIDGETS_CHECK_HELP_AFTER = `
LEITURA — o Console compila a pasta do widget (widget.html, widget.json,
example.json) e roda o lint de acessibilidade. Não grava nada. Cada problema
sai como \`arquivo:linha:coluna severidade código mensagem\`; com erro, exit 2.

EXAMPLES
  ravi widgets check ./pedido-card
  ravi widgets check ./pedido-card --json

FORMATO
  --json: { kind, ok, files[], diagnostics[], widget{ name, description, fields, variants, actions, hash } }.
  Com erro: envelope WIDGET_INVALID (exit 2) com issues[] (path = [arquivo, linha, coluna]).

FONTES
  src/cli/commands/widgets.ts · src/library/presentation.ts · 2026-10-16
`;

const WIDGETS_PREVIEW_HELP_AFTER = `
ESCREVE ARQUIVO LOCAL — o Console renderiza o widget num HTML sem script: todas
as variantes, claro e escuro lado a lado, com --data (um registro ou
{ "records": [...] }), senão example.json, senão valores inventados pelos tipos.
O tema é --theme <ref> (none: o tema padrão do Ravi), senão o tema efetivo do projeto.
Grava em --out (padrão <dir>/preview.html, que o publish ignora).

EXAMPLES
  ravi widgets preview ./pedido-card
  ravi widgets preview ./pedido-card --data ./pedido.json --theme org/acme
  ravi widgets preview ./pedido-card --out /tmp/pedido.html --json

ON ERROR (reason → fix)
  WIDGET_INVALID (2) → corrija as linhas indicadas (ravi widgets check).
  USAGE_ERROR (2)    → --data não é um arquivo JSON com um objeto.

FONTES
  src/cli/commands/widgets.ts · src/library/presentation.ts · 2026-10-16
`;

const WIDGETS_PUBLISH_HELP_AFTER = `
MUTA (FREIO) — publica uma pasta de widget na Biblioteca do Console: --scope org
(toda a organização) ou --scope <projeto>. Sem --scope, vale o projeto do Console
conhecido aqui. Sem --execute: valida a pasta, o Console a confere (erros saem
com exit 2) e o plano sai com exit 3. Com --execute: publica a versão nova.

ARQUIVOS
  widget.html e widget.json (obrigatórios; name e description no widget.json),
  example.json, README.md. Outros arquivos da pasta (preview.html) ficam fora.
  Slug = --slug, senão o nome da pasta. catalog, check, preview, scaffold e
  proposals são reservados.

EXAMPLES
  ravi widgets publish ./pedido-card --scope org                 # plano (exit 3)
  ravi widgets publish ./pedido-card --scope org --execute
  ravi widgets publish ./pedido-card --scope clinica --note "valor em destaque" --execute --json

AGENTES NÃO PUBLICAM
  Dentro de um agente o comando recusa antes de qualquer request
  (LIBRARY_AGENT_CANNOT_PUBLISH, exit 3): o agente propõe com
  \`ravi widgets propose\` e uma pessoa revisa e publica no Console.

ON ERROR (reason → fix)
  exit 3 WRITE_REQUIRES_EXECUTE → revise o plano e repita com --execute.
  WIDGET_INVALID (2)           → corrija as linhas indicadas (ravi widgets check).
  LIBRARY_PACKAGE_INVALID (2)  → falta widget.html, widget.json ou a description.
  CONFLICT reason=stale_base   → alguém publicou antes: rode sem --execute de novo.
  AUTH_REQUIRED                → rode \`ravi login\`.

FONTES
  src/cli/commands/widgets.ts · src/library/service.ts · 2026-10-16
`;

const WIDGETS_PROPOSE_HELP_AFTER = `
MUTA (FREIO) — propõe uma versão nova de um widget para revisão, sem publicar
(é assim que um agente muda um widget). A pasta é lida e conferida como no
publish. Sem --execute devolve o plano (exit 3); com --execute cria a proposta
(ou o rascunho, com --draft). --update <n> troca o conteúdo da sua proposta n.

EXAMPLES
  ravi widgets propose ./pedido-card --scope org                       # plano (exit 3)
  ravi widgets propose ./pedido-card --scope org --note "variante compacta" --execute
  ravi widgets propose ./pedido-card --scope org --update 2 --execute

ON ERROR (reason → fix)
  exit 3 WRITE_REQUIRES_EXECUTE     → revise o plano e repita com --execute.
  exit 3 LIBRARY_PROPOSAL_NOT_YOURS → só o autor atualiza: comente no Console ou abra outra.
  WIDGET_INVALID (2)                → corrija as linhas indicadas.
  CONFLICT reason=unchanged         → igual à versão publicada: nada a propor.

FONTES
  src/cli/commands/widgets.ts · src/library/service.ts · 2026-10-16
`;

const WIDGETS_PROPOSALS_HELP_AFTER = `
LEITURA — lista propostas de widgets: as de um item (<ref>) ou todas as que você vê.

EXAMPLES
  ravi widgets proposals
  ravi widgets proposals org/pedido-card --state all
  ravi widgets proposals --mine --json

FONTES
  src/cli/commands/widgets.ts · src/library/service.ts · 2026-10-16
`;

const WIDGETS_PROPOSAL_HELP_AFTER = `
LEITURA — mostra uma proposta de widget: status, base, arquivos e comentários da
revisão. O autor responde atualizando com
\`ravi widgets propose <dir> --scope ... --update <n> --execute\`.

EXAMPLES
  ravi widgets proposal org/pedido-card 2
  ravi widgets proposal clinica/pedido-card 1 --json

FONTES
  src/cli/commands/widgets.ts · src/library/service.ts · 2026-10-16
`;

@Group({
  name: "widgets",
  description: "Widget templates in the Console Library: catalog, check, preview, publish and propose",
  scope: "open",
})
export class WidgetsCommands {
  @Command({
    name: "search",
    description: "Search the Library's widgets (org and the caller's project) by words and field names",
    helpAfter: WIDGETS_SEARCH_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "widgets", action: "search", risk: "low" })
  @Returns(presentationSearchReturnSchema)
  search(
    @Arg("query", { required: false, description: "Words to look for (empty lists every widget you can see)" })
    query?: string,
    @Option({ flags: "--project <ref>", description: "Console project whose widgets to include" }) project?: string,
    @Option({ flags: "--limit <n>", description: "Maximum results (default: 10, max: 50)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPresentationSearch(WIDGET, { query, limit, project, asJson });
  }

  @Command({
    name: "show",
    description: "Show a Library widget (org/<slug>, <project>/<slug> or a slug): version and files",
    helpAfter: WIDGETS_SHOW_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "widgets", action: "show", risk: "low" })
  @Returns(presentationShowReturnSchema)
  show(
    @Arg("ref", { description: "Library ref (org/<slug>, <project>/<slug>) or slug" }) ref: string,
    @Option({ flags: "--version <n>", description: "A published version (default: the current one)" })
    version?: string,
    @Option({ flags: "--project <ref>", description: "Console project a bare slug resolves in" }) project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPresentationShow(WIDGET, { ref, version, project, asJson });
  }

  @Command({
    name: "catalog",
    description: "Print the Console's widget catalog for agents: pieces, filters, field types, the org's widgets",
    helpAfter: WIDGETS_CATALOG_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "widgets", action: "catalog", risk: "low" })
  @Returns(widgetCatalogReturnSchema)
  catalog(
    @Option({ flags: "--project <ref>", description: "Console project whose widgets to include" }) project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withLibraryContract("widgets catalog", WIDGET, asJson, async () => {
      const payload = await widgetCatalog({ project: project?.trim() || null, caller: runtimeLibraryCaller() });
      if (asJson) {
        printJson(payload);
        return payload;
      }
      console.log(payload.text.trimEnd());
      return payload;
    });
  }

  @Command({
    name: "init",
    description: "Write a widget folder from the Console's scaffold (fields from a Bases view with --from-view)",
    helpAfter: WIDGETS_INIT_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "widgets", action: "init", risk: "low" })
  @Returns(presentationInitReturnSchema)
  init(
    @Arg("dir", { description: "Folder to write widget.html, widget.json and example.json into" }) dir: string,
    @Option({ flags: "--slug <slug>", description: "Widget slug (default: the folder name)" }) slug?: string,
    @Option({ flags: "--from-view <view-uuid>", description: "Take the fields from this Bases view's columns" })
    fromView?: string,
    @Option({ flags: "--project <ref>", description: "Console project (default: the known project)" })
    project?: string,
    @Option({ flags: "--force", description: "Overwrite files the folder already has" }) force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "widgets init";
    const target = resolveCallerPath(dir ?? "");
    const widgetSlug = (slug?.trim() || basename(target)).toLowerCase();
    if (!isLibrarySlug(widgetSlug)) {
      failLibraryUsage(
        op,
        `"${widgetSlug.slice(0, 80)}" is not a valid widget slug: 1-64 characters of a-z, 0-9 and -.`,
        "Pass --slug <slug>",
        asJson,
        ["slug"],
      );
    }
    if (isReservedPresentationSlug("widget", widgetSlug)) {
      const message = `"${widgetSlug}" is reserved: the Library's widget routes use it.`;
      contractFail(op, "LIBRARY_SLUG_RESERVED", message, {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          suggestedAction: "Pick another slug with --slug",
          issues: libraryContractIssues(["slug"], "LIBRARY_SLUG_RESERVED", message, "Pick another slug with --slug"),
        },
      });
    }
    const view = fromView?.trim();
    if (view !== undefined && !VIEW_ID_PATTERN.test(view)) {
      failLibraryUsage(
        op,
        "--from-view takes a view id (uuid).",
        "Find it with: ravi bases views list <base>",
        asJson,
        ["fromView"],
      );
    }
    return withLibraryContract(op, WIDGET, asJson, async () => {
      const outcome = await initWidget({
        dir: target,
        slug: widgetSlug,
        ...(view ? { view } : {}),
        project: project?.trim() || null,
        force: force === true,
        caller: runtimeLibraryCaller(),
      });
      const payload = {
        success: true as const,
        kind: "widget" as const,
        dir: outcome.dir,
        slug: outcome.slug,
        files: outcome.files,
        diagnostics: outcome.diagnostics,
        next: `ravi widgets preview ${quoteCommandToken(dir ?? "")}`,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      printDiagnostics(payload.diagnostics);
      console.log(`✓ Wrote ${payload.files.map((file) => file.file).join(", ")} to ${payload.dir}`);
      console.log(`  Edit widget.html, then see it with: ${payload.next}`);
      return payload;
    });
  }

  @Command({
    name: "check",
    description: "Check a widget folder with the Console: template and accessibility errors (exit 2 on errors)",
    helpAfter: WIDGETS_CHECK_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "widgets", action: "check", risk: "low" })
  @Returns(widgetCheckReturnSchema)
  check(
    @Arg("dir", { description: "Widget folder holding widget.html (relative to your current directory)" })
    dir: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return withLibraryContract("widgets check", WIDGET, asJson, async () => {
      const outcome = await checkPresentationFolder({ kind: "widget", dir: resolveCallerPath(dir ?? "") });
      const payload = {
        kind: outcome.kind,
        ok: outcome.ok,
        files: outcome.files,
        diagnostics: outcome.diagnostics,
        widget: outcome.widget,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      printDiagnostics(payload.diagnostics);
      const widget = payload.widget;
      console.log(`✓ The widget compiles${widget ? `: ${widget.name}` : ""}`);
      if (widget) {
        console.log(`  Fields: ${fieldSummary(widget.fields) || "none"}`);
        console.log(`  Variants: ${widget.variants.join(", ") || "default"} · actions: ${widget.actions}`);
      }
      return payload;
    });
  }

  @Command({
    name: "preview",
    description: "Render a widget folder to a standalone HTML file (every variant, light and dark) through the Console",
    helpAfter: WIDGETS_PREVIEW_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "widgets", action: "preview", risk: "low" })
  @Returns(widgetPreviewReturnSchema)
  preview(
    @Arg("dir", { description: "Widget folder holding widget.html (relative to your current directory)" })
    dir: string,
    @Option({ flags: "--data <file>", description: "JSON file with one record or { records: [...] }" }) data?: string,
    @Option({
      flags: "--theme <ref>",
      description: "Theme ref, or none for Ravi's default theme (default: the effective theme)",
    })
    theme?: string,
    @Option({ flags: "--out <file.html>", description: "Where to write the HTML (default: <dir>/preview.html)" })
    out?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "widgets preview";
    const folder = resolveCallerPath(dir ?? "");
    const record = data?.trim() ? readPreviewData(op, data.trim(), asJson) : undefined;
    const themeRef = theme?.trim().toLowerCase();
    if (themeRef !== undefined && themeRef !== "none" && !parseItemSelector(themeRef)) {
      failLibraryUsage(
        op,
        `Not a valid theme ref: ${themeRef.slice(0, 120)}.`,
        "Use org/<slug>, <project>/<slug>, a slug or none (find refs with: ravi themes search)",
        asJson,
        ["theme"],
      );
    }
    const target = out?.trim() ? resolveCallerPath(out.trim()) : join(folder, "preview.html");
    return withLibraryContract(op, WIDGET, asJson, async () => {
      const outcome = await previewWidget({
        dir: folder,
        out: target,
        ...(themeRef !== undefined ? { theme: themeRef } : {}),
        ...(record !== undefined ? { data: record } : {}),
        caller: runtimeLibraryCaller(),
      });
      const payload = {
        success: true as const,
        out: outcome.out,
        bytes: outcome.bytes,
        diagnostics: outcome.diagnostics,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      printDiagnostics(payload.diagnostics);
      console.log(`✓ Preview written to ${payload.out} (${formatBytes(payload.bytes)}); open it in a browser`);
      return payload;
    });
  }

  @Command({
    name: "publish",
    description:
      "Publish a widget folder to the Console Library for the organization (--scope org) or one project. Requires --execute.",
    helpAfter: WIDGETS_PUBLISH_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "widgets", action: "publish", risk: "high", requiresConfirmation: true })
  @Returns(presentationPublishReturnSchema)
  publish(
    @Arg("dir", { description: "Widget folder holding widget.html (relative to your current directory)" })
    dir: string,
    @Option({ flags: "--scope <scope>", description: "org, or a Console project slug (default: the known project)" })
    scope?: string,
    @Option({ flags: "--slug <slug>", description: "Library slug (default: the folder name)" }) slug?: string,
    @Option({ flags: "--name <name>", description: "Display name (default: widget.json name, else the slug)" })
    name?: string,
    @Option({ flags: "--note <text>", description: "Version note, at most 500 characters" }) note?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Confirm the publish (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    return runPresentationPublish(WIDGET, { dir, scope, slug, name, note, asJson, execute: execute === true });
  }

  @Command({
    name: "propose",
    description:
      "Propose a new version of a Library widget for review instead of publishing it (agents use this). Requires --execute.",
    helpAfter: WIDGETS_PROPOSE_HELP_AFTER,
  })
  @CommandAccess({ kind: "mutate", resource: "widgets", action: "propose", risk: "medium", requiresConfirmation: true })
  @Returns(presentationProposeReturnSchema)
  propose(
    @Arg("dir", { description: "Widget folder holding widget.html (relative to your current directory)" })
    dir: string,
    @Option({ flags: "--scope <scope>", description: "org, or a Console project slug (default: the known project)" })
    scope?: string,
    @Option({ flags: "--slug <slug>", description: "Library slug (default: the folder name)" }) slug?: string,
    @Option({ flags: "--name <name>", description: "Display name (default: widget.json name, else the slug)" })
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
    return runPresentationPropose(WIDGET, {
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
    description: "List proposals of Library widgets: one item's (<ref>) or every one you can see",
    helpAfter: WIDGETS_PROPOSALS_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "widgets", action: "proposals", risk: "low" })
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
    return runPresentationProposals(WIDGET, { ref, project, state, mine, asJson });
  }

  @Command({
    name: "proposal",
    description: "Show one proposal of a Library widget: status, files and review comments",
    helpAfter: WIDGETS_PROPOSAL_HELP_AFTER,
  })
  @CommandAccess({ kind: "read", resource: "widgets", action: "proposal", risk: "low" })
  @Returns(presentationProposalReturnSchema)
  proposal(
    @Arg("ref", { description: "Library ref (org/<slug> or <project>/<slug>)" }) ref: string,
    @Arg("number", { description: "Proposal number" }) number: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runPresentationProposal(WIDGET, { ref, number, asJson });
  }
}
