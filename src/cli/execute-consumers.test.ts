import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

function sourceLines(path: string, marker: string): string[] {
  return readFileSync(join(repoRoot, path), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes(marker));
}

function normalizedSource(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8").replace(/\s+/g, " ").trim();
}

type ExecuteConsumer = {
  readonly name: string;
  readonly path: string;
  readonly marker: string;
  readonly expected: string;
  readonly matches: number;
};

const executeConsumers: readonly ExecuteConsumer[] = [
  {
    name: "cloud run approval hints in run show and follow",
    path: "src/cli/commands/cloud-agents.ts",
    marker: "Approve: ravi cloud runs approve",
    expected: "--execute",
    matches: 2,
  },
  {
    name: "cloud run approval relayed to a task's session",
    path: "src/cloud-agents/task-watcher.ts",
    marker: "Approve: ravi cloud runs approve",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "cloud deploy next-step hint",
    path: "src/cli/commands/cloud-agents.ts",
    marker: "Run it: ravi cloud runs start",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "cloud key error hints",
    path: "src/cli/cloud-agents-contract.ts",
    marker: "ravi cloud key set --stdin",
    expected: "--execute",
    matches: 2,
  },
  {
    name: "task dispatch status hint",
    path: "src/cli/commands/tasks.ts",
    marker: "ravi tasks dispatch",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "task profile dispatch hints",
    path: "src/tasks/profiles.ts",
    marker: "ravi tasks dispatch",
    expected: "--execute",
    matches: 3,
  },
  {
    name: "generated audio delivery hint",
    path: "src/cli/commands/audio.ts",
    marker: "ravi media send",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "generated image delivery hints",
    path: "src/cli/commands/image.ts",
    marker: "ravi media send",
    expected: "--execute",
    matches: 2,
  },
  {
    name: "Library publish refusal inside an agent",
    path: "src/cli/commands/skills.ts",
    marker: "const suggestedAction = `ravi skills propose",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "Library proposal review answer hint",
    path: "src/cli/commands/skills.ts",
    marker: "Answer the review by updating it: ravi skills propose",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "Library theme/widget publish refusal inside an agent and proposal review answer hint",
    path: "src/cli/library-contract.ts",
    marker: "ravi $" + "{profile.group} propose",
    expected: "--execute",
    matches: 2,
  },
  {
    name: "theme publish next-step hint",
    path: "src/cli/library-contract.ts",
    marker: "Make it the active theme with: ravi themes use",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "Library pin refusal inside an agent",
    path: "src/cli/commands/skills.ts",
    marker: "Ask the operator to run: ravi skills pin",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "themes use refusal inside an agent",
    path: "src/cli/commands/themes.ts",
    marker: "Ask the operator to run: ravi themes use",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "Library agent install/update refusal inside an agent",
    path: "src/cli/commands/agents-library.ts",
    marker: "`Ask the operator to run: ravi $",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "Library agent publish refusal inside an agent",
    path: "src/cli/commands/agents-library.ts",
    marker: "`Ask the operator to run: ravi agents publish",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "Library not_accepting conflict hint",
    path: "src/cli/library-contract.ts",
    marker: "Ask its operator to open it (ravi agents requests",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "sentinel WhatsApp DM reply hint",
    path: "src/omni/consumer.ts",
    marker: "use whatsapp dm send",
    expected: "--execute",
    matches: 1,
  },
  {
    name: "meeting prep routine asks before recording",
    path: "src/calendar/assistant.ts",
    marker: "ravi agenda record",
    expected: "--execute",
    matches: 1,
  },
];

