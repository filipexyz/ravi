/**
 * Setup Command - Wizard interativo para configurar o Ravi
 */

import * as readline from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_NATS_URL,
  NATS_PM2_PROCESS,
  NATS_SERVER_VERSION,
  OMNI_NATS_PM2_PROCESS,
  ensureNatsServerBinary,
  findNatsPm2Owner,
  isNatsReachable,
  natsPm2StartArgs,
  parseNatsEndpoint,
  type NatsServerBinary,
} from "../../nats-server.js";
import { getPm2Processes } from "../../pm2.js";
import { getRaviStateDir } from "../../utils/paths.js";

const RAVI_DOT_DIR = join(homedir(), ".ravi");
const ENV_FILE = join(RAVI_DOT_DIR, ".env");

// ============================================================================
// ANSI helpers
// ============================================================================

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

const ok = `${c.green}✓${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const bullet = `${c.gray}›${c.reset}`;
const arrow = `${c.cyan}❯${c.reset}`;

function heading(step: number, total: number, title: string, detail: string) {
  console.log();
  console.log(`  ${c.cyan}${c.bold}[${step}/${total}]${c.reset} ${c.bold}${title}${c.reset}`);
  console.log(`  ${c.gray}${detail}${c.reset}`);
  console.log();
}

function done(msg: string) {
  console.log(`    ${ok} ${msg}`);
}

function skip(msg: string) {
  console.log(`    ${c.gray}${msg} — já configurado${c.reset}`);
}

function warning(msg: string) {
  console.log(`    ${warn} ${c.yellow}${msg}${c.reset}`);
}

function info(msg: string) {
  console.log(`    ${c.gray}${msg}${c.reset}`);
}

// ============================================================================
// Prompt helpers
// ============================================================================

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      let input = "";

      const onData = (char: Buffer) => {
        const c = char.toString();
        if (c === "\n" || c === "\r") {
          process.stdin.removeListener("data", onData);
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          console.log();
          rl.close();
          resolve(input);
        } else if (c === "\u0003") {
          process.exit(1);
        } else if (c === "\u007F" || c === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += c;
        }
      };

      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function ask(label: string, opts?: { default?: string; hidden?: boolean }): Promise<string> {
  const def = opts?.default;
  const suffix = def ? ` ${c.gray}(${def})${c.reset}` : "";
  const answer = await prompt(`    ${arrow} ${label}${suffix} `, opts?.hidden);
  return answer.trim() || def || "";
}

async function choose(label: string, options: string[], defaultIdx = 0): Promise<string> {
  const optStr = options
    .map((o, i) => (i === defaultIdx ? `${c.white}${c.bold}${o}${c.reset}` : `${c.gray}${o}${c.reset}`))
    .join(`${c.gray}/${c.reset}`);
  const answer = await prompt(`    ${arrow} ${label} ${optStr} `);
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return options[defaultIdx];
  const match = options.find((o) => o.toLowerCase() === trimmed);
  return match || options[defaultIdx];
}

// ============================================================================
// .env helpers
// ============================================================================

function parseEnvFile(path: string): Map<string, string> {
  const env = new Map<string, string>();
  if (!existsSync(path)) return env;

  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && value) {
      env.set(key, value);
    }
  }
  return env;
}

function appendEnvKey(key: string, value: string): void {
  appendFileSync(ENV_FILE, `${key}=${value}\n`);
}

// ============================================================================
// System seam (NATS / Omni steps are tested without PM2, network or a shell)
// ============================================================================

const OMNI_API_HEALTH_URL = "http://127.0.0.1:8882/health";
const OMNI_API_PM2_PROCESS = "omni-api";
const TOTAL_STEPS = 6;

export interface SetupPm2Process {
  name: string;
  status: string;
  pid?: number;
}

export interface SetupCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SetupSystem {
  /** NATS URL Ravi connects to (`NATS_URL`, default nats://127.0.0.1:4222). */
  natsUrl: string;
  /** JetStream store dir for ravi-nats (`~/.ravi/jetstream`). */
  natsStoreDir: string;
  /** False when stdin is not a TTY: opt-in questions are answered with their default (No). */
  interactive: boolean;
  which(binary: string): boolean;
  /** Runs a command without a shell. `inherit` streams its output to the terminal. Never throws. */
  run(command: string, args: string[], options?: { inherit?: boolean }): SetupCommandResult;
  pm2Processes(): SetupPm2Process[];
  isNatsReachable(url: string): Promise<boolean>;
  ensureNatsServerBinary(): Promise<NatsServerBinary>;
  omniHealthy(timeoutMs: number): Promise<boolean>;
  omniConfigExists(): boolean;
  /** Yes/no question whose default is No. */
  confirm(question: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

function runCommand(command: string, args: string[], options: { inherit?: boolean } = {}): SetupCommandResult {
  const result = spawnSync(command, args, {
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: process.env,
  });
  return {
    status: result.error ? 1 : (result.status ?? 1),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : (result.error?.message ?? ""),
  };
}

export function createSetupSystem(): SetupSystem {
  return {
    natsUrl: process.env.NATS_URL || DEFAULT_NATS_URL,
    natsStoreDir: join(getRaviStateDir(), "jetstream"),
    interactive: Boolean(process.stdin.isTTY),
    which: (binary) => runCommand("which", [binary]).status === 0,
    run: runCommand,
    pm2Processes: () => getPm2Processes().map(({ name, status, pid }) => ({ name, status, pid })),
    isNatsReachable: (url) => isNatsReachable(url),
    ensureNatsServerBinary: () => ensureNatsServerBinary(),
    omniHealthy: async (timeoutMs) => {
      try {
        const res = await fetch(OMNI_API_HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
        return res.status < 500;
      } catch {
        return false;
      }
    },
    omniConfigExists: () => existsSync(join(homedir(), ".omni", "config.json")),
    confirm: async (question) => /^(y|yes|s|sim)$/i.test((await prompt(`    ${arrow} ${question} [y/N] `)).trim()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function ensurePm2(system: SetupSystem): boolean {
  if (system.which("pm2")) {
    done("pm2 encontrado");
    return true;
  }
  info("Instalando pm2...");
  if (system.run("bun", ["add", "-g", "pm2"]).status === 0) {
    done("pm2 instalado");
    return true;
  }
  warning("Falha ao instalar pm2 — instale manualmente: bun add -g pm2");
  return false;
}

// ============================================================================
// Wizard steps
// ============================================================================

export interface SetupNatsResult {
  action: "reused" | "started" | "not_reachable" | "failed";
  /** PM2 process that owns the NATS (`ravi-nats`, `omni-nats`), or null when it is not managed by PM2. */
  owner: string | null;
  detail?: string;
}

/**
 * D15: reuse whatever NATS already answers on the NATS URL (on existing hosts that is `omni-nats`, Ravi's NATS);
 * otherwise download the pinned nats-server and start it under PM2 as `ravi-nats`. It never stops, deletes or
 * restarts an existing NATS process.
 */
export async function setupNats(system: SetupSystem): Promise<SetupNatsResult> {
  heading(1, TOTAL_STEPS, "NATS", `JetStream em ${system.natsUrl}`);

  if (await system.isNatsReachable(system.natsUrl)) {
    const owner = findNatsPm2Owner(system.pm2Processes());
    done(`NATS já responde em ${system.natsUrl}${owner ? ` (PM2: ${owner.name})` : " (fora do PM2)"}`);
    return { action: "reused", owner: owner?.name ?? null };
  }

  let endpoint: ReturnType<typeof parseNatsEndpoint>;
  try {
    endpoint = parseNatsEndpoint(system.natsUrl);
  } catch {
    warning(`NATS_URL inválida: ${system.natsUrl}`);
    return { action: "failed", owner: null, detail: "invalid_nats_url" };
  }
  if (!endpoint.loopback) {
    warning(`NATS em ${system.natsUrl} não responde — host remoto, o setup não provisiona nada`);
    return { action: "not_reachable", owner: null, detail: "remote_nats_url" };
  }

  const registered = system
    .pm2Processes()
    .find((process) => process.name === NATS_PM2_PROCESS || process.name === OMNI_NATS_PM2_PROCESS);
  if (registered) {
    warning(
      `${registered.name} existe no PM2 (${registered.status}) mas o NATS não responde — o setup não mexe nele; verifique: pm2 logs ${registered.name}`,
    );
    return { action: "not_reachable", owner: registered.name, detail: "existing_process_not_answering" };
  }

  if (!ensurePm2(system)) {
    return { action: "failed", owner: null, detail: "pm2_unavailable" };
  }

  let binary: NatsServerBinary;
  try {
    binary = await system.ensureNatsServerBinary();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warning(`Falha ao obter nats-server ${NATS_SERVER_VERSION}: ${message}`);
    return { action: "failed", owner: null, detail: message };
  }
  if (binary.downloaded) done(`nats-server ${binary.version} baixado em ${c.gray}${binary.path}${c.reset}`);
  else done(`nats-server em ${c.gray}${binary.path}${c.reset}`);

  const started = system.run(
    "pm2",
    natsPm2StartArgs(binary.path, { storeDir: system.natsStoreDir, port: endpoint.port }),
  );
  if (started.status !== 0) {
    warning(`Falha ao iniciar ${NATS_PM2_PROCESS} — veja: pm2 logs ${NATS_PM2_PROCESS}`);
    return { action: "failed", owner: null, detail: started.stderr.trim() || "pm2_start_failed" };
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    if (await system.isNatsReachable(system.natsUrl)) {
      done(`${NATS_PM2_PROCESS} iniciado via PM2 (porta ${endpoint.port}, JetStream em ${system.natsStoreDir})`);
      return { action: "started", owner: NATS_PM2_PROCESS };
    }
    await system.sleep(500);
  }
  warning(`${NATS_PM2_PROCESS} iniciado mas ainda não responde — verifique: pm2 logs ${NATS_PM2_PROCESS}`);
  return { action: "started", owner: NATS_PM2_PROCESS, detail: "not_answering_yet" };
}

export interface SetupOmniResult {
  action:
    | "declined"
    | "already_running"
    | "installed_on_ravi_nats"
    | "started"
    | "installed"
    | "skipped_external_nats"
    | "unavailable"
    | "failed";
  /** Every command the step ran, in order (for the summary and for tests). */
  commands: string[];
}

/**
 * Opt-in legacy Omni bridge (Telegram/Discord only; WhatsApp runs in the ravi channels runner).
 *
 * - `omni-api` already online, or the API already healthy → nothing to do.
 * - NATS answers and its PM2 owner is `ravi-nats` → `omni install --non-interactive` (omni-api defaults to
 *   nats://localhost:4222, i.e. ravi-nats), then `pm2 delete omni-nats`, which can only crash-loop on the taken port.
 * - No NATS, or NATS owned by `omni-nats` → the classic flow (`omni start` when installed, else `omni install`).
 * - NATS answers but is not managed by PM2 → nothing is installed (Omni would start a second NATS on the port).
 * It never runs `omni stop`.
 */
export async function setupOmniBridge(system: SetupSystem): Promise<SetupOmniResult> {
  heading(2, TOTAL_STEPS, "Ponte legada Omni (opcional)", "Telegram/Discord — WhatsApp roda no ravi channels runner");
  const commands: string[] = [];
  const run = (command: string, args: string[], inherit = false) => {
    commands.push([command, ...args].join(" "));
    return system.run(command, args, { inherit });
  };

  const omniApi = system.pm2Processes().find((process) => process.name === OMNI_API_PM2_PROCESS);
  if (omniApi?.status === "online") {
    done(`${OMNI_API_PM2_PROCESS} já rodando — nada a fazer`);
    return { action: "already_running", commands };
  }

  const wanted = system.interactive && (await system.confirm("Instalar a ponte legada Omni para Telegram/Discord?"));
  if (!wanted) {
    info(
      system.interactive
        ? "Pulado — WhatsApp não precisa do Omni. Para Telegram/Discord rode ravi setup de novo."
        : "Pulado (não interativo) — WhatsApp não precisa do Omni.",
    );
    return { action: "declined", commands };
  }

  if (!ensurePm2(system)) return { action: "unavailable", commands };
  if (system.which("omni")) {
    done("omni encontrado");
  } else {
    info("Instalando omni...");
    if (run("bun", ["add", "-g", "@automagik/omni"]).status === 0) {
      done("omni instalado");
    } else {
      warning("Falha ao instalar omni — instale manualmente: bun add -g @automagik/omni");
      return { action: "unavailable", commands };
    }
  }

  if (await system.omniHealthy(3000)) {
    done("omni API já rodando (porta 8882)");
    return { action: "already_running", commands };
  }

  const natsUp = await system.isNatsReachable(system.natsUrl);
  const natsOwner = natsUp ? findNatsPm2Owner(system.pm2Processes()) : null;

  if (natsUp && natsOwner?.name === NATS_PM2_PROCESS) {
    info(`NATS em ${system.natsUrl} é o ${NATS_PM2_PROCESS} — instalando o Omni sobre ele`);
    const install = run("omni", ["install", "--non-interactive"], true);
    if (install.status === 0) done("omni install --non-interactive");
    else warning(`omni install --non-interactive terminou com status ${install.status}`);
    // Omni starts its own omni-nats on the same port; with ravi-nats holding it, it can only crash-loop.
    if (system.pm2Processes().some((process) => process.name === OMNI_NATS_PM2_PROCESS)) {
      const removed = run("pm2", ["delete", OMNI_NATS_PM2_PROCESS]);
      if (removed.status === 0) done(`pm2 delete ${OMNI_NATS_PM2_PROCESS} (o Omni usa o ${NATS_PM2_PROCESS})`);
      else warning(`Falha em pm2 delete ${OMNI_NATS_PM2_PROCESS} — remova manualmente`);
    }
    info(`Executado: ${commands.join(" ; ")}`);
    await verifyOmniHealth(system);
    return { action: install.status === 0 ? "installed_on_ravi_nats" : "failed", commands };
  }

  if (natsUp && !natsOwner) {
    warning(
      `NATS em ${system.natsUrl} não é gerenciado pelo PM2 — o Omni subiria um segundo NATS na mesma porta. Instale o Omni manualmente apontando o NATS dele para ${system.natsUrl}.`,
    );
    return { action: "skipped_external_nats", commands };
  }

  if (natsOwner?.name === OMNI_NATS_PM2_PROCESS) {
    info(`${OMNI_NATS_PM2_PROCESS} é o NATS do Ravi neste host — o setup nunca o para nem remove`);
  }

  let result: SetupCommandResult;
  let action: SetupOmniResult["action"];
  if (system.omniConfigExists()) {
    info("omni instalado mas parado — iniciando...");
    result = run("omni", ["start"], true);
    action = "started";
    if (result.status === 0) done("omni iniciado");
    else warning("Falha ao iniciar omni — execute: omni start");
  } else {
    info("Configurando omni pela primeira vez...");
    result = run("omni", ["install", "--non-interactive"], true);
    action = "installed";
    if (result.status === 0) done("omni instalado e iniciado");
    else warning("Falha ao instalar omni — execute: omni install");
  }

  await verifyOmniHealth(system);
  return { action: result.status === 0 ? action : "failed", commands };
}

async function verifyOmniHealth(system: SetupSystem): Promise<void> {
  await system.sleep(2000);
  if (await system.omniHealthy(5000)) done("omni API respondendo");
  else warning("omni API não respondeu — verifique: omni status");
}

async function stepEnvironment(): Promise<void> {
  heading(3, TOTAL_STEPS, "Ambiente", "~/.ravi/.env");

  mkdirSync(RAVI_DOT_DIR, { recursive: true });

  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, "# Ravi Daemon - Variáveis de ambiente\n\n");
  }

  const env = parseEnvFile(ENV_FILE);

  // Claude auth
  const hasAnthropicKey = env.has("ANTHROPIC_API_KEY");
  const hasOAuthToken = env.has("CLAUDE_CODE_OAUTH_TOKEN");

  if (hasAnthropicKey || hasOAuthToken) {
    if (hasAnthropicKey) skip("ANTHROPIC_API_KEY");
    if (hasOAuthToken) skip("CLAUDE_CODE_OAUTH_TOKEN");
  } else {
    const method = await choose("Autenticação Claude", ["API key", "OAuth token"], 0);
    if (method === "OAuth token") {
      info("Execute `claude setup-token` para obter o token");
      const val = await ask("CLAUDE_CODE_OAUTH_TOKEN", { hidden: true });
      if (val) {
        appendEnvKey("CLAUDE_CODE_OAUTH_TOKEN", val);
        done("CLAUDE_CODE_OAUTH_TOKEN salvo");
      }
    } else {
      const val = await ask("ANTHROPIC_API_KEY", { hidden: true });
      if (val) {
        appendEnvKey("ANTHROPIC_API_KEY", val);
        done("ANTHROPIC_API_KEY salvo");
      }
    }
  }

  // Opcional: OPENAI_API_KEY
  if (env.has("OPENAI_API_KEY")) {
    skip("OPENAI_API_KEY");
  } else {
    const val = await ask("OpenAI key — transcrição de áudio", { hidden: true });
    if (val) {
      appendEnvKey("OPENAI_API_KEY", val);
      done("OPENAI_API_KEY salvo");
    } else {
      info("Pulado — pode configurar depois");
    }
  }

  // Opcional: RAVI_MODEL
  if (env.has("RAVI_MODEL")) {
    skip(`RAVI_MODEL (${env.get("RAVI_MODEL")})`);
  } else {
    const val = await choose("Modelo", ["sonnet", "haiku", "opus"], 0);
    if (val !== "sonnet") {
      appendEnvKey("RAVI_MODEL", val);
    }
    done(`Modelo: ${val}`);
  }
}

async function stepAgent(): Promise<void> {
  heading(4, TOTAL_STEPS, "Agente", "~/ravi/main");

  const { dbListAgents, dbCreateAgent, dbSetSetting } = await import("../../router/router-db.js");
  const { ensureAgentDirs, loadRouterConfig } = await import("../../router/config.js");
  const { ensureAgentInstructionFiles } = await import("../../runtime/agent-instructions.js");

  const agents = dbListAgents();

  if (agents.length > 0) {
    const names = agents.map((a) => `${c.cyan}${a.id}${c.reset}`).join(", ");
    console.log(`    ${ok} Agentes existentes: ${names}`);
    return;
  }

  const id = await ask("Nome do agente", { default: "main" });
  const defaultCwd = `~/ravi/${id}`;
  const cwd = await ask("Diretório", { default: defaultCwd });

  dbCreateAgent({ id, cwd });
  dbSetSetting("defaultAgent", id);

  ensureAgentDirs(loadRouterConfig());

  const resolvedCwd = cwd.replace("~", homedir());
  ensureAgentInstructionFiles(resolvedCwd, {
    createAgentsStub: `# ${id}\n\nInstruções do agente aqui.\n`,
  });

  done(`Agente ${c.cyan}${id}${c.reset} criado em ${c.gray}${cwd}${c.reset}`);
}