const executeInstructions = [
  {
    name: "session reset documentation",
    path: "README.md",
    instruction: "ravi sessions reset main --execute",
  },
  {
    name: "session delete documentation",
    path: "docs/cli/overview.mdx",
    instruction: "ravi sessions delete <nameOrKey> --execute",
  },
  {
    name: "session message deletion tool",
    path: "src/cli/commands/sessions.ts",
    instruction: "ravi sessions delete-message <message-id> --execute",
  },
  {
    name: "sticker send conversational tool",
    path: "src/cli/commands/sessions.ts",
    instruction: "ravi stickers send <sticker-id> --execute",
  },
  {
    name: "media send conversational tool",
    path: "src/cli/commands/sessions.ts",
    instruction: 'ravi media send "<file-path>" --execute',
  },
  {
    name: "trigger test root instructions",
    path: "AGENTS.md",
    instruction: "ravi triggers test <id> --execute",
  },
  {
    name: "trigger test skill",
    path: "src/plugins/internal/ravi-system/skills/triggers/SKILL.md",
    instruction: "ravi triggers test <id> --execute",
  },
  {
    name: "audio direct-send documentation",
    path: "docs/reference/media.mdx",
    instruction: 'ravi audio generate "Voice message content" --send --execute',
  },
  {
    name: "audio captioned-send documentation",
    path: "docs/reference/media.mdx",
    instruction: 'ravi audio generate "Important update" --send --caption "Listen to this" --execute',
  },
  {
    name: "image direct-send documentation",
    path: "docs/reference/media.mdx",
    instruction: 'ravi image generate "coffee shop interior" --send --execute',
  },
  {
    name: "heartbeat root instructions",
    path: "AGENTS.md",
    instruction: "ravi heartbeat trigger <id> --execute",
  },
  {
    name: "heartbeat skill",
    path: "src/plugins/internal/ravi-system/skills/heartbeat/SKILL.md",
    instruction: "ravi heartbeat trigger <agent> --execute",
  },
  {
    name: "heartbeat guide",
    path: "docs/guides/heartbeat.mdx",
    instruction: "ravi heartbeat trigger main --execute",
  },
  {
    name: "heartbeat CLI overview",
    path: "docs/cli/overview.mdx",
    instruction: "ravi heartbeat trigger <id> --execute",
  },
  {
    name: "connectors mode help",
    path: "src/cli/commands/connectors.ts",
    instruction: "ravi connectors mode main google person-asking --execute",
  },
  {
    name: "connectors mode skill",
    path: "src/plugins/internal/ravi-system/skills/connectors/SKILL.md",
    instruction: "ravi connectors mode main google person-asking --execute",
  },
  {
    name: "connectors mode guide",
    path: "docs/console/connectors.mdx",
    instruction: "ravi connectors mode main google person-asking --execute",
  },
  {
    name: "connectors shared mode guide",
    path: "docs/console/connectors.mdx",
    instruction: "ravi connectors mode main google shared --execute",
  },
  {
    name: "Page Chat enable skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    instruction: "ravi pages chat set <host> --enabled true --execute",
  },
  {
    name: "Page text chat enable skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    instruction: "ravi pages chat set <host> --text true --execute",
  },
  {
    name: "Page text chat reply-always skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    instruction: "ravi pages chat set <host> --reply-policy always --execute",
  },
  {
    name: "Page text chat Ravi agent skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    instruction: "ravi pages chat set <host> --ravi-agent <installation-id>/<agente> --execute",
  },
  {
    name: "Library publish skill",
    path: "src/plugins/internal/ravi-system/skills/skills/SKILL.md",
    instruction: "ravi skills publish ./agenda-semanal --scope org --execute",
  },
  {
    name: "Library publish documentation",
    path: "docs/reference/skills.mdx",
    instruction: "ravi skills publish ./weekly-agenda --scope org --execute",
  },
  {
    name: "Library publish help",
    path: "src/cli/commands/skills.ts",
    instruction: "ravi skills publish ./agenda-semanal --scope org --execute",
  },
  {
    name: "Library propose skill",
    path: "src/plugins/internal/ravi-system/skills/skills/SKILL.md",
    instruction: "ravi skills propose ./agenda-semanal --scope org --update 3 --execute",
  },
  {
    name: "Library propose documentation",
    path: "docs/reference/skills.mdx",
    instruction: "ravi skills propose ./weekly-agenda --scope org --update 3 --execute",
  },
  {
    name: "Library propose help",
    path: "src/cli/commands/skills.ts",
    instruction: "ravi skills propose ./agenda-semanal --scope org --update 3 --execute",
  },
  {
    name: "Library proposal help",
    path: "src/cli/commands/skills.ts",
    instruction: "ravi skills propose <dir> --scope ... --update <n> --execute",
  },
  {
    name: "themes publish help",
    path: "src/cli/commands/themes.ts",
    instruction: "ravi themes publish ./acme --scope org --execute",
  },
  {
    name: "themes propose help",
    path: "src/cli/commands/themes.ts",
    instruction: "ravi themes propose ./acme --scope org --update 2 --execute",
  },
  {
    name: "themes proposal help",
    path: "src/cli/commands/themes.ts",
    instruction: "ravi themes propose <dir> --scope ... --update <n> --execute",
  },
  {
    name: "themes use help",
    path: "src/cli/commands/themes.ts",
    instruction: "ravi themes use org/acme --project clinica --execute",
  },
  {
    name: "widgets publish help",
    path: "src/cli/commands/widgets.ts",
    instruction: "ravi widgets publish ./pedido-card --scope org --execute",
  },
  {
    name: "widgets propose help",
    path: "src/cli/commands/widgets.ts",
    instruction: "ravi widgets propose ./pedido-card --scope org --update 2 --execute",
  },
  {
    name: "widgets proposal help",
    path: "src/cli/commands/widgets.ts",
    instruction: "ravi widgets propose <dir> --scope ... --update <n> --execute",
  },
  {
    name: "widgets propose in the pages skill",
    path: "src/plugins/internal/ravi-system/skills/pages/references/widgets.md",
    instruction: 'ravi widgets propose ./pedido-card --scope org --note "cartão de pedido" --execute',
  },
  {
    name: "widgets proposal answer in the pages skill",
    path: "src/plugins/internal/ravi-system/skills/pages/references/widgets.md",
    instruction: "ravi widgets propose ./pedido-card --scope org --update <n> --execute",
  },
  {
    name: "themes use in the pages skill",
    path: "src/plugins/internal/ravi-system/skills/pages/references/theme.md",
    instruction: "ravi themes use org/acme --execute",
  },
  {
    name: "themes propose in the pages skill",
    path: "src/plugins/internal/ravi-system/skills/pages/references/theme.md",
    instruction: 'ravi themes propose ./tema-acme --scope org --note "cores da marca" --execute',
  },
  {
    name: "WhatsApp group send in the pages design reference",
    path: "src/plugins/internal/ravi-system/skills/pages/references/design.md",
    instruction: 'ravi whatsapp group send <grupo> "<texto>" --json --execute',
  },
  {
    name: "Slack blocks send in the pages design reference",
    path: "src/plugins/internal/ravi-system/skills/pages/references/design.md",
    instruction: "ravi slack blocks-send <canal> <blocos.json> --execute",
  },
  {
    name: "themes publish documentation",
    path: "docs/console/widgets.mdx",
    instruction: "ravi themes publish ./acme --scope org --execute",
  },
  {
    name: "themes use documentation",
    path: "docs/console/widgets.mdx",
    instruction: "ravi themes use org/acme --project clinic --execute",
  },
  {
    name: "widgets publish documentation",
    path: "docs/console/widgets.mdx",
    instruction: "ravi widgets publish ./order-card --scope org --execute",
  },
  {
    name: "widgets propose root instructions",
    path: "AGENTS.md",
    instruction: "ravi widgets propose <dir> --scope org --execute",
  },
  {
    name: "Library pin skill",
    path: "src/plugins/internal/ravi-system/skills/skills/SKILL.md",
    instruction: "ravi skills pin org/tom-de-voz --agent main --execute",
  },
  {
    name: "Library pin documentation",
    path: "docs/reference/skills.mdx",
    instruction: "ravi skills pin org/tone-of-voice --agent main --execute",
  },
  {
    name: "Library pin help",
    path: "src/cli/commands/skills.ts",
    instruction: "ravi skills pin org/tom-de-voz --agent main --execute",
  },
  {
    name: "Library agent install skill",
    path: "src/plugins/internal/ravi-system/skills/agents/SKILL.md",
    instruction: "ravi agents install org/triagem --execute",
  },
  {
    name: "Library agent install documentation",
    path: "docs/reference/skills.mdx",
    instruction: "ravi agents install org/triage --execute",
  },
  {
    name: "Library agent install help",
    path: "src/cli/commands/agents-library.ts",
    instruction: "ravi agents install org/triage --execute",
  },
  {
    name: "Library agent publish skill",
    path: "src/plugins/internal/ravi-system/skills/agents/SKILL.md",
    instruction: "ravi agents publish triagem --scope org --execute",
  },
  {
    name: "Library agent publish documentation",
    path: "docs/reference/skills.mdx",
    instruction: "ravi agents publish triage --scope org --execute",
  },
  {
    name: "Library agent publish help",
    path: "src/cli/commands/agents-library.ts",
    instruction: "ravi agents publish triage --scope org --execute",
  },
  {
    name: "Library agent requests on skill",
    path: "src/plugins/internal/ravi-system/skills/agents/SKILL.md",
    instruction: "ravi agents requests financeiro on --execute",
  },
  {
    name: "Library agent requests on documentation",
    path: "docs/reference/skills.mdx",
    instruction: "ravi agents requests finance on --execute",
  },
  {
    name: "Library agent requests on help",
    path: "src/cli/commands/agents-library.ts",
    instruction: "ravi agents requests finance on --execute",
  },
  {
    name: "Library agent listing on skill",
    path: "src/plugins/internal/ravi-system/skills/agents/SKILL.md",
    instruction: "ravi agents listing financeiro on --execute",
  },
  {
    name: "Library agent listing on documentation",
    path: "docs/reference/skills.mdx",
    instruction: "ravi agents listing finance on --execute",
  },
  {
    name: "Library agent listing on help",
    path: "src/cli/commands/agents-library.ts",
    instruction: "ravi agents listing finance on --execute",
  },
  {
    name: "Library agent ask skill",
    path: "src/plugins/internal/ravi-system/skills/agents/SKILL.md",
    instruction: 'ravi agents ask macbook-ana/financeiro "Qual a data de fechamento?" --execute',
  },
  {
    name: "Library agent ask documentation",
    path: "docs/reference/skills.mdx",
    instruction: 'ravi agents ask macbook-ana/finance "When is the October close?" --execute',
  },
  {
    name: "Library agent ask help",
    path: "src/cli/commands/agents-library.ts",
    instruction: 'ravi agents ask macbook-ana/finance "What was the October close date?" --execute',
  },
  {
    name: "Page Chat enable documentation",
    path: "docs/console/pages.mdx",
    instruction: "ravi pages chat set acme-website --enabled true --execute",
  },
  {
    name: "Page text chat enable documentation",
    path: "docs/console/pages.mdx",
    instruction: "ravi pages chat set acme-website --text true --execute",
  },
  {
    name: "Page text chat reply-always documentation",
    path: "docs/console/pages.mdx",
    instruction: "ravi pages chat set acme-website --reply-policy always --execute",
  },
  {
    name: "Page text chat Ravi agent documentation",
    path: "docs/console/pages.mdx",
    instruction: "ravi pages chat set acme-website --ravi-agent <installation-id>/finance --execute",
  },
  {
    name: "Page text chat brakes in the command help",
    path: "src/cli/commands/pages.ts",
    instruction: "ravi pages chat set acme-website --text true --execute",
  },
  {
    name: "Pages share root instructions",
    path: "AGENTS.md",
    instruction: "ravi pages share <url> --with <email> --execute",
  },
  {
    name: "Pages share skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    instruction: "ravi pages share https://acme-proj.ravi.page/relatorio --with ana@example.com --execute",
  },
  {
    name: "Pages share documentation",
    path: "docs/console/pages.mdx",
    instruction:
      "ravi pages share https://acme-website.ravi.page/report --with ana@example.com --expires 30d --execute",
  },
  {
    name: "Pages share solutions skill",
    path: "src/plugins/internal/ravi-system/skills/solucoes/SKILL.md",
    instruction: "ravi pages share <url> --with <email> --execute",
  },
  {
    name: "invite create root instructions",
    path: "AGENTS.md",
    instruction: "ravi invites create --email <email> --role developer --execute",
  },
  {
    name: "invite create skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    instruction: "ravi invites create --email bia@example.com --role developer --execute",
  },
  {
    name: "invite create documentation",
    path: "docs/console/pages.mdx",
    instruction: "ravi invites create --email bia@example.com --role developer --execute",
  },
  {
    name: "access request root instructions",
    path: "AGENTS.md",
    instruction: 'ravi access request <url> --message "..." --execute',
  },
  {
    name: "access request skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    instruction: 'ravi access request https://outra-org.ravi.page/relatorio --message "Para a revisão do Q3" --execute',
  },
  {
    name: "access request documentation",
    path: "docs/console/pages.mdx",
    instruction: 'ravi access request https://other-org.ravi.page/report --message "For the Q3 review" --execute',
  },
  {
    name: "Knowledge propose skill",
    path: "src/plugins/internal/ravi-system/skills/knowledge/SKILL.md",
    instruction: 'ravi knowledge propose --note "Entregas para o Sul levam 12 dias" --project vendas --execute',
  },
  {
    name: "Knowledge propose documentation",
    path: "docs/guides/knowledge.mdx",
    instruction: 'ravi knowledge propose --note "Deliveries to the South take 12 days" --project sales --execute',
  },
  {
    name: "Knowledge propose help",
    path: "src/cli/commands/knowledge.ts",
    instruction: 'ravi knowledge propose --note "Entregas para o Sul levam 12 dias" --project vendas --execute',
  },
  {
    name: "Knowledge forget redact skill",
    path: "src/plugins/internal/ravi-system/skills/knowledge/SKILL.md",
    instruction: "ravi knowledge forget --about contact:<contact-id> --redact --execute",
  },
  {
    name: "Knowledge forget redact documentation",
    path: "docs/guides/knowledge.mdx",
    instruction: "ravi knowledge forget --about contact:<contact-id> --redact --execute",
  },
  {
    name: "Knowledge forget redact help",
    path: "src/cli/commands/knowledge.ts",
    instruction: "ravi knowledge forget --about contact:<contact-id> --redact --execute",
  },
  {
    name: "Cloud key set skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction: "ravi cloud key set --stdin --execute < ~/secrets/anthropic-key",
  },
  {
    name: "Cloud key set documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction: "ravi cloud key set --stdin --execute < ~/secrets/anthropic-key",
  },
  {
    name: "Cloud key set help",
    path: "src/cli/commands/cloud-agents.ts",
    instruction: "ravi cloud key set --stdin --execute < ~/secrets/anthropic-key",
  },
  {
    name: "Cloud agents deploy skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction: "ravi cloud agents deploy triage --project clinica --execute",
  },
  {
    name: "Cloud agents deploy documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction: "ravi cloud agents deploy triage --project clinica --execute",
  },
  {
    name: "Cloud agents deploy help",
    path: "src/cli/commands/cloud-agents.ts",
    instruction: "ravi cloud agents deploy triage --project clinica --execute",
  },
  {
    name: "Cloud runs start skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction: 'ravi cloud runs start triage "Summarize yesterday\'s open tickets" --project clinica --execute',
  },
  {
    name: "Cloud runs start documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction: 'ravi cloud runs start triage "Summarize yesterday\'s open tickets" --project clinica --execute',
  },
  {
    name: "Cloud runs start help",
    path: "src/cli/commands/cloud-agents.ts",
    instruction: 'ravi cloud runs start triage "Summarize yesterday\'s open tickets" --project clinica --execute',
  },
  {
    name: "Cloud runs reply skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction: 'ravi cloud runs reply <run> "Also check the billing queue" --execute',
  },
  {
    name: "Cloud runs reply documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction: 'ravi cloud runs reply <run> "Also check the billing queue" --execute',
  },
  {
    name: "Cloud runs approve skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction: "ravi cloud runs approve <run> <approval> --execute",
  },
  {
    name: "Cloud runs approve documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction: "ravi cloud runs approve <run> <approval> --execute",
  },
  {
    name: "Cloud runs approve help",
    path: "src/cli/commands/cloud-agents.ts",
    instruction: "ravi cloud runs approve <run> <approval> --execute",
  },
  {
    name: "Cloud schedules add skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction:
      'ravi cloud schedules add triage --cron "0 9 * * 1-5" --timezone America/Sao_Paulo --project clinica --execute',
  },
  {
    name: "Cloud schedules add documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction:
      'ravi cloud schedules add triage --cron "0 9 * * 1-5" --timezone America/Sao_Paulo --project clinica --execute',
  },
  {
    name: "Cloud schedules add help",
    path: "src/cli/commands/cloud-agents.ts",
    instruction:
      'ravi cloud schedules add triage --cron "0 9 * * 1-5" --timezone America/Sao_Paulo --project clinica --execute',
  },
  {
    name: "Cloud schedules enable skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction: "ravi cloud schedules update <id> --enable --execute",
  },
  {
    name: "Cloud schedules enable documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction: "ravi cloud schedules update <id> --enable --execute",
  },
  {
    name: "Cloud schedules enable help",
    path: "src/cli/commands/cloud-agents.ts",
    instruction: "ravi cloud schedules update <id> --enable --execute",
  },
  {
    name: "Cloud task dispatch skill",
    path: "src/plugins/internal/ravi-system/skills/cloud-agents/SKILL.md",
    instruction: "ravi tasks dispatch <task> --agent triage --cloud --budget 5 --execute",
  },
  {
    name: "Cloud task dispatch documentation",
    path: "docs/console/cloud-agents.mdx",
    instruction: "ravi tasks dispatch <task> --agent triage --cloud --budget 5 --execute",
  },
  {
    name: "Bases approve in the bases skill",
    path: "src/plugins/internal/ravi-system/skills/bases/references/approvals-agent-columns.md",
    instruction: 'ravi bases rows approve compras <row> aprovacao --note "Ok" --execute --json',
  },
  {
    name: "Bases reject in the bases skill",
    path: "src/plugins/internal/ravi-system/skills/bases/references/approvals-agent-columns.md",
    instruction: 'ravi bases rows reject compras <row> aprovacao --note "Sem orçamento" --execute --json',
  },
  {
    name: "Bases approve documentation",
    path: "docs/console/bases.mdx",
    instruction: 'ravi bases rows approve requests <rowId> approval --note "Ok" --execute --json',
  },
  {
    name: "Bases reject documentation",
    path: "docs/console/bases.mdx",
    instruction: "ravi bases rows reject requests <rowId> approval --execute --json",
  },
  {
    name: "Bases views share in the bases skill",
    path: "src/plugins/internal/ravi-system/skills/bases/references/views-access-forms.md",
    instruction:
      "ravi bases views share <base> <view> --site <slug|id|host> [--write a,b] [--create] [--archive] [--write-only] --json --execute",
  },
  {
    name: "Bases views share documentation",
    path: "docs/console/bases.mdx",
    instruction:
      "ravi bases views share requests <VIEW_ID> --site <host> [--write a,b] [--create] [--archive] [--write-only] --execute",
  },
] as const;

const obsoleteExecuteConsumers = [
  {
    name: "Knowledge forget skill: archiving applies at once",
    path: "src/plugins/internal/ravi-system/skills/knowledge/SKILL.md",
    obsolete: "ravi knowledge forget <item-id> --execute",
    current: "ravi knowledge forget <item-id>",
  },
  {
    name: "Knowledge forget documentation: archiving applies at once",
    path: "docs/guides/knowledge.mdx",
    obsolete: "ravi knowledge forget <item-id> --execute",
    current: "ravi knowledge forget <item-id>",
  },
  {
    name: "Library agent requests off skill: closing an agent applies at once",
    path: "src/plugins/internal/ravi-system/skills/agents/SKILL.md",
    obsolete: "ravi agents requests financeiro off --execute",
    current: "ravi agents requests financeiro off",
  },
  {
    name: "Library agent requests off documentation: closing an agent applies at once",
    path: "docs/reference/skills.mdx",
    obsolete: "ravi agents requests finance off --execute",
    current: "ravi agents requests finance off",
  },
  {
    name: "Library agent requests off help: closing an agent applies at once",
    path: "src/cli/commands/agents-library.ts",
    obsolete: "ravi agents requests finance off --execute",
    current: "ravi agents requests finance off",
  },
  {
    name: "Library agent listing off skill: unlisting an agent applies at once",
    path: "src/plugins/internal/ravi-system/skills/agents/SKILL.md",
    obsolete: "ravi agents listing financeiro off --execute",
    current: "ravi agents listing financeiro off",
  },
  {
    name: "Library agent listing off documentation: unlisting an agent applies at once",
    path: "docs/reference/skills.mdx",
    obsolete: "ravi agents listing finance off --execute",
    current: "ravi agents listing finance off",
  },
  {
    name: "Library agent listing off help: unlisting an agent applies at once",
    path: "src/cli/commands/agents-library.ts",
    obsolete: "ravi agents listing finance off --execute",
    current: "ravi agents listing finance off",
  },
  {
    name: "Library unpin skill: reducing what an agent loads applies at once",
    path: "src/plugins/internal/ravi-system/skills/skills/SKILL.md",
    obsolete: "ravi skills unpin org/tom-de-voz --agent main --execute",
    current: "ravi skills unpin org/tom-de-voz --agent main",
  },
  {
    name: "Library unpin documentation: reducing what an agent loads applies at once",
    path: "docs/reference/skills.mdx",
    obsolete: "ravi skills unpin org/tone-of-voice --agent main --execute",
    current: "ravi skills unpin org/tone-of-voice --agent main",
  },
  {
    name: "Library unpin help: reducing what an agent loads applies at once",
    path: "src/cli/commands/skills.ts",
    obsolete: "ravi skills unpin org/tom-de-voz --agent main --execute",
    current: "ravi skills unpin org/tom-de-voz --agent main",
  },
  {
    name: "contact block help",
    path: "src/cli/commands/contacts.ts",
    obsolete: "ravi contacts block <id> --execute",
    current: "ravi contacts block <id>",
  },
  {
    name: "CLI overview contact block example",
    path: "docs/cli/overview.mdx",
    obsolete: "ravi contacts block <contact> --execute",
    current: "ravi contacts block <contact>",
  },
  {
    name: "CLI overview instance delete example",
    path: "docs/cli/overview.mdx",
    obsolete: "ravi instances delete <name> --execute",
    current: "ravi instances delete <name>",
  },
  {
    name: "CLI overview route removal example",
    path: "docs/cli/overview.mdx",
    obsolete: "ravi instances routes remove <name> <pattern> --execute",
    current: "ravi instances routes remove <name> <pattern>",
  },
  {
    name: "agent permission containment hint",
    path: "src/cli/commands/agents.ts",
    obsolete: "ravi agents permissions $" + "{id} none --execute",
    current: "ravi agents permissions $" + "{id} none",
  },
  {
    name: "agent permission containment instructions",
    path: "AGENTS.md",
    obsolete: "ravi agents permissions dev none --execute",
    current: "ravi agents permissions dev none",
  },
  {
    name: "context revoke rotation hint",
    path: "src/cli/commands/daemon.ts",
    obsolete: "ravi context revoke <id> --execute",
    current: "ravi context revoke <id>",
  },
  {
    name: "WhatsApp demote skill",
    path: "src/plugins/internal/ravi-system/skills/whatsapp/SKILL.md",
    obsolete: 'ravi whatsapp group demote <groupId> "5511999999999" --execute',
    current: 'ravi whatsapp group demote <groupId> "5511999999999"',
  },
  {
    name: "WhatsApp demote CLI overview",
    path: "docs/cli/overview.mdx",
    obsolete: "ravi whatsapp group demote <groupId> <participants> --execute",
    current: "ravi whatsapp group demote <groupId> <participants>",
  },
  {
    name: "WhatsApp demote routing guide",
    path: "docs/guides/routing.mdx",
    obsolete: 'ravi whatsapp group demote group:120363425628305127 "5511999999999" --execute',
    current: 'ravi whatsapp group demote group:120363425628305127 "5511999999999"',
  },
  {
    name: "Slack Canvas access removal skill reference",
    path: "src/plugins/internal/ravi-system/skills/slack/references/canvas.md",
    obsolete: "ravi slack canvas-access-delete <canvas> --users <userIds> --execute --json",
    current: "ravi slack canvas-access-delete <canvas> --users <userIds> --json",
  },
  {
    name: "Slack Canvas access removal runbook",
    path: ".ravi/specs/channels/slack/canvas/RUNBOOK.md",
    obsolete: "ravi slack canvas-access-delete F123 --users U123 --execute --json",
    current: "ravi slack canvas-access-delete F123 --users U123 --json",
  },
  {
    name: "Pages ship root instructions",
    path: "AGENTS.md",
    obsolete: 'ravi pages ship --title "Weekly report" --body "<h1>OK</h1>" --json --execute',
    current: 'ravi pages ship --title "Weekly report" --body "<h1>OK</h1>" --json',
  },
  {
    name: "Pages ship skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: 'ravi pages ship --title "Relatório semanal" --body "<h1>OK</h1>" --json --execute',
    current: 'ravi pages ship --title "Relatório semanal" --body "<h1>OK</h1>" --json',
  },
  {
    name: "Pages create root instructions",
    path: "AGENTS.md",
    obsolete: "ravi pages create <project-ref> <site-slug> --visibility public --execute",
    current: "ravi pages create <project-ref> <site-slug> --visibility public",
  },
  {
    name: "Pages ship artifact runbook",
    path: ".ravi/specs/artifacts/RUNBOOK.md",
    obsolete: 'ravi pages ship --title "Demo" --body "<h1>OK</h1>" --json --execute',
    current: 'ravi pages ship --title "Demo" --body "<h1>OK</h1>" --json',
  },
  {
    name: "Pages ship artifact spec",
    path: ".ravi/specs/artifacts/SPEC.md",
    obsolete: 'ravi pages ship --title "Demo" --dir ./site --execute --json',
    current: 'ravi pages ship --title "Demo" --dir ./site --json',
  },
  {
    name: "Pages publish artifact spec",
    path: ".ravi/specs/artifacts/SPEC.md",
    obsolete:
      "ravi pages publish <project-ref> <site-slug> ./site --route / --visibility public --entrypoint index.html --execute",
    current:
      "ravi pages publish <project-ref> <site-slug> ./site --route / --visibility public --entrypoint index.html",
  },
  {
    name: "Pages create Console-scope acceptance",
    path: ".ravi/specs/cli/console-scope/SPEC.md",
    obsolete: "ravi pages create <slug> --json --execute",
    current: "ravi pages create <slug> --json",
  },
  {
    name: "connectors mode help: back to owner applies at once",
    path: "src/cli/commands/connectors.ts",
    obsolete: "ravi connectors mode main google owner --execute",
    current: "ravi connectors mode main google owner",
  },
  {
    name: "connectors skill: back to owner applies at once",
    path: "src/plugins/internal/ravi-system/skills/connectors/SKILL.md",
    obsolete: "ravi connectors mode main google owner --execute",
    current: "ravi connectors mode main google owner",
  },
  {
    name: "connectors guide: back to owner applies at once",
    path: "docs/console/connectors.mdx",
    obsolete: "ravi connectors mode main google owner --execute",
    current: "ravi connectors mode main google owner",
  },
  {
    name: "Page Chat disable skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: "ravi pages chat set <host> --enabled false --execute",
    current: "ravi pages chat set <host> --enabled false",
  },
  {
    name: "Page Chat settings skill",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: 'ravi pages chat set <host> --voice tempo --name "Lia" --language pt-BR --json --execute',
    current: 'ravi pages chat set <host> --voice tempo --name "Lia" --language pt-BR --json',
  },
  {
    name: "Page Chat disable documentation",
    path: "docs/console/pages.mdx",
    obsolete: "ravi pages chat set acme-website --enabled false --execute",
    current: "ravi pages chat set acme-website --enabled false",
  },
  {
    name: "Page text chat disable skill: turning it off applies at once",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: "ravi pages chat set <host> --text false --execute",
    current: "ravi pages chat set <host> --text false",
  },
  {
    name: "Page text chat mention skill: back to mention applies at once",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: "ravi pages chat set <host> --reply-policy mention --execute",
    current: "ravi pages chat set <host> --reply-policy mention",
  },
  {
    name: "Page text chat clear agent skill: clearing applies at once",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: "ravi pages chat set <host> --clear-ravi-agent --execute",
    current: "ravi pages chat set <host> --clear-ravi-agent",
  },
  {
    name: "Page text chat disable documentation",
    path: "docs/console/pages.mdx",
    obsolete: "ravi pages chat set acme-website --text false --execute",
    current: "ravi pages chat set acme-website --text false",
  },
  {
    name: "Page text chat mention documentation",
    path: "docs/console/pages.mdx",
    obsolete: "ravi pages chat set acme-website --reply-policy mention --execute",
    current: "ravi pages chat set acme-website --reply-policy mention",
  },
  {
    name: "Page text chat clear agent documentation",
    path: "docs/console/pages.mdx",
    obsolete: "ravi pages chat set acme-website --clear-ravi-agent --execute",
    current: "ravi pages chat set acme-website --clear-ravi-agent",
  },
  {
    name: "Pages unshare root instructions: reducing access applies at once",
    path: "AGENTS.md",
    obsolete: "ravi pages unshare <url> --with <email> --execute",
    current: "ravi pages unshare <url> --with <email>",
  },
  {
    name: "Pages unshare skill: reducing access applies at once",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: "ravi pages unshare https://acme-proj.ravi.page/relatorio --with ana@example.com --execute",
    current: "ravi pages unshare https://acme-proj.ravi.page/relatorio --with ana@example.com",
  },
  {
    name: "invite revoke skill: reducing access applies at once",
    path: "src/plugins/internal/ravi-system/skills/pages/SKILL.md",
    obsolete: "ravi invites revoke <invite-id> --execute",
    current: "ravi invites revoke <invite-id>",
  },
  {
    name: "views bind in the pages skill: a view update applies at once",
    path: "src/plugins/internal/ravi-system/skills/pages/references/widgets.md",
    obsolete: "ravi bases views bind <base> <view-id> org/pedido-card --variant compact --field valor=total --execute",
    current: "ravi bases views bind <base> <view-id> org/pedido-card --variant compact --field valor=total",
  },
  {
    name: "views bind documentation: a view update applies at once",
    path: "docs/console/widgets.mdx",
    obsolete: "ravi bases views bind requests <view id> none --execute",
    current: "ravi bases views bind requests <view id> none",
  },
  {
    name: "request-approval in the bases skill: asking applies at once",
    path: "src/plugins/internal/ravi-system/skills/bases/references/approvals-agent-columns.md",
    obsolete:
      'ravi bases rows request-approval compras <row> aprovacao --note "Acima do teto" --idempotency-key compras:<row>:pedir:<id-do-pedido> --json --execute',
    current:
      'ravi bases rows request-approval compras <row> aprovacao --note "Acima do teto" --idempotency-key compras:<row>:pedir:<id-do-pedido> --json',
  },
  {
    name: "rows fill in the bases skill: filling an agent cell applies at once",
    path: "src/plugins/internal/ravi-system/skills/bases/references/approvals-agent-columns.md",
    obsolete:
      'ravi bases rows fill leads <row> resumo --inputs-hash <hash> --value "Quer migrar o ERP" --json --execute',
    current: 'ravi bases rows fill leads <row> resumo --inputs-hash <hash> --value "Quer migrar o ERP" --json',
  },
  {
    name: "widgets check in the pages skill: a read",
    path: "src/plugins/internal/ravi-system/skills/pages/references/widgets.md",
    obsolete: "ravi widgets check ./pedido-card --execute",
    current: "ravi widgets check ./pedido-card",
  },
  {
    name: "themes check in the pages skill: a read",
    path: "src/plugins/internal/ravi-system/skills/pages/references/theme.md",
    obsolete: "ravi themes check ./tema-acme --execute",
    current: "ravi themes check ./tema-acme",
  },
  {
    name: "Pages ship in the pages design reference",
    path: "src/plugins/internal/ravi-system/skills/pages/references/design.md",
    obsolete:
      'ravi pages ship --project <p> --title "Semana do Atendimento" --route /semana --html site/index.html --json --execute',
    current:
      'ravi pages ship --project <p> --title "Semana do Atendimento" --route /semana --html site/index.html --json',
  },
  {
    name: "request-approval in the pages design reference: asking applies at once",
    path: "src/plugins/internal/ravi-system/skills/pages/references/design.md",
    obsolete:
      'ravi bases rows request-approval decisoes <row> aprovacao --note "Campanha de reativação" --idempotency-key decisoes:<row>:pedir:<id-do-pedido> --json --execute',
    current:
      'ravi bases rows request-approval decisoes <row> aprovacao --note "Campanha de reativação" --idempotency-key decisoes:<row>:pedir:<id-do-pedido> --json',
  },
] as const;