async function stepSettings(): Promise<void> {
  heading(5, TOTAL_STEPS, "Configurações", "fuso horário, políticas");

  const { dbGetSetting, dbSetSetting } = await import("../../router/router-db.js");

  // defaultTimezone
  const existingTz = dbGetSetting("defaultTimezone");
  if (existingTz) {
    skip(`Fuso horário (${existingTz})`);
  } else {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tz = await ask("Fuso horário", { default: detected });
    dbSetSetting("defaultTimezone", tz);
    done(`Fuso horário: ${c.cyan}${tz}${c.reset}`);
  }

  // whatsapp.dmPolicy
  const existingDm = dbGetSetting("whatsapp.dmPolicy");
  if (existingDm) {
    skip(`DM policy (${existingDm})`);
  } else {
    const val = await choose("WhatsApp DMs", ["open", "pairing", "closed"], 1);
    dbSetSetting("whatsapp.dmPolicy", val);
    done(`DM policy: ${c.cyan}${val}${c.reset}`);
  }

  // whatsapp.groupPolicy
  const existingGroup = dbGetSetting("whatsapp.groupPolicy");
  if (existingGroup) {
    skip(`Group policy (${existingGroup})`);
  } else {
    const val = await choose("WhatsApp grupos", ["open", "allowlist", "closed"], 1);
    dbSetSetting("whatsapp.groupPolicy", val);
    done(`Group policy: ${c.cyan}${val}${c.reset}`);
  }
}