describe("command consumer contracts", () => {
  it("keeps every consumer of a braked command executable", () => {
    for (const consumer of executeConsumers) {
      const lines = sourceLines(consumer.path, consumer.marker);

      expect(lines, consumer.name).toHaveLength(consumer.matches);
      for (const line of lines) expect(line, consumer.name).toContain(consumer.expected);
    }
  });

  it("keeps explicit braked command instructions executable", () => {
    for (const consumer of executeInstructions) {
      const source = readFileSync(join(repoRoot, consumer.path), "utf8");

      expect(source, consumer.name).toContain(consumer.instruction);
    }
  });

  it("does not teach obsolete execute flags for immediate commands", () => {
    for (const consumer of obsoleteExecuteConsumers) {
      const source = readFileSync(join(repoRoot, consumer.path), "utf8");

      expect(source, consumer.name).not.toContain(consumer.obsolete);
      expect(source, consumer.name).toContain(consumer.current);
    }
  });

  it("teaches immediate CRM writes without an execute brake", () => {
    const source = normalizedSource("src/plugins/internal/ravi-system/skills/crm/SKILL.md");

    expect(source).toContain(
      "`crm pipeline create`, `crm opportunity create` e `crm opportunity move` executam imediatamente sem `--execute`.",
    );
    expect(source).not.toContain(
      "**Onde o freio existe hoje:** somente `crm pipeline create`, `crm opportunity create` e `crm opportunity move`",
    );
    expect(source).not.toContain("Use o dry-run (exit 3) para conferir o `plan` antes de `--execute`.");
  });

  it("teaches the conditional heartbeat trigger brake without contradictions", () => {
    const source = normalizedSource("src/plugins/internal/ravi-system/skills/heartbeat/SKILL.md");

    expect(source).toContain(
      "Com trabalho pendente, `heartbeat trigger` retorna dry-run (exit 3) e exige `--execute`.",
    );
    expect(source).not.toContain("`3` NÃO acontece neste domínio");
    expect(source).not.toContain("nenhum comando aceita `--execute`");
    expect(source).not.toContain("aqui NÃO existe `--execute`");
  });
});