async function stepDaemon(system: SetupSystem): Promise<void> {
  heading(6, TOTAL_STEPS, "Daemon", "daemon + channels runner via PM2");

  const daemon = system.run("ravi", ["daemon", "start"]);
  if (daemon.status === 0) {
    done("Daemon iniciado via PM2");
  } else if (`${daemon.stderr}${daemon.stdout}`.includes("already running")) {
    done("Daemon já está rodando");
  } else {
    warning("Não foi possível iniciar — execute: ravi daemon start");
  }

  // The WhatsApp runner (and native Slack) live in the channels runner; it answers "already_running" when up.
  const channels = system.run("ravi", ["channels", "start", "--json"]);
  if (channels.status === 0) {
    done(
      channels.stdout.includes("already_running")
        ? "Channels runner já está rodando"
        : "Channels runner iniciado via PM2",
    );
  } else {
    warning("Não foi possível iniciar o channels runner — execute: ravi channels start");
  }

  // Save PM2 state
  if (system.run("pm2", ["save"]).status === 0) {
    done("PM2 state salvo");
  } else {
    info("Execute: pm2 save && pm2 startup");
  }
}

// ============================================================================
// Main entry
// ============================================================================

export async function runSetup(): Promise<void> {
  console.log();
  console.log(`  ${c.bold}Ravi Bot${c.reset} ${c.gray}— setup${c.reset}`);
  console.log(`  ${c.gray}${"─".repeat(30)}${c.reset}`);

  const system = createSetupSystem();
  await setupNats(system);
  await setupOmniBridge(system);
  await stepEnvironment();
  await stepAgent();
  await stepSettings();
  await stepDaemon(system);

  console.log();
  console.log(`  ${c.green}${c.bold}Configuração completa!${c.reset}`);
  console.log();
  console.log(`  ${c.gray}Próximos passos:${c.reset}`);
  console.log(`    ${bullet} ${c.white}ravi daemon logs -f${c.reset}       ${c.gray}Ver logs do daemon${c.reset}`);
  console.log(`    ${bullet} ${c.white}ravi instances connect <name>${c.reset}  ${c.gray}Conectar WhatsApp${c.reset}`);
  console.log(`    ${bullet} ${c.white}ravi agents chat main${c.reset}     ${c.gray}Testar o agente${c.reset}`);
  console.log(`    ${bullet} ${c.white}pm2 startup${c.reset}              ${c.gray}Iniciar no boot${c.reset}`);
  console.log();
}
